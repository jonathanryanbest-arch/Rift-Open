const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const BOARDS = [
  {
    id: 'win',
    title: 'TO WIN IT ALL',
    subtitle: 'Who hoists the jacket?',
    emoji: '🏆',
    theme: 'trophy',
    lines: [
      { player: 'MURPH',  odds: '+350' },
      { player: 'MAX',    odds: '+425' },
      { player: 'MANGO',  odds: '+500' },
      { player: 'PATTY',  odds: '+1000' },
      { player: 'HIPPIE', odds: '+1500' },
      { player: 'PICKLE', odds: '+2000' },
      { player: 'RYAN',   odds: '+3000' },
      { player: 'PARKER', odds: '+3000' },
      { player: 'DAN',    odds: '+4000' },
      { player: 'HOAG',   odds: '+4000' }
    ]
  },
  {
    id: 'beers',
    title: 'MOST BEERS',
    subtitle: 'Who drinks the field under the table?',
    emoji: '🍺',
    theme: 'gold',
    lines: [
      { player: 'MAX',    odds: '-150',  tag: 'LOCK' },
      { player: 'PARKER', odds: '+400' },
      { player: 'MANGO',  odds: '+700' },
      { player: 'PATTY',  odds: '+1000' },
      { player: 'RYAN',   odds: '+1400' },
      { player: 'HIPPIE', odds: '+1800' },
      { player: 'DAN',    odds: '+2500' },
      { player: 'HOAG',   odds: '+3000' },
      { player: 'MURPH',  odds: '+4000' },
      { player: 'PICKLE', odds: '+5000' }
    ]
  },
  {
    id: 'oob',
    title: 'HOUSE CALLS',
    subtitle: 'Most out of bounds',
    emoji: '📞',
    theme: 'tan',
    lines: [
      { player: 'RYAN',   odds: '-200',  tag: 'LOCK' },
      { player: 'MAX',    odds: '+500' },
      { player: 'DAN',    odds: '+900' },
      { player: 'MANGO',  odds: '+1400' },
      { player: 'PICKLE', odds: '+2000' },
      { player: 'PATTY',  odds: '+2500' },
      { player: 'PARKER', odds: '+3000' },
      { player: 'MURPH',  odds: '+4000' },
      { player: 'HIPPIE', odds: '+6000' },
      { player: 'HOAG',   odds: '+9000' }
    ]
  },
  {
    id: 'slurs',
    title: 'MOST SLURS',
    subtitle: 'Loudest mouth on the course',
    emoji: '🤬',
    theme: 'red',
    lines: [
      { player: 'MURPH',  odds: '+200' },
      { player: 'PARKER', odds: '+275' },
      { player: 'HOAG',   odds: '+350' },
      { player: 'MANGO',  odds: '+450' },
      { player: 'PICKLE', odds: '+1500' },
      { player: 'MAX',    odds: '+2000' },
      { player: 'PATTY',  odds: '+2500' },
      { player: 'HIPPIE', odds: '+3500' },
      { player: 'DAN',    odds: '+5000' },
      { player: 'RYAN',   odds: '+8000' }
    ]
  },
  {
    id: 'improved',
    title: 'MOST IMPROVED',
    subtitle: 'Glow up or go home',
    emoji: '📈',
    theme: 'blue',
    lines: [
      { player: 'RYAN',   odds: '+200' },
      { player: 'DAN',    odds: '+275' },
      { player: 'PATTY',  odds: '+600' },
      { player: 'HOAG',   odds: '+900' },
      { player: 'PARKER', odds: '+1200' },
      { player: 'HIPPIE', odds: '+1800' },
      { player: 'MANGO',  odds: '+2500' },
      { player: 'PICKLE', odds: '+3500' },
      { player: 'MURPH',  odds: '+5000' },
      { player: 'MAX',    odds: '+8000' }
    ]
  },
  {
    id: 'relief',
    title: 'FREE RELIEF',
    subtitle: 'Who drops without a penalty?',
    emoji: '⛳',
    theme: 'green',
    lines: [
      { player: 'MURPH',  odds: '-500',  tag: 'LOCK' },
      { player: 'PARKER', odds: '+700' },
      { player: 'HOAG',   odds: '+1000' },
      { player: 'MAX',    odds: '+1400' },
      { player: 'MANGO',  odds: '+1800' },
      { player: 'PICKLE', odds: '+2500' },
      { player: 'PATTY',  odds: '+3000' },
      { player: 'DAN',    odds: '+4000' },
      { player: 'HIPPIE', odds: '+5000' },
      { player: 'RYAN',   odds: '+8000' }
    ]
  },
  {
    id: 'cart',
    title: 'CART CASUALTY',
    subtitle: 'Ran over or ran off',
    emoji: '🛺',
    theme: 'orange',
    lines: [
      { player: 'MAX',    odds: '-250',  tag: 'LOCK' },
      { player: 'PICKLE', odds: '+400' },
      { player: 'PATTY',  odds: '+600' },
      { player: 'HIPPIE', odds: '+800' },
      { player: 'PARKER', odds: '+1000' },
      { player: 'DAN',    odds: '+1200' },
      { player: 'MANGO',  odds: '+1500' },
      { player: 'HOAG',   odds: '+2000' },
      { player: 'RYAN',   odds: '+3000' },
      { player: 'MURPH',  odds: '+4000' }
    ]
  },
  {
    id: 'barf',
    title: 'TECHNICOLOR YAWN',
    subtitle: 'First one to lose lunch',
    emoji: '🤮',
    theme: 'purple',
    lines: [
      { player: 'MAX',    odds: '+200' },
      { player: 'MURPH',  odds: '+275' },
      { player: 'PARKER', odds: '+350' },
      { player: 'MANGO',  odds: '+500' },
      { player: 'PATTY',  odds: '+800' },
      { player: 'HIPPIE', odds: '+1200' },
      { player: 'DAN',    odds: '+1500' },
      { player: 'PICKLE', odds: '+2000' },
      { player: 'HOAG',   odds: '+3000' },
      { player: 'RYAN',   odds: '+5000' }
    ]
  },
  {
    id: 'mulligan',
    title: 'MULLIGAN MAGNET',
    subtitle: 'Asks for a do-over first',
    emoji: '🔁',
    theme: 'cream',
    lines: [
      { player: 'MURPH',  odds: '-400',  tag: 'LOCK' },
      { player: 'MAX',    odds: '+500' },
      { player: 'DAN',    odds: '+700' },
      { player: 'MANGO',  odds: '+900' },
      { player: 'PATTY',  odds: '+1200' },
      { player: 'HIPPIE', odds: '+1800' },
      { player: 'PARKER', odds: '+2500' },
      { player: 'HOAG',   odds: '+3000' },
      { player: 'PICKLE', odds: '+4000' },
      { player: 'RYAN',   odds: '+6000' }
    ]
  }
];

const REFRESH_MS = 5 * 60 * 1000;
const MAX_HISTORY = 12;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(VOTES_FILE)) fs.writeFileSync(VOTES_FILE, JSON.stringify({ tallies: {}, users: {}, oddsOverrides: {}, oddsHistory: {} }));
}

function loadVotes() {
  ensureDataDir();
  try {
    const data = JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8'));
    return { tallies: {}, users: {}, oddsOverrides: {}, oddsHistory: {}, ...data };
  } catch {
    return { tallies: {}, users: {}, oddsOverrides: {}, oddsHistory: {} };
  }
}

let voteState = loadVotes();
let writePending = false;

function persistVotes() {
  if (writePending) return;
  writePending = true;
  setImmediate(() => {
    fs.writeFile(VOTES_FILE, JSON.stringify(voteState), () => {
      writePending = false;
    });
  });
}

const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

function keyFor(boardId, player) { return `${boardId}:${player}`; }

function americanToImplied(odds) {
  const n = parseInt(String(odds).replace(/[^-\d]/g, ''), 10);
  if (!n) return 0;
  if (n > 0) return 100 / (n + 100);
  return Math.abs(n) / (Math.abs(n) + 100);
}

function impliedToAmerican(p) {
  const clamped = Math.min(0.92, Math.max(0.01, p));
  let raw;
  if (clamped >= 0.5) {
    raw = -Math.round(clamped / (1 - clamped) * 100);
  } else {
    raw = Math.round((1 - clamped) / clamped * 100);
  }
  // snap to 5
  const snapped = Math.round(Math.abs(raw) / 5) * 5;
  const min = 105;
  const final = Math.max(min, snapped);
  return (raw < 0 ? '-' : '+') + final;
}

function liveBoards() {
  // Apply oddsOverrides on top of base BOARDS, re-sort each board, retag LOCK.
  return BOARDS.map(board => {
    const lines = board.lines.map(l => {
      const k = keyFor(board.id, l.player);
      const odds = voteState.oddsOverrides[k] || l.odds;
      return { player: l.player, odds };
    });
    lines.sort((a, b) => americanToImplied(b.odds) - americanToImplied(a.odds));
    lines.forEach((l, i) => {
      if (i === 0 && l.odds.startsWith('-')) l.tag = 'LOCK';
    });
    return { ...board, lines };
  });
}

function publicState() {
  return {
    boards: liveBoards(),
    tallies: voteState.tallies,
    oddsHistory: voteState.oddsHistory,
    refreshAt: nextBoundary()
  };
}

function recordHistory() {
  const live = liveBoards();
  for (const board of live) {
    for (const line of board.lines) {
      const key = keyFor(board.id, line.player);
      const arr = voteState.oddsHistory[key] || (voteState.oddsHistory[key] = []);
      arr.push(line.odds);
      if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
    }
  }
}

function nextBoundary() {
  return Math.ceil((Date.now() + 1) / REFRESH_MS) * REFRESH_MS;
}

function resetWindow() {
  // 1. Bake votes into new odds (probability shifts by ~1.5% per net vote, capped).
  const newOverrides = { ...voteState.oddsOverrides };
  const live = liveBoards();
  for (const board of live) {
    for (const line of board.lines) {
      const key = keyFor(board.id, line.player);
      const t = voteState.tallies[key] || { up: 0, down: 0 };
      const net = (t.up || 0) - (t.down || 0);
      if (net === 0) continue;
      const p = americanToImplied(line.odds);
      const newP = Math.min(0.85, Math.max(0.02, p + net * 0.015));
      newOverrides[key] = impliedToAmerican(newP);
    }
  }
  voteState.oddsOverrides = newOverrides;
  voteState.tallies = {};
  voteState.users = {};
  recordHistory();
  persistVotes();
  broadcast('snapshot', publicState());
}

function scheduleResets() {
  const fireAt = nextBoundary();
  const delay = Math.max(0, fireAt - Date.now());
  setTimeout(() => {
    try { resetWindow(); } catch (e) { console.error('reset failed', e); }
    setInterval(() => {
      try { resetWindow(); } catch (e) { console.error('reset failed', e); }
    }, REFRESH_MS);
  }, delay);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function applyVote(userId, boardId, player, vote) {
  if (!['up', 'down', null].includes(vote)) return null;
  const board = BOARDS.find(b => b.id === boardId);
  if (!board) return null;
  const line = board.lines.find(l => l.player === player);
  if (!line) return null;

  const key = keyFor(boardId, player);
  voteState.users[userId] = voteState.users[userId] || {};
  const prev = voteState.users[userId][key] || null;
  voteState.tallies[key] = voteState.tallies[key] || { up: 0, down: 0 };

  if (prev === 'up') voteState.tallies[key].up = Math.max(0, voteState.tallies[key].up - 1);
  if (prev === 'down') voteState.tallies[key].down = Math.max(0, voteState.tallies[key].down - 1);

  if (vote === 'up') voteState.tallies[key].up += 1;
  if (vote === 'down') voteState.tallies[key].down += 1;

  if (vote === null) delete voteState.users[userId][key];
  else voteState.users[userId][key] = vote;

  persistVotes();
  broadcast('tally', { key, tally: voteState.tallies[key] });
  return voteState.tallies[key];
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

const BUILD_VERSION = String(Date.now());

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) filePath = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const isHtml = ext === '.html';
    if (isHtml) {
      fs.readFile(filePath, 'utf8', (err2, data) => {
        if (err2) { res.writeHead(500); return res.end('error'); }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache, no-store, must-revalidate' });
        res.end(data.replace(/__V__/g, BUILD_VERSION));
      });
    } else {
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/healthz' || url === '/api/health')) {
    return send(res, 200, { ok: true, version: BUILD_VERSION, boards: BOARDS.length });
  }

  if (req.method === 'GET' && url === '/api/state') {
    return send(res, 200, publicState());
  }

  if (req.method === 'GET' && url === '/api/me') {
    const query = new URL(req.url, 'http://x').searchParams;
    const userId = query.get('uid') || crypto.randomUUID();
    const picks = voteState.users[userId] || {};
    return send(res, 200, { userId, picks });
  }

  if (req.method === 'POST' && url === '/api/vote') {
    try {
      const body = await readBody(req);
      const { userId, boardId, player, vote } = body;
      if (!userId || !boardId || !player) return send(res, 400, { error: 'missing fields' });
      const tally = applyVote(userId, boardId, player, vote === null ? null : vote);
      if (!tally && vote !== null) return send(res, 400, { error: 'invalid vote' });
      return send(res, 200, { ok: true, tally: voteState.tallies[keyFor(boardId, player)] || { up: 0, down: 0 } });
    } catch (e) {
      return send(res, 400, { error: 'bad json' });
    }
  }

  if (req.method === 'GET' && url === '/api/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(`: ping\n\n`); } catch {}
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
    return;
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Rift Open Sportsbook running on port ${PORT}`);
  // Seed history for any line without one so sparklines have a starting point.
  const live = liveBoards();
  let seeded = false;
  for (const board of live) {
    for (const line of board.lines) {
      const key = keyFor(board.id, line.player);
      if (!voteState.oddsHistory[key] || voteState.oddsHistory[key].length === 0) {
        voteState.oddsHistory[key] = [line.odds];
        seeded = true;
      }
    }
  }
  if (seeded) persistVotes();
  scheduleResets();
});
