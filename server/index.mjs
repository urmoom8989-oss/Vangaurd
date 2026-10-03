// Vangaurd matchmaking + match relay server.
// Speaks the same WebSocket protocol as the game client (path /ws).
// Railway: root directory /server, start command `npm start`; it listens on $PORT.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 8080;
const MIN_PLAYERS = Math.max(1, Number(process.env.MATCH_MIN_SIZE) || 2);
const MAX_PLAYERS = Math.max(MIN_PLAYERS, Number(process.env.MATCH_MAX_SIZE) || 12);
const COUNTDOWN_S = process.env.MATCH_COUNTDOWN !== undefined && process.env.MATCH_COUNTDOWN !== '' && Number.isFinite(Number(process.env.MATCH_COUNTDOWN)) ? Math.max(0, Number(process.env.MATCH_COUNTDOWN)) : 5;
const TAG_LIFETIME_S = 60;
const SPAWN_PROTECT_MS = 2000;
const LOAD_GRACE_MS = 4000; // extra spawn protection while clients load the voted map
const VOTE_S = process.env.MAP_VOTE_SECONDS !== undefined && process.env.MAP_VOTE_SECONDS !== '' && Number.isFinite(Number(process.env.MAP_VOTE_SECONDS)) ? Math.max(0, Number(process.env.MAP_VOTE_SECONDS)) : 10;
const MAPS = ['vardanek', 'kessel', 'foundry', 'freighter', 'airfield', 'lindenhof'];
const MODES = {
  tdm: { name: 'Team Deathmatch', scoreLimit: Math.max(1, Number(process.env.TDM_SCORE_LIMIT) || 50), ffa: false },
  kc: { name: 'Kill Confirmed (free-for-all)', scoreLimit: Math.max(1, Number(process.env.KC_SCORE_LIMIT) || 20), ffa: true },
};
const VERSION = '2.1.0';

const clients = new Map(); // id -> client
const queues = { tdm: [], kc: [] }; // arrays of client ids
const countdowns = {}; // mode -> { endsAt, timer }
const matches = new Map(); // matchId -> match

const newId = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => Date.now();
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cleanName = (s) => String(s || 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Player';
const modeOf = (m) => (MODES[m] ? m : 'tdm');

function send(c, msg) {
  if (c && c.ws.readyState === WebSocket.OPEN) {
    try { c.ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
  }
}
function broadcast(match, msg, exceptId = null) {
  for (const id of match.players.keys()) if (id !== exceptId) send(clients.get(id), msg);
}
function rosterOf(match) {
  return [...match.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, alive: p.alive, kills: p.kills, deaths: p.deaths, score: p.score }));
}
function boardOf(match) {
  return [...match.players.values()].map((p) => ({ id: p.id, name: p.name, score: p.score })).sort((a, b) => b.score - a.score);
}
function scoreMsg(match) {
  const m = { type: 'match_score', matchId: match.id, mode: match.mode, score: { ...match.score }, scoreLimit: match.scoreLimit };
  if (match.ffa) { m.ffa = true; m.players = boardOf(match); }
  return m;
}

// ---------- map vote ----------
function shuffled(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
function talliesOf(match) {
  const t = {};
  for (const id of match.vote.options) t[id] = 0;
  for (const [pid, mapId] of match.vote.votes) if (match.players.has(pid) && mapId in t) t[mapId]++;
  return t;
}
function voteInfo(match, forId = null) {
  if (match.phase !== 'vote') return null;
  return {
    options: match.vote.options, tallies: talliesOf(match), total: VOTE_S,
    endsIn: Math.max(0, (match.vote.endsAt - now()) / 1000), voters: match.players.size,
    mine: forId ? match.vote.votes.get(forId) || null : null,
  };
}
function broadcastVote(match) {
  if (match.phase !== 'vote') return;
  broadcast(match, { type: 'map_vote', matchId: match.id, tallies: talliesOf(match), endsIn: Math.max(0, (match.vote.endsAt - now()) / 1000), voters: match.players.size });
}
function onVote(c, msg) {
  const match = matches.get(c.matchId);
  if (!match || match.phase !== 'vote') return;
  const mapId = String(msg.mapId || '');
  if (!match.vote.options.includes(mapId)) return;
  match.vote.votes.set(c.id, mapId);
  broadcastVote(match);
}
function finishVote(match) {
  if (match.phase !== 'vote') return;
  clearTimeout(match.vote.timer);
  const t = talliesOf(match);
  const max = Math.max(...Object.values(t));
  const top = match.vote.options.filter((id) => t[id] === max);
  match.mapId = top[Math.floor(Math.random() * top.length)];
  match.phase = 'live';
  const at = now() + LOAD_GRACE_MS;
  for (const p of match.players.values()) { p.spawnedAt = at; p.health = 100; p.alive = true; }
  broadcast(match, { type: 'map_selected', matchId: match.id, mapId: match.mapId, tallies: t });
  log(`match ${match.id} map vote -> ${match.mapId} ${JSON.stringify(t)}`);
}

// ---------- queue ----------
function queueStatus(mode) {
  const q = queues[mode];
  const cd = countdowns[mode];
  const startsIn = cd ? Math.max(0, Math.ceil((cd.endsAt - now()) / 1000)) : null;
  for (const id of q) send(clients.get(id), { type: 'queue_status', mode, queued: q.length, minimum: MIN_PLAYERS, maximum: MAX_PLAYERS, startsIn });
}
function removeFromQueue(c) {
  for (const mode of Object.keys(queues)) {
    const i = queues[mode].indexOf(c.id);
    if (i >= 0) {
      queues[mode].splice(i, 1);
      if (queues[mode].length < MIN_PLAYERS) stopCountdown(mode);
      queueStatus(mode);
    }
  }
  c.queuedMode = null;
}
function stopCountdown(mode) {
  const cd = countdowns[mode];
  if (cd) { clearInterval(cd.timer); delete countdowns[mode]; }
}
function checkQueue(mode) {
  const q = queues[mode];
  if (q.length >= MAX_PLAYERS) { stopCountdown(mode); startMatch(mode); return; }
  if (q.length >= MIN_PLAYERS && !countdowns[mode]) {
    if (COUNTDOWN_S === 0) { startMatch(mode); return; }
    const cd = { endsAt: now() + COUNTDOWN_S * 1000, timer: null };
    cd.timer = setInterval(() => {
      if (queues[mode].length < MIN_PLAYERS) { stopCountdown(mode); queueStatus(mode); return; }
      if (now() >= cd.endsAt) { stopCountdown(mode); startMatch(mode); return; }
      queueStatus(mode);
    }, 1000);
    countdowns[mode] = cd;
  }
  queueStatus(mode);
}
function openMatchFor(mode) {
  let best = null;
  for (const m of matches.values()) {
    if (m.mode !== mode || m.ended || m.players.size >= MAX_PLAYERS || m.players.size === 0) continue;
    if (!best || m.players.size > best.players.size) best = m;
  }
  return best;
}
function joinQueue(c, msg) {
  if (c.matchId) leaveMatch(c, false);
  removeFromQueue(c);
  c.name = cleanName(msg.name || c.name);
  const mode = modeOf(msg.mode);
  const open = openMatchFor(mode);
  if (open) { addToMatch(open, c, true); return; }
  queues[mode].push(c.id);
  c.queuedMode = mode;
  checkQueue(mode);
}

// ---------- matches ----------
function pickTeam(match) {
  if (match.ffa) return 'ffa';
  let a = 0, b = 0;
  for (const p of match.players.values()) p.team === 'alpha' ? a++ : b++;
  return a <= b ? 'alpha' : 'bravo';
}
function startMatch(mode) {
  const ids = queues[mode].splice(0, MAX_PLAYERS);
  const match = {
    id: newId('m'), mode, ffa: MODES[mode].ffa, scoreLimit: MODES[mode].scoreLimit, score: { alpha: 0, bravo: 0 },
    players: new Map(), tags: new Map(), ended: false, createdAt: now(),
    phase: VOTE_S > 0 ? 'vote' : 'live', mapId: null,
    vote: { options: shuffled(MAPS).slice(0, 3), votes: new Map(), endsAt: now() + VOTE_S * 1000, timer: null },
  };
  if (match.phase === 'vote') match.vote.timer = setTimeout(() => finishVote(match), VOTE_S * 1000);
  else match.mapId = match.vote.options[0];
  matches.set(match.id, match);
  for (const id of ids) {
    const c = clients.get(id);
    if (!c) continue;
    c.queuedMode = null;
    addToMatch(match, c, false);
  }
  for (const id of match.players.keys()) sendMatchFound(match, clients.get(id));
  queueStatus(mode);
  log(`match ${match.id} (${mode}) started with ${match.players.size} player(s)`);
}
function sendMatchFound(match, c) {
  send(c, {
    type: 'match_found', matchId: match.id, mode: match.mode, ffa: match.ffa, playerId: c.id, roster: rosterOf(match),
    score: { ...match.score }, scoreLimit: match.scoreLimit, tags: [...match.tags.values()],
    phase: match.phase, mapId: match.mapId, vote: voteInfo(match, c.id), players: match.ffa ? boardOf(match) : undefined,
  });
  // Bring the newcomer up to date on where everyone is.
  for (const p of match.players.values()) {
    if (p.id === c.id || !p.state) continue;
    send(c, { type: 'player_state', matchId: match.id, playerId: p.id, state: p.state });
  }
}
function addToMatch(match, c, inProgress) {
  removeFromQueue(c);
  const p = { id: c.id, name: c.name, team: pickTeam(match), health: 100, alive: true, kills: 0, deaths: 0, score: 0, state: null, pos: null, joinedAt: now(), spawnedAt: now() + (match.phase === 'vote' ? LOAD_GRACE_MS : 0), diedAt: 0 };
  match.players.set(c.id, p);
  c.matchId = match.id;
  if (inProgress) {
    sendMatchFound(match, c);
    broadcast(match, { type: 'player_joined', matchId: match.id, player: { id: p.id, name: p.name, team: p.team } }, c.id);
    broadcast(match, { type: 'match_update', matchId: match.id, roster: rosterOf(match) }, c.id);
    broadcastVote(match);
    log(`${c.name} joined match ${match.id} in progress (${match.players.size} players)`);
  }
}
function leaveMatch(c, notify = true) {
  const match = matches.get(c.matchId);
  c.matchId = null;
  if (!match) return;
  match.players.delete(c.id);
  if (notify) send(c, { type: 'match_left', matchId: match.id });
  broadcast(match, { type: 'player_left', matchId: match.id, playerId: c.id });
  if (match.players.size > 0) { broadcast(match, { type: 'match_update', matchId: match.id, roster: rosterOf(match) }); broadcastVote(match); if (match.ffa) broadcast(match, scoreMsg(match)); }
  else { clearTimeout(match.vote?.timer); matches.delete(match.id); log(`match ${match.id} closed`); }
}
function endMatch(match, winner) {
  if (match.ended) return;
  match.ended = true;
  const msg = { type: 'match_ended', matchId: match.id, winner, score: { ...match.score } };
  if (match.ffa) { msg.ffa = true; msg.players = boardOf(match); msg.winnerName = match.players.get(winner)?.name || null; msg.scoreLimit = match.scoreLimit; }
  broadcast(match, msg);
  log(`match ${match.id} ended · winner ${winner}`);
}
function addScore(match, team, pts) {
  if (match.ended) return;
  match.score[team] = (match.score[team] || 0) + pts;
  broadcast(match, scoreMsg(match));
  if (match.score[team] >= match.scoreLimit) endMatch(match, team);
}
function addPlayerScore(match, p, pts) {
  if (match.ended) return;
  p.score += pts;
  broadcast(match, scoreMsg(match));
  if (p.score >= match.scoreLimit) endMatch(match, p.id);
}

function onHit(c, msg) {
  const match = matches.get(c.matchId);
  if (!match || match.ended || match.phase !== 'live') return;
  const attacker = match.players.get(c.id);
  const target = match.players.get(String(msg.targetId));
  if (!attacker || !target || !target.alive || !attacker.alive || target.id === attacker.id) return;
  if (!match.ffa && target.team === attacker.team) return; // no friendly fire
  if (now() - target.spawnedAt < SPAWN_PROTECT_MS) return; // fresh spawn
  const amount = Math.max(0, Math.min(250, num(msg.amount)));
  if (!amount) return;
  target.health = Math.max(0, target.health - amount);
  const zone = typeof msg.zone === 'string' ? msg.zone.slice(0, 16) : 'torso';
  broadcast(match, { type: 'player_damaged', matchId: match.id, attackerId: attacker.id, targetId: target.id, amount, health: target.health, zone });
  if (target.health > 0) return;
  target.alive = false;
  target.diedAt = now();
  target.deaths++;
  attacker.kills++;
  broadcast(match, { type: 'player_killed', matchId: match.id, attackerId: attacker.id, targetId: target.id, zone, attackerName: attacker.name, targetName: target.name });
  if (match.mode === 'kc') {
    const pos = target.pos || { x: 0, y: 0, z: 0 };
    const tag = { id: newId('t'), x: pos.x, y: pos.y, z: pos.z, team: target.team, victimId: target.id, killerId: attacker.id, createdAt: now() };
    match.tags.set(tag.id, tag);
    broadcast(match, { type: 'tag_spawned', matchId: match.id, tag });
  } else {
    addScore(match, attacker.team, 1);
  }
}
// Kill Confirmed is free-for-all: any tag except your own confirms a kill for you.
function tagConfirms(match, tag, p) {
  return match.ffa ? tag.victimId !== p.id : tag.team !== p.team;
}
function onTagPickup(c, msg) {
  const match = matches.get(c.matchId);
  if (!match || match.ended || match.mode !== 'kc' || match.phase !== 'live') return;
  const p = match.players.get(c.id);
  const tag = match.tags.get(String(msg.tagId));
  if (!p || !p.alive || !tag) return;
  if (p.pos) {
    const d = Math.hypot(p.pos.x - tag.x, p.pos.z - tag.z);
    if (d > 4) return; // too far away to have touched it
  }
  match.tags.delete(tag.id);
  const confirmed = tagConfirms(match, tag, p);
  broadcast(match, { type: 'tag_removed', matchId: match.id, tagId: tag.id, by: p.id, byName: p.name, team: p.team, confirmed, reason: confirmed ? 'confirmed' : 'denied' });
  if (confirmed) match.ffa ? addPlayerScore(match, p, 1) : addScore(match, p.team, 1);
}
function onState(c, msg) {
  const match = matches.get(c.matchId);
  if (!match) return;
  const p = match.players.get(c.id);
  if (!p || !msg.state || typeof msg.state !== 'object') return;
  const s = msg.state, pos = s.position || s;
  const x = num(pos.x, NaN), y = num(pos.y, NaN), z = num(pos.z, NaN);
  if (![x, y, z].every(Number.isFinite)) return;
  p.pos = { x, y, z };
  // A client that says it is alive long after the server marked it dead missed a
  // death or respawn message; trust the client so it does not stay invisible.
  if (!p.alive && s.alive !== false && now() - p.diedAt > 8000) { p.alive = true; p.health = 100; p.spawnedAt = now(); }
  p.state = {
    position: { x, y, z }, x, y, z,
    yaw: num(s.yaw), pitch: num(s.pitch),
    stance: typeof s.stance === 'string' ? s.stance.slice(0, 12) : 'stand',
    moving: !!s.moving, sprinting: !!s.sprinting,
    weaponId: typeof s.weaponId === 'string' ? s.weaponId.slice(0, 24) : null,
    variant: typeof s.variant === 'string' ? s.variant.slice(0, 24) : null,
    alive: s.alive !== false && p.alive,
  };
  broadcast(match, { type: 'player_state', matchId: match.id, playerId: p.id, state: p.state }, c.id);
}
function onRespawn(c, msg) {
  const match = matches.get(c.matchId);
  if (!match) return;
  const p = match.players.get(c.id);
  if (!p) return;
  p.health = 100;
  p.alive = true;
  p.spawnedAt = now();
  const pos = msg.position || {};
  const x = num(pos.x, NaN), y = num(pos.y, NaN), z = num(pos.z, NaN);
  if ([x, y, z].every(Number.isFinite)) p.pos = { x, y, z };
  broadcast(match, { type: 'player_respawned', matchId: match.id, playerId: p.id, state: p.pos ? { position: p.pos, ...p.pos, alive: true } : { alive: true } }, c.id);
}

function handle(c, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'join_queue': joinQueue(c, msg); break;
    case 'cancel_queue': removeFromQueue(c); send(c, { type: 'queue_cancelled' }); break;
    case 'leave_match': leaveMatch(c, true); break;
    case 'player_state': onState(c, msg); break;
    case 'player_hit': onHit(c, msg); break;
    case 'player_respawn': onRespawn(c, msg); break;
    case 'tag_pickup': onTagPickup(c, msg); break;
    case 'vote_map': onVote(c, msg); break;
    case 'weapon_fired': {
      const match = matches.get(c.matchId);
      if (match) broadcast(match, { type: 'weapon_fired', matchId: match.id, playerId: c.id, weaponId: typeof msg.weaponId === 'string' ? msg.weaponId.slice(0, 24) : null }, c.id);
      break;
    }
    case 'player_ready': {
      const match = matches.get(c.matchId);
      if (match) { send(c, scoreMsg(match)); for (const t of match.tags.values()) send(c, { type: 'tag_spawned', matchId: match.id, tag: t }); if (match.phase === 'vote') send(c, { type: 'map_vote', matchId: match.id, ...voteInfo(match, c.id) }); }
      break;
    }
    case 'ping': send(c, { type: 'pong', t: msg.t }); break;
    default: break;
  }
}

// ---------- housekeeping ----------
setInterval(() => {
  const t = now();
  for (const match of matches.values()) {
    for (const tag of match.tags.values()) {
      if (t - tag.createdAt > TAG_LIFETIME_S * 1000) {
        match.tags.delete(tag.id);
        broadcast(match, { type: 'tag_removed', matchId: match.id, tagId: tag.id, reason: 'expired' });
      }
    }
    if (match.ended && t - match.createdAt > 6 * 3600 * 1000) matches.delete(match.id);
  }
}, 2000);

function log(s) { console.log(`[${new Date().toISOString()}] ${s}`); }

const server = http.createServer((req, res) => {
  const path = (req.url || '/').split('?')[0];
  if (path === '/' || path === '/health' || path === '/status') {
    let players = 0;
    for (const m of matches.values()) players += m.players.size;
    const body = JSON.stringify({
      ok: true, service: 'vangaurd-matchmaking', version: VERSION,
      queued: queues.tdm.length + queues.kc.length, queuedByMode: { tdm: queues.tdm.length, kc: queues.kc.length },
      matchMinSize: MIN_PLAYERS, matchMaxSize: MAX_PLAYERS, matches: matches.size, playersInMatches: players, connected: clients.size,
      maps: MAPS, mapVoteSeconds: VOTE_S, modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { name: v.name, scoreLimit: v.scoreLimit, ffa: v.ffa }])),
    });
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// Optional WebSocket Origin allowlist (comma separated). Leave unset for the standalone/desktop builds.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? new Set(process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean))
  : null;
const wss = new WebSocketServer({
  server, maxPayload: 16 * 1024,
  verifyClient: ({ origin }) => !allowedOrigins || !origin || origin === 'null' || allowedOrigins.has(origin),
});
wss.on('connection', (ws) => {
  const c = { id: newId('p'), ws, name: 'Player', matchId: null, queuedMode: null, alive: true };
  clients.set(c.id, c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => handle(c, data.toString()));
  ws.on('close', () => {
    removeFromQueue(c);
    if (c.matchId) leaveMatch(c, false);
    clients.delete(c.id);
  });
  ws.on('error', () => {});
  send(c, { type: 'connected', playerId: c.id, version: VERSION, matchMinSize: MIN_PLAYERS, matchMaxSize: MAX_PLAYERS });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

server.listen(PORT, () => log(`vangaurd matchmaking ${VERSION} on :${PORT} · min ${MIN_PLAYERS} · max ${MAX_PLAYERS}`));
