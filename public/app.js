(() => {
  window.__riftBooted = true;
  function diag(msg, kind) {
    // Only show progress diagnostics when we have no data yet.
    // Errors always show.
    if (kind === 'err') { if (window.__riftStatus) window.__riftStatus(msg, kind); return; }
    if (state && state.boards && state.boards.length > 0) return;
    if (window.__riftStatus) window.__riftStatus(msg, kind);
  }

  const REFRESH_MS = 5 * 60 * 1000;
  const PLAYERS = ['MURPH', 'MAX', 'MANGO', 'PATTY', 'HIPPIE', 'PICKLE', 'RYAN', 'PARKER', 'DAN', 'HOAG'];
  const DEFAULT_PAR = 70;
  const BRACKET_DRAFT_KEY = 'rift_bracket_draft';

  function nextRefreshAt() {
    // Align to fixed 5-minute wall-clock boundaries so every viewer sees the
    // same countdown and refreshing the page doesn't reset it.
    return Math.ceil((Date.now() + 1) / REFRESH_MS) * REFRESH_MS;
  }

  const state = {
    boards: [],
    tallies: {},
    snapshotTallies: {},
    oddsHistory: {},
    proposals: [],
    proposalVotes: {},
    activeProposalId: null,
    consensus: null,
    prediction: null,
    bracketDraft: null,
    bracketEditing: false,
    bracketSort: (() => { try { return localStorage.getItem('rift_bracket_sort') || 'net'; } catch { return 'net'; } })(),
    prevRank: (() => { try { return JSON.parse(localStorage.getItem('rift_prev_rank') || 'null'); } catch { return null; } })(),
    whoami: (() => { try { return localStorage.getItem('rift_whoami') || ''; } catch { return ''; } })(),
    matchups: [],
    activeMatchupId: null,
    course: null,
    userId: null,
    picks: {},
    parlay: [],
    es: null,
    refreshAt: nextRefreshAt(),
    firstLoad: true
  };

  function snapshotNow() {
    state.snapshotTallies = JSON.parse(JSON.stringify(state.tallies || {}));
  }

  function $(sel, root = document) { return root.querySelector(sel); }
  function ce(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'data') Object.entries(v).forEach(([dk, dv]) => el.dataset[dk] = dv);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids) {
      if (kid == null || kid === false) continue;
      el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
    return el;
  }

  function getOrCreateUserId() {
    let uid = localStorage.getItem('rift_uid');
    if (!uid) {
      uid = (crypto.randomUUID && crypto.randomUUID()) || (Date.now().toString(36) + Math.random().toString(36).slice(2));
      localStorage.setItem('rift_uid', uid);
    }
    return uid;
  }

  function americanToDecimal(odds) {
    const n = parseInt(String(odds).replace(/[^-\d]/g, ''), 10);
    if (!n) return 1;
    return n > 0 ? 1 + n / 100 : 1 + 100 / Math.abs(n);
  }
  function americanToImplied(odds) {
    const n = parseInt(String(odds).replace(/[^-\d]/g, ''), 10);
    if (!n) return 0;
    return n > 0 ? 100 / (n + 100) : Math.abs(n) / (Math.abs(n) + 100);
  }
  function decimalToAmerican(dec) {
    if (dec <= 1) return '—';
    if (dec >= 2) return '+' + Math.round((dec - 1) * 100);
    return String(Math.round(-100 / (dec - 1)));
  }

  async function loadMe() {
    const stored = localStorage.getItem('rift_uid');
    const r = await fetch('/api/me' + (stored ? '?uid=' + encodeURIComponent(stored) : ''));
    const data = await r.json();
    state.userId = data.userId;
    localStorage.setItem('rift_uid', data.userId);
    state.picks = data.picks || {};
    state.proposalVotes = data.proposalVotes || {};
    state.prediction = data.prediction || null;
    renderProposal();
    renderLeaderboard();
  }

  const STATE_CACHE_KEY = 'rift_state_cache_v1';

  function saveStateCache(data) {
    if (!data || !Array.isArray(data.boards) || data.boards.length === 0) return;
    try {
      localStorage.setItem(STATE_CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
    } catch {}
  }
  function loadStateCache() {
    try {
      const raw = localStorage.getItem(STATE_CACHE_KEY);
      if (!raw) return null;
      const { t, data } = JSON.parse(raw);
      if (!data || !Array.isArray(data.boards) || data.boards.length === 0) return null;
      return { t, data };
    } catch { return null; }
  }

  async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(id);
    }
  }

  async function loadState() {
    diag('fetching /api/state\u2026');
    const r = await fetchWithTimeout('/api/state', { cache: 'no-store' }, 20000);
    if (!r.ok) throw new Error('state http ' + r.status);
    const data = await r.json();
    if (!Array.isArray(data.boards)) throw new Error('state missing boards');
    if (data.boards.length === 0) throw new Error('state returned 0 boards');
    state.boards = data.boards;
    state.tallies = data.tallies || {};
    state.oddsHistory = data.oddsHistory || {};
    state.proposals = data.proposals || [];
    state.consensus = data.consensus || null;
    state.matchups = data.matchups || [];
    state.course = data.course || null;
    if (data.refreshAt) state.refreshAt = data.refreshAt;
    saveStateCache(data);
    snapshotNow();
    diag('loaded ' + data.boards.length + ' boards, rendering\u2026');
    render();
    renderProposal();
    renderLeaderboard();
    renderMatchups();
    renderCourseCard();
    // clear the diag once everything is painted
    setTimeout(function(){ const d = document.getElementById('rift-diag'); if (d) d.remove(); }, 400);
  }

  async function loadStateWithRetry(max = 5) {
    let lastErr;
    for (let i = 0; i < max; i++) {
      try { await loadState(); return; }
      catch (e) {
        lastErr = e;
        const wait = Math.min(8000, 800 * Math.pow(1.6, i));
        await new Promise(r => setTimeout(r, wait));
      }
    }
    throw lastErr;
  }

  function connectStream() {
    if (state.es) { try { state.es.close(); } catch {} }
    const es = new EventSource('/api/stream');
    state.es = es;
    setStatus(true);
    function applyFullState(data, opts) {
      // On a boundary reset, votes and personal picks were wiped server-side.
      // Clear local picks so the up/down button highlights match reality.
      if (opts && opts.celebrate) {
        state.picks = {};
        // Snapshot the OLD consensus rank before overwriting so the
        // leaderboard can show movement arrows this window.
        if (state.consensus && Array.isArray(state.consensus.rank) && state.consensus.rank.length === PLAYERS.length) {
          const snap = {};
          state.consensus.rank.forEach((p, i) => { snap[p] = i + 1; });
          state.prevRank = snap;
          try { localStorage.setItem('rift_prev_rank', JSON.stringify(snap)); } catch {}
        }
      }
      state.boards = data.boards;
      state.tallies = data.tallies || {};
      state.oddsHistory = data.oddsHistory || {};
      state.proposals = data.proposals || state.proposals || [];
      state.consensus = data.consensus || null;
      state.matchups = data.matchups || state.matchups || [];
      state.course = data.course || state.course || null;
      if (data.refreshAt) state.refreshAt = data.refreshAt;
      snapshotNow();
      saveStateCache(data);
      render();
      renderProposal();
      renderLeaderboard();
      renderMatchups();
      renderCourseCard();
      if (opts && opts.celebrate) celebrateBoundary();
    }
    es.addEventListener('snapshot', (e) => {
      try { applyFullState(JSON.parse(e.data)); } catch {}
    });
    es.addEventListener('reset', (e) => {
      try { applyFullState(JSON.parse(e.data), { celebrate: true }); } catch {}
    });
    es.addEventListener('tally', (e) => {
      try {
        const { key, tally } = JSON.parse(e.data);
        state.tallies[key] = tally;
        updateTallyUI(key, tally);
        pingToast(key);
      } catch {}
    });
    es.addEventListener('proposal', (e) => {
      try {
        const { id, tally } = JSON.parse(e.data);
        const p = state.proposals.find(x => x.id === id);
        if (p) { p.tally = tally; renderProposal(); }
      } catch {}
    });
    es.onerror = () => {
      setStatus(false);
      setTimeout(() => { if (state.es === es) connectStream(); }, 3000);
    };
  }

  function setStatus(live) {
    const el = $('#status');
    const txt = $('#status-text');
    if (live) { el.classList.remove('offline'); txt.textContent = 'LIVE'; }
    else { el.classList.add('offline'); txt.textContent = 'RECONNECTING'; }
  }

  function render() {
    const container = $('#boards');
    container.innerHTML = '';
    // Headline strip
    const headline = buildHeadline();
    container.parentNode.insertBefore(headline, container);
    const existing = document.querySelector('.headline');
    if (existing && existing !== headline) existing.remove();

    for (const board of state.boards) {
      container.appendChild(renderBoard(board));
    }
    renderParlay();
    state.firstLoad = false;
  }

  function buildHeadline() {
    const existing = document.querySelector('.headline');
    if (existing) existing.remove();
    const node = ce('div', { class: 'headline' });

    let topSteal = null;
    let topFade = null;
    for (const board of state.boards) {
      for (const line of board.lines) {
        const key = `${board.id}:${line.player}`;
        const t = state.snapshotTallies[key] || { up: 0, down: 0 };
        const net = t.up - t.down;
        if (!topSteal || net > topSteal.net) topSteal = { board, line, net, t };
        if (!topFade || (t.down - t.up) > topFade.net) topFade = { board, line, net: t.down - t.up, t };
      }
    }
    if (topSteal && topSteal.net > 0) {
      node.appendChild(ce('div', { class: 'headline-chip' }, 'BIGGEST STEAL: ',
        ce('strong', {}, `${topSteal.line.player} ${topSteal.line.odds}`),
        ` · ${topSteal.board.title.toLowerCase()} · +${topSteal.net}`));
    }
    if (topFade && topFade.net > 0) {
      node.appendChild(ce('div', { class: 'headline-chip' }, 'BIGGEST TRAP: ',
        ce('strong', {}, `${topFade.line.player} ${topFade.line.odds}`),
        ` · ${topFade.board.title.toLowerCase()} · -${topFade.net}`));
    }
    const streak = getStreak();
    if (streak > 1) {
      node.appendChild(ce('div', { class: 'headline-chip' }, 'YOUR STREAK: ',
        ce('strong', {}, `${streak} DAYS`)));
    }
    return node;
  }

  function renderBoard(board) {
    const el = ce('div', { class: 'board', data: { theme: board.theme } });
    el.appendChild(ce('div', { class: 'board-head' },
      ce('div', { class: 'board-emoji' }, board.emoji),
      ce('div', { class: 'board-title' }, board.title),
      ce('div', { class: 'board-sub' }, board.subtitle)
    ));
    el.appendChild(ce('div', { class: 'board-rule' }));

    // find crowd favorite (highest net votes in this board, frozen at last refresh)
    let crowdFav = null;
    for (const line of board.lines) {
      const key = `${board.id}:${line.player}`;
      const t = state.snapshotTallies[key] || { up: 0, down: 0 };
      const net = t.up - t.down;
      if (net > 0 && (!crowdFav || net > crowdFav.net)) crowdFav = { player: line.player, net };
    }

    board.lines.forEach((line, i) => {
      el.appendChild(renderLine(board, line, i + 1, crowdFav && crowdFav.player === line.player));
    });
    return el;
  }

  function renderLine(board, line, rank, isCrowdFav) {
    const key = `${board.id}:${line.player}`;
    const tally = state.tallies[key] || { up: 0, down: 0 };
    const snap = state.snapshotTallies[key] || { up: 0, down: 0 };
    const myVote = (state.picks && state.picks[key]) || null;
    const selected = state.parlay.some(p => p.key === key);

    const row = ce('div', {
      class: `line${isCrowdFav ? ' crowd-fav' : ''}${selected ? ' parlay-selected' : ''}`,
      data: { key }
    });
    row.appendChild(ce('div', { class: 'line-rank' }, String(rank)));

    const nameEl = ce('button', {
      class: 'line-name', type: 'button',
      'aria-label': `View ${line.player}'s full profile`,
      onclick: (e) => { e.stopPropagation(); openPlayer(line.player); }
    }, line.player);
    row.appendChild(nameEl);

    const history = state.oddsHistory[key] || [];
    row.appendChild(renderSparkline(history));

    const move = moveIndicator(snap);
    const oddsKids = [];
    if (selected) {
      oddsKids.push(ce('span', { class: 'line-odds-check' }, '✓'));
    } else if (line.tag) {
      oddsKids.push(ce('span', { class: `line-tag ${line.tag}` }, line.tag));
    } else {
      oddsKids.push(ce('span', { class: 'line-odds-check' }, '+'));
    }
    oddsKids.push(line.odds);
    if (move && move.nodeType === 1) oddsKids.push(move);
    const oddsEl = ce('button', {
      class: `line-odds${selected ? ' selected' : ''}${line.tag ? ' has-tag' : ''}`, type: 'button',
      'aria-label': selected ? `Remove ${line.player} from parlay` : `Add ${line.player} to parlay`,
      'aria-pressed': selected ? 'true' : 'false',
      onclick: (e) => { e.stopPropagation(); toggleParlay(board, line); }
    }, ...oddsKids);
    row.appendChild(oddsEl);

    const votes = ce('div', { class: 'line-votes' });
    const upBtn = ce('button', {
      class: `vote up${myVote === 'up' ? ' active up' : ''}`,
      title: 'Bet on',
      onclick: (e) => { e.stopPropagation(); castVote(board.id, line.player, myVote === 'up' ? null : 'up'); }
    }, '👍 ', ce('span', { class: 'vote-count' }, String(tally.up || 0)));
    const downBtn = ce('button', {
      class: `vote down${myVote === 'down' ? ' active down' : ''}`,
      title: 'Fade',
      onclick: (e) => { e.stopPropagation(); castVote(board.id, line.player, myVote === 'down' ? null : 'down'); }
    }, '👎 ', ce('span', { class: 'vote-count' }, String(tally.down || 0)));
    votes.appendChild(upBtn);
    votes.appendChild(downBtn);
    row.appendChild(votes);

    return row;
  }

  function renderSparkline(history) {
    const W = 62, H = 18, padX = 2, padY = 3;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'line-sparkline');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('aria-hidden', 'true');

    if (!history || history.length < 2) {
      // placeholder flat dash so columns align
      const dash = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      dash.setAttribute('x1', padX); dash.setAttribute('x2', W - padX);
      dash.setAttribute('y1', H / 2); dash.setAttribute('y2', H / 2);
      dash.setAttribute('stroke', 'currentColor');
      dash.setAttribute('stroke-opacity', '0.25');
      dash.setAttribute('stroke-width', '1');
      dash.setAttribute('stroke-dasharray', '2 2');
      svg.appendChild(dash);
      return svg;
    }

    const probs = history.map(americanToImplied);
    const min = Math.min(...probs);
    const max = Math.max(...probs);
    const range = Math.max(max - min, 0.005);
    const step = (W - padX * 2) / (probs.length - 1);
    const pts = probs.map((p, i) => {
      const x = padX + i * step;
      const y = padY + (1 - (p - min) / range) * (H - padY * 2);
      return [x, y];
    });
    const trend = probs[probs.length - 1] - probs[0];
    const color = Math.abs(trend) < 0.005 ? 'currentColor' : (trend > 0 ? '#4ade80' : '#f87171');

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    poly.setAttribute('points', pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '));
    poly.setAttribute('fill', 'none');
    poly.setAttribute('stroke', color);
    poly.setAttribute('stroke-width', '1.5');
    poly.setAttribute('stroke-linejoin', 'round');
    poly.setAttribute('stroke-linecap', 'round');
    if (Math.abs(trend) < 0.005) poly.setAttribute('stroke-opacity', '0.5');
    svg.appendChild(poly);

    const [lx, ly] = pts[pts.length - 1];
    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx', lx.toFixed(1));
    dot.setAttribute('cy', ly.toFixed(1));
    dot.setAttribute('r', '2');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);
    return svg;
  }

  function moveIndicator(tally) {
    const net = (tally.up || 0) - (tally.down || 0);
    if (Math.abs(net) < 3) return document.createTextNode('');
    if (net >= 3) return ce('span', { class: 'line-move up', title: 'Line moving toward bet-on' }, ' ↑');
    return ce('span', { class: 'line-move down', title: 'Line moving toward fade' }, ' ↓');
  }

  function updateTallyUI(key, tally) {
    const row = document.querySelector(`.line[data-key="${CSS.escape(key)}"]`);
    if (!row) return;
    const [upBtn, downBtn] = row.querySelectorAll('.vote');
    if (upBtn) upBtn.querySelector('.vote-count').textContent = String(tally.up || 0);
    if (downBtn) downBtn.querySelector('.vote-count').textContent = String(tally.down || 0);
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 600);
    // Derived odds signals (movement arrows, crowd favorite, headline) are
    // intentionally not recomputed here — they are frozen until the next refresh.
  }

  async function castVote(boardId, player, vote) {
    const key = `${boardId}:${player}`;
    state.picks[key] = vote;
    updateVoteButtons(key);
    const modal = $('#player-modal');
    const modalOpen = modal && !modal.hidden;
    const modalName = modalOpen ? $('#player-modal-name').textContent : null;
    try {
      const res = await fetch('/api/vote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: state.userId, boardId, player, vote })
      });
      const data = await res.json();
      if (data && data.tally) {
        state.tallies[key] = data.tally;
        updateTallyUI(key, data.tally);
        if (modalOpen && modalName === player) openPlayer(player);
      }
    } catch {
      toast('Offline — vote not saved');
    }
    bumpStreak();
  }

  function updateVoteButtons(key) {
    const row = document.querySelector(`.line[data-key="${CSS.escape(key)}"]`);
    if (!row) return;
    const myVote = state.picks[key] || null;
    const [upBtn, downBtn] = row.querySelectorAll('.vote');
    upBtn.classList.toggle('active', myVote === 'up');
    upBtn.classList.toggle('up', true);
    downBtn.classList.toggle('active', myVote === 'down');
    downBtn.classList.toggle('down', true);
  }

  function toggleParlay(board, line) {
    const key = `${board.id}:${line.player}`;
    const idx = state.parlay.findIndex(p => p.key === key);
    if (idx >= 0) state.parlay.splice(idx, 1);
    else state.parlay.push({ key, boardId: board.id, boardTitle: board.title, player: line.player, odds: line.odds });
    persistParlay();
    render();
  }

  function removeLeg(key) {
    state.parlay = state.parlay.filter(p => p.key !== key);
    persistParlay();
    render();
  }

  function persistParlay() {
    try { localStorage.setItem('rift_parlay', JSON.stringify(state.parlay)); } catch {}
  }
  function loadParlay() {
    try { state.parlay = JSON.parse(localStorage.getItem('rift_parlay') || '[]'); } catch { state.parlay = []; }
  }

  function renderParlay() {
    const legs = $('#parlay-legs');
    const count = $('#parlay-count');
    const payout = $('#parlay-payout');
    const american = $('#parlay-american');
    const mini = $('#parlay-mini');
    const miniCount = $('#parlay-mini-count');
    const miniPay = $('#parlay-mini-pay');
    legs.innerHTML = '';
    if (state.parlay.length === 0) {
      legs.appendChild(ce('div', { class: 'parlay-empty' }, 'Tap a line above to add it to your parlay.'));
      count.textContent = '0';
      payout.textContent = '—';
      american.textContent = '—';
      if (mini) mini.classList.remove('visible');
      return;
    }
    let dec = 1;
    for (const leg of state.parlay) {
      dec *= americanToDecimal(leg.odds);
      legs.appendChild(ce('div', { class: 'parlay-leg' },
        ce('div', { class: 'parlay-leg-title' },
          ce('b', {}, leg.player),
          ce('span', {}, leg.boardTitle)
        ),
        ce('div', { class: 'parlay-leg-odds' }, leg.odds),
        ce('button', { class: 'parlay-leg-remove', title: 'Remove', onclick: () => removeLeg(leg.key) }, '✕')
      ));
    }
    count.textContent = String(state.parlay.length);
    const stake = 100;
    const pay = stake * dec;
    payout.textContent = '$' + pay.toFixed(0);
    american.textContent = decimalToAmerican(dec);
    if (mini) {
      mini.classList.add('visible');
      if (miniCount) miniCount.textContent = String(state.parlay.length);
      if (miniPay) miniPay.textContent = `$100 \u2192 $${pay.toFixed(0)}`;
    }
  }

  function shareParlay() {
    if (state.parlay.length === 0) { toast('Add some legs first'); return; }
    const keys = state.parlay.map(p => p.key).join(',');
    const url = `${location.origin}${location.pathname}#p=${encodeURIComponent(keys)}`;
    navigator.clipboard?.writeText(url).then(
      () => toast('Link copied — paste it in the group chat'),
      () => toast(url)
    );
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  async function renderParlayCanvas() {
    try { await document.fonts.ready; } catch {}

    const W = 1080, H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1c1c22');
    bg.addColorStop(0.5, '#141418');
    bg.addColorStop(1, '#08080a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle radial glow
    const glow = ctx.createRadialGradient(W / 2, H * 0.15, 60, W / 2, H * 0.15, 700);
    glow.addColorStop(0, 'rgba(231,193,107,0.12)');
    glow.addColorStop(1, 'rgba(231,193,107,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Top gold accent bar
    const gold = ctx.createLinearGradient(0, 0, W, 0);
    gold.addColorStop(0, '#e7c16b');
    gold.addColorStop(1, '#b8893f');
    ctx.fillStyle = gold;
    ctx.fillRect(0, 0, W, 14);

    // Logo mark
    const markSize = 96;
    const markX = W / 2 - markSize / 2;
    const markY = 100;
    ctx.fillStyle = gold;
    roundRectPath(ctx, markX, markY, markSize, markSize, 22);
    ctx.fill();
    ctx.fillStyle = '#1a130a';
    ctx.font = "900 56px 'Bebas Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('RO', W / 2, markY + 66);

    // Title
    ctx.fillStyle = '#fff6dd';
    ctx.font = "800 110px 'Bebas Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('THE RIFT OPEN', W / 2, 340);

    ctx.fillStyle = '#9a958b';
    ctx.font = "600 28px 'Inter', Arial, sans-serif";
    ctx.fillText('YEAR V · SPORTSBOOK', W / 2, 385);

    // Divider
    ctx.strokeStyle = 'rgba(231,193,107,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 60, 430);
    ctx.lineTo(W / 2 + 60, 430);
    ctx.stroke();

    ctx.fillStyle = '#e7c16b';
    ctx.font = "800 36px 'Bebas Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('BET SLIP', W / 2, 485);

    // Legs area
    const padX = 80;
    const legsTop = 540;
    const legsBottom = H - 620;
    const availableH = legsBottom - legsTop;
    const showLegs = Math.min(state.parlay.length, 7);
    const legH = Math.min(180, Math.floor(availableH / showLegs));

    let dec = 1;
    for (let i = 0; i < state.parlay.length; i++) {
      dec *= americanToDecimal(state.parlay[i].odds);
    }

    for (let i = 0; i < showLegs; i++) {
      const leg = state.parlay[i];
      const y = legsTop + i * legH;

      // Leg number
      ctx.fillStyle = '#9a958b';
      ctx.font = "700 22px 'Inter', Arial, sans-serif";
      ctx.textAlign = 'left';
      ctx.fillText(`LEG ${i + 1}`, padX, y + 26);

      // Player name
      ctx.fillStyle = '#f4efe6';
      ctx.font = `700 ${Math.min(78, Math.floor(legH * 0.48))}px 'Bebas Neue', Arial, sans-serif`;
      ctx.fillText(leg.player, padX, y + Math.floor(legH * 0.58));

      // Market subtitle
      ctx.fillStyle = '#9a958b';
      ctx.font = "500 26px 'Inter', Arial, sans-serif";
      ctx.fillText(leg.boardTitle, padX, y + Math.floor(legH * 0.58) + 34);

      // Odds pill
      ctx.textAlign = 'right';
      ctx.fillStyle = '#e7c16b';
      ctx.font = `700 ${Math.min(62, Math.floor(legH * 0.38))}px 'Bebas Neue', Arial, sans-serif`;
      ctx.fillText(leg.odds, W - padX, y + Math.floor(legH * 0.62));

      // Divider (skip after last visible leg)
      if (i < showLegs - 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padX, y + legH - 4);
        ctx.lineTo(W - padX, y + legH - 4);
        ctx.stroke();
      }
    }

    if (state.parlay.length > showLegs) {
      const y = legsTop + showLegs * legH;
      ctx.fillStyle = '#9a958b';
      ctx.font = "600 24px 'Inter', Arial, sans-serif";
      ctx.textAlign = 'center';
      ctx.fillText(`+ ${state.parlay.length - showLegs} more leg${state.parlay.length - showLegs === 1 ? '' : 's'}`, W / 2, y + 36);
    }

    // Payout box
    const boxX = padX, boxW = W - padX * 2;
    const boxH = 360;
    const boxY = H - boxH - 140;

    const boxGrad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
    boxGrad.addColorStop(0, '#f2d58a');
    boxGrad.addColorStop(1, '#b8893f');
    ctx.fillStyle = boxGrad;
    roundRectPath(ctx, boxX, boxY, boxW, boxH, 32);
    ctx.fill();

    // $100 PAYS
    ctx.fillStyle = 'rgba(26,19,10,0.7)';
    ctx.font = "800 30px 'Inter', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('$100 PAYS', W / 2, boxY + 76);

    // Payout amount
    const pay = 100 * dec;
    const payStr = '$' + pay.toLocaleString(undefined, { maximumFractionDigits: 0 });
    ctx.fillStyle = '#1a130a';
    ctx.font = "900 190px 'Bebas Neue', Arial, sans-serif";
    ctx.fillText(payStr, W / 2, boxY + 240);

    // Parlay meta
    ctx.fillStyle = 'rgba(26,19,10,0.68)';
    ctx.font = "700 24px 'Inter', Arial, sans-serif";
    ctx.fillText(`PARLAY ${decimalToAmerican(dec)}  ·  ${state.parlay.length} LEG${state.parlay.length === 1 ? '' : 'S'}`, W / 2, boxY + 300);

    // URL footer
    ctx.fillStyle = '#6d675d';
    ctx.font = "600 24px 'Inter', Arial, sans-serif";
    ctx.fillText('rift-open-production.up.railway.app', W / 2, H - 70);

    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png', 0.95);
    });
  }

  async function shareParlayCard() {
    if (state.parlay.length === 0) { toast('Add some legs first'); return; }
    const btn = document.getElementById('parlay-share-card');
    const originalText = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Generating\u2026'; }
    try {
      const blob = await renderParlayCanvas();
      if (!blob) throw new Error('no blob');
      const file = new File([blob], 'rift-open-parlay.png', { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({
            files: [file],
            title: 'My Rift Open Parlay',
            text: 'Bet the board. Fade your friends.'
          });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
          // fall through to download
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'rift-open-parlay.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Image saved — find it in your Photos or Downloads');
    } catch (e) {
      console.error('share card failed', e);
      toast('Couldn\u2019t make the image');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
  }

  async function renderBracketCanvas() {
    try { await document.fonts.ready; } catch {}
    const pred = state.prediction;
    if (!pred || !pred.scores || !pred.beers) return null;

    const W = 1080, H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1c1c22');
    bg.addColorStop(0.5, '#141418');
    bg.addColorStop(1, '#08080a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(W / 2, H * 0.15, 60, W / 2, H * 0.15, 700);
    glow.addColorStop(0, 'rgba(231,193,107,0.12)');
    glow.addColorStop(1, 'rgba(231,193,107,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Top gold bar + RO mark
    const gold = ctx.createLinearGradient(0, 0, W, 0);
    gold.addColorStop(0, '#e7c16b'); gold.addColorStop(1, '#b8893f');
    ctx.fillStyle = gold;
    ctx.fillRect(0, 0, W, 14);

    const markSize = 96, markX = W / 2 - markSize / 2, markY = 100;
    ctx.fillStyle = gold;
    roundRectPath(ctx, markX, markY, markSize, markSize, 22);
    ctx.fill();
    ctx.fillStyle = '#1a130a';
    ctx.font = "900 56px 'Bebas Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('RO', W / 2, markY + 66);

    // Title
    const who = whoamiPretty();
    const kickerName = state.whoami && state.whoami !== 'RAILBIRD' ? who.toUpperCase() + "'S BRACKET" : 'MY BRACKET';
    const headline = state.whoami && state.whoami !== 'RAILBIRD' ? `HERE'S HOW ${who.toUpperCase()} SEES IT` : "HERE'S HOW I SEE IT";
    ctx.fillStyle = '#fff6dd';
    ctx.font = "800 110px 'Bebas Neue', Arial, sans-serif";
    ctx.fillText('THE RIFT OPEN', W / 2, 340);
    ctx.fillStyle = '#9a958b';
    ctx.font = "600 28px 'Inter', Arial, sans-serif";
    ctx.fillText('YEAR V \u00b7 ' + kickerName, W / 2, 385);

    // Divider + section header
    ctx.strokeStyle = 'rgba(231,193,107,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 60, 430); ctx.lineTo(W / 2 + 60, 430);
    ctx.stroke();

    ctx.fillStyle = '#e7c16b';
    ctx.font = "800 44px 'Bebas Neue', Arial, sans-serif";
    ctx.fillText(headline, W / 2, 490);
    ctx.fillStyle = '#9a958b';
    ctx.font = "600 22px 'Inter', Arial, sans-serif";
    ctx.fillText('FADE ME IF YOU DARE \u00b7 1 BEER = \u22121 STROKE', W / 2, 525);

    // Rank rows \u2014 user's own bracket, sorted by THEIR net asc
    const ranked = [...PLAYERS].sort((a, b) => {
      const na = pred.scores[a] - pred.beers[a];
      const nb = pred.scores[b] - pred.beers[b];
      if (na !== nb) return na - nb;
      return pred.beers[a] - pred.beers[b];
    });

    const padX = 80;
    const legsTop = 580;
    const legsBottom = H - 140;
    const legH = Math.floor((legsBottom - legsTop) / ranked.length);

    const NUM_FONT = "800 60px 'Bebas Neue', Arial, sans-serif";
    const NET_FONT = "800 68px 'Bebas Neue', Arial, sans-serif";
    const OP_FONT  = "600 38px 'Inter', Arial, sans-serif";
    const LABEL_FONT = "800 13px 'Inter', Arial, sans-serif";

    ranked.forEach((player, i) => {
      const y = legsTop + i * legH;
      const net = pred.scores[player] - pred.beers[player];
      const isYou = state.whoami && state.whoami === player;
      const numY = y + Math.floor(legH * 0.52);
      const labelY = numY + 26;

      // Rank (left)
      ctx.fillStyle = i === 0 ? '#e7c16b' : '#9a958b';
      ctx.font = i === 0 ? "800 32px 'Inter', Arial, sans-serif" : "700 28px 'Inter', Arial, sans-serif";
      ctx.textAlign = 'left';
      ctx.fillText(String(i + 1), padX, numY);

      // Player (left)
      ctx.fillStyle = i === 0 ? '#fff6dd' : '#f4efe6';
      ctx.font = `700 ${Math.min(50, Math.floor(legH * 0.48))}px 'Bebas Neue', Arial, sans-serif`;
      ctx.fillText(player, padX + 60, numY);

      // "YOU" chip next to the player's own row
      if (isYou) {
        const playerWidth = ctx.measureText(player).width;
        const chipX = padX + 60 + playerWidth + 16;
        const chipY = numY - 30;
        const chipW = 64, chipH = 30;
        ctx.fillStyle = '#e7c16b';
        roundRectPath(ctx, chipX, chipY, chipW, chipH, 6);
        ctx.fill();
        ctx.fillStyle = '#1a130a';
        ctx.font = "800 17px 'Inter', Arial, sans-serif";
        ctx.textAlign = 'center';
        ctx.fillText('YOU', chipX + chipW / 2, chipY + 21);
      }

      // Math cluster on the right: SCORE \u2212 BEERS = NET
      // Laid out right-to-left so the NET number anchors to the right edge.
      let cursor = W - padX;
      const gap = 14;

      // NET (rightmost, biggest, gold)
      ctx.textAlign = 'right';
      ctx.fillStyle = '#e7c16b';
      ctx.font = NET_FONT;
      ctx.fillText(String(net), cursor, numY);
      const netW = ctx.measureText(String(net)).width;
      ctx.fillStyle = 'rgba(231,193,107,0.75)';
      ctx.font = LABEL_FONT;
      ctx.fillText('NET', cursor, labelY);
      cursor -= netW + gap;

      // "="
      ctx.fillStyle = '#6d675d';
      ctx.font = OP_FONT;
      ctx.fillText('=', cursor, numY - 4);
      const eqW = ctx.measureText('=').width;
      cursor -= eqW + gap;

      // BEERS
      ctx.fillStyle = '#d4c188';
      ctx.font = NUM_FONT;
      ctx.fillText(String(pred.beers[player]), cursor, numY);
      const beersW = ctx.measureText(String(pred.beers[player])).width;
      ctx.fillStyle = '#9a958b';
      ctx.font = LABEL_FONT;
      ctx.fillText('BEERS', cursor, labelY);
      cursor -= beersW + gap;

      // "\u2212"
      ctx.fillStyle = '#6d675d';
      ctx.font = OP_FONT;
      ctx.fillText('\u2212', cursor, numY - 4);
      const minusW = ctx.measureText('\u2212').width;
      cursor -= minusW + gap;

      // SCORE (gross)
      ctx.fillStyle = '#f4efe6';
      ctx.font = NUM_FONT;
      ctx.fillText(String(pred.scores[player]), cursor, numY);
      const scoreW = ctx.measureText(String(pred.scores[player])).width;
      ctx.fillStyle = '#9a958b';
      ctx.font = LABEL_FONT;
      ctx.fillText('SCORE', cursor, labelY);

      // Divider
      if (i < ranked.length - 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padX, y + legH - 4); ctx.lineTo(W - padX, y + legH - 4);
        ctx.stroke();
      }
    });

    // URL footer
    ctx.fillStyle = '#6d675d';
    ctx.font = "600 24px 'Inter', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('rift-open-production.up.railway.app', W / 2, H - 70);

    return new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob), 'image/png', 0.95); });
  }

  async function shareBracketCard() {
    if (!state.prediction) { toast('Submit your bracket first'); return; }
    const btn = document.getElementById('leaderboard-share');
    const originalText = btn && btn.textContent;
    if (btn) { btn.disabled = true; btn.textContent = 'Generating\u2026'; }
    try {
      const blob = await renderBracketCanvas();
      if (!blob) throw new Error('no blob');
      const who = whoamiPretty();
      const namePart = (state.whoami && state.whoami !== 'RAILBIRD') ? who.toLowerCase() + '-' : 'my-';
      const file = new File([blob], `rift-open-${namePart}bracket.png`, { type: 'image/png' });
      const title = (state.whoami && state.whoami !== 'RAILBIRD') ? `${who}'s Rift Open Bracket` : 'My Rift Open Bracket';
      const text = (state.whoami && state.whoami !== 'RAILBIRD')
        ? `Here's ${who}'s Rift Open bracket. Fade me.`
        : "Here's my Rift Open bracket. Fade me.";
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({ files: [file], title, text });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rift-open-${namePart}bracket.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Image saved \u2014 find it in your Photos or Downloads');
    } catch (e) {
      console.error('bracket card failed', e);
      toast("Couldn\u2019t make the image");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
  }

  // --- H2H matchup share card ---
  async function renderMatchupCanvas(matchup, draft, winner) {
    try { await document.fonts.ready; } catch {}
    const W = 1080, H = 1920;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    // Background
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1c1c22'); bg.addColorStop(0.5, '#141418'); bg.addColorStop(1, '#08080a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(W / 2, H * 0.18, 60, W / 2, H * 0.18, 700);
    glow.addColorStop(0, 'rgba(231,193,107,0.14)'); glow.addColorStop(1, 'rgba(231,193,107,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

    // Gold bar + logo
    const gold = ctx.createLinearGradient(0, 0, W, 0);
    gold.addColorStop(0, '#e7c16b'); gold.addColorStop(1, '#b8893f');
    ctx.fillStyle = gold; ctx.fillRect(0, 0, W, 14);
    const markSize = 96, markX = W / 2 - markSize / 2, markY = 100;
    ctx.fillStyle = gold; roundRectPath(ctx, markX, markY, markSize, markSize, 22); ctx.fill();
    ctx.fillStyle = '#1a130a';
    ctx.font = "900 56px 'Bebas Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('RO', W / 2, markY + 66);

    // Title
    ctx.fillStyle = '#fff6dd';
    ctx.font = "800 110px 'Bebas Neue', Arial, sans-serif";
    ctx.fillText('THE RIFT OPEN', W / 2, 340);
    ctx.fillStyle = '#9a958b';
    ctx.font = "600 28px 'Inter', Arial, sans-serif";
    ctx.fillText('YEAR V \u00b7 MY CALL', W / 2, 385);

    ctx.strokeStyle = 'rgba(231,193,107,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(W / 2 - 60, 430); ctx.lineTo(W / 2 + 60, 430); ctx.stroke();

    ctx.fillStyle = '#e7c16b';
    ctx.font = "800 44px 'Bebas Neue', Arial, sans-serif";
    ctx.fillText(matchup.kicker || 'HEAD TO HEAD', W / 2, 490);
    if (matchup.blurb) {
      ctx.fillStyle = '#9a958b';
      ctx.font = "500 24px 'Inter', Arial, sans-serif";
      ctx.fillText(matchup.blurb, W / 2, 530);
    }

    // Two side columns
    const colAx = W * 0.28, colBx = W * 0.72;
    const topY = 680;
    const drawSide = (player, d, x, isWinner) => {
      ctx.textAlign = 'center';
      ctx.fillStyle = isWinner ? '#e7c16b' : '#6d675d';
      ctx.font = "800 96px 'Bebas Neue', Arial, sans-serif";
      ctx.fillText(player, x, topY);
      if (d.dnf) {
        // Red DNF chip
        const chipW = 260, chipH = 92, chipX = x - chipW / 2, chipY = topY + 40;
        ctx.fillStyle = '#7a1f1f';
        roundRectPath(ctx, chipX, chipY, chipW, chipH, 16); ctx.fill();
        ctx.fillStyle = '#ffd7d7';
        ctx.font = "800 56px 'Bebas Neue', Arial, sans-serif";
        ctx.fillText('DNF', x, chipY + 65);
        return;
      }
      const net = d.score - d.beers;
      // Score + beers stacked
      ctx.fillStyle = '#f4efe6';
      ctx.font = "700 32px 'Inter', Arial, sans-serif";
      ctx.fillText('SCORE', x, topY + 100);
      ctx.font = "800 80px 'Bebas Neue', Arial, sans-serif";
      ctx.fillStyle = '#fff6dd';
      ctx.fillText(String(d.score), x, topY + 170);

      ctx.fillStyle = '#f4efe6';
      ctx.font = "700 32px 'Inter', Arial, sans-serif";
      ctx.fillText('BEERS', x, topY + 240);
      ctx.font = "800 80px 'Bebas Neue', Arial, sans-serif";
      ctx.fillStyle = '#fff6dd';
      ctx.fillText(String(d.beers), x, topY + 310);

      // Net callout
      const chipW = 300, chipH = 110, chipX = x - chipW / 2, chipY = topY + 370;
      ctx.fillStyle = isWinner ? 'rgba(231,193,107,0.2)' : 'rgba(255,255,255,0.04)';
      roundRectPath(ctx, chipX, chipY, chipW, chipH, 16); ctx.fill();
      ctx.strokeStyle = isWinner ? '#e7c16b' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = isWinner ? 3 : 1;
      roundRectPath(ctx, chipX, chipY, chipW, chipH, 16); ctx.stroke();
      ctx.fillStyle = '#9a958b';
      ctx.font = "700 20px 'Inter', Arial, sans-serif";
      ctx.fillText('NET', x, chipY + 35);
      ctx.fillStyle = isWinner ? '#e7c16b' : '#f4efe6';
      ctx.font = "800 64px 'Bebas Neue', Arial, sans-serif";
      ctx.fillText(String(net), x, chipY + 92);
    };

    drawSide(matchup.a, draft[matchup.a], colAx, winner === 'a');
    drawSide(matchup.b, draft[matchup.b], colBx, winner === 'b');

    // VS badge center
    ctx.fillStyle = '#6d675d';
    ctx.font = "800 80px 'Bebas Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    ctx.fillText('VS', W / 2, topY + 150);

    // Verdict
    ctx.fillStyle = '#e7c16b';
    ctx.font = "800 48px 'Bebas Neue', Arial, sans-serif";
    ctx.textAlign = 'center';
    const verdict = winner
      ? `I GOT ${winner === 'a' ? matchup.a : matchup.b}`
      : 'NO CALL';
    ctx.fillText(verdict, W / 2, H - 280);
    ctx.fillStyle = '#9a958b';
    ctx.font = "600 26px 'Inter', Arial, sans-serif";
    ctx.fillText('FADE ME \u2014 1 BEER = \u22121 STROKE', W / 2, H - 230);

    // URL footer
    ctx.fillStyle = '#6d675d';
    ctx.font = "600 24px 'Inter', Arial, sans-serif";
    ctx.fillText('rift-open-production.up.railway.app', W / 2, H - 70);

    return new Promise((resolve) => { canvas.toBlob((blob) => resolve(blob), 'image/png', 0.95); });
  }

  async function shareMatchupCard(matchupId, draft, winner) {
    const m = state.matchups.find(x => x.id === matchupId);
    if (!m) return;
    try {
      const blob = await renderMatchupCanvas(m, draft, winner);
      if (!blob) throw new Error('no blob');
      const file = new File([blob], `rift-open-${m.a.toLowerCase()}-vs-${m.b.toLowerCase()}.png`, { type: 'image/png' });
      const title = `${m.a} vs ${m.b} \u2014 My Call`;
      const text = `My ${m.a} vs ${m.b} call. Fade me.`;
      if (navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          await navigator.share({ files: [file], title, text });
          return;
        } catch (e) {
          if (e && e.name === 'AbortError') return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Image saved');
    } catch (e) {
      console.error('matchup card failed', e);
      toast("Couldn\u2019t make the image");
    }
  }

  function hydrateFromHash() {
    const m = location.hash.match(/p=([^&]+)/);
    if (!m) return;
    const keys = decodeURIComponent(m[1]).split(',').filter(Boolean);
    if (!keys.length) return;
    const parlay = [];
    for (const key of keys) {
      const [bid, player] = key.split(':');
      const board = state.boards.find(b => b.id === bid);
      if (!board) continue;
      const line = board.lines.find(l => l.player === player);
      if (!line) continue;
      parlay.push({ key, boardId: bid, boardTitle: board.title, player, odds: line.odds });
    }
    if (parlay.length) {
      state.parlay = parlay;
      persistParlay();
    }
  }

  function openPlayer(name) {
    if (!state.boards || state.boards.length === 0) return;
    const modal = $('#player-modal');
    if (!modal) return;
    $('#player-modal-name').textContent = name;
    $('#player-modal-avatar').textContent = (name[0] || '').toUpperCase();
    // Aggregate stat line: how many markets they're favored / longshot in.
    let favCount = 0, longshotCount = 0;
    for (const board of state.boards) {
      if (!board.lines.length) continue;
      if (board.lines[0].player === name) favCount++;
      if (board.lines[board.lines.length - 1].player === name) longshotCount++;
    }
    const sub = [];
    if (favCount) sub.push(`FAV in ${favCount}`);
    if (longshotCount) sub.push(`LONGSHOT in ${longshotCount}`);
    sub.push(`${state.boards.length} MARKETS`);
    $('#player-modal-sub').textContent = sub.join(' · ');

    const body = $('#player-modal-body');
    body.innerHTML = '';
    for (const board of state.boards) {
      const idx = board.lines.findIndex(l => l.player === name);
      if (idx < 0) continue;
      const line = board.lines[idx];
      const rank = idx + 1;
      const key = `${board.id}:${name}`;
      const tally = state.tallies[key] || { up: 0, down: 0 };
      const myVote = (state.picks && state.picks[key]) || null;
      const history = state.oddsHistory[key] || [];

      const alreadyIn = state.parlay.some(p => p.key === key);
      const oddsBox = ce('button', {
        class: `player-market-odds${alreadyIn ? ' selected' : ''}`, type: 'button',
        onclick: (e) => { e.stopPropagation(); toggleParlay(board, line); openPlayer(name); }
      }, ce('span', { class: 'line-odds-check' }, alreadyIn ? '✓' : '+'), line.odds);
      if (line.tag) oddsBox.appendChild(ce('span', { class: `line-tag ${line.tag}` }, line.tag));

      const upBtn = ce('button', {
        class: `vote up${myVote === 'up' ? ' active up' : ''}`, type: 'button',
        onclick: (e) => { e.stopPropagation(); castVote(board.id, name, myVote === 'up' ? null : 'up'); }
      }, '👍 ', ce('span', { class: 'vote-count' }, String(tally.up || 0)));
      const downBtn = ce('button', {
        class: `vote down${myVote === 'down' ? ' active down' : ''}`, type: 'button',
        onclick: (e) => { e.stopPropagation(); castVote(board.id, name, myVote === 'down' ? null : 'down'); }
      }, '👎 ', ce('span', { class: 'vote-count' }, String(tally.down || 0)));

      const market = ce('div', { class: 'player-market' },
        ce('div', { class: 'player-market-head' },
          ce('div', { class: 'player-market-emoji' }, board.emoji),
          ce('div', { class: 'player-market-title' }, board.title)
        ),
        oddsBox,
        ce('div', { class: 'player-market-foot' },
          renderSparkline(history),
          ce('div', { class: 'player-market-rank' }, `#${rank} of ${board.lines.length}`),
          ce('div', { class: 'line-votes' }, upBtn, downBtn)
        )
      );
      body.appendChild(market);
    }
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function buildProposalBanner(p) {
    const tally = p.tally || { yes: 0, no: 0 };
    const total = tally.yes + tally.no;
    const myVote = (state.proposalVotes || {})[p.id] || null;
    const pct = total > 0 ? Math.round((tally.yes / total) * 100) : 0;

    const btn = document.createElement('button');
    btn.className = 'proposal-banner' + (myVote ? ' voted' : '');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Open ballot: ' + p.title);
    btn.addEventListener('click', () => openProposal(p.id));

    const kicker = document.createElement('div');
    kicker.className = 'proposal-banner-kicker';
    kicker.textContent = p.kicker || 'OFFICIAL RULING';
    btn.appendChild(kicker);

    const body = document.createElement('div');
    body.className = 'proposal-banner-body';
    const title = document.createElement('div');
    title.className = 'proposal-banner-title';
    title.textContent = p.title;
    body.appendChild(title);

    const tallyEl = document.createElement('div');
    tallyEl.className = 'proposal-banner-tally';
    if (myVote) {
      tallyEl.appendChild(document.createTextNode('YOU VOTED '));
      const b = document.createElement('b'); b.textContent = myVote.toUpperCase(); tallyEl.appendChild(b);
      tallyEl.appendChild(document.createTextNode(` · ${total} BALLOT${total === 1 ? '' : 'S'} · ${pct}% YES`));
    } else {
      tallyEl.textContent = `${total} BALLOT${total === 1 ? '' : 'S'} CAST · ${pct}% YES`;
    }
    body.appendChild(tallyEl);
    btn.appendChild(body);

    const cta = document.createElement('div');
    cta.className = 'proposal-banner-cta';
    cta.textContent = myVote ? 'CHANGE' : 'VOTE';
    btn.appendChild(cta);

    return btn;
  }

  function renderProposal() {
    const container = $('#proposal-banners');
    const dotsEl = $('#proposal-dots');
    if (!container) return;
    container.innerHTML = '';
    const proposals = state.proposals || [];
    for (const p of proposals) {
      container.appendChild(buildProposalBanner(p));
    }
    if (dotsEl) {
      dotsEl.innerHTML = '';
      if (proposals.length > 1) {
        dotsEl.hidden = false;
        proposals.forEach((p, i) => {
          const dot = document.createElement('button');
          dot.type = 'button';
          dot.className = 'proposal-dot' + (i === 0 ? ' active' : '');
          dot.setAttribute('aria-label', 'Ballot ' + (i + 1));
          dot.addEventListener('click', () => {
            const target = container.children[i];
            if (target) target.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
          });
          dotsEl.appendChild(dot);
        });
      } else {
        dotsEl.hidden = true;
      }
    }
    setupCarouselTracking();
    // If a modal is already open for a proposal that still exists, refresh it.
    if (state.activeProposalId && proposals.some(p => p.id === state.activeProposalId)) {
      const modal = $('#proposal-modal');
      if (modal && !modal.hidden) openProposal(state.activeProposalId);
    }
  }

  let carouselScrollTimer = null;
  function setupCarouselTracking() {
    const container = $('#proposal-banners');
    const dotsEl = $('#proposal-dots');
    if (!container || !dotsEl) return;
    if (container.__riftTracked) return;
    container.__riftTracked = true;
    container.addEventListener('scroll', () => {
      clearTimeout(carouselScrollTimer);
      carouselScrollTimer = setTimeout(() => {
        const center = container.scrollLeft + container.clientWidth / 2;
        const banners = container.children;
        let closest = 0, minDist = Infinity;
        for (let i = 0; i < banners.length; i++) {
          const b = banners[i];
          const bCenter = b.offsetLeft + b.offsetWidth / 2;
          const dist = Math.abs(center - bCenter);
          if (dist < minDist) { minDist = dist; closest = i; }
        }
        const dots = dotsEl.children;
        for (let i = 0; i < dots.length; i++) {
          dots[i].classList.toggle('active', i === closest);
        }
      }, 40);
    }, { passive: true });
  }

  function openProposal(id) {
    const p = state.proposals.find(x => x.id === id) || state.proposals[0];
    if (!p) return;
    state.activeProposalId = p.id;
    const modal = $('#proposal-modal');
    if (!modal) return;
    const tally = p.tally || { yes: 0, no: 0 };
    const myVote = (state.proposalVotes || {})[p.id] || null;
    $('#proposal-modal-emoji').textContent = p.emoji || '🗳️';
    $('#proposal-modal-kicker').textContent = p.kicker || 'OFFICIAL RULING';
    $('#proposal-modal-title').textContent = p.title;
    $('#proposal-modal-sub').textContent = p.subtitle || '';
    $('#proposal-yes-label').textContent = p.yesLabel || 'YES';
    $('#proposal-no-label').textContent = p.noLabel || 'NO';
    const yesBlurbEl = $('#proposal-yes-blurb');
    const noBlurbEl = $('#proposal-no-blurb');
    yesBlurbEl.textContent = p.yesBlurb || '';
    noBlurbEl.textContent = p.noBlurb || '';
    yesBlurbEl.style.display = p.yesBlurb ? '' : 'none';
    noBlurbEl.style.display = p.noBlurb ? '' : 'none';
    $('#proposal-yes-tally').textContent = String(tally.yes || 0);
    $('#proposal-no-tally').textContent = String(tally.no || 0);
    $('#proposal-yes').classList.toggle('selected', myVote === 'yes');
    $('#proposal-no').classList.toggle('selected', myVote === 'no');
    const meta = $('#proposal-modal-meta');
    meta.textContent = myVote ? `Tap again to undo your ${myVote.toUpperCase()} vote` : 'One vote per person. You can change it anytime.';
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeProposal() {
    const modal = $('#proposal-modal');
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    state.activeProposalId = null;
  }

  async function castProposalVote(proposalId, vote) {
    const current = (state.proposalVotes || {})[proposalId] || null;
    const next = current === vote ? null : vote; // toggle off if re-tap
    state.proposalVotes = state.proposalVotes || {};
    if (next === null) delete state.proposalVotes[proposalId];
    else state.proposalVotes[proposalId] = next;
    renderProposal();
    openProposal(proposalId);
    try {
      const res = await fetch('/api/proposal-vote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: state.userId, proposalId, vote: next })
      });
      const data = await res.json();
      if (data && data.tally) {
        const p = state.proposals.find(x => x.id === proposalId);
        if (p) p.tally = data.tally;
        renderProposal();
        openProposal(proposalId);
      }
    } catch {
      toast('Offline — vote not saved');
    }
  }

  // --- Crowd Leaderboard ---

  function loadBracketDraft() {
    try {
      const raw = localStorage.getItem(BRACKET_DRAFT_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (!d || !d.scores || !d.beers) return null;
      return d;
    } catch { return null; }
  }
  function saveBracketDraft(draft) {
    try { localStorage.setItem(BRACKET_DRAFT_KEY, JSON.stringify(draft)); } catch {}
  }
  function clearBracketDraft() {
    try { localStorage.removeItem(BRACKET_DRAFT_KEY); } catch {}
  }

  function hydrateBracketDraft() {
    const draft = loadBracketDraft();
    if (draft && draft.scores && draft.beers) {
      if (!draft.dnf) draft.dnf = {};
      return draft;
    }
    if (state.prediction && state.prediction.scores && state.prediction.beers) {
      return {
        scores: { ...state.prediction.scores },
        beers: { ...state.prediction.beers },
        dnf:    { ...(state.prediction.dnf || {}) }
      };
    }
    const scores = {}, beers = {};
    for (const p of PLAYERS) { scores[p] = DEFAULT_PAR; beers[p] = 0; }
    return { scores, beers, dnf: {} };
  }

  function netOf(p, scores, beers) {
    return (scores[p] || 0) - (beers[p] || 0);
  }

  function clampScore(n)  { return Math.max(55, Math.min(140, Math.round(n))); }
  function clampBeers(n)  { return Math.max(0, Math.min(50, Math.round(n))); }

  function formatMinsAgo(ts) {
    if (!ts) return '';
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'just now';
    const secs = Math.floor(diffMs / 1000);
    if (secs < 30) return 'just now';
    if (secs < 60) return secs + 's ago';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    return hrs + 'h ago';
  }

  function whoamiPretty() {
    const map = {
      MURPH: 'Murph', MAX: 'Max', MANGO: 'Mango', PATTY: 'Patty', HIPPIE: 'Hippie',
      PICKLE: 'Pickle', RYAN: 'Ryan', PARKER: 'Parker', DAN: 'Dan', HOAG: 'Hoag',
      REESE: 'Reese', RAILBIRD: 'Rail bird'
    };
    return map[state.whoami] || '';
  }

  function enterBracketEdit() {
    if (state.bracketEditing) return;
    state.bracketEditing = true;
    state.bracketDraft = hydrateBracketDraft();
    renderLeaderboard();
    // Scroll the section into view so the user can see the steppers
    const section = $('#leaderboard');
    if (section && section.scrollIntoView) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderLeaderboard() {
    const section = $('#leaderboard');
    if (!section) return;
    const editBtn = $('#leaderboard-edit');
    const shareBtn = $('#leaderboard-share');
    if (state.bracketEditing) {
      renderBracketEditor();
      if (editBtn) editBtn.textContent = 'Save bracket';
      if (shareBtn) shareBtn.hidden = true;
    } else {
      renderLeaderboardConsensus();
      if (editBtn) editBtn.textContent = state.prediction ? 'Edit my bracket' : 'Submit my bracket';
      if (shareBtn) shareBtn.hidden = !state.prediction;
    }
  }

  function renderLeaderboardConsensus() {
    const rowsEl = $('#leaderboard-rows');
    const subEl = $('#leaderboard-sub');
    const metaEl = $('#leaderboard-meta');
    const sortEl = $('#leaderboard-sort');
    if (!rowsEl) return;
    rowsEl.classList.remove('editing');
    rowsEl.innerHTML = '';
    const c = state.consensus;

    // Sort tabs only visible when there's data
    if (sortEl) sortEl.hidden = !c;
    if (sortEl) {
      for (const btn of sortEl.querySelectorAll('button[data-sort]')) {
        btn.classList.toggle('active', btn.dataset.sort === state.bracketSort);
      }
    }

    if (!c) {
      if (subEl) subEl.textContent = 'Tap any row to submit your bracket';
      if (metaEl) metaEl.textContent = '';
      // Render 10 placeholder rows — each row enters edit mode on tap
      PLAYERS.forEach((player, i) => {
        const row = ce('button', {
          class: 'leaderboard-row tappable', type: 'button',
          onclick: () => enterBracketEdit()
        },
          ce('div', { class: 'leaderboard-rank' }, String(i + 1)),
          ce('div', { class: 'leaderboard-player' }, player),
          ce('div', { class: 'leaderboard-stat empty' }, ce('span', { class: 'leaderboard-stat-label' }, 'NET'), '—'),
          ce('div', { class: 'leaderboard-stat empty' }, ce('span', { class: 'leaderboard-stat-label' }, 'SCORE'), '—'),
          ce('div', { class: 'leaderboard-stat empty' }, ce('span', { class: 'leaderboard-stat-label' }, 'BEERS'), '—')
        );
        rowsEl.appendChild(row);
      });
      return;
    }

    const sortMode = state.bracketSort || 'net';
    // Null-aware comparator — nulls sink to bottom.
    const cmpNum = (x, y) => {
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return x - y;
    };
    const ranked = sortMode === 'net'
      // Server already sorted this for us (null-aware, with tiebreaks).
      ? c.rank.slice()
      : [...PLAYERS].sort((a, b) => {
          if (sortMode === 'score') {
            const d = cmpNum(c.averageScore[a], c.averageScore[b]);
            return d !== 0 ? d : cmpNum(c.averageBeers[a], c.averageBeers[b]);
          } else {
            const d = cmpNum(c.averageBeers[b], c.averageBeers[a]); // DESC
            return d !== 0 ? d : cmpNum(c.averageNet[a], c.averageNet[b]);
          }
        });

    // Movement arrows only make sense for the canonical NET ranking.
    const showMovement = sortMode === 'net' && state.prevRank && Object.keys(state.prevRank).length > 0;

    ranked.forEach((player, i) => {
      const currentRank = i + 1;
      const fmt = n => (Number.isFinite(n) ? n.toFixed(1) : '—');
      const netCls = 'leaderboard-stat' + (sortMode === 'net' ? ' primary' : '');
      const scoreCls = 'leaderboard-stat' + (sortMode === 'score' ? ' primary' : '');
      const beersCls = 'leaderboard-stat' + (sortMode === 'beers' ? ' primary' : '');

      // Rank cell — optionally decorated with a movement indicator
      const rankKids = [document.createTextNode(String(currentRank))];
      if (showMovement) {
        const prev = state.prevRank[player];
        if (Number.isInteger(prev)) {
          const delta = prev - currentRank; // positive = moved up, negative = moved down
          if (delta > 0) {
            rankKids.push(ce('span', { class: 'leaderboard-move up', title: `Moved up ${delta}` }, '↑' + delta));
          } else if (delta < 0) {
            rankKids.push(ce('span', { class: 'leaderboard-move down', title: `Moved down ${-delta}` }, '↓' + (-delta)));
          }
        }
      }

      const isYou = state.whoami && state.whoami === player;
      const playerKids = [document.createTextNode(player)];
      if (isYou) playerKids.push(ce('span', { class: 'leaderboard-you' }, 'YOU'));
      const row = ce('button', {
        class: 'leaderboard-row tappable' + (isYou ? ' is-you' : ''), type: 'button',
        onclick: () => enterBracketEdit()
      },
        ce('div', { class: 'leaderboard-rank' }, ...rankKids),
        ce('div', { class: 'leaderboard-player' }, ...playerKids),
        ce('div', { class: netCls }, ce('span', { class: 'leaderboard-stat-label' }, 'NET'), fmt(c.averageNet[player])),
        ce('div', { class: scoreCls }, ce('span', { class: 'leaderboard-stat-label' }, 'SCORE'), fmt(c.averageScore[player])),
        ce('div', { class: beersCls }, ce('span', { class: 'leaderboard-stat-label' }, 'BEERS'), fmt(c.averageBeers[player]))
      );
      rowsEl.appendChild(row);
    });

    if (subEl) subEl.textContent = `${c.submissionCount} BRACKET${c.submissionCount === 1 ? '' : 'S'} SUBMITTED`;
    if (metaEl) metaEl.textContent = 'Updated ' + formatMinsAgo(c.computedAt) + ' · refreshes every 5 minutes';
  }

  function renderBracketEditor() {
    const rowsEl = $('#leaderboard-rows');
    const subEl = $('#leaderboard-sub');
    const metaEl = $('#leaderboard-meta');
    const sortEl = $('#leaderboard-sort');
    if (!rowsEl) return;
    if (sortEl) sortEl.hidden = true;
    rowsEl.classList.add('editing');
    rowsEl.innerHTML = '';

    if (!state.bracketDraft) state.bracketDraft = hydrateBracketDraft();
    const draft = state.bracketDraft;

    // During edit, keep rows in canonical PLAYERS order — re-sorting while
    // the user is tapping inputs would move steppers out from under their
    // finger. Final crowd-sort happens after save, in display mode.

    if (subEl) subEl.textContent = 'Par ' + DEFAULT_PAR + ' · 1 beer = −1 stroke · tap save when done';
    if (metaEl) metaEl.textContent = '';

    PLAYERS.forEach((player, i) => {
      const isDnf = !!(draft.dnf && draft.dnf[player]);
      const scoreInput = buildNumericField('SCORE', draft.scores[player], (next) => {
        draft.scores[player] = clampScore(next);
        saveBracketDraft(draft);
        updateBracketRowNet(player);
      }, 55, 140);
      const beersInput = buildNumericField('BEERS', draft.beers[player], (next) => {
        draft.beers[player] = clampBeers(next);
        saveBracketDraft(draft);
        updateBracketRowNet(player);
      }, 0, 50);
      if (isDnf) {
        // Lock inputs when DNF is active.
        scoreInput.querySelector('input').disabled = true;
        beersInput.querySelector('input').disabled = true;
      }
      const playerCell = ce('div', { class: 'leaderboard-player' }, player);
      if (player === 'PARKER') {
        // Running-gag DNF checkbox — only Parker gets one.
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.id = 'parker-dnf-cb';
        cb.checked = isDnf;
        cb.addEventListener('change', () => {
          if (!draft.dnf) draft.dnf = {};
          draft.dnf.PARKER = cb.checked;
          if (cb.checked) { draft.scores.PARKER = 0; draft.beers.PARKER = 0; }
          else { if (draft.scores.PARKER === 0) draft.scores.PARKER = DEFAULT_PAR; }
          saveBracketDraft(draft);
          renderBracketEditor();
        });
        const label = ce('label', { class: 'dnf-toggle', for: 'parker-dnf-cb' }, cb, ' DNF');
        playerCell.appendChild(label);
      }
      const row = ce('div', {
        class: 'leaderboard-row' + (isDnf ? ' is-dnf' : ''), data: { player }
      },
        ce('div', { class: 'leaderboard-rank' }, String(i + 1)),
        playerCell,
        ce('div', { class: 'leaderboard-net', title: 'Net (score minus beers)' },
          isDnf ? ce('span', { class: 'dnf-chip' }, 'DNF') : String(netOf(player, draft.scores, draft.beers))
        ),
        ce('div', { class: 'leaderboard-inputs' }, scoreInput, beersInput)
      );
      rowsEl.appendChild(row);
    });
  }

  function updateBracketRowNet(player) {
    const draft = state.bracketDraft;
    if (!draft) return;
    const row = document.querySelector(`.leaderboard-row[data-player="${CSS.escape(player)}"]`);
    if (!row) return;
    const netEl = row.querySelector('.leaderboard-net');
    if (netEl) netEl.textContent = String(netOf(player, draft.scores, draft.beers));
  }

  function buildNumericField(label, value, onChange, min, max) {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.pattern = '[0-9]*';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.className = 'stepper-value';
    input.setAttribute('aria-label', label);
    const commit = () => {
      const parsed = parseInt(input.value, 10);
      if (Number.isFinite(parsed)) onChange(parsed);
      else onChange(value);
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    });
    // Tap to focus selects the current value so typing replaces it immediately
    input.addEventListener('focus', () => { try { input.select(); } catch {} });
    return ce('label', { class: 'stepper' },
      ce('span', { class: 'stepper-label' }, label),
      input
    );
  }

  async function submitBracket() {
    if (!state.bracketDraft) return;
    try {
      const res = await fetchWithTimeout('/api/prediction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: state.userId, scores: state.bracketDraft.scores, beers: state.bracketDraft.beers, dnf: state.bracketDraft.dnf || {} })
      }, 15000);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast(data.error ? 'Error: ' + data.error : 'Submit failed');
        return false;
      }
      state.prediction = data.prediction;
      state.bracketDraft = null;
      clearBracketDraft();
      toast('Bracket submitted — see you at the next refresh');
      return true;
    } catch (e) {
      toast('Offline — try again in a sec');
      return false;
    }
  }

  // --- Head-to-head matchups (derived from the shared prediction store) ---

  function deriveUserPick(prediction, a, b) {
    if (!prediction || !prediction.scores || !prediction.beers) return null;
    const dnf = prediction.dnf || {};
    const dnfA = !!dnf[a], dnfB = !!dnf[b];
    if (dnfA && !dnfB) return 'b';
    if (dnfB && !dnfA) return 'a';
    if (dnfA && dnfB) return null;
    const netA = prediction.scores[a] - prediction.beers[a];
    const netB = prediction.scores[b] - prediction.beers[b];
    if (netA < netB) return 'a';
    if (netB < netA) return 'b';
    if (prediction.beers[a] < prediction.beers[b]) return 'a';
    if (prediction.beers[b] < prediction.beers[a]) return 'b';
    return a < b ? 'a' : 'b';
  }

  function myMatchupPick(a, b) {
    return deriveUserPick(state.prediction, a, b);
  }

  function formatPlayerDisplay(player, prediction, field /* 'score'|'beers'|'net' */) {
    if (!prediction) return '—';
    const dnf = (prediction.dnf || {})[player];
    if (dnf) return 'DNF';
    const s = prediction.scores && prediction.scores[player];
    const b = prediction.beers && prediction.beers[player];
    if (field === 'score') return Number.isFinite(s) ? String(s) : '—';
    if (field === 'beers') return Number.isFinite(b) ? String(b) : '—';
    if (field === 'net') return (Number.isFinite(s) && Number.isFinite(b)) ? String(s - b) : '—';
    return '—';
  }

  function renderMatchups() {
    const listEl = $('#matchups-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!state.matchups || state.matchups.length === 0) return;
    for (const m of state.matchups) {
      const isActive = state.activeMatchupId === m.id;
      const card = ce('div', {
        class: 'matchup-card' + (isActive ? ' expanded' : ''),
        data: { matchupId: m.id }
      });
      card.appendChild(buildMatchupTeaser(m));
      if (isActive) card.appendChild(buildMatchupPane(m));
      listEl.appendChild(card);
    }
  }

  function buildMatchupTeaser(m) {
    const total = (m.tally.a || 0) + (m.tally.b || 0);
    const pctA = total > 0 ? Math.round((m.tally.a / total) * 100) : 50;
    const pctB = total > 0 ? 100 - pctA : 50;
    const myPick = myMatchupPick(m.a, m.b);
    const myLabel = myPick === 'a' ? m.a : myPick === 'b' ? m.b : null;

    const teaser = ce('button', {
      class: 'matchup-teaser', type: 'button',
      onclick: () => toggleMatchupExpand(m.id)
    },
      ce('div', { class: 'matchup-card-kicker' }, m.kicker || 'HEAD TO HEAD'),
      ce('div', { class: 'matchup-sides' },
        ce('div', { class: 'matchup-side a' + (myPick === 'a' ? ' mine' : '') },
          ce('div', { class: 'matchup-player' }, m.a),
          ce('div', { class: 'matchup-pct' }, pctA + '%')
        ),
        ce('div', { class: 'matchup-vs' }, 'VS'),
        ce('div', { class: 'matchup-side b' + (myPick === 'b' ? ' mine' : '') },
          ce('div', { class: 'matchup-player' }, m.b),
          ce('div', { class: 'matchup-pct' }, pctB + '%')
        )
      ),
      ce('div', { class: 'matchup-bar' },
        ce('div', { class: 'matchup-bar-fill', style: 'width:' + pctA + '%' })
      ),
      ce('div', { class: 'matchup-meta' },
        total === 0 ? 'No picks yet — tap to cast yours'
          : (total + (total === 1 ? ' pick' : ' picks'))
            + (myLabel ? ' · your call: ' + myLabel : ' · tap to cast yours')
      )
    );
    return teaser;
  }

  function buildMatchupPane(m) {
    // Default each side from the user's existing bracket prediction, or 70/0.
    const p = state.prediction;
    const getDefaultScore = (pl) => (p && p.scores && Number.isFinite(p.scores[pl])) ? p.scores[pl] : 70;
    const getDefaultBeers = (pl) => (p && p.beers && Number.isFinite(p.beers[pl])) ? p.beers[pl] : 0;
    const getDefaultDnf   = (pl) => !!(p && p.dnf && p.dnf[pl]);

    const draft = {
      [m.a]: { score: getDefaultScore(m.a), beers: getDefaultBeers(m.a), dnf: getDefaultDnf(m.a) },
      [m.b]: { score: getDefaultScore(m.b), beers: getDefaultBeers(m.b), dnf: getDefaultDnf(m.b) }
    };

    const pane = ce('div', { class: 'matchup-pane' });

    const renderPane = () => {
      pane.innerHTML = '';
      pane.appendChild(buildPaneBody(m, draft, renderPane));
    };
    renderPane();
    return pane;
  }

  function buildPaneBody(m, draft, rerender) {
    const blurb = m.blurb ? ce('div', { class: 'matchup-pane-blurb' }, m.blurb) : null;

    const netA = draft[m.a].dnf ? Infinity : draft[m.a].score - draft[m.a].beers;
    const netB = draft[m.b].dnf ? Infinity : draft[m.b].score - draft[m.b].beers;
    let winner = null;
    if (netA === Infinity && netB === Infinity) winner = null;
    else if (netA < netB) winner = 'a';
    else if (netB < netA) winner = 'b';
    else if (draft[m.a].beers < draft[m.b].beers) winner = 'a';
    else if (draft[m.b].beers < draft[m.a].beers) winner = 'b';
    else winner = m.a < m.b ? 'a' : 'b';

    const sideBlock = (side, key) => {
      const d = draft[key];
      const mine = winner === side && !(draft[m.a].dnf && draft[m.b].dnf);
      const dnfToggleAllowed = (key === 'PARKER');
      const children = [
        ce('div', { class: 'pane-player' + (mine ? ' mine' : ''), }, key),
      ];
      if (dnfToggleAllowed) {
        const dnfLabel = ce('label', { class: 'pane-dnf' });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!d.dnf;
        cb.addEventListener('change', () => {
          d.dnf = cb.checked;
          if (d.dnf) { d.score = 0; d.beers = 0; }
          else { if (d.score === 0) d.score = 70; }
          rerender();
        });
        dnfLabel.appendChild(cb);
        dnfLabel.appendChild(document.createTextNode(' DNF'));
        children.push(dnfLabel);
      }
      if (!d.dnf) {
        children.push(ce('div', { class: 'pane-fields' },
          buildPaneNumericField('SCORE', d.score, (next) => {
            d.score = Math.max(55, Math.min(140, Math.round(next)));
            rerender();
          }, 55, 140),
          buildPaneNumericField('BEERS', d.beers, (next) => {
            d.beers = Math.max(0, Math.min(50, Math.round(next)));
            rerender();
          }, 0, 50)
        ));
        const net = d.score - d.beers;
        children.push(ce('div', { class: 'pane-net' + (mine ? ' mine' : '') }, 'NET ' + net));
      } else {
        children.push(ce('div', { class: 'pane-dnf-flag' }, 'DNF — scratched last year'));
      }
      return ce('div', { class: 'pane-side ' + side }, ...children);
    };

    const verdictText = (() => {
      if (draft[m.a].dnf && draft[m.b].dnf) return 'Both DNF — no call';
      if (draft[m.a].dnf) return `${m.b} wins — ${m.a} DNF`;
      if (draft[m.b].dnf) return `${m.a} wins — ${m.b} DNF`;
      const diff = Math.abs(netA - netB);
      const winnerName = winner === 'a' ? m.a : m.b;
      if (diff === 0) return `Tied — tiebreaker: ${winnerName}`;
      return `You pick ${winnerName} — lower net by ${diff}`;
    })();

    const actions = ce('div', { class: 'pane-actions' },
      ce('button', {
        class: 'pane-save', type: 'button',
        onclick: () => saveMatchupEdits(m.id, draft)
      }, 'Save my call'),
      ce('button', {
        class: 'pane-share', type: 'button',
        onclick: () => shareMatchupCard(m.id, draft, winner)
      }, '📸 Share')
    );

    const body = ce('div', { class: 'pane-body' });
    if (blurb) body.appendChild(blurb);
    body.appendChild(ce('div', { class: 'pane-columns' },
      sideBlock('a', m.a),
      sideBlock('b', m.b)
    ));
    body.appendChild(ce('div', { class: 'pane-verdict' }, verdictText));
    body.appendChild(actions);
    return body;
  }

  function buildPaneNumericField(label, value, onChange, min, max) {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'numeric';
    input.pattern = '[0-9]*';
    input.min = String(min);
    input.max = String(max);
    input.value = String(value);
    input.className = 'stepper-value';
    input.setAttribute('aria-label', label);
    const commit = () => {
      const parsed = parseInt(input.value, 10);
      if (Number.isFinite(parsed)) onChange(parsed);
      else onChange(value);
    };
    input.addEventListener('change', commit);
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    });
    input.addEventListener('focus', () => { try { input.select(); } catch {} });
    return ce('label', { class: 'stepper' },
      ce('span', { class: 'stepper-label' }, label),
      input
    );
  }

  function toggleMatchupExpand(id) {
    state.activeMatchupId = state.activeMatchupId === id ? null : id;
    renderMatchups();
  }

  async function saveMatchupEdits(matchupId, draft) {
    const m = state.matchups.find(x => x.id === matchupId);
    if (!m) return;
    const partial = {
      userId: state.userId,
      scores: {
        [m.a]: draft[m.a].dnf ? 0 : draft[m.a].score,
        [m.b]: draft[m.b].dnf ? 0 : draft[m.b].score
      },
      beers: {
        [m.a]: draft[m.a].dnf ? 0 : draft[m.a].beers,
        [m.b]: draft[m.b].dnf ? 0 : draft[m.b].beers
      },
      dnf: {
        [m.a]: !!draft[m.a].dnf,
        [m.b]: !!draft[m.b].dnf
      }
    };
    try {
      const res = await fetchWithTimeout('/api/prediction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(partial)
      }, 15000);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast(data.error ? 'Error: ' + data.error : 'Save failed');
        return;
      }
      state.prediction = data.prediction;
      toast('Saved — ' + m.a + ' vs ' + m.b);
      state.activeMatchupId = null;
      // Refresh leaderboard consensus view with new numbers (tally updates at next boundary).
      renderLeaderboard();
      renderMatchups();
    } catch (e) {
      toast('Offline — try again');
    }
  }

  // --- Course reference card (static, from data/course.json) ---
  function renderCourseCard() {
    const root = document.getElementById('course-card');
    const summary = document.getElementById('course-summary');
    const body = document.getElementById('course-body');
    if (!root || !body || !summary) return;
    const c = state.course;
    if (!c || !Array.isArray(c.holes) || c.holes.length === 0) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const teeName = (c.tee && c.tee.name) || '';
    const totalYd = (c.tee && c.tee.totalYards) || c.holes.reduce((s, h) => s + (h.yardage || 0), 0);
    const par = c.totalPar || c.holes.reduce((s, h) => s + (h.par || 0), 0);
    summary.textContent = `${(c.courseName || c.clubName || 'Course').toUpperCase()} · ${teeName.toUpperCase()} · ${totalYd.toLocaleString()} YD · PAR ${par}`;

    body.innerHTML = '';
    const teeChip = ce('div', { class: 'course-tee-chip' },
      teeName ? teeName.toUpperCase() + ' TEES' : 'TEES',
      c.tee && c.tee.rating && c.tee.slope ? ce('span', {}, ` · ${c.tee.rating}/${c.tee.slope}`) : ''
    );
    body.appendChild(teeChip);

    const buildNineGrid = (holes, label) => {
      const grid = ce('div', { class: 'course-nine' },
        ce('div', { class: 'course-nine-label' }, label)
      );
      const head = ce('div', { class: 'course-row course-row-head' },
        ce('div', { class: 'course-cell hole' }, 'Hole'),
        ce('div', { class: 'course-cell par' }, 'Par'),
        ce('div', { class: 'course-cell yd' }, 'Yd'),
        ce('div', { class: 'course-cell hdcp' }, 'Hdcp')
      );
      grid.appendChild(head);
      for (const h of holes) {
        grid.appendChild(ce('div', { class: 'course-row' },
          ce('div', { class: 'course-cell hole' }, String(h.num)),
          ce('div', { class: 'course-cell par' }, String(h.par)),
          ce('div', { class: 'course-cell yd' }, String(h.yardage)),
          ce('div', { class: 'course-cell hdcp' }, String(h.handicap))
        ));
      }
      const totalPar = holes.reduce((s, h) => s + (h.par || 0), 0);
      const totalYd = holes.reduce((s, h) => s + (h.yardage || 0), 0);
      grid.appendChild(ce('div', { class: 'course-row course-row-total' },
        ce('div', { class: 'course-cell hole' }, label),
        ce('div', { class: 'course-cell par' }, String(totalPar)),
        ce('div', { class: 'course-cell yd' }, String(totalYd)),
        ce('div', { class: 'course-cell hdcp' }, '')
      ));
      return grid;
    };

    const front = c.holes.slice(0, 9);
    const back = c.holes.slice(9, 18);
    body.appendChild(buildNineGrid(front, 'OUT'));
    if (back.length) body.appendChild(buildNineGrid(back, 'IN'));

    body.appendChild(ce('div', { class: 'course-total' },
      `TOTAL · PAR ${par} · ${totalYd.toLocaleString()} YD`
    ));
  }

  function closePlayer() {
    const modal = $('#player-modal');
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  let pingTimer = null;
  let pingQueue = [];
  function pingToast(key) {
    if (state.firstLoad) return;
    const [bid, player] = key.split(':');
    const board = state.boards.find(b => b.id === bid);
    if (!board) return;
    pingQueue.push(`Someone moved a line on ${player} · ${board.title.toLowerCase()}`);
    clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      toast(pingQueue[pingQueue.length - 1]);
      pingQueue = [];
    }, 300);
  }

  function startCountdown() {
    const timeEl = $('#countdown-time');
    const barEl = $('#countdown-bar');
    let lastBoundaryAt = 0;
    function tick() {
      const remain = Math.max(0, state.refreshAt - Date.now());
      const mins = Math.floor(remain / 60000);
      const secs = Math.floor((remain % 60000) / 1000);
      timeEl.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
      barEl.style.width = `${(remain / REFRESH_MS) * 100}%`;
      if (remain <= 0 && Date.now() - lastBoundaryAt > 8000) {
        lastBoundaryAt = Date.now();
        state.refreshAt = nextRefreshAt();
        state.picks = {}; // match server-side vote wipe
        // SSE should deliver the 'reset' event instantly (which also fires
        // the celebration). This fetch is a safety net in case SSE is dead.
        loadState().then(() => celebrateBoundary()).catch(() => {});
      }
    }
    tick();
    setInterval(tick, 1000);
  }

  let lastCelebrateAt = 0;
  function celebrateBoundary() {
    const now = Date.now();
    if (now - lastCelebrateAt < 3000) return; // dedupe: SSE + fallback fetch race
    lastCelebrateAt = now;
    const el = document.createElement('div');
    el.className = 'boundary-flash';
    el.textContent = 'ODDS UPDATED';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  function getStreak() {
    try {
      const s = JSON.parse(localStorage.getItem('rift_streak') || '{}');
      return s.count || 0;
    } catch { return 0; }
  }
  function bumpStreak() {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const s = JSON.parse(localStorage.getItem('rift_streak') || '{}');
      if (s.last === today) return;
      const yest = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      s.count = (s.last === yest) ? (s.count || 0) + 1 : 1;
      s.last = today;
      localStorage.setItem('rift_streak', JSON.stringify(s));
    } catch {}
  }

  function renderLoadingPlaceholder(msg, withRetry) {
    const container = $('#boards');
    if (!container) return;
    container.innerHTML = '';
    const card = ce('div', { class: 'boards-placeholder' },
      ce('div', { class: 'boards-placeholder-title' }, msg || 'Loading odds\u2026'),
      ce('div', { class: 'boards-placeholder-sub' }, 'Railway sometimes cold-starts. Give it a few seconds.')
    );
    if (withRetry) {
      card.appendChild(ce('button', {
        class: 'boards-placeholder-retry', type: 'button',
        onclick: () => { renderLoadingPlaceholder('Retrying\u2026', false); bootData(); }
      }, 'Tap to retry'));
    }
    container.appendChild(card);
  }

  async function bootData() {
    try {
      await loadStateWithRetry();
      connectStream();
    } catch (e) {
      console.error('boot failed', e);
      if (!state.boards.length) renderLoadingPlaceholder('Couldn\u2019t reach the server', true);
      else toast('Reconnecting\u2026');
    }
  }

  function showFatalRetry(msg) {
    const container = $('#boards');
    if (!container) return;
    container.innerHTML = '';
    const card = ce('div', { class: 'boards-placeholder' },
      ce('div', { class: 'boards-placeholder-title' }, msg || 'Couldn\u2019t load'),
      ce('div', { class: 'boards-placeholder-sub' }, 'Something errored out on the page. Tap retry or hard-refresh.'),
      ce('button', {
        class: 'boards-placeholder-retry', type: 'button',
        onclick: () => location.reload()
      }, 'Reload')
    );
    container.appendChild(card);
  }

  window.addEventListener('error', (e) => {
    // Skip third-party noise (Snapchat in-app browser bridge, etc.)
    if (!e.filename || e.filename.indexOf(location.origin) !== 0) return;
    if (e.message && /SCDynimacBridge|webkitMessageHandlers|__firefox__|ResizeObserver loop/i.test(e.message)) return;
    console.error('window error', e.error || e.message);
    if (!state.boards || state.boards.length === 0) showFatalRetry('Script error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('unhandled rejection', e.reason);
  });

  async function init() {
    state.userId = getOrCreateUserId();
    loadParlay();

    // Stale-while-revalidate: render cached state immediately if we have one.
    const cached = loadStateCache();
    if (cached && cached.data) {
      state.boards = cached.data.boards;
      state.tallies = cached.data.tallies || {};
      state.oddsHistory = cached.data.oddsHistory || {};
      if (cached.data.refreshAt) state.refreshAt = cached.data.refreshAt;
      snapshotNow();
      hydrateFromHash();
      render();
    }
    // else: the HTML-embedded initial loader is already visible.

    loadMe().catch(e => console.warn('loadMe failed, continuing', e));
    bootData();

    // Safety net: if after 25s we still have no boards visible, surface a retry UI.
    setTimeout(() => {
      if (!state.boards || state.boards.length === 0) {
        renderLoadingPlaceholder('Still loading\u2026 tap retry if nothing changes', true);
      }
    }, 25000);

    startCountdown();
    bumpStreak();
    $('#parlay-clear').addEventListener('click', () => { state.parlay = []; persistParlay(); render(); });
    $('#parlay-share').addEventListener('click', shareParlay);
    $('#parlay-share-card')?.addEventListener('click', shareParlayCard);
    const mini = $('#parlay-mini');
    if (mini) mini.addEventListener('click', () => {
      const card = $('#parlay-card');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    $('#player-modal-close')?.addEventListener('click', closePlayer);
    $('#player-modal-backdrop')?.addEventListener('click', closePlayer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePlayer(); closeProposal(); } });

    $('#proposal-modal-close')?.addEventListener('click', closeProposal);
    $('#proposal-modal-backdrop')?.addEventListener('click', closeProposal);
    $('#proposal-yes')?.addEventListener('click', () => {
      if (state.activeProposalId) castProposalVote(state.activeProposalId, 'yes');
    });
    $('#proposal-no')?.addEventListener('click', () => {
      if (state.activeProposalId) castProposalVote(state.activeProposalId, 'no');
    });
    // Auto-open the first unvoted-and-undismissed ballot on first visit.
    setTimeout(() => {
      for (const p of state.proposals || []) {
        const dismissed = localStorage.getItem('rift_proposal_shown_' + p.id);
        const voted = (state.proposalVotes || {})[p.id];
        if (!voted && !dismissed) {
          openProposal(p.id);
          localStorage.setItem('rift_proposal_shown_' + p.id, '1');
          break;
        }
      }
    }, 800);

    // Leaderboard controls
    $('#leaderboard-edit')?.addEventListener('click', async () => {
      if (!state.bracketEditing) { enterBracketEdit(); return; }
      // Currently editing — save + exit
      const ok = await submitBracket();
      if (ok) {
        state.bracketEditing = false;
        renderLeaderboard();
      }
    });
    $('#leaderboard-share')?.addEventListener('click', shareBracketCard);
    $('#leaderboard-sort')?.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-sort]');
      if (!btn) return;
      state.bracketSort = btn.dataset.sort;
      try { localStorage.setItem('rift_bracket_sort', state.bracketSort); } catch {}
      renderLeaderboard();
    });
    const whoamiEl = $('#leaderboard-whoami');
    if (whoamiEl) {
      whoamiEl.value = state.whoami || '';
      whoamiEl.addEventListener('change', () => {
        state.whoami = whoamiEl.value;
        try { localStorage.setItem('rift_whoami', state.whoami); } catch {}
        renderLeaderboard();
      });
    }

    // When the tab becomes visible again after being backgrounded on mobile,
    // SSE may be dead. Refresh state and reconnect.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') bootData();
    });

    initRiftTabs();
  }

  function initRiftTabs() {
    const tabs = document.getElementById('rift-tabs');
    if (!tabs) return;

    // Measure topbar height for sticky offset (updated on resize).
    const measureTopbar = () => {
      const bar = document.querySelector('.topbar');
      if (bar) document.documentElement.style.setProperty('--topbar-h', bar.offsetHeight + 'px');
    };
    measureTopbar();
    window.addEventListener('resize', measureTopbar);

    // Click → smooth-scroll to section with offset accounting for sticky topbar + tabs.
    tabs.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-target]');
      if (!a) return;
      e.preventDefault();
      const target = document.getElementById(a.dataset.target);
      if (!target) return;
      const topbarH = (document.querySelector('.topbar') || { offsetHeight: 0 }).offsetHeight;
      const tabsH = tabs.offsetHeight;
      const y = target.getBoundingClientRect().top + window.scrollY - topbarH - tabsH - 8;
      window.scrollTo({ top: y, behavior: 'smooth' });
    });

    // Active tab tracking via intersection observer.
    const sectionIds = ['leaderboard', 'boards', 'matchups', 'proposals-section', 'parlay-section'];
    const sections = sectionIds.map(id => document.getElementById(id)).filter(Boolean);
    const setActive = (id) => {
      for (const a of tabs.querySelectorAll('a[data-target]')) {
        a.classList.toggle('active', a.dataset.target === id);
      }
    };
    if ('IntersectionObserver' in window && sections.length) {
      const visible = new Map();
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.set(entry.target.id, entry.intersectionRatio);
          else visible.delete(entry.target.id);
        }
        // Pick the topmost visible section (first in DOM order).
        for (const id of sectionIds) {
          if (visible.has(id)) { setActive(id); break; }
        }
      }, { rootMargin: '-120px 0px -60% 0px', threshold: [0, 0.1, 0.5] });
      for (const s of sections) io.observe(s);
    }

    // Auto-hide on scroll-down, reveal on scroll-up.
    let lastY = window.scrollY, ticking = false;
    window.addEventListener('scroll', () => {
      if (ticking) return;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        if (y > lastY + 4 && y > 140) tabs.classList.add('rift-tabs--hidden');
        else if (y < lastY - 4)       tabs.classList.remove('rift-tabs--hidden');
        lastY = y; ticking = false;
      });
      ticking = true;
    }, { passive: true });
  }

  init();
})();
