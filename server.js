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
      { player: 'MURPH',  odds: '+350',  tag: 'FAV' },
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
      { player: 'MURPH',  odds: '+200',  tag: 'FAV' },
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
      { player: 'RYAN',   odds: '+200',  tag: 'FAV' },
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
  }
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(VOTES_FILE)) fs.writeFileSync(VOTES_FILE, JSON.stringify({ tallies: {}, users: {} }));
}

function loadVotes() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(VOTES_FILE, 'utf8'));
  } catch {
    return { tallies: {}, users: {} };
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

function publicState() {
  return { boards: BOARDS, tallies: voteState.tallies };
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

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) filePath = path.join(PUBLIC_DIR, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

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
});
