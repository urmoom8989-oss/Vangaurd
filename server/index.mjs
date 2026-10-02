import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const MATCH_MIN_SIZE = Math.max(6, Math.min(12, Number(process.env.MATCH_MIN_SIZE) || 6));
const MATCH_MAX_SIZE = Math.max(MATCH_MIN_SIZE, Math.min(12, Number(process.env.MATCH_MAX_SIZE) || 12));
const MATCH_START_GRACE_MS = 30_000;
const server = createServer((request, response) => {
  if (request.url === '/health' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, service: 'vangaurd-matchmaking', queued: queue.length, matchMinSize: MATCH_MIN_SIZE, matchMaxSize: MATCH_MAX_SIZE }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const clients = new Map();
const rooms = new Map();
const queue = [];
let queueReadyAt = 0;
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? new Set(process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean))
  : null;

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function queueSnapshot() {
  return {
    type: 'queue_status',
    queued: queue.length,
    minimum: MATCH_MIN_SIZE,
    maximum: MATCH_MAX_SIZE,
    startsIn: queueReadyAt ? Math.max(0, Math.ceil((queueReadyAt - Date.now()) / 1000)) : null,
    names: queue.map((id) => clients.get(id)?.name).filter(Boolean),
  };
}

function broadcastQueue() {
  const snapshot = queueSnapshot();
  for (const id of queue) {
    const player = clients.get(id);
    if (player) send(player.socket, snapshot);
  }
}

function removeFromQueue(player) {
  const index = queue.indexOf(player.id);
  if (index >= 0) queue.splice(index, 1);
  player.queued = false;
  if (queue.length < MATCH_MIN_SIZE) queueReadyAt = 0;
  broadcastQueue();
}

function startMatch() {
  if (queue.length < MATCH_MIN_SIZE) {
    queueReadyAt = 0;
    broadcastQueue();
    return;
  }
  if (!queueReadyAt) queueReadyAt = Date.now() + MATCH_START_GRACE_MS;
  if (Date.now() < queueReadyAt) {
    broadcastQueue();
    return;
  }

  if (queue.length >= MATCH_MIN_SIZE) {
    const targetSize = Math.min(MATCH_MAX_SIZE, queue.length);
    const playerIds = queue.splice(0, targetSize);
    const matchId = randomUUID();
    const roster = playerIds.map((id, index) => {
      const player = clients.get(id);
      if (!player) return null;
      player.queued = false;
      player.matchId = matchId;
      player.team = index < playerIds.length / 2 ? 'alpha' : 'bravo';
      player.health = 100;
      player.deadAt = 0;
      player.spawnProtectedUntil = Date.now() + 2500;
      player.alive = true;
      return { id, name: player.name, team: player.team };
    }).filter(Boolean);
    if (roster.length < MATCH_MIN_SIZE) {
      for (const member of roster) {
        const player = clients.get(member.id);
        if (player) { player.matchId = null; player.queued = true; queue.push(player.id); }
      }
      queueReadyAt = Date.now() + MATCH_START_GRACE_MS;
      broadcastQueue();
      return;
    }
    const members = new Set(roster.map((player) => player.id));
    rooms.set(matchId, { members, score: { alpha: 0, bravo: 0 } });
    for (const member of roster) {
      const player = clients.get(member.id);
      if (player) send(player.socket, { type: 'match_found', matchId, mode: 'tdm', roster });
    }
    queueReadyAt = queue.length >= MATCH_MIN_SIZE ? Date.now() + MATCH_START_GRACE_MS : 0;
  }
  broadcastQueue();
}

function joinQueue(player, message) {
  if (player.matchId) {
    send(player.socket, { type: 'error', code: 'already_in_match', message: 'Leave your current match before queueing again.' });
    return;
  }
  if (player.queued) { send(player.socket, queueSnapshot()); return; }
  const name = typeof message.name === 'string' ? message.name.trim().replace(/[<>\u0000-\u001f]/g, '').slice(0, 20) : '';
  player.name = name || `Player-${player.id.slice(0, 4)}`;
  player.queued = true;
  queue.push(player.id);
  startMatch();
}

function roomBroadcast(player, payload) {
  const room = rooms.get(player.matchId);
  if (!room) return false;
  for (const id of room.members) {
    if (id === player.id) continue;
    const peer = clients.get(id);
    if (peer) send(peer.socket, payload);
  }
  return true;
}

function validNumber(value, min, max) {
  return Number.isFinite(value) && value >= min && value <= max;
}

function receivePlayerState(player, message) {
  if (!player.matchId || !rooms.has(player.matchId)) return;
  const now = Date.now();
  if (now - player.lastStateAt < 70) return;
  const state = message.state;
  if (!state || !state.position || !['x', 'y', 'z'].every((axis) => validNumber(state.position[axis], -500, 500))) return;
  if (!validNumber(state.yaw, -Math.PI * 100, Math.PI * 100) || !validNumber(state.pitch, -Math.PI, Math.PI)) return;
  const pose = {
    x: state.position.x, y: state.position.y, z: state.position.z,
    yaw: state.yaw, pitch: state.pitch,
    stance: ['stand', 'crouch', 'prone'].includes(state.stance) ? state.stance : 'stand',
    moving: !!state.moving,
    sprinting: !!state.sprinting,
    weaponId: state.weaponId === 'pistol' ? 'pistol' : 'rifle',
    alive: player.health > 0 && state.alive !== false,
  };
  player.lastStateAt = now;
  player.latestState = pose;
  roomBroadcast(player, { type: 'player_state', matchId: player.matchId, playerId: player.id, state: pose });
}

function receiveWeaponCue(player, message) {
  if (!player.matchId || !rooms.has(player.matchId)) return;
  const now = Date.now();
  if (now - player.lastShotAt < 80) return;
  const weaponId = message.weaponId === 'pistol' ? 'pistol' : 'rifle';
  player.lastShotAt = now;
  roomBroadcast(player, { type: 'weapon_fired', matchId: player.matchId, playerId: player.id, weaponId, at: now });
}

function receivePlayerHit(player, message) {
  if (!player.matchId || !rooms.has(player.matchId) || player.health <= 0) return;
  const target = clients.get(message.targetId);
  if (!target || target.matchId !== player.matchId || target.id === player.id || target.health <= 0 || target.team === player.team) return;
  const now = Date.now();
  if (now < target.spawnProtectedUntil) return;
  if (now - player.lastHitAt < 80) return;
  const claimed = Number(message.amount);
  if (!Number.isFinite(claimed) || claimed <= 0) return;
  const amount = Math.min(55, claimed);
  player.lastHitAt = now;
  target.health = Math.max(0, target.health - amount);
  const killed = target.health === 0;
  if (killed) {
    target.deadAt = now;
    target.alive = false;
    const room = rooms.get(player.matchId);
    room.score[player.team] = (room.score[player.team] || 0) + 1;
  }
  const update = {
    type: 'player_damaged',
    matchId: player.matchId,
    targetId: target.id,
    attackerId: player.id,
    amount,
    health: target.health,
    zone: ['head', 'torso', 'limb'].includes(message.zone) ? message.zone : 'torso',
    killed,
  };
  const room = rooms.get(player.matchId);
  for (const id of room.members) {
    const member = clients.get(id);
    if (member) send(member.socket, update);
  }
  if (killed) {
    const score = { ...room.score };
    for (const id of room.members) {
      const member = clients.get(id);
      if (member) send(member.socket, { type: 'match_score', matchId: player.matchId, score, scoreLimit: 50 });
    }
  }
}

function receivePlayerReady(player) {
  if (!player.matchId || !rooms.has(player.matchId)) return;
  player.health = 100;
  player.deadAt = 0;
  player.spawnProtectedUntil = Date.now() + 3000;
  roomBroadcast(player, { type: 'player_ready', matchId: player.matchId, playerId: player.id });
}

function receivePlayerRespawn(player, message) {
  if (!player.matchId || !rooms.has(player.matchId) || player.health > 0 || !player.deadAt || Date.now() - player.deadAt < 2000 || !message.position) return;
  const { x, y, z } = message.position;
  if (![x, y, z].every((value) => validNumber(value, -500, 500))) return;
  player.health = 100;
  player.deadAt = 0;
  player.spawnProtectedUntil = Date.now() + 2500;
  player.alive = true;
  const state = player.latestState || {};
  player.latestState = { ...state, x, y, z, alive: true };
  roomBroadcast(player, { type: 'player_respawned', matchId: player.matchId, playerId: player.id, state: player.latestState });
}

function leaveMatch(player) {
  if (!player.matchId) return;
  const matchId = player.matchId;
  const room = rooms.get(matchId);
  player.matchId = null;
  player.latestState = null;
  player.health = 100;
  player.deadAt = 0;
  player.team = null;
  if (!room) return;
  room.members.delete(player.id);
  for (const id of room.members) {
    const peer = clients.get(id);
    if (peer) send(peer.socket, { type: 'player_left', matchId, playerId: player.id });
  }
  if (!room.members.size) rooms.delete(matchId);
}

function handleMessage(player, raw) {
  let message;
  try { message = JSON.parse(raw.toString()); }
  catch { send(player.socket, { type: 'error', code: 'invalid_json', message: 'Message must be valid JSON.' }); return; }
  if (!message || typeof message.type !== 'string') return;
  if (message.type === 'join_queue') {
    if (message.mode && message.mode !== 'tdm') {
      send(player.socket, { type: 'error', code: 'unsupported_mode', message: 'Only Team Deathmatch matchmaking is available.' });
      return;
    }
    joinQueue(player, message);
  } else if (message.type === 'cancel_queue') {
    removeFromQueue(player);
    send(player.socket, { type: 'queue_cancelled' });
  } else if (message.type === 'leave_match') {
    leaveMatch(player);
    send(player.socket, { type: 'match_left' });
  } else if (message.type === 'player_state') {
    receivePlayerState(player, message);
  } else if (message.type === 'weapon_fired') {
    receiveWeaponCue(player, message);
  } else if (message.type === 'player_hit') {
    receivePlayerHit(player, message);
  } else if (message.type === 'player_ready') {
    receivePlayerReady(player);
  } else if (message.type === 'player_respawn') {
    receivePlayerRespawn(player, message);
  } else if (message.type === 'ping') {
    send(player.socket, { type: 'pong', at: Date.now() });
  } else {
    send(player.socket, { type: 'error', code: 'unknown_message', message: 'Unsupported matchmaking message.' });
  }
}

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const origin = request.headers.origin;
  if (pathname !== '/ws' || (allowedOrigins && origin && origin !== 'null' && !allowedOrigins.has(origin))) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit('connection', webSocket, request));
});

wss.on('connection', (socket) => {
  const id = randomUUID();
  const player = { id, name: '', socket, queued: false, matchId: null, team: null, health: 100, deadAt: 0, spawnProtectedUntil: 0, alive: true, lastStateAt: 0, lastShotAt: 0, lastHitAt: 0, latestState: null };
  clients.set(id, player);
  send(socket, { type: 'connected', playerId: id, matchMinSize: MATCH_MIN_SIZE, matchMaxSize: MATCH_MAX_SIZE });
  socket.on('pong', () => { player.alive = true; });
  socket.on('message', (raw) => handleMessage(player, raw));
  socket.on('close', () => {
    removeFromQueue(player);
    leaveMatch(player);
    clients.delete(id);
  });
  socket.on('error', (error) => console.warn('[matchmaking] socket error:', error.message));
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    const player = [...clients.values()].find((candidate) => candidate.socket === socket);
    if (player && !player.alive) { socket.terminate(); continue; }
    if (player) player.alive = false;
    socket.ping();
  }
}, 25_000);

const matchmakingTimer = setInterval(() => {
  if (queueReadyAt) startMatch();
}, 1_000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[matchmaking] listening on ${PORT}; TDM match window=${MATCH_MIN_SIZE}-${MATCH_MAX_SIZE}`);
});

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(matchmakingTimer);
  for (const socket of wss.clients) socket.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
