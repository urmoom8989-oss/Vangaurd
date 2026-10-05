// Vangaurd matchmaking + match relay server.
// Speaks the same WebSocket protocol as the game client (path /ws).
// Railway: root directory /server, start command `npm start`; it listens on $PORT.
import http from 'node:http';
import { createModeration, cleanDevice } from './moderation.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import pathMod from 'node:path';
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
const VERSION = '2.7.0';
// ---------- client version gate ----------
// Only the newest game build may play online. The newest build number is read from the
// version.json attached to the latest GitHub release (refreshed every 5 minutes).
// MIN_CLIENT_BUILD sets a floor (and is used if GitHub cannot be reached); VERSION_GATE=off disables the check.
const GATE = String(process.env.VERSION_GATE || 'on').toLowerCase() !== 'off';
const LATEST_URL = process.env.LATEST_VERSION_URL || 'https://github.com/urmoom8989-oss/opus-of-duty/releases/latest/download/version.json';
const RELEASE_PAGE = process.env.RELEASE_PAGE_URL || 'https://github.com/urmoom8989-oss/opus-of-duty/releases/latest';
const latest = { build: Math.max(0, Math.floor(Number(process.env.MIN_CLIENT_BUILD ?? 1)) || 0), label: 'Beta 1.03', checkedAt: 0, source: 'env' };
async function refreshLatest() {
  if (!GATE || String(process.env.LATEST_VERSION_URL || '').toLowerCase() === 'off') return;
  try {
    const res = await fetch(LATEST_URL, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = await res.json();
    const b = Math.floor(Number(v.build));
    if (Number.isFinite(b) && b > 0) {
      if (b !== latest.build) log(`latest client build ${latest.build} -> ${b} (${v.label || ''})`);
      latest.build = Math.max(b, Math.floor(Number(process.env.MIN_CLIENT_BUILD) || 0));
      latest.label = typeof v.label === 'string' ? v.label.slice(0, 40) : latest.label;
      latest.source = 'github';
    }
    latest.checkedAt = Date.now();
  } catch (e) {
    log(`could not read the latest build (${e.message}); keeping build ${latest.build}`);
  }
}
refreshLatest();
setInterval(refreshLatest, 5 * 60 * 1000);
function clientOutdated(c, msg) {
  if (!GATE) return false;
  const b = Math.floor(num(msg.clientBuild ?? msg.build, 0));
  c.build = b;
  if (b >= latest.build) return false;
  send(c, {
    type: 'error', code: 'outdated', latestBuild: latest.build, latestLabel: latest.label, yourBuild: b || null, downloadUrl: RELEASE_PAGE,
    message: `Your game is out of date. Update to Vangaurd ${latest.label} to play online.`,
  });
  log(`refused outdated client ${c.id} (build ${b || 'none'} < ${latest.build})`);
  return true;
}


// ---------- accounts ----------
// Username + password accounts. Passwords are stored only as salted scrypt hashes; sessions are random tokens
// (stored as SHA-256 hashes). Everything lives in DATA_DIR/accounts.json, so DATA_DIR must be on a persistent
// volume (Railway: mount a volume at /data and set DATA_DIR=/data).
const DATA_DIR = process.env.DATA_DIR || pathMod.join(process.cwd(), 'data');
const ACCOUNTS_FILE = pathMod.join(DATA_DIR, 'accounts.json');
const SESSION_DAYS = Math.max(1, Number(process.env.SESSION_DAYS) || 60);
const accounts = { users: {}, sessions: {} };
try {
  const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  if (raw && typeof raw === 'object') { accounts.users = raw.users || {}; accounts.sessions = raw.sessions || {}; }
} catch (e) { if (e.code !== 'ENOENT') console.error('could not read accounts:', e.message); }
let saveTimer = null;
function writeAccounts() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${ACCOUNTS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(accounts));
    fs.renameSync(tmp, ACCOUNTS_FILE);
  } catch (e) { console.error('could not save accounts:', e.message); }
}
// New accounts, sign-ins and sign-outs are written straight away; "last used" bumps are batched.
function saveAccounts(urgent = true) {
  if (urgent) return writeAccounts();
  if (!saveTimer) saveTimer = setTimeout(writeAccounts, 5000);
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { if (saveTimer) writeAccounts(); if (savesTimer) writeSaves(); mod.flush(); process.exit(0); });
const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const RESERVED = new Set(['player', 'admin', 'administrator', 'moderator', 'server', 'vangaurd', 'system', 'bot', 'guest']);
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(String(pw), Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k.toString('hex')))));
}
function newSession(name) {
  const token = crypto.randomBytes(32).toString('hex');
  accounts.sessions[sha(token)] = { user: name.toLowerCase(), created: now(), lastUsed: now() };
  saveAccounts();
  return token;
}
function sessionUser(token) {
  if (typeof token !== 'string' || token.length !== 64) return null;
  const k = sha(token), ses = accounts.sessions[k];
  if (!ses) return null;
  const u = accounts.users[ses.user];
  if (!u || now() - (ses.lastUsed || ses.created) > SESSION_DAYS * 864e5) { delete accounts.sessions[k]; saveAccounts(); return null; }
  if (now() - ses.lastUsed > 36e5) { ses.lastUsed = now(); saveAccounts(false); }
  return u;
}
// Simple brute-force guard: at most 10 failed attempts per address per 10 minutes.
const failures = new Map();
function limited(c) {
  const f = failures.get(c.ip);
  return f && f.n >= 10 && now() - f.t < 10 * 60e3;
}
function failed(c) {
  const f = failures.get(c.ip);
  if (!f || now() - f.t > 10 * 60e3) failures.set(c.ip, { n: 1, t: now() }); else f.n++;
}
function authOk(c, u, token, created = false) {
  c.account = u.name;
  c.name = u.name;
  send(c, { type: 'auth_ok', username: u.name, token, created });
  mod.noteDevice(u, c.device);
  goOnline(c);
}
function authError(c, code, message) { send(c, { type: 'auth_error', code, message }); }
// Banned: refuse (every game version shows the auth_error message; Beta 0.95+ also shows the ban screen).
function refuseBanned(c, v) {
  const message = mod.banMessage(v);
  send(c, { type: 'auth_error', code: 'banned', message, ban: v });
  send(c, { type: 'banned', ban: v, message });
}
async function onRegister(c, msg) {
  if (limited(c)) return authError(c, 'too_many', 'Too many attempts. Wait a few minutes and try again.');
  c.device = cleanDevice(msg.device) || c.device;
  { const b = mod.checkDevice(c.device); if (b) return refuseBanned(c, b); }
  const name = String(msg.username || '').trim(), pw = String(msg.password || '');
  if (!NAME_RE.test(name)) return authError(c, 'bad_name', 'Usernames are 3 to 16 letters, numbers, - or _.');
  if (RESERVED.has(name.toLowerCase())) return authError(c, 'taken', 'That username is taken. Pick another one.');
  if (pw.length < 6 || pw.length > 64) return authError(c, 'bad_password', 'Passwords must be 6 to 64 characters long.');
  const key = name.toLowerCase();
  if (accounts.users[key]) { failed(c); return authError(c, 'taken', 'That username is taken. If it is yours, sign in instead.'); }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(pw, salt);
  if (accounts.users[key]) return authError(c, 'taken', 'That username is taken. If it is yours, sign in instead.');
  const u = accounts.users[key] = { name, salt, hash, created: now(), lastLogin: now() };
  saveAccounts();
  log(`account created: ${name}`);
  authOk(c, u, newSession(name), true);
}
async function onLogin(c, msg) {
  if (limited(c)) return authError(c, 'too_many', 'Too many attempts. Wait a few minutes and try again.');
  const name = String(msg.username || '').trim(), pw = String(msg.password || '');
  const u = accounts.users[name.toLowerCase()];
  const hash = await scrypt(pw, u ? u.salt : '00'.repeat(16));
  if (!u || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) {
    failed(c);
    return authError(c, 'bad_login', u ? 'Wrong password for that username.' : 'No account with that username. Create one instead.');
  }
  c.device = cleanDevice(msg.device) || c.device;
  { const b = mod.checkAccount(keyOf(u.name), c.device); if (b) return refuseBanned(c, b); }
  u.lastLogin = now();
  saveAccounts();
  authOk(c, u, newSession(u.name));
}
function onResume(c, msg) {
  const u = sessionUser(msg.token);
  if (!u) return authError(c, 'session_expired', 'Your sign-in has expired. Please sign in again.');
  c.device = cleanDevice(msg.device) || c.device;
  { const b = mod.checkAccount(keyOf(u.name), c.device); if (b) return refuseBanned(c, b); }
  authOk(c, u, msg.token);
}
function onLogout(c, msg) {
  if (typeof msg.token === 'string') { delete accounts.sessions[sha(msg.token)]; saveAccounts(); }
  goOffline(c);
  c.account = null;
  send(c, { type: 'logged_out' });
}

// ---------- friends, presence and parties ----------
// Friends are stored with the accounts. Presence and parties live in memory: a party is a group of
// signed-in friends that queue together and are put on the same team.
const MAX_PARTY = 6;
const online = new Map(); // account key -> Set of client connections
const parties = new Map(); // party id -> { id, leader, members: [keys], invites: Set(keys) }
const partyOf = new Map(); // account key -> party id
const keyOf = (name) => String(name || '').trim().toLowerCase();
const userOf = (key) => accounts.users[key] || null;
const nameOf = (key) => accounts.users[key]?.name || key;
function social(u) {
  u.friends ||= []; u.incoming ||= []; u.outgoing ||= [];
  return u;
}
function statusOf(key) {
  const set = online.get(key);
  if (!set || !set.size) return 'offline';
  let st = 'online';
  for (const c of set) { if (c.matchId) return 'match'; if (c.queuedMode) st = 'searching'; }
  return st;
}
function sendTo(key, msg) {
  const set = online.get(key);
  if (set) for (const c of set) send(c, msg);
}
function note(key, text, extra = {}) { sendTo(key, { type: 'social_note', text, ...extra }); }
function partyView(pid) {
  const pt = parties.get(pid);
  if (!pt) return null;
  return { id: pt.id, leader: nameOf(pt.leader), members: pt.members.map((k) => ({ name: nameOf(k), status: statusOf(k), leader: k === pt.leader })) };
}
function socialSnapshot(key) {
  const u = userOf(key);
  if (!u) return null;
  social(u);
  const invites = [];
  for (const pt of parties.values()) if (pt.invites.has(key)) invites.push({ partyId: pt.id, from: nameOf(pt.leader), size: pt.members.length });
  return {
    type: 'social', me: u.name,
    friends: u.friends.map((k) => ({ name: nameOf(k), status: statusOf(k), inParty: partyOf.get(k) != null && partyOf.get(k) === partyOf.get(key) })).sort((a, b) => (a.status === 'offline') - (b.status === 'offline') || a.name.localeCompare(b.name)),
    incoming: u.incoming.map(nameOf), outgoing: u.outgoing.map(nameOf), party: partyView(partyOf.get(key)), invites,
  };
}
function pushSocial(key) { const snap = socialSnapshot(key); if (snap) sendTo(key, snap); }
// Tell everyone who can see this account (friends and party) that something changed.
function pushAround(key) {
  pushSocial(key);
  const u = userOf(key);
  for (const f of u?.friends || []) pushSocial(f);
  const pt = parties.get(partyOf.get(key));
  if (pt) for (const m of pt.members) if (m !== key) pushSocial(m);
}
function goOnline(c) {
  const key = keyOf(c.account);
  if (!key) return;
  let set = online.get(key);
  if (!set) online.set(key, set = new Set());
  const was = set.size > 0;
  set.add(c);
  c.accountKey = key;
  if (!was) pushAround(key); else pushSocial(key);
}
function goOffline(c) {
  const key = c.accountKey;
  if (!key) return;
  const set = online.get(key);
  if (!set) return;
  set.delete(c);
  if (!set.size) {
    online.delete(key);
    // An offline player leaves their party after a short grace period (reconnects keep it).
    setTimeout(() => { if (!online.get(key)?.size && partyOf.has(key)) leaveParty(key); }, 60000);
    pushAround(key);
  }
}
function socialError(c, message) { send(c, { type: 'social_error', message }); }
function friendAdd(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.username);
  const u = userOf(me), t = userOf(them);
  if (!u) return;
  if (!t) return socialError(c, `There is no player called ${String(msg.username || '').slice(0, 16)}.`);
  if (them === me) return socialError(c, "You can't add yourself.");
  social(u); social(t);
  if (u.friends.includes(them)) return socialError(c, `${t.name} is already your friend.`);
  if (u.incoming.includes(them)) return friendAccept(c, { username: t.name });
  if (u.outgoing.includes(them)) return socialError(c, `You already sent ${t.name} a friend request.`);
  if (u.friends.length >= 200) return socialError(c, 'Your friends list is full (200).');
  u.outgoing.push(them); t.incoming.push(me);
  saveAccounts();
  note(them, `${u.name} sent you a friend request`, { kind: 'friend_request', from: u.name });
  pushSocial(me); pushSocial(them);
}
function friendAccept(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.username);
  const u = userOf(me), t = userOf(them);
  if (!u || !t) return;
  social(u); social(t);
  if (!u.incoming.includes(them)) return socialError(c, 'That friend request is no longer open.');
  u.incoming = u.incoming.filter((k) => k !== them); t.outgoing = t.outgoing.filter((k) => k !== me);
  if (!u.friends.includes(them)) u.friends.push(them);
  if (!t.friends.includes(me)) t.friends.push(me);
  saveAccounts();
  note(them, `${u.name} accepted your friend request`, { kind: 'friend_accepted', from: u.name });
  pushSocial(me); pushSocial(them);
}
function friendDecline(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.username);
  const u = userOf(me), t = userOf(them);
  if (!u) return;
  social(u);
  u.incoming = u.incoming.filter((k) => k !== them); u.outgoing = u.outgoing.filter((k) => k !== them);
  if (t) { social(t); t.outgoing = t.outgoing.filter((k) => k !== me); t.incoming = t.incoming.filter((k) => k !== me); }
  saveAccounts();
  pushSocial(me); if (t) pushSocial(them);
}
function friendRemove(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.username);
  const u = userOf(me), t = userOf(them);
  if (!u) return;
  social(u);
  u.friends = u.friends.filter((k) => k !== them);
  if (t) { social(t); t.friends = t.friends.filter((k) => k !== me); }
  saveAccounts();
  pushSocial(me); if (t) pushSocial(them);
}
function leaveParty(key) {
  const pid = partyOf.get(key);
  const pt = parties.get(pid);
  partyOf.delete(key);
  if (!pt) return;
  pt.members = pt.members.filter((k) => k !== key);
  if (pt.members.length <= 1) {
    for (const k of pt.members) { partyOf.delete(k); note(k, 'Your party was disbanded', { kind: 'party' }); pushSocial(k); }
    for (const k of pt.invites) pushSocial(k);
    parties.delete(pid);
  } else {
    if (pt.leader === key) pt.leader = pt.members[0];
    for (const k of pt.members) { note(k, `${nameOf(key)} left the party`, { kind: 'party' }); pushSocial(k); }
  }
  pushAround(key);
}
function partyInvite(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.username);
  const u = userOf(me), t = userOf(them);
  if (!u || !t) return socialError(c, 'That player does not exist.');
  social(u);
  if (!u.friends.includes(them)) return socialError(c, `Add ${t.name} as a friend first.`);
  if (statusOf(them) === 'offline') return socialError(c, `${t.name} is offline.`);
  let pid = partyOf.get(me), pt = parties.get(pid);
  if (pt && pt.leader !== me) return socialError(c, 'Only the party leader can invite players.');
  if (pt && pt.members.includes(them)) return socialError(c, `${t.name} is already in your party.`);
  if (!pt) {
    pid = newId('party');
    pt = { id: pid, leader: me, members: [me], invites: new Set() };
    parties.set(pid, pt); partyOf.set(me, pid);
  }
  if (pt.members.length + pt.invites.size >= MAX_PARTY) return socialError(c, `Parties hold up to ${MAX_PARTY} players.`);
  pt.invites.add(them);
  note(them, `${u.name} invited you to their party`, { kind: 'party_invite', from: u.name, partyId: pid });
  pushSocial(me); pushSocial(them);
}
function partyAccept(c, msg) {
  const me = keyOf(c.account), pt = parties.get(String(msg.partyId || ''));
  if (!pt || !pt.invites.has(me)) { socialError(c, 'That party invite has expired.'); return pushSocial(me); }
  if (pt.members.length >= MAX_PARTY) return socialError(c, 'That party is full.');
  if (partyOf.has(me) && partyOf.get(me) !== pt.id) leaveParty(me);
  pt.invites.delete(me);
  pt.members.push(me); partyOf.set(me, pt.id);
  for (const k of pt.members) { if (k !== me) note(k, `${nameOf(me)} joined the party`, { kind: 'party' }); pushSocial(k); }
  pushAround(me);
}
function partyDecline(c, msg) {
  const me = keyOf(c.account), pt = parties.get(String(msg.partyId || ''));
  if (pt) {
    pt.invites.delete(me);
    if (pt.members.length <= 1 && !pt.invites.size) { for (const k of pt.members) partyOf.delete(k); parties.delete(pt.id); }
    for (const k of pt.members) pushSocial(k);
  }
  pushSocial(me);
}
function partyKick(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.username), pt = parties.get(partyOf.get(me));
  if (!pt || pt.leader !== me || !pt.members.includes(them) || them === me) return;
  note(them, 'You were removed from the party', { kind: 'party' });
  leaveParty(them);
}
// The leader queued: bring the rest of the party along.
function partyFollow(c, mode) {
  const me = keyOf(c.account), pt = parties.get(partyOf.get(me));
  if (!pt || pt.leader !== me) return;
  for (const k of pt.members) if (k !== me && statusOf(k) !== 'match') sendTo(k, { type: 'party_queue', mode, leader: nameOf(me) });
}
function handleSocial(c, msg) {
  if (!c.account) return socialError(c, 'Sign in to use friends and parties.');
  switch (msg.type) {
    case 'social_state': pushSocial(keyOf(c.account)); break;
    case 'friend_add': friendAdd(c, msg); break;
    case 'friend_accept': friendAccept(c, msg); break;
    case 'friend_decline': friendDecline(c, msg); break;
    case 'friend_remove': friendRemove(c, msg); break;
    case 'party_invite': partyInvite(c, msg); break;
    case 'party_accept': partyAccept(c, msg); break;
    case 'party_decline': partyDecline(c, msg); break;
    case 'party_leave': leaveParty(keyOf(c.account)); break;
    case 'party_kick': partyKick(c, msg); break;
    default: break;
  }
}

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
function openMatchFor(mode, c = null) {
  // A party member goes to the match their party is already playing, if it has room.
  const pid = c?.accountKey ? partyOf.get(c.accountKey) : null;
  if (pid) {
    for (const k of parties.get(pid)?.members || []) {
      for (const pc of online.get(k) || []) {
        const m = pc.matchId && matches.get(pc.matchId);
        if (m && !m.ended && m.mode === mode && m.players.size < MAX_PLAYERS) return m;
      }
    }
  }
  let best = null;
  for (const m of matches.values()) {
    if (m.mode !== mode || m.ended || m.players.size >= MAX_PLAYERS || m.players.size === 0) continue;
    if (!best || m.players.size > best.players.size) best = m;
  }
  return best;
}
function joinQueue(c, msg) {
  if (clientOutdated(c, msg)) return;
  c.device = cleanDevice(msg.device) || c.device;
  if (!c.account && msg.token) { const u = sessionUser(msg.token); if (u) { const b = mod.checkAccount(keyOf(u.name), c.device); if (b) return refuseBanned(c, b); c.account = u.name; goOnline(c); } }
  if (c.account) { const b = mod.checkAccount(keyOf(c.account), c.device); if (b) return mod.kickNow(c, b); }
  if (!c.account) {
    send(c, { type: 'error', code: 'login_required', message: 'Sign in to your Vangaurd account to play online.' });
    return;
  }
  if (c.matchId) leaveMatch(c, false);
  removeFromQueue(c);
  c.name = c.account;
  const mode = modeOf(msg.mode);
  partyFollow(c, mode);
  const open = openMatchFor(mode, c);
  if (open) { addToMatch(open, c, true); if (c.accountKey) pushAround(c.accountKey); return; }
  queues[mode].push(c.id);
  c.queuedMode = mode;
  if (c.accountKey) pushAround(c.accountKey);
  checkQueue(mode);
}

// ---------- matches ----------
function pickTeam(match, c = null) {
  if (match.ffa) return 'ffa';
  const pid = c?.accountKey ? partyOf.get(c.accountKey) : null;
  if (pid) {
    for (const p of match.players.values()) {
      const pc = clients.get(p.id);
      if (pc && pc.accountKey && partyOf.get(pc.accountKey) === pid) {
        let n = 0;
        for (const q of match.players.values()) if (q.team === p.team) n++;
        if (n < Math.ceil(MAX_PLAYERS / 2)) return p.team;
      }
    }
  }
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
  for (const id of match.players.keys()) { const pc = clients.get(id); if (pc?.accountKey) pushAround(pc.accountKey); }
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
  const p = { id: c.id, key: c.accountKey || keyOf(c.account), name: c.name, team: pickTeam(match, c), health: 100, alive: true, kills: 0, deaths: 0, score: 0, state: null, pos: null, joinedAt: now(), spawnedAt: now() + (match.phase === 'vote' ? LOAD_GRACE_MS : 0), diedAt: 0 };
  match.players.set(c.id, p);
  c.matchId = match.id;
  mod.matchSeen(match);
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
  if (c.accountKey) setTimeout(() => pushAround(c.accountKey), 0);
  if (!match) return;
  mod.matchSeen(match);
  match.players.delete(c.id);
  if (notify) send(c, { type: 'match_left', matchId: match.id });
  broadcast(match, { type: 'player_left', matchId: match.id, playerId: c.id });
  if (match.players.size > 0) { broadcast(match, { type: 'match_update', matchId: match.id, roster: rosterOf(match) }); broadcastVote(match); if (match.ffa) broadcast(match, scoreMsg(match)); }
  else { clearTimeout(match.vote?.timer); matches.delete(match.id); log(`match ${match.id} closed`); }
}
function endMatch(match, winner) {
  if (match.ended) return;
  match.ended = true;
  mod.matchSeen(match);
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
    moving: !!s.moving, sprinting: !!s.sprinting, quiet: !!s.quiet,
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

// Ping marks: relayed to teammates (rate limited).
function onMark(c, msg) {
  const match = matches.get(c.matchId);
  if (!match || match.ended || match.phase !== 'live') return;
  const p = match.players.get(c.id);
  if (!p) return;
  const t = now();
  if (t - (c.lastMark || 0) < 250) return;
  c.lastMark = t;
  const x = num(msg.x, NaN), y = num(msg.y, NaN), z = num(msg.z, NaN);
  if (![x, y, z].every(Number.isFinite)) return;
  const kind = msg.kind === 'enemy' ? 'enemy' : msg.kind === 'remove' ? 'remove' : 'spot';
  const targetId = typeof msg.targetId === 'string' && match.players.has(msg.targetId) ? msg.targetId : null;
  const out = { type: 'mark', matchId: match.id, playerId: p.id, name: p.name, team: p.team, kind, x, y, z, id: typeof msg.id === 'string' ? msg.id.slice(0, 24) : null, targetId };
  for (const q of match.players.values()) if (q.id !== p.id && (match.ffa ? false : q.team === p.team)) send(clients.get(q.id), out);
}
// ---------- cloud saves ----------
// Each account's game data (progression, loadouts, camos, perks, settings, records) exactly as the game sends it,
// so signing in on another device brings everything along. Kept in DATA_DIR/saves.json (same persistent volume as
// the accounts). Every upload bumps "rev"; an upload made from an older rev is refused with the current save
// (data_conflict) so the game can decide which one to keep.
const SAVES_FILE = pathMod.join(DATA_DIR, 'saves.json');
const SAVE_MAX = 256 * 1024;
// Cloud saves started with Beta 0.94. Accounts created before then never had a save of their own: their progress
// lived on each device, so the first device they sign in on brings its progress along instead of starting fresh.
const CLOUD_SAVES_SINCE = Date.UTC(2026, 9, 5, 12, 18);
let saves = {};
try {
  const raw = JSON.parse(fs.readFileSync(SAVES_FILE, 'utf8'));
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) saves = raw;
} catch (e) { if (e.code !== 'ENOENT') console.error('could not read saves:', e.message); }
let savesTimer = null;
function writeSaves() {
  if (savesTimer) { clearTimeout(savesTimer); savesTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${SAVES_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saves));
    fs.renameSync(tmp, SAVES_FILE);
  } catch (e) { console.error('could not save game data:', e.message); }
}
function onData(c, msg) {
  const key = c.account ? keyOf(c.account) : null;
  if (!key || !userOf(key)) return send(c, { type: 'data_error', code: 'login_required', message: 'Sign in to save your progress to your account.' });
  const cur = saves[key] || { rev: 0, at: 0, blob: null };
  if (msg.type === 'data_get') return send(c, { type: 'data', rev: cur.rev, at: cur.at, blob: cur.blob, legacy: (userOf(key)?.created || 0) < CLOUD_SAVES_SINCE });
  const blob = msg.blob;
  if (typeof blob !== 'string' || !blob.length || blob.length > SAVE_MAX) return send(c, { type: 'data_error', code: 'bad_data', message: 'That save is empty or too large.' });
  try {
    const o = JSON.parse(blob);
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
  } catch { return send(c, { type: 'data_error', code: 'bad_data', message: 'That save could not be read.' }); }
  if (!msg.force && Math.floor(num(msg.baseRev, -1)) !== cur.rev) return send(c, { type: 'data_conflict', rev: cur.rev, at: cur.at, blob: cur.blob });
  const t = now();
  saves[key] = { rev: cur.rev + 1, at: t, blob };
  if (!savesTimer) savesTimer = setTimeout(writeSaves, 1500);
  send(c, { type: 'data_saved', rev: saves[key].rev, at: t });
}
// ---------- moderation (bans, reports, /admin console) ----------
// A banned player is told why, taken out of their queue or match and disconnected.
function kickClient(c, msg) {
  send(c, msg);
  removeFromQueue(c);
  if (c.matchId) leaveMatch(c, false);
  goOffline(c);
  c.account = null;
  setTimeout(() => { try { c.ws.close(4003, msg.type || 'kicked'); } catch { /* gone */ } }, 400);
}
const mod = createModeration({
  DATA_DIR, accounts, saveAccounts, online, clients, statusOf, keyOf, userOf, nameOf, scrypt, now, log, send,
  kick: kickClient, saveOf: (key) => saves[key]?.blob || null,
  putSave(key, blob) {
    const cur = saves[key] || { rev: 0 };
    saves[key] = { rev: cur.rev + 1, at: now(), blob };
    if (!savesTimer) savesTimer = setTimeout(writeSaves, 1500);
    sendTo(key, { type: 'data', rev: saves[key].rev, at: saves[key].at, blob, admin: true });
    return saves[key].rev;
  },
});
mod.kickNow = (c, b) => kickClient(c, mod.bannedMsg(b));
function handle(c, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'join_queue': joinQueue(c, msg); break;
    case 'cancel_queue': {
      removeFromQueue(c); send(c, { type: 'queue_cancelled' });
      const pt = c.accountKey && parties.get(partyOf.get(c.accountKey));
      if (pt && pt.leader === c.accountKey) for (const k of pt.members) if (k !== c.accountKey) sendTo(k, { type: 'party_cancel', leader: nameOf(c.accountKey) });
      if (c.accountKey) pushAround(c.accountKey);
      break;
    }
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
    case 'ping': send(c, { type: 'pong', t: msg.t, seq: msg.seq, serverTime: now() }); break;
    case 'mark': onMark(c, msg); break;
    case 'hello': {
      c.build = Math.floor(num(msg.clientBuild, 0));
      const dev = cleanDevice(msg.device);
      if (dev) { c.device = dev; const b = mod.checkDevice(dev); send(c, b ? mod.bannedMsg(b) : { type: 'device_ok' }); }
      break;
    }
    case 'report': mod.onReport(c, msg); break;
    case 'register': onRegister(c, msg).catch((e) => { log(`register error: ${e.message}`); authError(c, 'server', 'The server could not create the account. Try again.'); }); break;
    case 'login': onLogin(c, msg).catch((e) => { log(`login error: ${e.message}`); authError(c, 'server', 'The server could not sign you in. Try again.'); }); break;
    case 'resume': onResume(c, msg); break;
    case 'social_state': case 'friend_add': case 'friend_accept': case 'friend_decline': case 'friend_remove':
    case 'party_invite': case 'party_accept': case 'party_decline': case 'party_leave': case 'party_kick':
      handleSocial(c, msg); break;
    case 'logout': onLogout(c, msg); break;
    case 'data_get': case 'data_put': onData(c, msg); break;
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
  if (path === '/admin' || path.startsWith('/admin/')) {
    mod.http(req, res, path).then((done) => { if (!done) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); } })
      .catch((e) => { log(`admin error: ${e.message}`); try { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":"Server error."}'); } catch { /* sent */ } });
    return;
  }
  if (path === '/' || path === '/health' || path === '/status') {
    let players = 0;
    for (const m of matches.values()) players += m.players.size;
    const body = JSON.stringify({
      ok: true, service: 'vangaurd-matchmaking', version: VERSION,
      queued: queues.tdm.length + queues.kc.length, queuedByMode: { tdm: queues.tdm.length, kc: queues.kc.length },
      matchMinSize: MIN_PLAYERS, matchMaxSize: MAX_PLAYERS, matches: matches.size, playersInMatches: players, connected: clients.size,
      maps: MAPS, mapVoteSeconds: VOTE_S, versionGate: GATE, accounts: Object.keys(accounts.users).length, saves: Object.keys(saves).length, online: online.size, parties: parties.size, accountsPersistent: !!process.env.DATA_DIR, minClientBuild: latest.build, latestLabel: latest.label, latestSource: latest.source, modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { name: v.name, scoreLimit: v.scoreLimit, ffa: v.ffa }])),
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
  server, maxPayload: 320 * 1024, // cloud saves (up to 256 KB) are the largest messages
  verifyClient: ({ origin }) => !allowedOrigins || !origin || origin === 'null' || allowedOrigins.has(origin),
});
wss.on('connection', (ws, req) => {
  const fwd = String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const c = { id: newId('p'), ws, name: 'Player', matchId: null, queuedMode: null, alive: true, account: null, ip: fwd || req?.socket?.remoteAddress || '?' };
  clients.set(c.id, c);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => handle(c, data.toString()));
  ws.on('close', () => {
    goOffline(c);
    removeFromQueue(c);
    if (c.matchId) leaveMatch(c, false);
    clients.delete(c.id);
  });
  ws.on('error', () => {});
  send(c, { type: 'connected', playerId: c.id, version: VERSION, matchMinSize: MIN_PLAYERS, matchMaxSize: MAX_PLAYERS, minClientBuild: GATE ? latest.build : 0, latestLabel: latest.label });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

server.listen(PORT, () => log(`vangaurd matchmaking ${VERSION} on :${PORT} · min ${MIN_PLAYERS} · max ${MAX_PLAYERS}`));
