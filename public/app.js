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
    if (data.refreshAt) state.refreshAt = data.refreshAt;
    saveStateCache(data);
    snapshotNow();
    diag('loaded ' + data.boards.length + ' boards, rendering\u2026');
    render();
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
      if (opts && opts.celebrate) state.picks = {};
      state.boards = data.boards;
      state.tallies = data.tallies || {};
      state.oddsHistory = data.oddsHistory || {};
      if (data.refreshAt) state.refreshAt = data.refreshAt;
      snapshotNow();
      saveStateCache(data);
      render();
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlayer(); });

    // When the tab becomes visible again after being backgrounded on mobile,
    // SSE may be dead. Refresh state and reconnect.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') bootData();
    });
  }

  init();
})();
