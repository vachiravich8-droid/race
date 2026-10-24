// TikTok LIVE -> Roblox bridge
// Reads TikTok LIVE comments and lets your Roblox game ask for them over HTTP.
//
// Endpoints (all need ?key=YOUR_BRIDGE_KEY):
//   GET /connect?user=tiktokname          start listening to that LIVE
//   GET /events?user=tiktokname&since=ID  new comments after ID
//   GET /disconnect?user=tiktokname       stop listening
//
// Web control panel (open https://<your-bridge>/panel and type your BRIDGE_KEY):
//   POST /game/sync          the Roblox server sends its race state and picks up commands from the panel
//   GET  /api/live           panel: servers, race state, TikTok feed, command results
//   POST /api/cmd            panel: queue a command for one server or all of them
//   GET  /overlay?v=TOKEN    read-only live leaderboard for OBS / TikTok LIVE Studio
//   GET  /api/view?v=TOKEN   data for the overlay (TOKEN is shown in the panel, it can't send commands)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BRIDGE_KEY = process.env.BRIDGE_KEY || 'change-me';
// optional second password for the race-only page (vmk-race.html): view the race + start / clear / +10 test only
const RACE_KEY = process.env.RACE_KEY || '';
const RACE_KEY_CMDS = new Set(['start', 'clear', 'test']);
const SIGN_API_KEY = process.env.SIGN_API_KEY || ''; // optional (Euler Stream key) if TikTok blocks connections
const MAX_EVENTS = 500;          // comments kept per channel
const IDLE_MS = 3 * 60 * 1000;   // stop a channel nobody polled for 3 minutes
const RETRY_MS = 20 * 1000;

let Lib = null;
async function loadLib() {
  if (Lib) return Lib;
  const mod = await import('tiktok-live-connector');
  const m = mod.TikTokLiveConnection || mod.WebcastPushConnection ? mod : (mod.default || mod);
  Lib = {
    Conn: m.TikTokLiveConnection || m.WebcastPushConnection,
    CHAT: (m.WebcastEvent && m.WebcastEvent.CHAT) || 'chat',
    STREAM_END: (m.WebcastEvent && m.WebcastEvent.STREAM_END) || 'streamEnd',
    GIFT: (m.WebcastEvent && m.WebcastEvent.GIFT) || 'gift',
    LIKE: (m.WebcastEvent && m.WebcastEvent.LIKE) || 'like',
  };
  return Lib;
}


// TikTok's data shape differs between library versions: read every known field name
function firstStr(...vals) {
  for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim();
  return '';
}
function pickUser(d) {
  const u = d.user || d.userInfo || d.userDetails || {};
  const id = firstStr(u.uniqueId, u.displayId, u.username, u.unique_id, u.display_id, d.uniqueId, d.displayId, d.username);
  const nick = firstStr(u.nickname, u.nickName, u.nick_name, d.nickname, id);
  // last resort: a stable id made from the numeric user id or the nickname
  const fallback = firstStr(u.userId && String(u.userId), u.id && String(u.id), d.userId && String(d.userId), nick);
  return { id: (id || fallback).replace(/\s+/g, '_'), nick };
}
function pickText(d) {
  return firstStr(d.comment, d.content, d.text, d.message, d.msg, d.common && d.common.describe);
}
const sampled = {};
function sample(kind, d) {
  if (sampled[kind]) return;
  sampled[kind] = true;
  try {
    console.log(`[sample ${kind}]`, JSON.stringify(d, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 1500));
  } catch (_) {}
}

const rooms = new Map(); // tiktok user -> room

function cleanUser(u) {
  return String(u || '').trim().replace(/^@/, '').toLowerCase();
}
function shortErr(e) {
  const msg = (e && (e.message || e.toString())) || 'unknown';
  if (/offline|not.*live|isn't online|not online|LIVE has ended/i.test(msg)) return 'offline';
  return msg.slice(0, 120);
}
function push(room, ev) {
  ev.id = room.nextId++;
  room.events.push(ev);
  if (room.events.length > MAX_EVENTS) room.events.splice(0, room.events.length - MAX_EVENTS);
}

async function startConn(user, room) {
  if (room.closed) return;
  let lib;
  try {
    lib = await loadLib();
  } catch (e) {
    room.status = 'error: tiktok-live-connector not installed (run npm install)';
    console.error(e.message);
    return;
  }
  const { Conn, CHAT, STREAM_END, GIFT, LIKE } = lib;
  const opts = { processInitialData: false };
  if (SIGN_API_KEY) opts.signApiKey = SIGN_API_KEY;
  const conn = new Conn(user, opts);
  room.conn = conn;
  room.status = 'connecting';

  conn.on(CHAT, (d) => {
    sample('chat', d);
    const who = pickUser(d);
    push(room, { type: 'comment', user: who.id, nickname: who.nick, text: pickText(d) });
  });
  conn.on(GIFT, (d) => {
    sample('gift', d);
    const det = d.giftDetails || d.gift || {};
    const giftType = d.giftType != null ? d.giftType : det.giftType;
    // streakable gifts (type 1) fire repeatedly; only count them when the streak ends
    if (giftType === 1 && !(d.repeatEnd === true || d.repeatEnd === 1)) return;
    const who = pickUser(d);
    push(room, {
      type: 'gift', user: who.id, nickname: who.nick,
      gift: d.giftName || det.giftName || det.name || 'Gift',
      count: Number(d.repeatCount || d.comboCount || 1) || 1,
      diamonds: Number(d.diamondCount || det.diamondCount || det.diamond_count || 1) || 1,
    });
  });
  conn.on(LIKE, (d) => {
    const who = pickUser(d);
    push(room, { type: 'like', user: who.id, nickname: who.nick, count: Number(d.likeCount || d.count || 1) || 1 });
  });
  conn.on(STREAM_END, () => { room.status = 'offline'; retry(user, room); });
  conn.on('disconnected', () => {
    if (room.status === 'connected') room.status = 'reconnecting';
    retry(user, room);
  });
  conn.on('error', (e) => console.error(`[${user}]`, shortErr(e)));

  try {
    await conn.connect();
    room.status = 'connected';
    console.log(`[${user}] connected`);
  } catch (e) {
    const err = shortErr(e);
    room.status = err === 'offline' ? 'offline' : 'error: ' + err;
    console.log(`[${user}] connect failed: ${err}`);
    retry(user, room);
  }
}

function retry(user, room) {
  if (room.closed || room.retryTimer) return;
  room.retryTimer = setTimeout(() => {
    room.retryTimer = null;
    try { room.conn && room.conn.disconnect(); } catch (_) {}
    startConn(user, room);
  }, RETRY_MS);
}

function stopRoom(user) {
  const room = rooms.get(user);
  if (!room) return;
  room.closed = true;
  clearTimeout(room.retryTimer);
  try { room.conn && room.conn.disconnect(); } catch (_) {}
  rooms.delete(user);
  console.log(`[${user}] stopped`);
}

function getRoom(user) {
  let room = rooms.get(user);
  if (!room) {
    room = { status: 'connecting', events: [], nextId: 1, lastPoll: Date.now(), conn: null, retryTimer: null, closed: false };
    rooms.set(user, room);
    startConn(user, room);
  }
  room.lastPoll = Date.now();
  return room;
}

setInterval(() => {
  const now = Date.now();
  for (const [user, room] of rooms) if (now - room.lastPoll > IDLE_MS) stopRoom(user);
}, 30 * 1000);

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// ------------------------------------------------------------------ web control panel <-> Roblox
const SERVER_TTL = 25 * 1000;     // a game server that hasn't synced for this long is gone
const CMD_TTL = 60 * 1000;        // commands nobody picked up in a minute are dropped
const MAX_CMDS = 300;
const servers = new Map();        // jobId -> { jobId, state, info, at }
const cmds = [];                  // { id, at, to (jobId or 'all'), type, ...args, results: { jobId: {ok,msg} } }
let nextCmd = 1;
// read-only token for the overlay, made from the key (so it never shows the key itself)
const VIEW_TOKEN = crypto.createHash('sha256').update('view:' + BRIDGE_KEY).digest('hex').slice(0, 16);

function safeEq(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function keyOf(req, url) {
  return req.headers['x-bridge-key'] || url.searchParams.get('key') || '';
}
function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too big')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}
function liveServers() {
  const now = Date.now();
  for (const [id, s] of servers) if (now - s.at > SERVER_TTL) servers.delete(id);
  return [...servers.values()].sort((a, b) => (b.info.players || 0) - (a.info.players || 0) || b.at - a.at);
}
function pruneCmds() {
  const now = Date.now();
  while (cmds.length && (cmds.length > MAX_CMDS || now - cmds[0].at > CMD_TTL * 5)) cmds.shift();
}
// the server whose race the overlay should show: the one connected to TikTok, else the busiest
function mainServer(list) {
  return list.find((s) => s.state && s.state.tiktok && s.state.tiktok.connected) || list[0] || null;
}
function roomFeed(channel, since) {
  const user = cleanUser(channel);
  const room = user && rooms.get(user);
  if (!room) return { channel: user || null, status: user ? 'not connected' : null, events: [], last: since };
  const events = room.events.filter((e) => e.id > since).slice(-60);
  return { channel: user, status: room.status, events, last: room.nextId - 1 };
}
const COMMAND_TYPES = new Set(['start', 'clear', 'test', 'addRacer', 'announce', 'event', 'testGift', 'map', 'laps', 'mode',
  'capacity', 'ghost', 'tiktok', 'tiktokOff', 'raw']);
function cleanCmd(b) {
  const type = String(b.type || '');
  if (!COMMAND_TYPES.has(type)) return null;
  const c = { type };
  for (const k of ['text', 'name', 'roblox', 'kind', 'gift', 'target', 'user', 'value']) {
    if (b[k] != null) c[k] = String(b[k]).slice(0, 200);
  }
  for (const k of ['diamonds', 'count', 'number']) if (b[k] != null) c[k] = Math.max(0, Math.min(1e6, Number(b[k]) || 0));
  return c;
}

let pages = {};
function page(name) {
  if (!pages[name] || process.env.DEV_PAGES) pages[name] = fs.readFileSync(path.join(__dirname, name), 'utf8');
  return pages[name];
}
function sendPage(res, name) {
  try {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Frame-Options': 'SAMEORIGIN', 'Referrer-Policy': 'no-referrer' });
    res.end(page(name));
  } catch (e) {
    send(res, 500, { error: name + ' is missing next to server.js' });
  }
}

// allow the panel to be opened from another address (a saved file, another site) and still talk to the bridge.
// Safe because every control route still needs the BRIDGE_KEY.
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // ---- pages (no key needed to load them; the panel asks for the key)
  if (p === '/' && (req.headers.accept || '').includes('text/html')) { res.writeHead(302, { Location: '/panel' }); return res.end(); }
  if (p === '/') return send(res, 200, { ok: true, service: 'tiktok-roblox-bridge', channels: rooms.size, games: liveServers().length });
  if (p === '/panel' || p === '/panel/') return sendPage(res, 'panel.html');
  if (p === '/overlay') return sendPage(res, 'overlay.html');

  // ---- overlay data (read-only token)
  if (p === '/api/view') {
    if (!safeEq(url.searchParams.get('v'), VIEW_TOKEN)) return send(res, 403, { error: 'Wrong overlay link' });
    const s = mainServer(liveServers());
    return send(res, 200, { now: Date.now(), state: s ? s.state : null, age: s ? Date.now() - s.at : null });
  }

  const given = keyOf(req, url);
  const raceOnly = !!RACE_KEY && !safeEq(given, BRIDGE_KEY) && safeEq(given, RACE_KEY);
  if (!raceOnly && !safeEq(given, BRIDGE_KEY)) return send(res, 403, { error: 'Wrong BRIDGE_KEY' });
  // the race password can only see the race and press start / clear / +10 test
  if (raceOnly && !(p === '/api/live' || (p === '/api/cmd' && req.method === 'POST'))) return send(res, 403, { error: 'Not allowed with this password' });

  // ---- Roblox game server: send state, receive commands
  if (p === '/game/sync' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const jobId = String(b.jobId || 'studio').slice(0, 64);
    const s = servers.get(jobId) || { jobId, state: null, info: {}, at: 0, since: Date.now() };
    s.state = b.state && typeof b.state === 'object' ? b.state : s.state;
    s.info = { players: Number(b.players) || 0, place: String(b.place || '').slice(0, 40), studio: !!b.studio };
    s.at = Date.now();
    servers.set(jobId, s);
    // results of commands this server ran
    if (Array.isArray(b.results)) {
      for (const r of b.results.slice(0, 50)) {
        const c = cmds.find((x) => x.id === Number(r.id));
        if (c) c.results[jobId] = { ok: r.ok !== false, msg: String(r.msg || '').slice(0, 200) };
      }
    }
    const ack = Number(b.ack) || 0;
    const now = Date.now();
    const out = cmds.filter((c) => c.id > ack && now - c.at < CMD_TTL && (c.to === 'all' || c.to === jobId))
      .slice(0, 20).map(({ results, at, to, ...c }) => c);
    return send(res, 200, { ok: true, commands: out, last: nextCmd - 1 });
  }

  // ---- panel
  if (p === '/api/live') {
    const list = liveServers();
    const pick = url.searchParams.get('server');
    const main = (pick && servers.get(pick)) || mainServer(list);
    const since = Number(url.searchParams.get('feedSince')) || 0;
    const channel = url.searchParams.get('channel') || (main && main.state && main.state.tiktok && main.state.tiktok.channel) || '';
    const cmdSince = Number(url.searchParams.get('cmdSince')) || 0;
    if (raceOnly) {
      return send(res, 200, { now: Date.now(), servers: list.map((s) => ({ jobId: s.jobId, players: s.info.players, studio: s.info.studio, age: Date.now() - s.at,
        phase: s.state && s.state.phase, count: s.state && s.state.count, map: s.state && s.state.mapName })),
        server: main ? main.jobId : null, state: main ? main.state : null, age: main ? Date.now() - main.at : null, cmds: [] });
    }
    return send(res, 200, {
      now: Date.now(),
      view: VIEW_TOKEN,
      servers: list.map((s) => ({ jobId: s.jobId, players: s.info.players, studio: s.info.studio, age: Date.now() - s.at,
        phase: s.state && s.state.phase, count: s.state && s.state.count, map: s.state && s.state.map })),
      server: main ? main.jobId : null,
      state: main ? main.state : null,
      age: main ? Date.now() - main.at : null,
      feed: roomFeed(channel, since),
      cmds: cmds.filter((c) => c.id > cmdSince || Object.keys(c.results).length).slice(-30)
        .map((c) => ({ id: c.id, type: c.type, to: c.to, results: c.results, at: c.at })),
    });
  }
  if (p === '/api/cmd' && req.method === 'POST') {
    let b;
    try { b = await readBody(req, 8 * 1024); } catch (e) { return send(res, 400, { error: e.message }); }
    const c = cleanCmd(b);
    if (!c) return send(res, 400, { error: 'Unknown command' });
    if (raceOnly && !RACE_KEY_CMDS.has(c.type)) return send(res, 403, { error: 'Not allowed with this password' });
    // (the server it goes to is kept in `to`; `target` inside a command means a racer, e.g. who gets a gift)
    const to = String(b.server || 'all').slice(0, 64);
    if (to !== 'all' && !servers.has(to)) return send(res, 404, { error: 'That server is offline' });
    pruneCmds();
    const cmd = { ...c, id: nextCmd++, at: Date.now(), to, results: {} };
    cmds.push(cmd);
    return send(res, 200, { ok: true, id: cmd.id, servers: to === 'all' ? liveServers().length : 1 });
  }

  // ---- TikTok (used by the game)
  const user = cleanUser(url.searchParams.get('user'));
  if (!/^[a-z0-9_.]{2,30}$/.test(user)) return send(res, 400, { error: 'Bad TikTok username' });

  if (p === '/connect') {
    const room = getRoom(user);
    return send(res, 200, { ok: true, status: room.status, last: room.nextId - 1 });
  }
  if (p === '/events') {
    const room = getRoom(user);
    // if the bridge restarted, the game's "since" can be ahead of us: clamp it
    const since = Math.min(Number(url.searchParams.get('since')) || 0, room.nextId - 1);
    const events = room.events.filter((e) => e.id > since).slice(0, 100);
    return send(res, 200, { status: room.status, events, last: events.length ? events[events.length - 1].id : since });
  }
  if (p === '/disconnect') {
    stopRoom(user);
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'Not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => { console.error(e); try { send(res, 500, { error: 'server error' }); } catch (_) {} });
}).listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
  if (BRIDGE_KEY === 'change-me') console.log('WARNING: set BRIDGE_KEY on Render, the panel is open with the default key');
});
