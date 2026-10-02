import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const MATCH_SIZE = Math.max(2, Math.min(10, Number(process.env.MATCH_SIZE) || 10));
const server = createServer((request, response) => {
  if (request.url === '/health' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ ok: true, service: 'vangaurd-matchmaking', queued: queue.length, matchSize: MATCH_SIZE }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'not_found' }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const clients = new Map();
const rooms = new Map();
const queue = [];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? new Set(process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean))
  : null;

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function queueSnapshot() {
  return { type: 'queue_status', queued: queue.length, required: MATCH_SIZE, names: queue.map((id) => clients.get(id)?.name).filter(Boolean) };
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
  broadcastQueue();
}

function startMatch() {
  while (queue.length >= MATCH_SIZE) {
    const playerIds = queue.splice(0, MATCH_SIZE);
    const matchId = randomUUID();
    const roster = playerIds.map((id, index) => {
      const player = clients.get(id);
      if (!player) return null;
      player.queued = false;
      player.matchId = matchId;
      return { id, name: player.name, team: index < MATCH_SIZE / 2 ? 'alpha' : 'bravo' };
    }).filter(Boolean);
    if (roster.length < MATCH_SIZE) {
      for (const member of roster) {
        const player = clients.get(member.id);
        if (player) { player.matchId = null; player.queued = true; queue.push(player.id); }
      }
      break;
    }
    rooms.set(matchId, new Set(roster.map((player) => player.id)));
    for (const member of roster) {
      const player = clients.get(member.id);
      if (player) send(player.socket, { type: 'match_found', matchId, mode: 'tdm', roster });
    }
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
  broadcastQueue();
  startMatch();
}

function leaveMatch(player) {
  if (!player.matchId) return;
  const matchId = player.matchId;
  const members = rooms.get(matchId);
  player.matchId = null;
  if (!members) return;
  members.delete(player.id);
  for (const id of members) {
    const peer = clients.get(id);
    if (peer) send(peer.socket, { type: 'player_left', matchId, playerId: player.id });
  }
  if (!members.size) rooms.delete(matchId);
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
  const player = { id, name: '', socket, queued: false, matchId: null, alive: true };
  clients.set(id, player);
  send(socket, { type: 'connected', playerId: id, matchSize: MATCH_SIZE });
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[matchmaking] listening on ${PORT}; TDM match size=${MATCH_SIZE}`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of wss.clients) socket.close(1001, 'server shutdown');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
