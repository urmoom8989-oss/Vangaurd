// Vangaurd matchmaking + match relay server.
// Speaks the same WebSocket protocol as the game client (path /ws).
// Railway: root directory /server, start command `npm start`; it listens on $PORT.
import http from 'node:http';
import { createModeration, cleanDevice } from './moderation.mjs';
import { createMailer, codeEmail } from './mailer.mjs';
import { createOps } from './ops.mjs';
import { createTourneys, T_FFA_MAX } from './tourneys.mjs';
import { loadLos } from './los.mjs';
import zlib from 'node:zlib';
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
// Release 1.0: the match intro: a flyover of the map and a 5-second countdown before the fight (seconds, after the
// map loads; MATCH_INTRO=0 turns it off)
const INTRO_MS = (process.env.MATCH_INTRO !== undefined && process.env.MATCH_INTRO !== '' && Number.isFinite(Number(process.env.MATCH_INTRO)) ? Math.max(0, Number(process.env.MATCH_INTRO)) : 11.5) * 1000;
const startsIn = (match) => (match.startAt && match.startAt > now() ? Math.round((match.startAt - now()) / 100) / 10 : undefined);
// Release 1.0: after a match the lobby stays together and plays the next one after this many seconds (0 = off)
const LOBBY_NEXT_S = process.env.LOBBY_NEXT !== undefined && process.env.LOBBY_NEXT !== '' && Number.isFinite(Number(process.env.LOBBY_NEXT)) ? Math.max(0, Number(process.env.LOBBY_NEXT)) : 20;
// Release 1.0: tournament spectators see the match this many seconds late (so it can't be used to cheat)
const CASTER_DELAY_MS = (process.env.CASTER_DELAY !== undefined && process.env.CASTER_DELAY !== '' && Number.isFinite(Number(process.env.CASTER_DELAY)) ? Math.max(0, Number(process.env.CASTER_DELAY)) : 10) * 1000;
const VOTE_S = process.env.MAP_VOTE_SECONDS !== undefined && process.env.MAP_VOTE_SECONDS !== '' && Number.isFinite(Number(process.env.MAP_VOTE_SECONDS)) ? Math.max(0, Number(process.env.MAP_VOTE_SECONDS)) : 10;
const MAPS = ['vardanek', 'kessel', 'foundry', 'freighter', 'airfield', 'lindenhof'];
// Release 1.0 anti-cheat: the walls of every map, for the server's line-of-sight check (see los.mjs)
const LOS = loadLos(pathMod.join(pathMod.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), 'los-maps.json'));
// How far each gun can hit (the game's own ranges, plus a little): a hit from further away is thrown out.
const GUN_RANGE = { ar7: 450, smg9: 220, br4: 520, lmg60: 600, dmr14: 750, sg12: 60, sr50: 1200, p9: 150, mp20: 90, hc50: 160, p3b: 120 };
// Release 1.0 anti-cheat: each gun's damage per bullet and fire rate (from the game), and the melee weapons' reach
const GUN_DMG = { ar7: 31, smg9: 26, br4: 36, lmg60: 34, dmr14: 54, sg12: 20, sr50: 105, p9: 34, mp20: 21, hc50: 68, p3b: 28 };
const GUN_RPM = { ar7: 750, smg9: 920, br4: 900, lmg60: 680, dmr14: 320, sg12: 190, sr50: 70, p9: 420, mp20: 1050, hc50: 170, p3b: 1000 };
const MELEE_DMG = { knife: 150, machete: 150, axe: 200, bat: 160 }, MELEE_REACH = 6;
// Release 1.0: dropped guns: how long they lie there, how many at once, how close you must be to pick one up
const GUN_LIFE_MS = 30000, GUN_MAX = 24, GUN_REACH = 3.5;
const AC_FLAG_SCORE = Math.max(3, Number(process.env.AC_FLAG_SCORE) || 8);
const AC_WALL_MIN = Math.max(3, Number(process.env.AC_WALL_MIN) || 8), AC_WALL_SHARE = Math.min(1, Math.max(0.1, Number(process.env.AC_WALL_SHARE) || 0.4));
const MODES = {
  tdm: { name: 'Team Deathmatch', scoreLimit: Math.max(1, Number(process.env.TDM_SCORE_LIMIT) || 50), ffa: false },
  kc: { name: 'Kill Confirmed (free-for-all)', scoreLimit: Math.max(1, Number(process.env.KC_SCORE_LIMIT) || 20), ffa: true },
  // Release 1.0: Gun Game online (free-for-all): every kill moves you to the next of the game's 11 guns
  gg: { name: 'Gun Game (free-for-all)', scoreLimit: Math.max(1, Number(process.env.GG_SCORE_LIMIT) || 11), ffa: true },
  // Release 1.0: Blackout is Team Deathmatch with the lights out (only pumpkins and cauldrons give light)
  blackout: { name: 'Blackout', scoreLimit: Math.max(1, Number(process.env.BLACKOUT_SCORE_LIMIT) || 50), ffa: false },
};
// Release 1.0: the weekly mode. Online play always has Team Deathmatch plus one more mode that changes every Monday
// at 00:00 UTC; Team Deathmatch is never in the rotation. The owner can pin this week's mode in the console.
const WEEKLY_POOL = ['kc', 'gg', 'blackout'];
const WEEK_MS = 7 * 864e5, WEEK0 = Date.UTC(2026, 9, 12); // Monday 12 October 2026: Kill Confirmed, then Gun Game, then Blackout
const VERSION = '4.0.0';
// Where this server runs (shown in the game and on /health). The main server is NA East from Beta 1.3.
const REGION = String(process.env.REGION || 'na-east').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'na-east';
const REGION_NAMES = { 'na-east': 'North America', 'na-west': 'NA West', eu: 'Europe', 'eu-west': 'EU West' };
// Regions (Beta 1.3). The main server keeps accounts, friends, parties and moderation. Regional match servers
// (e.g. Europe) run the same code with MAIN_SERVER_URL and INTERNAL_KEY set: they only host matches and ask the
// main server who a player is (and whether they're banned, Steam, maintenance). The main server lists them to the
// game with REGIONS='[{"id":"eu","name":"Europe","url":"https://vangaurd-eu.up.railway.app"}]' (same INTERNAL_KEY).
const INTERNAL_KEY = String(process.env.INTERNAL_KEY || '');
const MAIN_URL = String(process.env.MAIN_SERVER_URL || '').replace(/\/+$/, '');
const REGIONAL = !!(MAIN_URL && INTERNAL_KEY);
let REGIONS = [];
try {
  REGIONS = (JSON.parse(process.env.REGIONS || '[]') || []).filter((r) => r && /^[a-z0-9-]{2,16}$/.test(r.id) && /^https?:\/\//.test(r.url))
    .map((r) => ({ id: r.id, name: String(r.name || REGION_NAMES[r.id] || r.id).slice(0, 24), url: String(r.url).replace(/\/+$/, '') }));
} catch { REGIONS = []; }
// ---------- client version gate ----------
// Only the newest game build may play online. The newest build is the highest of: the version.json attached to
// the latest GitHub release (read every 5 minutes; LATEST_VERSION_URL=off turns that off), server/latest.json,
// the build the owner sets in the /admin console, and MIN_CLIENT_BUILD. VERSION_GATE=off disables the check.
const GATE = String(process.env.VERSION_GATE || 'on').toLowerCase() !== 'off';
const LATEST_URL = process.env.LATEST_VERSION_URL || 'https://github.com/urmoom8989-oss/Vangaurd/releases/latest/download/version.json';
// Where outdated games are sent to update. RELEASE_PAGE_URL=steam tells them to update through Steam instead.
const RELEASE_PAGE = String(process.env.RELEASE_PAGE_URL || '').toLowerCase() === 'steam' ? null : process.env.RELEASE_PAGE_URL || 'https://github.com/urmoom8989-oss/Vangaurd/releases/latest';
const latest = { build: Math.max(0, Math.floor(Number(process.env.MIN_CLIENT_BUILD ?? 1)) || 0), label: 'Beta 1.04', checkedAt: 0, source: 'env' };
function raiseLatest(build, label, source) {
  const b = Math.floor(Number(build));
  if (!(b > 0) || b < latest.build) return;
  if (b !== latest.build) log(`latest client build ${latest.build} -> ${b} (${label || ''}, ${source})`);
  latest.build = b; latest.label = typeof label === 'string' && label ? label.slice(0, 40) : latest.label; latest.source = source;
}
try {
  const shipped = JSON.parse(fs.readFileSync(new URL('./latest.json', import.meta.url), 'utf8'));
  raiseLatest(shipped.build, shipped.label, 'server');
} catch (e) { if (e.code !== 'ENOENT') console.error('could not read latest.json:', e.message); }
async function refreshLatest() {
  if (!GATE || !LATEST_URL || LATEST_URL.toLowerCase() === 'off') return;
  try {
    const res = await fetch(LATEST_URL, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const v = await res.json();
    const b = Math.floor(Number(v.build));
    if (Number.isFinite(b) && b > 0) {
      raiseLatest(b, v.label, 'url');
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
    type: 'error', code: 'outdated', latestBuild: latest.build, latestLabel: latest.label, yourBuild: b || null, downloadUrl: RELEASE_PAGE, steam: !RELEASE_PAGE,
    message: RELEASE_PAGE ? `Your game is out of date. Update to Vangaurd ${latest.label} to play online.` : `Your game is out of date. Restart Steam to update Vangaurd to ${latest.label}, then play online.`,
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
// Usernames can never contain "Parallel" or "Developer", however they are written: any case, digits for letters
// (P4ra11el), - or _ in between, doubled letters. Existing accounts keep working; this only stops new ones.
function nameBlocked(name) {
  const leet = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/[0-9]/g, (d) => leet[d] || d);
  const sq = (s) => s.replace(/(.)\1+/g, '$1');
  return [n, n.replace(/i/g, 'l')].some((v) => ['parallel', 'developer'].some((w) => v.includes(w) || sq(v).includes(sq(w))));
}
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
// Release 1.0: a game build newer than the published one (latest.build) has not been released yet. Only the owner
// may sign in or play with it; everyone else is told the version is not available.
const UNAVAILABLE = 'This version of Vangaurd is not available yet.';
function unreleasedFor(c, key) {
  // Release 1.0: the owner and players given early access to this build (or a newer one) may play it
  return GATE && (c.build || 0) > latest.build && !ops.isOwner(key) && !(ops.earlyBuild(key) >= (c.build || 0));
}
// ---------- Release 1.0: recent versions, for the console's early-access list ----------
// The GitHub releases (with their version.json: build and name), plus any newer build a game has connected with.
const RELEASES_API = process.env.RELEASES_API_URL || 'https://api.github.com/repos/urmoom8989-oss/Vangaurd/releases?per_page=12';
const relCache = { list: [], at: 0, busy: null, info: new Map() }, seenBuilds = new Map();
function noteBuild(c, msg) {
  const b = c.build | 0;
  if (!(b > latest.build) || b > 1e6) return;
  const label = typeof msg.clientLabel === 'string' ? msg.clientLabel.replace(/[^\w .()-]/g, '').slice(0, 40) : '';
  const was = seenBuilds.get(b);
  seenBuilds.set(b, { at: now(), label: label || was?.label || '' });
  if (seenBuilds.size > 20) seenBuilds.delete([...seenBuilds.keys()].sort((x, y) => x - y)[0]);
}
async function refreshReleases() {
  if (!RELEASES_API || RELEASES_API === 'off') return;
  try {
    const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'vangaurd-server' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json(), out = [];
    for (const r of Array.isArray(rows) ? rows.slice(0, 12) : []) {
      if (!r || r.draft) continue;
      let info = relCache.info.get(r.tag_name);
      if (!info) {
        const asset = (r.assets || []).find((x) => x.name === 'version.json');
        if (!asset) continue;
        try {
          const v = await (await fetch(asset.browser_download_url, { redirect: 'follow', headers: { 'user-agent': 'vangaurd-server' } })).json();
          info = { build: Math.floor(Number(v.build)) || 0, label: String(v.label || r.name || r.tag_name).slice(0, 40) };
        } catch { continue; }
        info.build > 0 && relCache.info.set(r.tag_name, info);
      }
      info.build > 0 && out.push({ build: info.build, label: info.label, tag: r.tag_name, prerelease: !!r.prerelease, url: r.html_url || null, at: Date.parse(r.published_at || r.created_at) || 0 });
    }
    relCache.list = out, relCache.at = now();
  } catch (e) { log(`could not read the GitHub releases (${e.message})`); relCache.at = now() - 8 * 60e3; }
}
function recentVersions() {
  if (!relCache.busy && now() - relCache.at > 10 * 60e3) relCache.busy = refreshReleases().finally(() => { relCache.busy = null; });
  const by = new Map();
  for (const r of relCache.list) by.has(r.build) || by.set(r.build, r);
  for (const [b, x] of seenBuilds) by.has(b) || by.set(b, { build: b, label: x.label || `Build ${b}`, tag: null, prerelease: true, url: null, at: x.at, seen: true });
  return [...by.values()].map((v) => ({ ...v, released: v.build <= latest.build })).sort((x, y) => y.build - x.build).slice(0, 10);
}
// Release 1.0: every account has a permanent user ID (shown in Settings > Account, used by support).
// It is given out the first time the account signs in, so older accounts get one too.
const UID_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const PRIVATE_OPS = new Set(['spectre']);
function newUid() {
  const taken = new Set(Object.values(accounts.users).map((x) => x?.uid).filter(Boolean));
  for (;;) {
    const b = crypto.randomBytes(10);
    let id = '';
    for (let i = 0; i < 10; i++) id += UID_CHARS[b[i] % UID_CHARS.length];
    id = `VG-${id.slice(0, 5)}-${id.slice(5)}`;
    if (!taken.has(id)) return id;
  }
}
function uidOf(u) {
  if (!u.uid) { u.uid = newUid(); saveAccounts(); }
  return u.uid;
}
function authOk(c, u, token, created = false) {
  const key = keyOf(u.name), g = ops.gate(c, key);
  if (g) return refuseGate(c, g);
  if (unreleasedFor(c, key)) { log(`refused unreleased build ${c.build} for ${u.name}`); return refuseGate(c, { code: 'unavailable', message: UNAVAILABLE }); }
  c.account = u.name;
  c.name = u.name;
  send(c, { type: 'auth_ok', username: u.name, userId: uidOf(u), token, created, developer: ops.isDev(key), moderator: !!mod.roleOf(key), dlc: ops.dlcOf(key), early: (c.build | 0) > latest.build && ops.earlyBuild(key) >= (c.build | 0) ? { build: ops.earlyBuild(key) } : null });
  mod.noteDevice(u, c.device);
  goOnline(c);
  // Release 1.0: a player they reported was banned while they were away
  const told = mod.takeNotices(key);
  told && setTimeout(() => send(c, { type: 'report_action', count: told }), 1500);
}
function authError(c, code, message) { send(c, { type: 'auth_error', code, message }); }
// Maintenance or a missing Steam: the game shows its "Login failed" screen with a Retry button.
function refuseGate(c, g) {
  send(c, { type: 'auth_error', code: g.code, message: g.message });
  if (g.code === 'maintenance') send(c, { type: 'maintenance', message: g.message });
}
// Banned: refuse (every game version shows the auth_error message; Beta 0.95+ also shows the ban screen).
function refuseBanned(c, v) {
  const message = mod.banMessage(v);
  send(c, { type: 'auth_error', code: 'banned', message, ban: v });
  send(c, { type: 'banned', ban: v, message });
}
async function onRegister(c, msg) {
  if (limited(c)) return authError(c, 'too_many', 'Too many attempts. Wait a few minutes and try again.');
  // an unreleased game build can't create accounts (only the owner may use it, and the owner has one)
  if (GATE && (c.build || 0) > latest.build) return authError(c, 'unavailable', UNAVAILABLE);
  c.device = cleanDevice(msg.device) || c.device;
  { const b = mod.checkDevice(c.device); if (b) return refuseBanned(c, b); }
  await ops.noteSteam(c, msg);
  const name = String(msg.username || '').trim(), pw = String(msg.password || '');
  { const g = ops.gate(c, keyOf(name)); if (g) return refuseGate(c, g); }
  if (!NAME_RE.test(name)) return authError(c, 'bad_name', 'Usernames are 3 to 16 letters, numbers, - or _.');
  if (RESERVED.has(name.toLowerCase())) return authError(c, 'taken', 'That username is taken. Pick another one.');
  if (nameBlocked(name)) return authError(c, 'bad_name', "That username isn't allowed. Pick another one.");
  if (pw.length < 6 || pw.length > 64) return authError(c, 'bad_password', 'Passwords must be 6 to 64 characters long.');
  const key = name.toLowerCase();
  if (accounts.users[key]) { failed(c); return authError(c, 'taken', 'That username is taken. If it is yours, sign in instead.'); }
  const email = String(msg.email || '').trim();
  if (email || mailer.enabled || EMAIL_REQUIRED) {
    if (!EMAIL_RE.test(email)) return authError(c, 'bad_email', 'Enter a valid email address.');
    if (findByEmail(email)) return authError(c, 'email_taken', 'That email already belongs to an account. Sign in, or reset its password.');
  }
  // New accounts always confirm their email with a code; without a working sender, sign-up waits.
  if (!mailer.enabled && EMAIL_REQUIRED) {
    log(`sign-up refused for ${name}: no email sender is set up`);
    return authError(c, 'email_unavailable', "New accounts can't be created right now because the Vangaurd server can't send verification emails yet. Try again later.");
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(pw, salt);
  if (accounts.users[key]) return authError(c, 'taken', 'That username is taken. If it is yours, sign in instead.');
  // With email set up, the account is only created once the code sent to the email is entered.
  if (mailer.enabled) return sendCode(c, { purpose: 'register', key, username: name, email, salt, hash, device: c.device });
  const u = accounts.users[key] = { name, salt, hash, created: now(), lastLogin: now(), ...(email ? { email, emailVerified: false } : {}) };
  saveAccounts();
  log(`account created: ${name}`);
  authOk(c, u, newSession(name), true);
}
async function onLogin(c, msg) {
  if (limited(c)) return authError(c, 'too_many', 'Too many attempts. Wait a few minutes and try again.');
  // Sign in with the username or the account's email.
  const ident = String(msg.username || msg.identifier || '').trim(), pw = String(msg.password || ''), byEmail = ident.includes('@');
  const key = byEmail ? findByEmail(ident) : ident.toLowerCase();
  const u = key ? accounts.users[key] : null;
  const hash = await scrypt(pw, u ? u.salt : '00'.repeat(16));
  if (!u || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) {
    failed(c);
    return authError(c, 'bad_login', u ? 'Wrong password.' : byEmail ? 'No account uses that email. Create one instead.' : 'No account with that username. Create one instead.');
  }
  c.device = cleanDevice(msg.device) || c.device;
  { const b = mod.checkAccount(keyOf(u.name), c.device); if (b) return refuseBanned(c, b); }
  await ops.noteSteam(c, msg);
  { const g = ops.gate(c, keyOf(u.name)); if (g) return refuseGate(c, g); }
  // (If the start-up check found the email sender broken, sign-in goes on without a code rather than locking
  // every player out; the log says so. Sign-up still needs a working sender.)
  if (mailer.enabled && emailState.checked === false) log(`${u.name} signed in without a code: the email sender is not working (${emailState.detail})`);
  if (mailer.enabled && emailState.checked !== false) {
    // Accounts from before emails were required add one first; everyone then confirms with a code.
    if (!u.email || !u.emailVerified && !EMAIL_RE.test(u.email)) {
      const id = newPendingId();
      pendings.set(id, { id, purpose: 'add_email', key: keyOf(u.name), username: u.name, device: c.device, expires: now() + CODE_TTL, stage: 'need_email' });
      return send(c, { type: 'auth_need_email', pending: id, username: u.name });
    }
    return sendCode(c, { purpose: 'login', key: keyOf(u.name), username: u.name, email: u.email, device: c.device });
  }
  u.lastLogin = now();
  saveAccounts();
  authOk(c, u, newSession(u.name));
}
async function onResume(c, msg) {
  const u = sessionUser(msg.token);
  if (!u) return authError(c, 'session_expired', 'Your sign-in has expired. Please sign in again.');
  c.device = cleanDevice(msg.device) || c.device;
  { const b = mod.checkAccount(keyOf(u.name), c.device); if (b) return refuseBanned(c, b); }
  await ops.noteSteam(c, msg);
  authOk(c, u, msg.token);
}
function onLogout(c, msg) {
  if (typeof msg.token === 'string') { delete accounts.sessions[sha(msg.token)]; saveAccounts(); }
  goOffline(c);
  c.account = null;
  send(c, { type: 'logged_out' });
}

// ---------- email and verification codes ----------
// When an email service is configured (see mailer.mjs), creating an account, signing in, adding an email to an
// older account and resetting a password each send a 6-digit code to the account's email. A code lasts 10 minutes
// and allows 5 tries; a new one can be sent every 30 seconds, at most 6 an hour per address.
const mailer = createMailer(process.env);
// EMAIL_REQUIRED=off lets accounts be created without a code while no email sender is set up.
const EMAIL_REQUIRED = !/^(0|off|false|no)$/i.test(String(process.env.EMAIL_REQUIRED || 'on').trim());
const emailState = { ok: mailer.enabled ? null : false, detail: mailer.enabled ? 'checking the email sender' : 'no email sender is set up' };
if (mailer.enabled) {
  // A slow sender (the Gmail script can take a while to wake up) gets more tries: after 30 s, 1 min, then every
  // 10 minutes until it answers or a code goes out. Until then sign-in skips the code (see onLogin).
  let emailTries = 0;
  const checkEmail = () => mailer.check().then((r) => {
    if (emailState.ok) return; // a code already went out in the meantime
    const was = emailState.checked;
    Object.assign(emailState, r, { checked: r.ok });
    if (r.ok || was !== false) log(r.ok ? `email: ${r.detail}${emailTries ? ` (after ${emailTries + 1} tries)` : ''}` : `email is NOT working: ${r.detail} (trying again)`);
    if (!r.ok) { emailTries++; setTimeout(checkEmail, emailTries < 3 ? 30e3 * emailTries : 10 * 60e3).unref?.(); }
  }, (e) => { log(`email check failed: ${e?.message || e}`); });
  checkEmail();
} else log(`email: no sender set up (GMAIL_SCRIPT_URL, BREVO_API_KEY or SMTP_*), so ${EMAIL_REQUIRED ? 'new accounts are paused' : 'accounts are created without a code'} and sign-in needs no code`);
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
const CODE_TTL = 10 * 60e3, CODE_TRIES = 5, RESEND_MS = 30e3;
const pendings = new Map(); // id -> { id, purpose, key, username, email, salt, hash, codeHash, expires, tries, sentAt, device, stage }
const sendsTo = new Map(); // email -> recent send times
const newPendingId = () => crypto.randomBytes(16).toString('hex');
function findByEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return null;
  for (const [k, u] of Object.entries(accounts.users)) if (u.email && u.email.toLowerCase() === e) return k;
  return null;
}
function maskEmail(e) {
  const [a = '', d = ''] = String(e).split('@');
  return `${a.slice(0, Math.min(2, a.length))}${'•'.repeat(Math.max(2, Math.min(6, a.length - 2)))}@${d}`;
}
async function sendCode(c, p) {
  p.id ||= newPendingId();
  const recent = (sendsTo.get(p.email.toLowerCase()) || []).filter((t) => now() - t < 3600e3);
  if (recent.length >= 6) return authError(c, 'too_many', 'Too many codes were sent to that email. Wait a while and try again.');
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  try {
    await mailer.send(codeEmail(p.email, code, p.purpose, p.username));
  } catch (e) {
    log(`email to ${maskEmail(p.email)} failed: ${e.message}`);
    Object.assign(emailState, { ok: false, detail: e.message });
    return authError(c, 'email_failed', 'The code email could not be sent. Check the address and try again in a minute.');
  }
  recent.push(now()); sendsTo.set(p.email.toLowerCase(), recent);
  if (!emailState.ok) Object.assign(emailState, { ok: true, checked: true, detail: `${mailer.kind}: sent a code` });
  Object.assign(p, { codeHash: sha(`${code}:${p.id}`), expires: now() + CODE_TTL, tries: 0, sentAt: now(), stage: 'code' });
  pendings.set(p.id, p);
  log(`sent a ${p.purpose} code to ${maskEmail(p.email)}${p.username ? ` (${p.username})` : ''}`);
  send(c, { type: 'auth_code', pending: p.id, purpose: p.purpose, to: maskEmail(p.email), ttl: CODE_TTL / 1000, resendIn: RESEND_MS / 1000 });
}
setInterval(() => { for (const [id, p] of pendings) if (now() > p.expires + 20 * 60e3) pendings.delete(id); }, 60e3).unref?.();
// An older account (no email yet) gives its email after the password was right.
async function onAddEmail(c, msg) {
  const p = pendings.get(String(msg.pending || ''));
  if (!p || p.purpose !== 'add_email' || now() > p.expires) return authError(c, 'code_expired', 'That took too long. Sign in again.');
  const email = String(msg.email || '').trim();
  if (!EMAIL_RE.test(email)) return authError(c, 'bad_email', 'Enter a valid email address.');
  const other = findByEmail(email);
  if (other && other !== p.key) return authError(c, 'email_taken', 'That email already belongs to another account.');
  p.email = email;
  return sendCode(c, p);
}
async function onResetRequest(c, msg) {
  if (limited(c)) return authError(c, 'too_many', 'Too many attempts. Wait a few minutes and try again.');
  if (!mailer.enabled) return authError(c, 'no_email', 'Password reset is not available yet: the server cannot send emails.');
  const ident = String(msg.username || msg.identifier || '').trim(), byEmail = ident.includes('@');
  const key = byEmail ? findByEmail(ident) : ident.toLowerCase();
  const u = key ? accounts.users[key] : null;
  if (!u) { failed(c); return authError(c, 'bad_login', byEmail ? 'No account uses that email.' : 'No account with that username.'); }
  if (!u.email) return authError(c, 'no_email', 'This account has no email yet. Sign in with your password to add one.');
  return sendCode(c, { purpose: 'reset', key, username: u.name, email: u.email, device: cleanDevice(msg.device) || c.device });
}
async function onResendCode(c, msg) {
  const p = pendings.get(String(msg.pending || ''));
  if (!p || !p.email || now() > p.expires + 20 * 60e3) return authError(c, 'code_expired', 'Start again: that request has expired.');
  if (now() - (p.sentAt || 0) < RESEND_MS) return authError(c, 'wait', `Wait ${Math.ceil((RESEND_MS - (now() - p.sentAt)) / 1000)} seconds before asking for another code.`);
  return sendCode(c, p);
}
async function onVerifyCode(c, msg) {
  if (limited(c)) return authError(c, 'too_many', 'Too many attempts. Wait a few minutes and try again.');
  const p = pendings.get(String(msg.pending || ''));
  if (!p || p.stage !== 'code' || now() > p.expires) return authError(c, 'code_expired', 'That code has expired. Ask for a new one.');
  const code = String(msg.code || '').replace(/\D/g, '');
  if (sha(`${code}:${p.id}`) !== p.codeHash) {
    p.tries++; failed(c);
    if (p.tries >= CODE_TRIES) { pendings.delete(p.id); return authError(c, 'code_expired', 'Too many wrong codes. Ask for a new one.'); }
    return authError(c, 'bad_code', `That code isn't right. ${CODE_TRIES - p.tries} ${CODE_TRIES - p.tries === 1 ? 'try' : 'tries'} left.`);
  }
  const newPw = String(msg.newPassword || '');
  if (p.purpose === 'reset' && (newPw.length < 6 || newPw.length > 64)) return authError(c, 'bad_password', 'Passwords must be 6 to 64 characters long.');
  pendings.delete(p.id);
  c.device = cleanDevice(msg.device) || p.device || c.device;
  if (p.purpose === 'register') {
    if (accounts.users[p.key]) return authError(c, 'taken', 'That username was taken while you were confirming. Pick another one.');
    const other = findByEmail(p.email);
    if (other) return authError(c, 'email_taken', 'That email already belongs to an account.');
    { const b = mod.checkDevice(c.device); if (b) return refuseBanned(c, b); }
    const u = accounts.users[p.key] = { name: p.username, salt: p.salt, hash: p.hash, email: p.email, emailVerified: true, created: now(), lastLogin: now() };
    saveAccounts();
    log(`account created: ${u.name} (email confirmed)`);
    return authOk(c, u, newSession(u.name), true);
  }
  const u = accounts.users[p.key];
  if (!u) return authError(c, 'bad_login', 'That account no longer exists.');
  { const b = mod.checkAccount(p.key, c.device); if (b) return refuseBanned(c, b); }
  if (p.purpose === 'add_email') {
    const other = findByEmail(p.email);
    if (other && other !== p.key) return authError(c, 'email_taken', 'That email already belongs to another account.');
    u.email = p.email;
    log(`${u.name} added an email`);
  }
  if (p.purpose === 'reset') {
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = await scrypt(newPw, u.salt);
    for (const [k, ses] of Object.entries(accounts.sessions)) if (ses.user === p.key) delete accounts.sessions[k]; // sign out everywhere
    log(`${u.name} reset their password`);
  }
  u.emailVerified = true;
  u.lastLogin = now();
  saveAccounts();
  return authOk(c, u, newSession(u.name));
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
  return !!set?.size;
}
function note(key, text, extra = {}) { sendTo(key, { type: 'social_note', text, ...extra }); }
function partyView(pid) {
  const pt = parties.get(pid);
  if (!pt) return null;
  // Release 1.0: who is in the party's voice chat (and has their mic muted)
  return { id: pt.id, leader: nameOf(pt.leader), members: pt.members.map((k) => ({ name: nameOf(k), status: statusOf(k), leader: k === pt.leader, voice: !!voiceOf.get(k)?.on, vmuted: !!voiceOf.get(k)?.muted })) };
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
    incoming: u.incoming.map(nameOf), outgoing: u.outgoing.map(nameOf), party: partyView(partyOf.get(key)), invites, blocked: (Array.isArray(u.blocked) ? u.blocked : []).map(nameOf),
    // players from recent matches, for "Recently played" (Add friend)
    recent: (mod?.recentWith?.(key, 12) || []).map((r) => ({ name: r.name, at: r.at, mode: r.mode, map: r.map, status: statusOf(r.key), friend: u.friends.includes(r.key), sent: u.outgoing.includes(r.key), incoming: u.incoming.includes(r.key) })),
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
    voiceOf.get(key)?.on && voiceLeave(key);
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
  if (blockedBy(me, them)) return socialError(c, `You blocked ${t.name}. Unblock them first.`);
  if (blockedBy(them, me)) return socialError(c, `${t.name} isn't taking friend requests.`);
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
  voiceOf.get(key)?.on && voiceLeave(key, true);
  partyOf.delete(key);
  if (!pt) return;
  pt.members = pt.members.filter((k) => k !== key);
  if (pt.ready) readyDone(pt, false, `${nameOf(key)} left the party.`);
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
  if (eitherBlocked(me, them)) return socialError(c, `You can't invite ${t.name}.`);
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
// Ready check: before the leader queues, every party member who is not already in a match is asked to ready up.
// Everyone ready -> the leader's game queues (and the party follows as usual); anyone not ready or 20 s pass -> off.
const READY_S = 20;
function readyView(pt) {
  const r = pt.ready;
  return { type: 'party_ready', id: r.id, leader: nameOf(pt.leader), mode: r.mode, endsIn: Math.max(0, Math.round((r.endsAt - now()) / 1000)), members: [...r.state].map(([k, st]) => ({ name: nameOf(k), state: st, leader: k === pt.leader })) };
}
function readyPush(pt) { const v = readyView(pt); for (const k of pt.members) sendTo(k, v); }
function readyDone(pt, ok, reason = '') {
  const r = pt.ready;
  if (!r) return;
  clearTimeout(r.timer);
  pt.ready = null;
  for (const k of pt.members) sendTo(k, { type: 'party_ready_done', id: r.id, ok, reason, mode: r.mode, leader: nameOf(pt.leader) });
}
function readyStart(c, msg) {
  const me = keyOf(c.account), pt = parties.get(partyOf.get(me));
  const mode = modeOf(msg.mode);
  if (!pt || pt.members.length < 2) return send(c, { type: 'party_ready_done', id: null, ok: true, reason: 'solo', mode });
  if (pt.leader !== me) return socialError(c, 'Only the party leader can start the match search.');
  if (pt.ready) readyDone(pt, false, 'restarted');
  const r = { id: newId('rdy'), mode, endsAt: now() + READY_S * 1000, state: new Map(), timer: null };
  for (const k of pt.members) r.state.set(k, k === me ? 'ready' : statusOf(k) === 'match' ? 'in_match' : statusOf(k) === 'offline' ? 'offline' : 'pending');
  pt.ready = r;
  r.timer = setTimeout(() => {
    if (pt.ready !== r) return;
    const late = [...r.state].filter(([, st]) => st === 'pending').map(([k]) => nameOf(k));
    readyDone(pt, false, late.length ? `${late.join(', ')} didn't ready up in time.` : 'The ready check timed out.');
  }, READY_S * 1000);
  readyCheck(pt);
}
function readyCheck(pt) {
  const r = pt.ready;
  if (!r) return;
  readyPush(pt);
  const states = [...r.state.values()];
  if (states.includes('declined')) {
    const who = [...r.state].filter(([, st]) => st === 'declined').map(([k]) => nameOf(k));
    return readyDone(pt, false, `${who.join(', ')} ${who.length === 1 ? "isn't" : "aren't"} ready.`);
  }
  if (!states.includes('pending')) readyDone(pt, true);
}
function readyReply(c, msg) {
  const me = keyOf(c.account), pt = parties.get(partyOf.get(me));
  if (!pt?.ready || pt.ready.id !== msg.id || !pt.ready.state.has(me)) return;
  pt.ready.state.set(me, msg.ready ? 'ready' : 'declined');
  readyCheck(pt);
}
function readyCancel(c) {
  const me = keyOf(c.account), pt = parties.get(partyOf.get(me));
  if (pt?.ready && pt.leader === me) readyDone(pt, false, `${nameOf(me)} cancelled the search.`);
}
// The leader queued: bring the rest of the party along.
function partyFollow(c, mode) {
  const me = keyOf(c.account), pt = parties.get(partyOf.get(me));
  if (!pt || pt.leader !== me) return;
  for (const k of pt.members) if (k !== me && statusOf(k) !== 'match') sendTo(k, { type: 'party_queue', mode, leader: nameOf(me) });
}
// ---------- Release 1.0: blocking, lobby chat (All and Party) and party voice chat ----------
// Blocking someone hides you from each other in chat, ends any friendship or open request between you, stops friend
// requests and party invites both ways, and drops you out of a party you share. Muting (only in the game) just
// silences someone's chat and voice for you.
const voiceOf = new Map(); // account key -> { on, muted }
const blockedBy = (a, b) => !!userOf(a)?.blocked?.includes?.(b);
const eitherBlocked = (a, b) => blockedBy(a, b) || blockedBy(b, a);
function blockSet(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.username), u = userOf(me), t = userOf(them);
  if (!u) return;
  if (!t) return socialError(c, `There is no player called ${String(msg.username || '').slice(0, 16)}.`);
  if (them === me) return socialError(c, "You can't block yourself.");
  u.blocked = Array.isArray(u.blocked) ? u.blocked : [];
  if (msg.on === false) u.blocked = u.blocked.filter((k) => k !== them);
  else if (!u.blocked.includes(them)) {
    if (u.blocked.length >= 500) return socialError(c, 'Your block list is full (500).');
    u.blocked.push(them);
    social(u); social(t);
    u.friends = u.friends.filter((k) => k !== them); t.friends = t.friends.filter((k) => k !== me);
    u.incoming = u.incoming.filter((k) => k !== them); u.outgoing = u.outgoing.filter((k) => k !== them);
    t.incoming = t.incoming.filter((k) => k !== me); t.outgoing = t.outgoing.filter((k) => k !== me);
    for (const pt of parties.values()) { if (pt.invites.has(me) && pt.members.includes(them)) pt.invites.delete(me); if (pt.invites.has(them) && pt.members.includes(me)) pt.invites.delete(them); }
    if (partyOf.get(me) && partyOf.get(me) === partyOf.get(them)) leaveParty(me);
  }
  saveAccounts();
  note(me, msg.on === false ? `Unblocked ${t.name}` : `Blocked ${t.name}. You won't see each other in chat, and they can't invite you or send you friend requests.`, { kind: 'block' });
  pushSocial(me); pushSocial(them);
}
// chat
const CHAT_MAX = 200, chatLog = [], chatRate = new Map();
const chatClean = (t) => String(t || '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
const chatPublic = (m) => ({ type: 'chat', ch: m.ch, id: m.id, from: m.from, text: m.text, at: m.at, dev: m.dev || undefined });
function onChat(c, msg) {
  const me = keyOf(c.account), u = userOf(me);
  if (!u) return socialError(c, 'Sign in to chat.');
  const ch = msg.ch === 'party' ? 'party' : 'all', text = chatClean(msg.text);
  if (!text) return;
  if ((u.chatMutedUntil || 0) > now()) {
    const left = u.chatMutedUntil - now();
    return send(c, { type: 'chat_error', message: `A moderator muted you in chat. You can chat again in ${left > 36e5 ? `${Math.ceil(left / 36e5)} hours` : `${Math.max(1, Math.ceil(left / 6e4))} minutes`}.` });
  }
  const t = now(), r = (chatRate.get(me) || []).filter((x) => t - x < 10e3);
  if (r.length >= 5 || (r.length && t - r[r.length - 1] < 600)) return send(c, { type: 'chat_error', message: 'Slow down a little.' });
  r.push(t), chatRate.set(me, r);
  const m = { ch, id: newId('m'), key: me, from: u.name, text, at: t, dev: !!(mod.roleOf?.(me)) || undefined };
  if (ch === 'party') {
    const pt = parties.get(partyOf.get(me));
    if (!pt) return send(c, { type: 'chat_error', message: "You're not in a party. Invite friends from the Friends panel." });
    for (const k of pt.members) if (!eitherBlocked(k, me)) sendTo(k, chatPublic(m));
    return;
  }
  chatLog.push(m), chatLog.length > 400 && chatLog.splice(0, chatLog.length - 400);
  for (const k of online.keys()) if (!eitherBlocked(k, me)) sendTo(k, chatPublic(m));
}
function chatHistory(c) {
  const me = keyOf(c.account);
  if (!userOf(me)) return;
  send(c, { type: 'chat_history', list: chatLog.slice(-50).filter((m) => !eitherBlocked(me, m.key)).map(chatPublic) });
}
const chatAdmin = {
  list: () => chatLog.slice(-300).reverse().map((m) => ({ id: m.id, at: m.at, from: m.from, text: m.text })),
  mutedList: () => Object.values(accounts.users).filter((u) => (u.chatMutedUntil || 0) > now()).map((u) => ({ name: u.name, until: u.chatMutedUntil })),
  mute(key, hours) {
    const u = userOf(key);
    if (!u) return;
    u.chatMutedUntil = hours ? now() + hours * 36e5 : 0, saveAccounts();
    hours && note(key, `A moderator muted you in chat for ${hours >= 24 ? `${Math.round(hours / 24)} day${hours >= 48 ? 's' : ''}` : `${hours} hour${hours === 1 ? '' : 's'}`}.`, { kind: 'chat_mute' });
  },
};
// voice: the server only passes the WebRTC set-up messages between party members (the audio goes player to player)
function voicePush(pt) { for (const k of pt.members) pushSocial(k); }
function voiceSet(c, msg) {
  const me = keyOf(c.account), pt = parties.get(partyOf.get(me));
  if (msg.on && !pt) return socialError(c, 'Join a party to use voice chat.');
  if (!msg.on) return voiceLeave(me);
  const was = voiceOf.get(me)?.on;
  voiceOf.set(me, { on: true, muted: !!msg.muted });
  if (!was) for (const k of pt.members) k !== me && voiceOf.get(k)?.on && sendTo(k, { type: 'voice_join', name: nameOf(me) });
  voicePush(pt);
}
function voiceLeave(me, quiet = false) {
  const was = voiceOf.get(me)?.on;
  voiceOf.delete(me);
  const pt = parties.get(partyOf.get(me));
  if (pt && was) {
    for (const k of pt.members) k !== me && sendTo(k, { type: 'voice_leave', name: nameOf(me) });
    quiet || voicePush(pt);
  }
}
function rtcRelay(c, msg) {
  const me = keyOf(c.account), them = keyOf(msg.to), pt = parties.get(partyOf.get(me));
  if (!pt || !pt.members.includes(them) || !voiceOf.get(me)?.on || !voiceOf.get(them)?.on || eitherBlocked(me, them)) return;
  const d = msg.d && typeof msg.d === 'object' ? msg.d : null;
  if (!d || JSON.stringify(d).length > 20000) return;
  sendTo(them, { type: 'rtc', from: nameOf(me), d });
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
    case 'party_ready_start': readyStart(c, msg); break;
    case 'party_ready_reply': readyReply(c, msg); break;
    case 'party_ready_cancel': readyCancel(c); break;
    case 'block': blockSet(c, msg); break;
    case 'chat_send': onChat(c, msg); break;
    case 'chat_history': chatHistory(c); break;
    case 'voice': voiceSet(c, msg); break;
    case 'rtc': rtcRelay(c, msg); break;
    case 'tourney_list': case 'tourney_register': case 'tourney_unregister': case 'tourney_play': case 'tourney_board': case 'tourney_watch': tourneyMsg(c, msg); break;
    default: break;
  }
}

const clients = new Map(); // id -> client
const queues = Object.fromEntries(Object.keys(MODES).map((m) => [m, []])); // arrays of client ids
const countdowns = {}; // mode -> { endsAt, timer }
const matches = new Map(); // matchId -> match

const newId = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => Date.now();
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cleanName = (s) => String(s || 'Player').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20) || 'Player';
const modeOf = (m) => (MODES[m] ? m : 'tdm');
const shortName = (m) => (MODES[m]?.name || m).replace(/ \(.*\)$/, '');
function weekly(t = now()) {
  const wk = Math.floor((t - WEEK0) / WEEK_MS), n = WEEKLY_POOL.length;
  const pin = !REGIONAL && WEEKLY_POOL.includes(ops.state.weekly) ? ops.state.weekly : null, mode = pin || WEEKLY_POOL[((wk % n) + n) % n];
  return { mode, name: shortName(mode), endsAt: WEEK0 + (wk + 1) * WEEK_MS, pinned: !!pin, pool: WEEKLY_POOL.map((m) => ({ id: m, name: shortName(m) })) };
}

function send(c, msg) {
  if (c && c.ws.readyState === WebSocket.OPEN) {
    try { c.ws.send(JSON.stringify(msg)); } catch { /* socket closing */ }
  }
}
function broadcast(match, msg, exceptId = null) {
  for (const id of match.players.keys()) if (id !== exceptId) send(clients.get(id), msg);
  if (match.spectators?.size) for (const id of match.spectators) { const sc = clients.get(id); sc?.caster ? castSend(sc, msg) : send(sc, msg); }
}
// a tournament spectator's messages wait CASTER_DELAY_MS
function castSend(c, msg) {
  if (!c) return;
  if (!CASTER_DELAY_MS) return send(c, msg);
  (c.cq ||= []).push([now() + CASTER_DELAY_MS, msg]);
}
setInterval(() => {
  const t = now();
  for (const c of clients.values()) {
    if (!c.cq?.length) continue;
    while (c.cq.length && c.cq[0][0] <= t) send(c, c.cq.shift()[1]);
  }
}, 100).unref?.();
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
  match.startAt = INTRO_MS ? at + INTRO_MS : 0;
  for (const p of match.players.values()) { p.spawnedAt = at; p.health = 100; p.alive = true; }
  broadcast(match, { type: 'map_selected', matchId: match.id, mapId: match.mapId, tallies: t, startsIn: startsIn(match) });
  log(`match ${match.id} map vote -> ${match.mapId} ${JSON.stringify(t)}`);
}

// ---------- queue ----------
function queueStatus(mode) {
  const q = queues[mode];
  const cd = countdowns[mode];
  const startsIn = cd ? Math.max(0, Math.ceil((cd.endsAt - now()) / 1000)) : null;
  const live = modeMatch(mode), full = !!live && live.players.size >= MAX_PLAYERS;
  q.forEach((id, i) => send(clients.get(id), { type: 'queue_status', mode, queued: q.length, minimum: MIN_PLAYERS, maximum: MAX_PLAYERS, startsIn: full ? null : startsIn, full, position: i + 1, inMatch: live ? live.players.size : 0, scoreLimit: live?.scoreLimit || null, score: live && !live.ffa ? { ...live.score } : null }));
}
// Beta 1.3: each mode has one match running at a time (one "server"). While it has room, players join it in the
// middle of the game; while it is full (12), new players wait in line for a free spot or for the match to end,
// and then the next match starts with the players who waited.
function modeMatch(mode) {
  let best = null;
  for (const m of matches.values()) if (m.mode === mode && !m.tourney && !m.ended && m.players.size > 0 && (!best || m.players.size > best.players.size)) best = m;
  return best;
}
function removeFromQueue(c) {
  if (c.tourneyQ) tqLeave(c);
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
  const live = modeMatch(mode);
  if (live) {
    stopCountdown(mode);
    while (q.length && live.players.size < MAX_PLAYERS && !live.ended) {
      const c = clients.get(q.shift());
      if (!c) continue;
      c.queuedMode = null;
      addToMatch(live, c, true);
      if (c.accountKey) pushAround(c.accountKey);
    }
    queueStatus(mode);
    return;
  }
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
        if (m && !m.ended && !m.tourney && m.mode === mode && m.players.size < MAX_PLAYERS) return m;
      }
    }
  }
  const live = modeMatch(mode);
  return live && live.players.size < MAX_PLAYERS && !queues[mode].length ? live : null;
}
async function joinQueue(c, msg) {
  if (clientOutdated(c, msg)) return;
  c.device = cleanDevice(msg.device) || c.device;
  if (REGIONAL) {
    // a regional match server: the main server checks the player (account, bans, Steam, maintenance)
    const r = await regionalSession(c, msg);
    if (r.error === 'banned') return refuseBanned(c, r.ban);
    if (r.error === 'session_expired') return send(c, { type: 'error', code: 'login_required', message: r.message });
    if (r.error) { send(c, { type: 'error', code: r.error, message: r.message }); if (r.error === 'maintenance') send(c, { type: 'maintenance', message: r.message }); return; }
    c.account = r.name; c.accountKey = r.key; c.staff = !!r.staff;
  }
  await ops.noteSteam(c, msg);
  if (!REGIONAL && !c.account && msg.token) { const u = sessionUser(msg.token); if (u) { const b = mod.checkAccount(keyOf(u.name), c.device); if (b) return refuseBanned(c, b); c.account = u.name; goOnline(c); } }
  if (c.account && !REGIONAL) { const b = mod.checkAccount(keyOf(c.account), c.device); if (b) return mod.kickNow(c, b); }
  if (!c.account) {
    send(c, { type: 'error', code: 'login_required', message: 'Sign in to your Vangaurd account to play online.' });
    return;
  }
  if (!REGIONAL) { const g = ops.gate(c, keyOf(c.account)); if (g) { send(c, { type: 'error', code: g.code, message: g.message }); if (g.code === 'maintenance') send(c, { type: 'maintenance', message: g.message }); return; } }
  if (!REGIONAL && unreleasedFor(c, keyOf(c.account))) return send(c, { type: 'error', code: 'unavailable', message: UNAVAILABLE });
  if (c.matchId) leaveMatch(c, false);
  removeFromQueue(c);
  c.name = c.account;
  if (msg.tourney) return tourneyJoin(c, msg);
  const mode = modeOf(msg.mode);
  // Release 1.0: Team Deathmatch or this week's mode (a regional server takes any mode in the rotation)
  if (mode !== 'tdm' && (REGIONAL ? !WEEKLY_POOL.includes(mode) : mode !== weekly().mode)) {
    const w = weekly();
    return send(c, { type: 'error', code: 'mode_unavailable', message: `${shortName(mode)} isn't on this week. This week's mode is ${w.name}.`, weekly: w });
  }
  partyFollow(c, mode);
  const open = openMatchFor(mode, c);
  if (open) { addToMatch(open, c, true); if (c.accountKey) pushAround(c.accountKey); return; }
  queues[mode].push(c.id);
  c.queuedMode = mode;
  if (c.accountKey) pushAround(c.accountKey);
  checkQueue(mode);
  const lm = modeMatch(mode);
  if (lm && queues[mode].includes(c.id)) log(`${c.name} is waiting for a spot in the full match ${lm.id} (${queues[mode].indexOf(c.id) + 1} in line)`);
}

// ---------- matches ----------
function pickTeam(match, c = null) {
  if (match.tourney) return match.tourney.side.get(c?.accountKey || keyOf(c?.account)) || (match.ffa ? 'ffa' : 'alpha');
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
  else match.mapId = match.vote.options[0], match.startAt = INTRO_MS ? now() + LOAD_GRACE_MS + INTRO_MS : 0;
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
    phase: match.phase, mapId: match.mapId, vote: voteInfo(match, c.id), players: match.ffa ? boardOf(match) : undefined, startsIn: startsIn(match),
    tourney: match.tourney ? { id: match.tourney.id, name: match.tourney.name, format: match.tourney.format, points: tourneyLivePoints(match, c.accountKey || keyOf(c.account)) } : undefined,
    lobby: match.lobby || undefined,
  });
  // Bring the newcomer up to date on where everyone is.
  for (const p of match.players.values()) {
    if (p.id === c.id || !p.state) continue;
    send(c, { type: 'player_state', matchId: match.id, playerId: p.id, state: p.state });
  }
}
function addToMatch(match, c, inProgress) {
  if (match.tourney) {
    const k = c.accountKey || keyOf(c.account);
    if (!match.tourney.side.has(k) || (!match.players.has(c.id) && match.players.size >= (match.tourney.cap || T_FFA_MAX))) return false;
  }
  removeFromQueue(c);
  const p = { id: c.id, key: c.accountKey || keyOf(c.account), name: c.name, team: pickTeam(match, c), health: 100, alive: true, kills: 0, deaths: 0, score: 0, state: null, pos: null, joinedAt: now(), spawnedAt: now() + (match.phase === 'vote' ? LOAD_GRACE_MS : 0), diedAt: 0 };
  match.players.set(c.id, p);
  c.matchId = match.id;
  mod.matchSeen(match); regionSeen(match);
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
  mod.matchSeen(match); regionSeen(match);
  const lp = match.players.get(c.id);
  if (match.tourney && lp && !match.ended) match.tourney.gone.set(lp.key, { kills: lp.kills, score: lp.score, at: now() });
  match.players.delete(c.id);
  if (notify) send(c, { type: 'match_left', matchId: match.id });
  if (match.tourney && !match.ended && match.players.size) tourneyForfeit(match);
  broadcast(match, { type: 'player_left', matchId: match.id, playerId: c.id });
  if (match.players.size > 0) { broadcast(match, { type: 'match_update', matchId: match.id, roster: rosterOf(match) }); broadcastVote(match); if (match.ffa) broadcast(match, scoreMsg(match)); }
  else if (match.droneWait > 0 || [...match.spectators || []].some((id) => clients.get(id)?.drone)) {
    // a developer's drone is still flying over the map: keep it for them (nobody else is put into an empty match)
    clearTimeout(match.vote?.timer);
    for (const id of [...match.spectators || []]) { const sc = clients.get(id); if (sc && !sc.drone) { sc.spectating = null; match.spectators.delete(id); send(sc, { type: 'spectate_end', reason: 'Everyone left the match.' }); } }
    broadcast(match, { type: 'match_update', matchId: match.id, roster: [] });
  } else { clearTimeout(match.vote?.timer); clearTimeout(match.nextTimer); spectatorsOut(match, 'Everyone left the match.'); recKeep(match); matches.delete(match.id); log(`match ${match.id} closed`); }
  if (queues[match.mode]?.length) setTimeout(() => checkQueue(match.mode), 0); // a spot opened (or the match closed)
}
function endMatch(match, winner) {
  if (match.ended) return;
  match.ended = true;
  mod.matchSeen(match); regionSeen(match);
  const msg = { type: 'match_ended', matchId: match.id, winner, score: { ...match.score } };
  if (!match.tourney && !match.drone && LOBBY_NEXT_S > 0) {
    msg.nextIn = LOBBY_NEXT_S;
    match.nextAt = now() + LOBBY_NEXT_S * 1000;
    match.nextTimer = setTimeout(() => lobbyNext(match), LOBBY_NEXT_S * 1000);
  }
  if (match.tourney) { try { tourneyReport(match, winner); } catch (e) { log(`tournament result error: ${e.message}`); } msg.tourney = { id: match.tourney.id, name: match.tourney.name }; }
  if (match.ffa) { msg.ffa = true; msg.players = boardOf(match); msg.winnerName = match.players.get(winner)?.name || null; msg.scoreLimit = match.scoreLimit; }
  broadcast(match, msg);
  for (const p of match.players.values()) if (p.key) pushSocial(p.key); // "Recently played" now lists this match
  log(`match ${match.id} ended · winner ${winner}`);
  if (queues[match.mode]?.length) setTimeout(() => checkQueue(match.mode), 0); // the players who waited start the next match
}
// the next match of a lobby: the same players, a new map vote (teams are balanced again, parties together)
function lobbyNext(old) {
  if (matches.get(old.id) !== old) return;
  const ids = [...old.players.keys()].filter((id) => clients.get(id)?.matchId === old.id);
  if (!ids.length) return;
  const mode = old.mode;
  const match = {
    id: newId('m'), mode, ffa: MODES[mode].ffa, scoreLimit: MODES[mode].scoreLimit, score: { alpha: 0, bravo: 0 },
    players: new Map(), tags: new Map(), ended: false, createdAt: now(), lobby: (old.lobby || 0) + 1,
    phase: VOTE_S > 0 ? 'vote' : 'live', mapId: null,
    vote: { options: shuffled(MAPS.filter((m) => m !== old.mapId)).slice(0, 3), votes: new Map(), endsAt: now() + VOTE_S * 1000, timer: null },
  };
  if (match.phase === 'vote') match.vote.timer = setTimeout(() => finishVote(match), VOTE_S * 1000);
  else match.mapId = match.vote.options[0], match.startAt = INTRO_MS ? now() + LOAD_GRACE_MS + INTRO_MS : 0;
  matches.set(match.id, match);
  for (const id of ids) {
    const c = clients.get(id);
    old.players.delete(id), c.matchId = null;
    addToMatch(match, c, false);
  }
  for (const id of match.players.keys()) sendMatchFound(match, clients.get(id));
  for (const id of match.players.keys()) { const pc = clients.get(id); if (pc?.accountKey) pushAround(pc.accountKey); }
  spectatorsOut(old, 'The match is over.'); recKeep(old); matches.delete(old.id);
  log(`lobby: match ${old.id} -> next match ${match.id} (${mode}) with ${match.players.size} player(s)`);
  if (queues[mode]?.length) setTimeout(() => checkQueue(mode), 0); // anyone waiting joins while there's room
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
  const streak = typeof msg.streak === 'string' && STREAKS.has(msg.streak) && (attacker?.streakUntil || 0) > now();
  if (!attacker || !target || !target.alive || !(attacker.alive || streak) || target.id === attacker.id) return;
  if (!match.ffa && target.team === attacker.team) return; // no friendly fire
  if (now() - target.spawnedAt < SPAWN_PROTECT_MS) return; // fresh spawn
  if (match.startAt && now() < match.startAt) return; // the intro: the match hasn't started yet
  const amount = Math.max(0, Math.min(250, num(msg.amount)));
  if (!amount) return;
  // Release 1.0 anti-cheat: the server checks the shot's distance, line of sight, damage, fire rate and aim
  // (killstreaks are not shots)
  const chk = streak ? { ok: true } : shotCheck(match, attacker, target, msg, amount);
  if (chk.reject) return;
  target.health = Math.max(0, target.health - amount);
  const zone = typeof msg.zone === 'string' ? msg.zone.slice(0, 16) : 'torso';
  broadcast(match, { type: 'player_damaged', matchId: match.id, attackerId: attacker.id, targetId: target.id, amount, health: target.health, zone });
  recEvent(match, ['d', attacker.id, target.id, amount, zone, chk.wall ? 1 : 0, Math.round(chk.d || 0)]);
  if (target.health > 0) return;
  recEvent(match, ['k', attacker.id, target.id]);
  if (!streak) {
    const ac = acOf(attacker);
    ac.kills++, zone === 'head' && ac.hsKills++;
    !ac.once.hs && ac.kills >= 15 && ac.hsKills / ac.kills >= 0.8 && (ac.once.hs = true, acFlag(match, attacker, 'headshots', `${ac.hsKills} of ${ac.kills} kills were headshots`));
  }
  target.alive = false;
  target.diedAt = now();
  target.deaths++;
  attacker.kills++;
  if (match.tourney) tourneyLive(match, attacker);
  broadcast(match, { type: 'player_killed', matchId: match.id, attackerId: attacker.id, targetId: target.id, zone, attackerName: attacker.name, targetName: target.name, ...(streak ? { streak: msg.streak } : {}) });
  if (match.mode !== 'gg') gunSpawn(match, target.state?.variant, target.pos);
  if (match.mode === 'kc') {
    const pos = target.pos || { x: 0, y: 0, z: 0 };
    const tag = { id: newId('t'), x: pos.x, y: pos.y, z: pos.z, team: target.team, victimId: target.id, killerId: attacker.id, createdAt: now() };
    match.tags.set(tag.id, tag);
    broadcast(match, { type: 'tag_spawned', matchId: match.id, tag });
  } else if (match.ffa) {
    addPlayerScore(match, attacker, 1); // Gun Game: a kill is a point (and the next gun)
  } else {
    addScore(match, attacker.team, 1);
  }
}
// ---------- Release 1.0 anti-cheat: shot checks and cheat flags ----------
// Every hit is checked against where the server last saw both players: too far for the gun, or claimed from somewhere
// the shooter wasn't, and it doesn't count. On top of that the server keeps flags on each player through the match:
//   range / origin   hits thrown out by the checks above
//   wall             hits with no line of sight (bullets do go through thin walls, so only many of them count)
//   snap             the view swung far in the tenth of a second before the hit and stopped dead on the target
//   phantom          hits with no shot fired before them
//   rate             more shots a second than the gun can fire
//   damage           more damage in one hit than the gun can do
//   speed / teleport moving faster than anyone can run, or jumping across the map
//   headshots        nearly every kill a headshot (15 kills or more)
//   accuracy         nearly every shot a hit (60 shots or more)
// Each flag adds to the player's suspicion score for the match; at AC_FLAG_SCORE the server files a report with the
// match recording, and the flagged moments are marked in the console's replay so a moderator can jump straight to
// them and decide.
// [points per flag, flags that are free, most points] (the old rules still report on their own: 5 thrown-out hits, or
// AC_WALL_MIN hits through walls that are AC_WALL_SHARE of all hits)
const AC_W = { range: [AC_FLAG_SCORE / 5, 0, 9], origin: [AC_FLAG_SCORE / 5, 0, 9], wall: [AC_FLAG_SCORE / Math.max(1, AC_WALL_MIN - 1), 1, 9], snap: [1.5, 2, 7.5], phantom: [1, 2, 5], rate: [2, 0, 6], damage: [3, 0, 6], speed: [2, 0, 4], teleport: [3, 0, 6], headshots: [3, 0, 3], accuracy: [3, 0, 3] };
const AC_NAMES = { range: 'out of range', origin: 'from the wrong place', wall: 'no line of sight', snap: 'aim snaps', phantom: 'hits without shots', rate: 'impossible fire rate', damage: 'impossible damage', speed: 'too fast', teleport: 'teleports', headshots: 'headshot rate', accuracy: 'accuracy' };
function acOf(a) {
  return a.ac ||= { hits: 0, wall: 0, bad: 0, reported: false, n: {}, score: 0, kills: 0, hsKills: 0, shots: [], shotCount: 0, hitShots: 0, lastShotUsed: 0, look: [], mv: [], once: {}, last: {} };
}
function acScore(ac) {
  let s = 0;
  for (const [k, n] of Object.entries(ac.n)) {
    const w = AC_W[k] || [1, 0, 5];
    s += k === 'wall' && ac.wall / Math.max(1, ac.hits) < AC_WALL_SHARE ? 0 : Math.min(w[2], Math.max(0, n - w[1]) * w[0]);
  }
  return Math.round(s * 10) / 10;
}
// one flagged moment: counted, marked in the recording, and maybe the report
function acFlag(match, a, cat, detail = '', targetId = null) {
  const ac = acOf(a);
  ac.n[cat] = (ac.n[cat] || 0) + 1;
  recEvent(match, ['F', a.id, cat, String(detail).slice(0, 120), targetId]);
  ac.score = acScore(ac);
  if (ac.score >= AC_FLAG_SCORE && !ac.reported && a.key) acReport(match, a);
  else if (ac.flagId) {
    mod.flagUpdate?.(ac.flagId, { score: ac.score, counts: { ...ac.n } });
    // later flags go into the report's recording too (at most every 10 s; the whole match is saved when it ends)
    ac.reportId && now() - (ac.savedAt || 0) > 10e3 && (ac.savedAt = now(), replaySave(ac.reportId, match.id, a.key));
  }
}
function acNote(ac) {
  return `Anti-cheat · suspicion ${ac.score}: ${Object.entries(ac.n).filter(([, n]) => n > 0).map(([k, n]) => `${AC_NAMES[k] || k} ×${n}`).join(', ')}`;
}
function acReport(match, a) {
  const ac = acOf(a);
  ac.reported = true;
  const note = acNote(ac);
  log(`anti-cheat: flagging ${a.name} (${note})`);
  if (REGIONAL) return acForward(match, a, note);
  try {
    const rid = mod.autoReport(a.key, match, note);
    ac.flagId = mod.flagAdd?.({ key: a.key, name: a.name, reportId: rid, score: ac.score, counts: { ...ac.n }, match: { id: match.id, mode: match.mode, map: match.mapId || null, region: REGION } }) || null;
    ac.reportId = rid, ac.savedAt = now();
  } catch (e) { log(`anti-cheat report error: ${e.message}`); }
}
// a regional server sends the flag, with its recording, to the main server (where the console is)
async function acForward(match, a, note) {
  try {
    const R = match.rec;
    const target = R ? Object.entries(R.names).find(([, n]) => n.key === a.key)?.[0] || null : null;
    const rep = R ? zlib.gzipSync(JSON.stringify({ v: 1, at: now(), map: R.map, mode: R.mode, matchId: R.matchId, target, players: R.names, frames: R.frames, ev: R.ev, plan: LOS.plan(R.map) })).toString('base64') : null;
    const ac = acOf(a);
    await internalPost(MAIN_URL, '/internal/flag', { key: a.key, name: a.name, note, score: ac.score, counts: { ...ac.n }, match: { id: `${REGION}:${match.id}`, mode: match.mode, mapId: match.mapId || null, createdAt: match.createdAt, region: REGION }, replay: rep }, 15000);
  } catch (e) { log(`anti-cheat: could not send the flag to the main server: ${e.message}`); }
}
// At the end of a match a flagged player's report gets the whole match in its recording.
function acFinish(match) {
  for (const a of match.players.values()) {
    const ac = a.ac;
    if (!ac?.reported || !ac.reportId || REGIONAL) continue;
    try { replaySave(ac.reportId, match.id, a.key); mod.flagUpdate?.(ac.flagId, { score: ac.score, counts: { ...ac.n }, final: true }); } catch (e) { log(`anti-cheat finish error: ${e.message}`); }
  }
}
const vdir = (yaw, pitch) => ({ x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) });
const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) * 180 / Math.PI;
const EYE_H = { prone: 0.4, crouch: 1.1, slide: 1.0, stand: 1.62 };
function shotCheck(match, a, t, msg, amount = 0) {
  const A = a.pos, T = t.pos;
  if (!A || !T) return { ok: true };
  const ac = acOf(a), d = Math.hypot(A.x - T.x, A.y - T.y, A.z - T.z), w = typeof msg.w === 'string' ? msg.w.slice(0, 24) : '';
  const boom = msg.k === 'x', gun = a.state?.variant || '', melee = /^melee/.test(w) || (!w && MELEE_DMG[gun] != null);
  const max = boom ? 120 : melee ? MELEE_REACH : (GUN_RANGE[gun] || 1200) + 25; // grenades: thrown, then a blast
  const o = msg.o && typeof msg.o === 'object' ? msg.o : null, od = o && [o.x, o.y, o.z].every(Number.isFinite) ? Math.hypot(o.x - A.x, o.z - A.z) : 0;
  if (d > max || od > 9) {
    ac.bad++, recEvent(match, ['x', a.id, t.id, d > max ? 'range' : 'origin', Math.round(d > max ? d : od)]);
    log(`anti-cheat: ${a.name} hit ${t.name} ${d > max ? `from ${Math.round(d)} m (${melee ? 'melee' : gun || 'gun'} reaches ${melee ? MELEE_REACH : max - 25} m)` : `from ${Math.round(od)} m away from where they were`} · not counted`);
    acFlag(match, a, d > max ? 'range' : 'origin', d > max ? `${Math.round(d)} m with ${melee ? 'a melee weapon' : gun || 'a gun'}` : `${Math.round(od)} m from where they were`, t.id);
    return { reject: true, d };
  }
  if (boom) return { ok: true, d }; // a blast reaches round corners
  // more damage than the weapon can do in one hit
  const cap = melee ? 210 : GUN_DMG[gun] ? Math.min(250, GUN_DMG[gun] * 2.5) : 250;
  if (amount > cap + 0.5) {
    acFlag(match, a, 'damage', `${Math.round(amount)} damage in one hit (${melee ? 'melee' : gun || 'gun'} does at most ${Math.round(cap)})`, t.id);
    return { reject: true, d };
  }
  ac.hits++;
  const tNow = now();
  if (!melee) {
    // every bullet hit comes after a shot: count the shot as a hit (once), or flag a hit with no shot at all
    const sh = ac.shots.filter((x) => tNow - x < 2000);
    if (!sh.length && ac.shotCount > 0 || !ac.shotCount) {
      tNow - (ac.last.phantom || 0) > 400 && (ac.last.phantom = tNow, acFlag(match, a, 'phantom', 'a hit with no shot fired before it', t.id));
    } else if (ac.lastShotUsed !== sh.at(-1)) ac.lastShotUsed = sh.at(-1), ac.hitShots++;
    // the aim: a big swing just before the hit that stops right on the target
    const L = ac.look.at(-1);
    if (L && tNow - L.t < 160 && d >= 8) {
      const S = [...ac.look].reverse().find((x) => L.t - x.t >= 70 && L.t - x.t <= 220);
      if (S) {
        const swing = angDeg(vdir(S.yaw, S.pitch), vdir(L.yaw, L.pitch));
        const eye = { x: A.x, y: A.y + (EYE_H[a.state?.stance] ?? 1.62), z: A.z }, tc = { x: T.x - eye.x, y: T.y + (EYE_H[t.state?.stance] ?? 1.62) - 0.35 - eye.y, z: T.z - eye.z }, tl = Math.hypot(tc.x, tc.y, tc.z) || 1;
        const err = angDeg(vdir(L.yaw, L.pitch), { x: tc.x / tl, y: tc.y / tl, z: tc.z / tl });
        swing >= 35 && err <= 3 && tNow - (ac.last.snap || 0) > 300 && (ac.last.snap = tNow, acFlag(match, a, 'snap', `${Math.round(swing)}° in ${L.t - S.t} ms, then ${err.toFixed(1)}° off the target at ${Math.round(d)} m`, t.id));
      }
    }
    // nearly every shot a hit (not shotguns)
    gun !== 'sg12' && !ac.once.acc && ac.shotCount >= 60 && ac.hitShots / ac.shotCount >= 0.85 && (ac.once.acc = true, acFlag(match, a, 'accuracy', `${ac.hitShots} of ${ac.shotCount} shots hit`));
  }
  const see = melee ? true : LOS.canSee(match.mapId, A, a.state?.stance, a.state?.yaw, T, t.state?.stance);
  see === false && (ac.wall++, acFlag(match, a, 'wall', `hit ${t.name} at ${Math.round(d)} m`, t.id));
  return { ok: true, wall: see === false, d };
}
// a shot: fire rate against the gun's
function acShot(match, a) {
  const ac = acOf(a), t = now(), gun = a.state?.variant || '';
  ac.shotCount++, ac.shots.push(t);
  while (ac.shots.length && t - ac.shots[0] > 2000) ac.shots.shift();
  const rpm = GUN_RPM[gun];
  if (rpm && ac.shots.length > rpm / 30 * 1.35 + 3 && t - (ac.last.rate || 0) > 5000) ac.last.rate = t, acFlag(match, a, 'rate', `${ac.shots.length} shots in 2 s (${gun} fires ${Math.round(rpm / 30)})`);
}
// movement: faster than anyone can run, or a jump across the map
function acMove(match, a, x, z, yaw, pitch) {
  const ac = acOf(a), t = now();
  ac.look.push({ t, yaw, pitch });
  ac.look.length > 8 && ac.look.shift();
  if (!a.alive || t - (a.spawnedAt || 0) < 1500) { ac.mv.length = 0; return; }
  const prev = ac.mv.at(-1);
  if (prev && t - prev.t < 500) {
    const jump = Math.hypot(x - prev.x, z - prev.z);
    jump > 25 && t - (ac.last.tp || 0) > 3000 && (ac.last.tp = t, acFlag(match, a, 'teleport', `${Math.round(jump)} m in ${t - prev.t} ms`));
  }
  ac.mv.push({ t, x, z });
  while (ac.mv.length > 2 && t - ac.mv[0].t > 1500) ac.mv.shift();
  const first = ac.mv[0], span = t - first.t;
  if (span >= 900) {
    const v = Math.hypot(x - first.x, z - first.z) / (span / 1000);
    v > 14 && v < 400 && t - (ac.last.speed || 0) > 5000 && (ac.last.speed = t, acFlag(match, a, 'speed', `${v.toFixed(1)} m/s for ${(span / 1000).toFixed(1)} s`));
  }
}
// ---------- Release 1.0: match recordings ----------
// Five times a second, where every player is and looks, plus shots, hits and kills, for the last five minutes of
// each match (kept a few hours after it ends). A report saves a copy, so moderators can watch it in the console.
const REC_STEP_MS = 200, REC_KEEP_MS = 5 * 60e3, recentRecs = new Map(), STANCE = { stand: 0, crouch: 1, prone: 2, slide: 3 };
const r2 = (v) => Math.round(num(v) * 100) / 100;
function recOf(match) {
  return match.rec ||= { t0: now(), map: match.mapId || null, mode: match.mode, matchId: match.id, frames: [], ev: [], names: {}, last: {} };
}
function recTrim(R, t) {
  const cut = t - REC_KEEP_MS;
  if (R.frames.length > 4000 && R.frames[1500][0] < cut) { let i = 0; while (i < R.frames.length && R.frames[i][0] < cut) i++; R.frames.splice(0, i); }
  if (R.ev.length > 3000 && R.ev[1000][0] < cut) { let i = 0; while (i < R.ev.length && R.ev[i][0] < cut) i++; R.ev.splice(0, i); }
}
function recFrame(match, p) {
  const R = recOf(match), t = now() - R.t0, s = p.state;
  if (!s || t - (R.last[p.id] ?? -1e9) < REC_STEP_MS) return;
  R.last[p.id] = t, R.map = match.mapId || R.map, R.names[p.id] = { name: p.name, team: p.team, key: p.key || keyOf(p.name) };
  R.frames.push([t, p.id, r2(s.x), r2(s.y), r2(s.z), r2(s.yaw), r2(s.pitch), STANCE[s.stance] ?? 0, s.alive ? 1 : 0]), recTrim(R, t);
}
function recEvent(match, e) {
  const R = recOf(match), t = now() - R.t0;
  R.ev.push([t, ...e]), recTrim(R, t);
}
function recKeep(match) {
  if (!match?.rec) return;
  acFinish(match);
  recentRecs.set(match.id, { ...match.rec, closed: now() });
  for (const [id, r] of recentRecs) if (recentRecs.size > 12 || now() - r.closed > 3 * 3600e3) recentRecs.delete(id);
}
const REPLAY_DIR = pathMod.join(DATA_DIR, 'replays');
function replaySave(reportId, matchId, targetKey) {
  const R = matches.get(matchId)?.rec || recentRecs.get(matchId);
  if (!R || !R.frames.length || !/^[a-f0-9]{6,32}$/.test(String(reportId))) return false;
  const target = Object.entries(R.names).find(([, n]) => n.key === targetKey)?.[0] || null;
  const rep = { v: 1, at: now(), map: R.map, mode: R.mode, matchId: R.matchId, target, players: R.names, frames: R.frames, ev: R.ev, plan: LOS.plan(R.map) };
  try {
    fs.mkdirSync(REPLAY_DIR, { recursive: true });
    fs.writeFileSync(pathMod.join(REPLAY_DIR, `${reportId}.json.gz`), zlib.gzipSync(JSON.stringify(rep)));
    const files = fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.json.gz')).map((f) => ({ f, t: fs.statSync(pathMod.join(REPLAY_DIR, f)).mtimeMs })).sort((x, y) => y.t - x.t);
    for (const { f } of files.slice(120)) fs.rmSync(pathMod.join(REPLAY_DIR, f), { force: true });
    return true;
  } catch (e) {
    log(`replay save error: ${e.message}`);
    return false;
  }
}
function replayLoad(reportId) {
  if (!/^[a-f0-9]{6,32}$/.test(String(reportId))) return null;
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(pathMod.join(REPLAY_DIR, `${reportId}.json.gz`))).toString('utf8')); } catch { return null; }
}
// Kill Confirmed is free-for-all: any tag except your own confirms a kill for you.
function tagConfirms(match, tag, p) {
  return match.ffa ? tag.victimId !== p.id : tag.team !== p.team;
}
// Beta 1.3 killstreaks: the caller's game runs the streak (it decides hits); the server passes the event on so
// everyone sees the UAV, airstrike, care package, sentry or helicopter, and lets that player's streak damage count
// for a while even if they die meanwhile.
const STREAKS = new Set(['uav', 'cuav', 'care', 'air', 'sentry', 'heli']);
const STREAK_LIFE = { uav: 35e3, cuav: 30e3, care: 70e3, air: 12e3, sentry: 50e3, heli: 50e3 };
function onStreak(c, msg) {
  const match = matches.get(c.matchId);
  if (!match || match.ended || match.phase !== 'live') return;
  const p = match.players.get(c.id);
  const kind = String(msg.kind || ''), phase = String(msg.phase || '').slice(0, 10);
  if (!p || !STREAKS.has(kind) || !/^[a-z]+$/.test(phase)) return;
  const t = now();
  c.streakBucket = Math.min(12, (c.streakBucket ?? 12) + (t - (c.streakT || t)) / 1000 * 6); c.streakT = t;
  if (c.streakBucket < 1) return; // at most ~6 a second
  c.streakBucket -= 1;
  let data = msg.data && typeof msg.data === 'object' && !Array.isArray(msg.data) ? msg.data : {};
  try { if (JSON.stringify(data).length > 600) data = {}; } catch { data = {}; }
  if (phase !== 'fire' && phase !== 'taken') p.streakUntil = Math.max(p.streakUntil || 0, t + (STREAK_LIFE[kind] || 30e3));
  broadcast(match, { type: 'streak', matchId: match.id, playerId: c.id, name: p.name, team: p.team, kind, phase, data }, c.id);
}
// a gun on the ground (ammo and reserve: what was in it, or null for a full magazine)
function gunSpawn(match, variant, pos, ammo = null, reserve = null) {
  if (!GUN_DMG[variant] || !pos || ![pos.x, pos.y, pos.z].every(Number.isFinite) || match.ended) return null;
  const guns = match.guns ||= new Map();
  while (guns.size >= GUN_MAX) {
    const old = guns.values().next().value;
    guns.delete(old.id);
    broadcast(match, { type: 'gun_removed', matchId: match.id, gunId: old.id, reason: 'expired' });
  }
  const n = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(999, Math.floor(v))) : null);
  const gun = { id: newId('g'), variant, x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2), yaw: +(Math.random() * Math.PI * 2).toFixed(2), ammo: n(ammo), reserve: n(reserve), at: now() };
  guns.set(gun.id, gun);
  broadcast(match, { type: 'gun_spawned', matchId: match.id, gun });
  return gun;
}
function onGunPickup(c, msg) {
  const match = matches.get(c.matchId);
  if (!match || match.ended || match.phase !== 'live' || !match.guns) return;
  const p = match.players.get(c.id), gun = match.guns.get(String(msg.gunId || ''));
  if (!p || !p.alive || !gun) return send(c, { type: 'gun_missed', matchId: match.id, gunId: String(msg.gunId || '') });
  if (p.pos && Math.hypot(p.pos.x - gun.x, p.pos.z - gun.z) > GUN_REACH) return send(c, { type: 'gun_missed', matchId: match.id, gunId: gun.id });
  match.guns.delete(gun.id);
  broadcast(match, { type: 'gun_removed', matchId: match.id, gunId: gun.id, by: c.id });
  send(c, { type: 'gun_taken', matchId: match.id, gunId: gun.id, variant: gun.variant, ammo: gun.ammo, reserve: gun.reserve });
  // the gun you had in that slot drops where you stand
  const d = msg.drop && typeof msg.drop === 'object' ? msg.drop : null;
  if (d && typeof d.variant === 'string' && GUN_DMG[d.variant] && p.pos) gunSpawn(match, d.variant, p.pos, Number(d.ammo), Number(d.reserve));
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
    moving: !!s.moving, sprinting: !!s.sprinting, sliding: !!s.sliding, quiet: !!s.quiet, ghost: !!s.ghost,
    weaponId: typeof s.weaponId === 'string' ? s.weaponId.slice(0, 24) : null,
    variant: typeof s.variant === 'string' ? s.variant.slice(0, 24) : null,
    // Release 1.0: the player's operator (the developer-only one is never shown to anyone else)
    op: typeof s.op === 'string' && /^[a-z0-9_-]{1,24}$/.test(s.op) && !PRIVATE_OPS.has(s.op) ? s.op : null,
    inspect: !!s.inspect, // Release 1.0: looking at their gun
    alive: s.alive !== false && p.alive,
  };
  recFrame(match, p);
  try { acMove(match, p, x, z, p.state.yaw, p.state.pitch); } catch (e) { log(`anti-cheat move error: ${e.message}`); }
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
  p.ac && (p.ac.mv.length = 0);
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
// ---------- spectating (moderators, from the /admin console) ----------
// The console sends an offer to the moderator's own signed-in game; the game then joins the match as an
// invisible spectator: it gets every match message (positions, shots, kills) but is not a player.
function liveMatchOf(key) {
  for (const set of [online.get(key)]) if (set) for (const c of set) if (c.matchId && matches.get(c.matchId)) return { match: matches.get(c.matchId), c };
  return null;
}
function spectateOffer(modKey, targetKey) {
  const lm = liveMatchOf(targetKey);
  if (!lm) return { error: `${nameOf(targetKey)} is not in a match right now.` };
  if (!online.get(modKey)?.size) return { error: `Open Vangaurd and sign in as ${nameOf(modKey)} first; the match opens in your game.` };
  sendTo(modKey, { type: 'spectate_offer', target: nameOf(targetKey), matchId: lm.match.id, mode: lm.match.mode, players: lm.match.players.size });
  return { match: lm.match.id, players: lm.match.players.size, mode: lm.match.mode };
}
function spectateJoin(c, msg) {
  if (msg.tourney) return void casterJoin(c, msg).catch((e) => log(`watch error: ${e.message}`));
  if (!c.account && msg.token) { const u = sessionUser(msg.token); if (u) c.account = u.name; }
  const me = keyOf(c.account);
  if (!me || !mod.roleOf(me)) return send(c, { type: 'spectate_error', message: 'Only moderators can spectate.' });
  if (c.matchId) return send(c, { type: 'spectate_error', message: 'Leave your own match first.' });
  const lm = liveMatchOf(keyOf(msg.target));
  if (!lm) return send(c, { type: 'spectate_error', message: `${String(msg.target || 'That player').slice(0, 16)} is not in a match right now.` });
  spectateLeave(c, false);
  removeFromQueue(c);
  const { match } = lm;
  (match.spectators ||= new Set()).add(c.id);
  c.spectating = match.id;
  send(c, {
    type: 'spectate_start', matchId: match.id, mode: match.mode, ffa: match.ffa, phase: match.phase, mapId: match.mapId || match.vote?.options?.[0] || null,
    roster: rosterOf(match), score: { ...match.score }, scoreLimit: match.scoreLimit, players: match.ffa ? boardOf(match) : undefined, target: lm.c.id, targetName: nameOf(keyOf(msg.target)), ended: match.ended,
  });
  for (const p of match.players.values()) if (p.state) send(c, { type: 'player_state', matchId: match.id, playerId: p.id, state: p.state });
  log(`moderation: ${c.account} is spectating ${nameOf(keyOf(msg.target))} in match ${match.id}`);
}
function spectateLeave(c, notify) {
  if (c.caster) c.cq = [], c.caster = false;
  const match = c.spectating && matches.get(c.spectating);
  if (match) {
    if (match.spectators?.has(c.id)) match.spectators.delete(c.id);
    else if (c.drone) match.droneWait = Math.max(0, (match.droneWait || 1) - 1); // left while its map was loading
  }
  if (c.spectating && notify) send(c, { type: 'spectate_end', reason: 'left' });
  if (match && !match.players.size && !match.spectators?.size && !match.droneWait && matches.get(match.id) === match) {
    // a developer's drone was the last one there
    clearTimeout(match.vote?.timer); recKeep(match); matches.delete(match.id); log(`match ${match.id} closed`);
  }
  c.spectating = null;
  c.drone = false;
}
// ---------- drone (developers, Beta 1.31) ----------
// A developer flies the drone over a multiplayer map. If a match of that mode is being played on that map they
// watch it (invisible, like a moderator spectating); otherwise they get the map to themselves in an empty match
// that nobody else is put into. The game picks the map and mode.
function devOf(c, msg) {
  if (!c.account && msg.token) { const u = sessionUser(msg.token); if (u) c.account = u.name; }
  const key = keyOf(c.account);
  return key && ops.isDev(key) ? key : null;
}
function droneLive() {
  const out = [];
  for (const m of matches.values()) {
    if (m.ended || !m.players.size) continue;
    out.push({ matchId: m.id, mode: m.mode, mapId: m.phase === 'vote' ? null : m.mapId, phase: m.phase, players: m.players.size, options: m.phase === 'vote' ? m.vote.options : undefined });
  }
  return out;
}
function droneInfo(c, msg) {
  if (!devOf(c, msg)) return send(c, { type: 'drone_error', message: 'Drone mode is for developers.' });
  send(c, { type: 'drone_info', maps: MAPS, modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { name: v.name, ffa: v.ffa }])), live: droneLive() });
}
function droneJoin(c, msg) {
  if (REGIONAL) return send(c, { type: 'spectate_error', message: 'Drone mode runs on the main server.' });
  if (!devOf(c, msg)) return send(c, { type: 'spectate_error', message: 'Drone mode is for developers.' });
  if (c.matchId) return send(c, { type: 'spectate_error', message: 'Leave your match first.' });
  const mode = modeOf(msg.mode), mapId = MAPS.includes(String(msg.mapId || '')) ? String(msg.mapId) : null;
  if (!mapId) return send(c, { type: 'spectate_error', message: 'Pick a map.' });
  spectateLeave(c, false);
  removeFromQueue(c);
  let match = null;
  for (const m of matches.values()) if (m.mode === mode && !m.ended && m.players.size && m.phase === 'live' && m.mapId === mapId && (!match || m.players.size > match.players.size)) match = m;
  const watching = !!match;
  if (!match) {
    match = {
      id: newId('m'), mode, ffa: MODES[mode].ffa, scoreLimit: MODES[mode].scoreLimit, score: { alpha: 0, bravo: 0 },
      players: new Map(), tags: new Map(), ended: false, createdAt: now(), phase: 'live', mapId, drone: true,
      vote: { options: [mapId], votes: new Map(), endsAt: 0, timer: null },
    };
    matches.set(match.id, match);
  }
  // The game loads the map first and then says spectate_ready; only then does it get the match's messages (a
  // flood of positions during a long map load can stall the connection until the server drops it).
  c.spectating = match.id;
  c.drone = true;
  match.droneWait = (match.droneWait || 0) + 1;
  send(c, {
    type: 'spectate_start', drone: true, watching, matchId: match.id, mode: match.mode, ffa: match.ffa, phase: match.phase, mapId: match.mapId,
    roster: rosterOf(match), score: { ...match.score }, scoreLimit: match.scoreLimit, players: match.ffa ? boardOf(match) : undefined, target: null, targetName: '', ended: match.ended,
  });
  log(`drone: ${c.account} is flying over ${mapId} (${mode}${watching ? `, watching match ${match.id} with ${match.players.size} player(s)` : ', empty map'})`);
}
function droneReady(c) {
  if (!c.drone || !c.spectating) return;
  const match = matches.get(c.spectating);
  if (!match) { c.spectating = null; c.drone = false; return send(c, { type: 'spectate_end', reason: 'The match closed.' }); }
  if (match.spectators?.has(c.id)) return;
  match.droneWait = Math.max(0, (match.droneWait || 1) - 1);
  (match.spectators ||= new Set()).add(c.id);
  send(c, { type: 'match_update', matchId: match.id, roster: rosterOf(match) });
  send(c, scoreMsg(match));
  for (const t of match.tags.values()) send(c, { type: 'tag_spawned', matchId: match.id, tag: t });
  for (const p of match.players.values()) if (p.state) send(c, { type: 'player_state', matchId: match.id, playerId: p.id, state: p.state });
}
function spectatorsOut(match, reason) {
  if (!match.spectators?.size) return;
  for (const id of match.spectators) { const sc = clients.get(id); if (sc) { sc.spectating = null; sc.caster ? castSend(sc, { type: 'spectate_end', reason, caster: true }) : send(sc, { type: 'spectate_end', reason }); } }
  match.spectators.clear();
}
// ---------- Release 1.0: watching tournament matches ----------
async function casterJoin(c, msg) {
  if (REGIONAL) {
    const r = await regionalSession(c, msg);
    if (r?.error) return send(c, { type: 'spectate_error', message: r.message || 'Sign in to watch tournament matches.' });
    c.account = r.name; c.accountKey = r.key;
  } else if (!c.account && msg.token) { const u = sessionUser(msg.token); if (u) c.account = u.name; }
  if (!c.account) return send(c, { type: 'spectate_error', message: 'Sign in to watch tournament matches.' });
  if (c.matchId) return send(c, { type: 'spectate_error', message: 'Leave your own match first.' });
  const tid = String(msg.tourney || '');
  const all = [...matches.values()].filter((m) => m.tourney?.id === tid && !m.ended && m.players.size), live = all.filter((m) => m.phase === 'live' && m.mapId);
  if (!live.length) return send(c, { type: 'spectate_error', code: all.length ? 'soon' : 'none', message: all.length ? 'A match is picking its map. Try again in a few seconds.' : 'No matches of this tournament are being played right now. Try again in a minute.' });
  const match = live.find((m) => m.id === String(msg.matchId || '')) || live.sort((a, b) => b.players.size - a.players.size || b.createdAt - a.createdAt)[0];
  spectateLeave(c, false);
  removeFromQueue(c);
  c.spectating = match.id; c.caster = true; c.cq = []; c.castReady = false;
  const T = match.tourney;
  send(c, {
    type: 'spectate_start', caster: true, delay: CASTER_DELAY_MS / 1000, matchId: match.id, mode: match.mode, ffa: match.ffa, phase: match.phase, mapId: match.mapId,
    roster: rosterOf(match), score: { ...match.score }, scoreLimit: match.scoreLimit, players: match.ffa ? boardOf(match) : undefined, target: null, targetName: '', ended: match.ended,
    tourney: { id: T.id, name: T.name, format: T.format, round: T.round, teams: (T.teams || []).map((t) => ({ side: t.side, name: t.name, members: t.members.map(nameOf) })) },
    live: live.map((m) => ({ matchId: m.id, players: m.players.size, mapId: m.mapId, score: { ...m.score } })),
  });
  log(`${c.account} is watching ${T.name} (match ${match.id}, ${match.players.size} players)`);
}
// the spectator's map has loaded: from now on they get the match (late)
function casterReady(c) {
  const match = c.caster && c.spectating && matches.get(c.spectating);
  if (!match) { if (c.caster) { c.spectating = null; send(c, { type: 'spectate_end', reason: 'The match is over.', caster: true }); } return; }
  if (match.spectators?.has(c.id)) return;
  (match.spectators ||= new Set()).add(c.id);
  castSend(c, { type: 'match_update', matchId: match.id, roster: rosterOf(match) });
  castSend(c, scoreMsg(match));
  for (const t of match.tags.values()) castSend(c, { type: 'tag_spawned', matchId: match.id, tag: t });
  for (const g of match.guns?.values() || []) castSend(c, { type: 'gun_spawned', matchId: match.id, gun: g });
  for (const p of match.players.values()) if (p.state) castSend(c, { type: 'player_state', matchId: match.id, playerId: p.id, state: p.state });
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
  chat: chatAdmin, kick: kickClient, kickKey: (key, msg) => (REGIONS.length ? regionKick(key, msg) : Promise.resolve(0)), saveOf: (key) => saves[key]?.blob || null, spectateOffer, replaySave, replayLoad, sendTo: (key, msg) => sendTo(key, msg),
  putSave(key, blob) {
    const cur = saves[key] || { rev: 0 };
    saves[key] = { rev: cur.rev + 1, at: now(), blob };
    if (!savesTimer) savesTimer = setTimeout(writeSaves, 1500);
    sendTo(key, { type: 'data', rev: saves[key].rev, at: saves[key].at, blob, admin: true });
    return saves[key].rev;
  },
});
mod.kickNow = (c, b) => kickClient(c, mod.bannedMsg(b));
// ---------- operations: announcements, maintenance, Steam, developers, latest build (see ops.mjs) ----------
const ops = createOps({ DATA_DIR, now, log, keyOf, nameOf, userOf, roleOf: (k) => mod.roleOf(k), ownerKey: () => mod.ownerKey(), env: process.env });
if (ops.state.release) raiseLatest(ops.state.release.build, ops.state.release.label, 'console');
// ---------- Release 1.0: tournaments (see tourneys.mjs) ----------
// The main server keeps the tournaments, registrations and leaderboards. Pressing Play hands each team member a
// ticket for the tournament's match server (this one, or a regional one), whose tournament queue starts a match as
// soon as two whole teams are waiting (Duo and Squad), or 2 to 8 solo players after a short wait (Solo). Results go
// back to the main server.
const TQ_FFA_WAIT = process.env.TOURNEY_FFA_WAIT !== undefined && process.env.TOURNEY_FFA_WAIT !== '' && Number.isFinite(Number(process.env.TOURNEY_FFA_WAIT)) ? Math.max(0, Number(process.env.TOURNEY_FFA_WAIT)) : 20;
const tourneys = REGIONAL ? null : createTourneys({ DATA_DIR, now, log, nameOf, keyOf, userOf, staff: (k) => ops.staff(k), modeName: shortName, regions: () => REGIONS, mainRegion: { id: REGION, name: REGION_NAMES[REGION] || REGION } });
function tourneyListTo(key) { if (tourneys) sendTo(key, { type: 'tourneys', list: tourneys.listFor(key) }); }
// the owner changed a tournament: every game with the Tournaments screen open asks for the list again
if (tourneys) mod.attachTourneys({ ...tourneys, changed(keys) { broadcastAll({ type: 'tourneys_changed' }); for (const k of keys || []) tourneyListTo(k); } });
function partyKeys(key) {
  const pt = parties.get(partyOf.get(key));
  return pt ? { members: pt.members.slice(), leader: pt.leader } : { members: [key], leader: key };
}
function tourneyMsg(c, msg) {
  if (!tourneys) return;
  const key = keyOf(c.account), id = String(msg.id || '');
  const fail = (message) => send(c, { type: 'tourney_error', id, message });
  if (msg.type === 'tourney_list') return send(c, { type: 'tourneys', list: tourneys.listFor(key) });
  if (msg.type === 'tourney_board') { const b = tourneys.board(id, key); return b ? send(c, { type: 'tourney_board', ...b }) : fail('That tournament no longer exists.'); }
  if (msg.type === 'tourney_watch') { const w = tourneys.watch(id); return w.error ? fail(w.error) : send(c, { type: 'tourney_watch_go', id, name: w.tournament.name, url: w.region.url || null }); }
  const pk = partyKeys(key);
  if (msg.type === 'tourney_register') {
    const r = tourneys.register(key, id, pk.members, pk.leader);
    if (r.error) return fail(r.error);
    log(`tournament ${r.tournament.name}: ${r.team.members.map(nameOf).join(', ')} registered`);
    for (const k of new Set([...pk.members, key])) { tourneyListTo(k); k !== key && note(k, `${nameOf(key)} registered your party for ${r.tournament.name}`, { kind: 'party' }); }
    return send(c, { type: 'tourney_ok', id, action: 'register' });
  }
  if (msg.type === 'tourney_unregister') {
    const r = tourneys.unregister(key, id);
    if (r.error) return fail(r.error);
    for (const k of new Set([...r.team.members, key])) tourneyListTo(k);
    return send(c, { type: 'tourney_ok', id, action: 'unregister' });
  }
  if (msg.type === 'tourney_play') {
    // checked after the tournament's own rules: everyone online, nobody in a match that's still going, the servers up
    const busy = (members, region) => {
      for (const k of members) {
        if (statusOf(k) === 'offline') return `${nameOf(k)} is offline.`;
        for (const pc of online.get(k) || []) { const m = pc.matchId && matches.get(pc.matchId); if (m && !m.ended) return `${nameOf(k)} is in a match. Wait for them to finish.`; }
      }
      if (region.id !== REGION && !regionUp.get(region.id)) return `The ${region.name} servers are offline right now. Try again in a minute.`;
      return null;
    };
    const r = tourneys.play(key, id, pk.members, busy, pk.leader);
    if (r.error) return fail(r.error);
    for (const tk of r.tickets) sendTo(tk.key, { type: 'tourney_go', id: r.tournament.id, name: r.tournament.name, mode: r.tournament.mode, format: r.tournament.format, url: r.region.url || null, ticket: tk.ticket, leader: nameOf(key), points: r.team.points || 0 });
    log(`tournament ${r.tournament.name}: ${r.team.members.map(nameOf).join(', ')} queued (${r.region.id})`);
    // Play made the party a team (there's no registering by hand): everyone's list shows it
    if (r.joined) for (const k of r.team.members) tourneyListTo(k);
  }
}
// main: a tournament match ended (here or on a regional server)
function tourneyResult(tid, matchId, rows, round = null) {
  if (!tourneys) return { error: 'not the main server' };
  const r = tourneys.result(tid, matchId, rows, round);
  if (!r.ok || r.dup) return r;
  const t = r.tournament;
  for (const row of r.teams) {
    const tm = t.teams[row.teamId];
    if (!tm) continue;
    const my = tourneys.board(t.id, tm.members[0], 0)?.my;
    for (const k of tm.members) {
      sendTo(k, { type: 'tourney_result', id: t.id, name: t.name, points: row.points, kills: row.kills, won: row.won, place: row.place, total: tm.points, rank: my?.rank ?? null, matches: tm.matches, maxMatches: t.maxMatches, left: my?.left ?? 0, rounds: t.rounds });
      tourneyListTo(k);
    }
  }
  log(`tournament ${t.name}: match ${matchId} · ${r.teams.map((x) => `${x.name} +${x.points}`).join(', ')}`);
  return { ok: true };
}

// ---------- tournament queue (every match server) ----------
const tq = new Map(); // tournament id -> { conf, teams: Map(teamId -> { team, at, cids: Map(key -> client id) }), cd }
async function tourneyJoin(c, msg) {
  const key = c.accountKey || keyOf(c.account), ticket = String(msg.tourney?.ticket || '');
  let r;
  if (REGIONAL) { try { r = await internalPost(MAIN_URL, '/internal/tourney-ticket', { ticket, key }); } catch { r = { error: "Can't reach the tournament server. Try again." }; } }
  else r = tourneys.ticketCheck(ticket, key);
  if (!r?.ok) return send(c, { type: 'error', code: 'tourney', message: r?.error || 'Could not join the tournament.' });
  if (c.ws.readyState !== WebSocket.OPEN || !clients.has(c.id)) return;
  const { conf, team } = r;
  let q = tq.get(conf.id);
  if (!q) tq.set(conf.id, q = { conf, teams: new Map(), cd: null });
  q.conf = conf;
  let e = q.teams.get(team.id);
  if (!e) q.teams.set(team.id, e = { team, at: now(), cids: new Map() });
  e.team = team;
  const was = e.cids.get(key);
  if (was && was !== c.id) { const oc = clients.get(was); if (oc) oc.tourneyQ = null; }
  e.cids.set(key, c.id);
  c.queuedMode = `t:${conf.id}`, c.tourneyQ = { tid: conf.id, teamId: team.id };
  if (c.accountKey) pushAround(c.accountKey);
  log(`${c.name} is waiting in the ${conf.name} tournament queue`);
  tqCheck(conf.id);
}
// a tournament lobby: Duo is 2v2 (4 players), Squad 4v4 (8 players), Solo a free-for-all of up to T_FFA_MAX
const tqSize = (conf) => Math.max(1, Number(conf.size) || (conf.format === 'squad' ? 4 : conf.format === 'duo' ? 2 : 1));
const tqCap = (conf) => (conf.format === 'solo' ? T_FFA_MAX : 2 * tqSize(conf));
const tqHere = (q, e, k) => { const cl = clients.get(e.cids.get(k)); return !!cl && cl.tourneyQ?.tid === q.conf.id && cl.tourneyQ.teamId === e.team.id; };
const tqReady = (q) => [...q.teams.values()].filter((e) => e.team.members.every((k) => tqHere(q, e, k))).sort((a, b) => a.at - b.at);
function tqStatus(q) {
  const ready = tqReady(q), solo = q.conf.format === 'solo', startsIn = q.cd ? Math.max(0, Math.ceil((q.cd.endsAt - now()) / 1000)) : null;
  // counted in players: a team lobby needs both teams (2 of 4 players for Duo, 4 of 8 for Squad)
  const size = tqSize(q.conf), cap = tqCap(q.conf), queued = solo ? ready.length : Math.min(1, ready.length) * size;
  for (const e of q.teams.values()) {
    const missing = e.team.members.filter((k) => !tqHere(q, e, k)).map(nameOf);
    for (const cid of e.cids.values()) send(clients.get(cid), { type: 'queue_status', mode: q.conf.mode, tourney: q.conf.id, tourneyName: q.conf.name, format: q.conf.format, queued, minimum: solo ? 2 : cap, maximum: cap, teams: ready.length, teamSize: size, startsIn, full: false, waitingFor: missing });
  }
}
function tqCheck(tid) {
  const q = tq.get(tid);
  if (!q) return;
  for (const [id, e] of q.teams) { for (const k of [...e.cids.keys()]) if (!tqHere(q, e, k)) e.cids.delete(k); if (!e.cids.size) q.teams.delete(id); }
  if (!q.teams.size) { clearInterval(q.cd?.timer); tq.delete(tid); return; }
  if (q.conf.endsAt <= now()) {
    for (const e of [...q.teams.values()]) for (const cid of [...e.cids.values()]) { const cl = clients.get(cid); if (cl) { cl.tourneyQ = null; cl.queuedMode = null; send(cl, { type: 'queue_cancelled' }); send(cl, { type: 'error', code: 'tourney', message: `${q.conf.name} has ended.` }); } }
    clearInterval(q.cd?.timer); tq.delete(tid); return;
  }
  const ready = tqReady(q);
  if (q.conf.format === 'solo') {
    if (ready.length >= T_FFA_MAX) return tqStart(q, ready.slice(0, T_FFA_MAX));
    if (ready.length >= 2 && TQ_FFA_WAIT === 0) return tqStart(q, ready);
    if (ready.length >= 2 && !q.cd) {
      const cd = q.cd = { endsAt: now() + TQ_FFA_WAIT * 1000, timer: null };
      cd.timer = setInterval(() => {
        if (q.cd !== cd) return clearInterval(cd.timer);
        const r2 = tqReady(q);
        if (r2.length < 2) { clearInterval(cd.timer); q.cd = null; return tqStatus(q); }
        if (now() >= cd.endsAt) { clearInterval(cd.timer); q.cd = null; return tqStart(q, r2.slice(0, T_FFA_MAX)); }
        tqStatus(q);
      }, 1000);
    } else if (ready.length < 2 && q.cd) { clearInterval(q.cd.timer); q.cd = null; }
  } else if (ready.length >= 2) return tqStart(q, ready.slice(0, 2));
  tqStatus(q);
}
// a team member left the queue (cancel, disconnect): the whole team leaves it
function tqLeave(c) {
  const { tid, teamId } = c.tourneyQ;
  c.tourneyQ = null;
  const q = tq.get(tid), e = q?.teams.get(teamId);
  if (!e) return;
  const key = c.accountKey || keyOf(c.account);
  e.cids.get(key) === c.id && e.cids.delete(key);
  for (const [k, cid] of [...e.cids]) {
    const cl = clients.get(cid);
    e.cids.delete(k);
    if (!cl || !cl.tourneyQ) continue;
    cl.tourneyQ = null, cl.queuedMode = null;
    send(cl, { type: 'queue_cancelled' }), send(cl, { type: 'error', code: 'tourney', message: `${nameOf(key)} left the tournament queue.` });
    if (cl.accountKey) pushAround(cl.accountKey);
  }
  q.teams.delete(teamId);
  setTimeout(() => tqCheck(tid), 0);
}
function tqStart(q, entries) {
  const conf = q.conf, ffa = !!MODES[conf.mode]?.ffa, side = new Map(), teams = [], size = tqSize(conf), cap = tqCap(conf);
  // exactly two teams of the format's size in a team lobby (2v2, 4v4); up to T_FFA_MAX players in a free-for-all
  entries = conf.format === 'solo' ? entries.slice(0, T_FFA_MAX) : entries.slice(0, 2);
  entries.forEach((e, i) => {
    const s = ffa ? 'ffa' : i === 0 ? 'alpha' : 'bravo', members = e.team.members.slice(0, size);
    for (const k of members) side.set(k, s);
    teams.push({ teamId: e.team.id, side: s, members, name: e.team.name, base: Math.max(0, Math.floor(Number(e.team.points) || 0)) });
    q.teams.delete(e.team.id);
  });
  const match = {
    id: newId('m'), mode: conf.mode, ffa, scoreLimit: conf.scoreLimit || MODES[conf.mode].scoreLimit, score: { alpha: 0, bravo: 0 },
    players: new Map(), tags: new Map(), ended: false, createdAt: now(),
    phase: VOTE_S > 0 ? 'vote' : 'live', mapId: null,
    vote: { options: shuffled(MAPS).slice(0, 3), votes: new Map(), endsAt: now() + VOTE_S * 1000, timer: null },
    tourney: { id: conf.id, name: conf.name, format: conf.format, round: Number.isInteger(conf.round) ? conf.round : null, side, teams, cap, gone: new Map() },
  };
  if (match.phase === 'vote') match.vote.timer = setTimeout(() => finishVote(match), VOTE_S * 1000);
  else match.mapId = match.vote.options[0], match.startAt = INTRO_MS ? now() + LOAD_GRACE_MS + INTRO_MS : 0;
  matches.set(match.id, match);
  for (const e of entries) for (const [k, cid] of e.cids) {
    const c = clients.get(cid);
    if (!c || !side.has(k)) continue;
    c.tourneyQ = null, c.queuedMode = null;
    addToMatch(match, c, false);
  }
  for (const id of match.players.keys()) sendMatchFound(match, clients.get(id));
  for (const id of match.players.keys()) { const pc = clients.get(id); if (pc?.accountKey) pushAround(pc.accountKey); }
  log(`tournament match ${match.id} (${conf.name}, ${conf.mode}) started: ${teams.map((t) => t.name).join(' vs ')}`);
  if (!q.teams.size) { clearInterval(q.cd?.timer); tq.delete(conf.id); } else tqStatus(q);
}
// the team's tournament points so far, live in the match: before it, plus every elimination in it (the win and the
// free-for-all placement are added when it ends)
function tourneyLivePoints(match, key) {
  const T = match.tourney, tm = T?.teams.find((x) => x.members.includes(key));
  if (!tm) return null;
  let kills = 0;
  for (const k of tm.members) {
    let here = false;
    for (const p of match.players.values()) if (p.key === k) { kills += p.kills; here = true; }
    if (!here) kills += T.gone.get(k)?.kills || 0;
  }
  return tm.base + kills;
}
function tourneyLive(match, attacker) {
  const T = match.tourney, tm = T.teams.find((x) => x.members.includes(attacker.key));
  if (!tm) return;
  const points = tourneyLivePoints(match, attacker.key);
  for (const p of match.players.values()) if (tm.members.includes(p.key)) send(clients.get(p.id), { type: 'tourney_points', matchId: match.id, id: T.id, points, add: 1, by: attacker.name });
}
// a whole team left (or all but one free-for-all player): the match ends and the rest win
function tourneyForfeit(match) {
  const T = match.tourney;
  if (match.ffa) {
    if (match.players.size === 1) endMatch(match, [...match.players.keys()][0]);
    return;
  }
  const here = new Set([...match.players.values()].map((p) => p.team));
  if (here.size === 1) endMatch(match, [...here][0]);
  else if (!here.size) endMatch(match, null);
  void T;
}
function tourneyReport(match, winner) {
  const T = match.tourney;
  if (T.reported) return;
  T.reported = true;
  const statOf = (k) => {
    for (const p of match.players.values()) if (p.key === k) return { kills: p.kills, score: p.score, here: 1, at: 0 };
    const g = T.gone.get(k);
    return g ? { kills: g.kills, score: g.score, here: 0, at: g.at } : { kills: 0, score: 0, here: 0, at: 0 };
  };
  const rows = [];
  if (match.ffa) {
    const ppl = T.teams.map((t) => ({ t, s: statOf(t.members[0]), w: match.players.get(winner)?.key === t.members[0] ? 1 : 0 }));
    ppl.sort((a, b) => b.w - a.w || b.s.here - a.s.here || b.s.score - a.s.score || b.s.at - a.s.at);
    ppl.forEach((x, i) => rows.push({ teamId: x.t.teamId, place: i + 1, kills: x.s.kills }));
  } else for (const t of T.teams) rows.push({ teamId: t.teamId, won: winner === t.side, kills: t.members.reduce((n, k) => n + statOf(k).kills, 0) });
  const id = `${REGION}:${match.id}`;
  if (REGIONAL) internalPost(MAIN_URL, '/internal/tourney-result', { tid: T.id, matchId: id, round: T.round, rows }).catch((e) => log(`could not report tournament match ${match.id}: ${e.message}`));
  else tourneyResult(T.id, id, rows, T.round);
}
// a tournament that ended empties its queue
setInterval(() => { for (const tid of [...tq.keys()]) tqCheck(tid); }, 5000).unref?.();
function broadcastAll(msg) { for (const c of clients.values()) send(c, msg); }
// ---------- regions: main <-> regional servers ----------
async function internalPost(base, path, body, ms = 5000) {
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${base}${path}`, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-internal-key': INTERNAL_KEY }, body: JSON.stringify(body) });
    return await res.json();
  } finally { clearTimeout(to); }
}
const internalOk = (req) => {
  const given = String(req.headers['x-internal-key'] || '');
  return !!INTERNAL_KEY && given.length === INTERNAL_KEY.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(INTERNAL_KEY));
};
// main: tell the regional servers to disconnect a player (moderator kick or ban); returns how many were kicked
async function regionKick(key, msg) {
  let n = 0;
  await Promise.all(REGIONS.map(async (r) => { try { n += (await internalPost(r.url, '/internal/kick', { key, msg }))?.kicked | 0; } catch (e) { log(`region ${r.id} kick failed: ${e.message}`); } }));
  return n;
}
function regionMaintenance(message) {
  for (const r of REGIONS) internalPost(r.url, '/internal/maintenance', { message }).catch((e) => log(`region ${r.id} maintenance failed: ${e.message}`));
}
// main: who is this token? (asked by a regional server when a player queues there)
// Release 1.0: early access to a version ends once that version is released
setTimeout(() => { const n = ops.earlyPrune(latest.build); n && log(`early access ended for ${n} player(s): their version is out`); }, 5000).unref?.();
setInterval(() => { const n = ops.earlyPrune(latest.build); n && log(`early access ended for ${n} player(s): their version is out`); }, 60e3).unref?.();
// Release 1.0: tell every game when the weekly mode changes (Monday 00:00 UTC, or the owner pinned one)
let weeklyLast = null;
function weeklyTell() { const w = weekly(); weeklyLast = w.mode; broadcastAll({ type: 'weekly', weekly: w }); }
setInterval(() => { if (weekly().mode !== weeklyLast) weeklyLast === null ? (weeklyLast = weekly().mode) : (log(`weekly mode is now ${weekly().name}`), weeklyTell()); }, 60e3).unref?.();
// Release 1.0: only offer regional servers that answer (checked every minute), so a region that is down or not
// deployed yet is never picked; players then stay on this server.
const regionUp = new Map();
const liveRegions = () => REGIONS.filter((r) => regionUp.get(r.id));
async function checkRegions() {
  await Promise.all(REGIONS.map(async (r) => {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 4000);
    let ok = false;
    try { const res = await fetch(`${r.url}/health`, { signal: ctl.signal }); ok = res.ok && (await res.json().catch(() => ({})))?.regional === true; } catch {} finally { clearTimeout(to); }
    if (ok !== !!regionUp.get(r.id)) log(`region ${r.id} is ${ok ? 'up' : 'down'}`);
    regionUp.set(r.id, ok);
  }));
}
if (!REGIONAL && REGIONS.length) { checkRegions(); setInterval(checkRegions, 60e3).unref?.(); }
async function internalSession(body) {
  const u = sessionUser(body.token);
  if (!u) return { error: 'session_expired', message: 'Your sign-in has expired. Please sign in again.' };
  const key = keyOf(u.name), device = cleanDevice(body.device);
  const b = mod.checkAccount(key, device);
  if (b) return { error: 'banned', ban: b, message: mod.banMessage(b) };
  const pc = { steam: null };
  await ops.noteSteam(pc, body);
  const g = ops.gate(pc, key);
  if (g) return { error: g.code, message: g.message };
  return { ok: true, name: u.name, key, staff: ops.staff(key), developer: ops.isDev(key) };
}
// regional: remember who played together so reports work on the main server
const seenTimers = new Map();
function regionSeen(match) {
  if (!REGIONAL || seenTimers.has(match.id)) return;
  seenTimers.set(match.id, setTimeout(() => {
    seenTimers.delete(match.id);
    const players = [...match.players.values()].map((p) => ({ key: p.key, name: p.name, team: p.team, kills: p.kills, deaths: p.deaths, score: p.score }));
    internalPost(MAIN_URL, '/internal/seen', { match: { id: `${REGION}:${match.id}`, mode: match.mode, mapId: match.mapId, createdAt: match.createdAt, ended: match.ended, players } }).catch((e) => log(`could not tell the main server about match ${match.id}: ${e.message}`));
  }, 1000));
}
const sessionCache = new Map();
async function regionalSession(c, msg) {
  const t = String(msg.token || '');
  const hit = sessionCache.get(t);
  if (hit && now() - hit.at < 60e3 && !msg.steam) return hit.r;
  let r;
  try { r = await internalPost(MAIN_URL, '/internal/session', { token: t, device: c.device, steam: msg.steam || null }); } catch (e) { r = { error: 'server', message: "Can't reach the Vangaurd account server. Try again." }; log(`session check failed: ${e.message}`); }
  if (r?.ok) sessionCache.set(t, { at: now(), r });
  return r || { error: 'server', message: 'Sign-in check failed.' };
}

// Maintenance started: everyone but the owner, moderators and developers is signed out and sees "Login failed".
function maintenanceKick() {
  const message = ops.maintenanceMessage();
  let n = 0;
  for (const c of [...clients.values()]) {
    const key = c.account ? keyOf(c.account) : null;
    if (key && ops.staff(key)) continue;
    send(c, { type: 'maintenance', message });
    removeFromQueue(c);
    if (c.matchId) leaveMatch(c, false);
    if (c.account) { goOffline(c); c.account = null; n++; }
    setTimeout(() => { try { c.ws.close(4004, 'maintenance'); } catch { /* gone */ } }, 400);
  }
  log(`maintenance started: ${n} player(s) signed out`);
  return n;
}
mod.attachOps({
  view: () => ({ ...ops.view(), weekly: weekly(), versions: recentVersions(), latest: { build: latest.build, label: latest.label, source: latest.source }, region: REGION, live: Object.fromEntries(Object.keys(MODES).map((m) => { const lm = modeMatch(m); return [m, { inMatch: lm ? lm.players.size : 0, waiting: queues[m].length, max: MAX_PLAYERS }]; })) }),
  announce(by, body) {
    const r = ops.setAnnouncement(by, body);
    if (!r.error) broadcastAll({ type: 'announcement', announcement: r.announcement });
    return r;
  },
  clearAnnouncement() { ops.clearAnnouncement(); broadcastAll({ type: 'announcement', announcement: null }); },
  maintenance(by, on, message) {
    const was = ops.state.maintenance.on, m = ops.setMaintenance(by, on, message);
    let kicked = 0;
    if (m.on && !was) { broadcastAll({ type: 'announcement', announcement: null }); kicked = maintenanceKick(); regionMaintenance(ops.maintenanceMessage()); }
    if (!m.on && was) { broadcastAll({ type: 'maintenance_over' }); log('maintenance over'); }
    return { maintenance: m, kicked };
  },
  steamRequired(on) { ops.setSteamRequired(on); return { required: !!on }; },
  steamAllow: (key, add) => ops.steamAllowEdit(key, add),
  dev(key, add) {
    const changed = ops.devEdit(key, add);
    for (const c of online.get(key) || []) send(c, { type: 'role', developer: ops.isDev(key), moderator: !!mod.roleOf(key) });
    return changed;
  },
  dlc(key, id, add) {
    const r = ops.dlcEdit(key, id, add);
    if (!r.error) for (const c of online.get(key) || []) send(c, { type: 'dlc', dlc: ops.dlcOf(key) });
    return r;
  },
  early(key, build, add, by) {
    const v = recentVersions().find((x) => x.build === Math.floor(Number(build)));
    if (add && !v) return { error: 'Pick one of the versions in the list.' };
    if (add && v.released) return { error: `${v.label} is already out: everyone can play it.` };
    const r = ops.earlyEdit(key, add, v ? { build: v.build, label: v.label } : {}, by);
    if (!r.error) for (const c of online.get(key) || []) send(c, { type: 'early_access', early: add ? { build: v.build, label: v.label } : null });
    return r;
  },
  weekly(mode) {
    if (mode && !WEEKLY_POOL.includes(mode)) return { error: 'That mode is not in the weekly rotation.' };
    ops.setWeekly(mode || null), weeklyTell();
    return { weekly: weekly() };
  },
  dlcApp(id, appId) {
    const r = ops.setDlcApp(id, appId);
    if (!r.error) broadcastAll({ type: 'dlc_apps', dlcApps: ops.dlcApps() });
    return r;
  },
  release(by, body) {
    const r = ops.setRelease(by, body);
    if (!r.error) { const prev = latest.build; latest.build = 0; raiseLatest(Math.max(r.release.build, Math.floor(Number(process.env.MIN_CLIENT_BUILD) || 0)), r.release.label, 'console'); if (latest.build < prev) log(`latest client build lowered ${prev} -> ${latest.build} by the console`); ops.earlyPrune(latest.build); }
    return r;
  },
});
function handle(c, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.clientBuild === 'number' && Number.isFinite(msg.clientBuild)) c.build = Math.floor(msg.clientBuild), noteBuild(c, msg);
  switch (msg.type) {
    case 'join_queue': joinQueue(c, msg).catch((e) => log(`join error: ${e.message}`)); break;
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
    case 'gun_pickup': onGunPickup(c, msg); break;
    case 'vote_map': onVote(c, msg); break;
    case 'weapon_fired': {
      const match = matches.get(c.matchId);
      if (match) broadcast(match, { type: 'weapon_fired', matchId: match.id, playerId: c.id, weaponId: typeof msg.weaponId === 'string' ? msg.weaponId.slice(0, 24) : null }, c.id), match.players.has(c.id) && (recEvent(match, ['f', c.id]), acShot(match, match.players.get(c.id)));
      break;
    }
    case 'player_ready': {
      const match = matches.get(c.matchId);
      if (match) { send(c, scoreMsg(match)); for (const t of match.tags.values()) send(c, { type: 'tag_spawned', matchId: match.id, tag: t }); for (const g of match.guns?.values() || []) send(c, { type: 'gun_spawned', matchId: match.id, gun: g }); if (match.phase === 'vote') send(c, { type: 'map_vote', matchId: match.id, ...voteInfo(match, c.id) }); }
      break;
    }
    case 'ping': send(c, { type: 'pong', t: msg.t, seq: msg.seq, serverTime: now() }); break;
    case 'mark': onMark(c, msg); break;
    case 'streak': onStreak(c, msg); break;
    case 'hello': {
      c.build = Math.floor(num(msg.clientBuild, 0));
      const dev = cleanDevice(msg.device);
      if (dev) { c.device = dev; const b = mod.checkDevice(dev); send(c, b ? mod.bannedMsg(b) : { type: 'device_ok' }); }
      break;
    }
    case 'report': mod.onReport(c, msg); break;
    case 'register': onRegister(c, msg).catch((e) => { log(`register error: ${e.message}`); authError(c, 'server', 'The server could not create the account. Try again.'); }); break;
    case 'login': onLogin(c, msg).catch((e) => { log(`login error: ${e.message}`); authError(c, 'server', 'The server could not sign you in. Try again.'); }); break;
    case 'resume': onResume(c, msg).catch((e) => { log(`resume error: ${e.message}`); authError(c, 'server', 'The server could not sign you in. Try again.'); }); break;
    case 'social_state': case 'friend_add': case 'friend_accept': case 'friend_decline': case 'friend_remove':
    case 'party_invite': case 'party_accept': case 'party_decline': case 'party_leave': case 'party_kick':
    case 'party_ready_start': case 'party_ready_reply': case 'party_ready_cancel':
    case 'block': case 'chat_send': case 'chat_history': case 'voice': case 'rtc':
    case 'tourney_list': case 'tourney_register': case 'tourney_unregister': case 'tourney_play': case 'tourney_board': case 'tourney_watch':
      handleSocial(c, msg); break;
    case 'bug_report': mod.onBug(c, msg); break;
    case 'spectate_join': msg.drone ? droneJoin(c, msg) : spectateJoin(c, msg); break;
    case 'drone_info': droneInfo(c, msg); break;
    case 'spectate_ready': c.caster ? casterReady(c) : droneReady(c); break;
    case 'spectate_leave': spectateLeave(c, true); break;
    case 'logout': onLogout(c, msg); break;
    case 'verify_code': onVerifyCode(c, msg).catch((e) => { log(`verify error: ${e.message}`); authError(c, 'server', 'The server could not check the code. Try again.'); }); break;
    case 'resend_code': onResendCode(c, msg).catch((e) => { log(`resend error: ${e.message}`); authError(c, 'server', 'The server could not send a new code. Try again.'); }); break;
    case 'add_email': onAddEmail(c, msg).catch((e) => { log(`add email error: ${e.message}`); authError(c, 'server', 'The server could not send the code. Try again.'); }); break;
    case 'reset_request': onResetRequest(c, msg).catch((e) => { log(`reset error: ${e.message}`); authError(c, 'server', 'The server could not send the code. Try again.'); }); break;
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
    for (const g of match.guns?.values() || []) if (t - g.at > GUN_LIFE_MS) { match.guns.delete(g.id); broadcast(match, { type: 'gun_removed', matchId: match.id, gunId: g.id, reason: 'expired' }); }
    if (match.ended && t - match.createdAt > 6 * 3600 * 1000) { spectatorsOut(match, 'The match is over.'); matches.delete(match.id); }
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
  if (path === '/news') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ news: mod.newsPublic() }));
    return;
  }
  // Main <-> regional servers (need INTERNAL_KEY on both).
  if (path.startsWith('/internal/') && req.method === 'POST') {
    if (!internalOk(req)) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    let body = '';
    const limit = path === '/internal/flag' ? 8 * 1024 * 1024 : 64 * 1024;
    req.on('data', (b) => { body += b; if (body.length > limit) req.destroy(); });
    req.on('end', async () => {
      let v = null, out = { error: 'Unknown.' };
      try { v = JSON.parse(body); } catch { /* bad */ }
      try {
        if (!v) out = { error: 'Bad JSON.' };
        else if (path === '/internal/session' && !REGIONAL) out = await internalSession(v);
        else if (path === '/internal/tourney-ticket' && !REGIONAL) out = tourneys.ticketCheck(String(v.ticket || ''), String(v.key || ''));
        else if (path === '/internal/tourney-result' && !REGIONAL && v.tid) out = tourneyResult(String(v.tid), String(v.matchId || ''), Array.isArray(v.rows) ? v.rows : [], Number.isInteger(v.round) ? v.round : null);
        else if (path === '/internal/seen' && !REGIONAL && v.match?.id) {
          const m = v.match;
          mod.matchSeen({ id: String(m.id).slice(0, 40), mode: m.mode, mapId: m.mapId, createdAt: m.createdAt, ended: !!m.ended, players: new Map((Array.isArray(m.players) ? m.players : []).slice(0, 24).map((p) => [String(p.key), { key: String(p.key), name: String(p.name || p.key).slice(0, 20), team: p.team, kills: p.kills | 0, deaths: p.deaths | 0, score: p.score | 0 }])) });
          out = { ok: true };
        } else if (path === '/internal/flag' && !REGIONAL && v.key) {
          // Release 1.0: a regional server flagged a player: file the report (with its recording) and the flag here
          const key = String(v.key).slice(0, 40), m = v.match || {}, match = { id: String(m.id || '').slice(0, 40), mode: m.mode, mapId: m.mapId || null, createdAt: m.createdAt, ended: false, players: new Map() };
          const rid = userOf(key) ? mod.autoReport(key, match, String(v.note || '').slice(0, 300)) : null;
          if (rid && typeof v.replay === 'string' && v.replay.length < 8 * 1024 * 1024) {
            try { fs.mkdirSync(REPLAY_DIR, { recursive: true }); fs.writeFileSync(pathMod.join(REPLAY_DIR, `${rid}.json.gz`), Buffer.from(v.replay, 'base64')); mod.markReplay(rid); } catch (e) { log(`flag replay save error: ${e.message}`); }
          }
          rid && mod.flagAdd({ key, name: String(v.name || '').slice(0, 20), reportId: rid, score: +v.score || 0, counts: v.counts && typeof v.counts === 'object' ? v.counts : {}, match: { id: match.id, mode: match.mode, map: match.mapId, region: String(m.region || '').slice(0, 16) } });
          out = { ok: true, reportId: rid };
        } else if (path === '/internal/kick' && REGIONAL) {
          let n = 0;
          const msg = v.msg && typeof v.msg === 'object' ? v.msg : { type: 'kicked', message: 'A moderator disconnected you from the server.' };
          for (const c of [...clients.values()]) if (c.accountKey && c.accountKey === String(v.key)) { kickClient(c, msg); n++; }
          for (const [t, e] of sessionCache) if (e.r?.key === String(v.key)) sessionCache.delete(t);
          out = { ok: true, kicked: n };
        } else if (path === '/internal/maintenance' && REGIONAL) {
          const message = String(v.message || 'Vangaurd is undergoing maintenance. Please try again later.').slice(0, 240);
          let n = 0;
          for (const c of [...clients.values()]) {
            if (c.staff) continue;
            send(c, { type: 'maintenance', message }); removeFromQueue(c); if (c.matchId) leaveMatch(c, false);
            setTimeout(() => { try { c.ws.close(4004, 'maintenance'); } catch { /* gone */ } }, 400); n++;
          }
          sessionCache.clear();
          out = { ok: true, kicked: n };
        }
      } catch (e) { out = { error: e.message }; }
      res.writeHead(out.error ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  // The release pipeline can tell the server about a new build (needs RELEASE_KEY; off when it is not set).
  if (path === '/release' && req.method === 'POST') {
    const key = String(process.env.RELEASE_KEY || '');
    const given = String(req.headers['x-release-key'] || '');
    if (!key || given.length !== key.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    let body = '';
    req.on('data', (b) => { body += b; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let v = null;
      try { v = JSON.parse(body); } catch { /* bad */ }
      const r = v ? ops.setRelease('pipeline', v) : { error: 'Bad JSON.' };
      if (!r.error) raiseLatest(r.release.build, r.release.label, 'pipeline');
      res.writeHead(r.error ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.error ? { error: r.error } : { ok: true, latest: { build: latest.build, label: latest.label } }));
    });
    return;
  }
  if (path === '/' || path === '/health' || path === '/status') {
    let players = 0;
    for (const m of matches.values()) players += m.players.size;
    const body = JSON.stringify({
      ok: true, service: 'vangaurd-matchmaking', version: VERSION, region: REGION, regional: REGIONAL, regions: REGIONS.map((r) => r.id), maintenance: ops.state.maintenance.on, announcement: ops.announcementView(), requireSteam: !!ops.state.steam.required,
      queued: Object.values(queues).reduce((n, q) => n + q.length, 0), queuedByMode: Object.fromEntries(Object.entries(queues).map(([m, q]) => [m, q.length])), weekly: weekly(),
      matchMinSize: MIN_PLAYERS, matchMaxSize: MAX_PLAYERS, matches: matches.size, playersInMatches: players, connected: clients.size,
      maps: MAPS, mapVoteSeconds: VOTE_S, versionGate: GATE, accounts: Object.keys(accounts.users).length, saves: Object.keys(saves).length, email: mailer.enabled ? mailer.kind : false, emailReady: emailState.ok, emailStatus: emailState.detail, emailRequired: EMAIL_REQUIRED, online: online.size, parties: parties.size, accountsPersistent: !!process.env.DATA_DIR, minClientBuild: latest.build, latestLabel: latest.label, latestSource: latest.source, modes: Object.fromEntries(Object.entries(MODES).map(([k, v]) => [k, { name: v.name, scoreLimit: v.scoreLimit, ffa: v.ffa }])),
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
    spectateLeave(c, false);
    goOffline(c);
    removeFromQueue(c);
    if (c.matchId) leaveMatch(c, false);
    clients.delete(c.id);
  });
  ws.on('error', () => {});
  send(c, {
    type: 'connected', playerId: c.id, version: VERSION, weekly: weekly(), matchMinSize: MIN_PLAYERS, matchMaxSize: MAX_PLAYERS, minClientBuild: GATE ? latest.build : 0, latestLabel: latest.label, emailAuth: mailer.enabled, steamUpdates: !RELEASE_PAGE,
    region: REGION, regionName: REGION_NAMES[REGION] || REGION.toUpperCase(), regions: !REGIONAL && liveRegions().length ? [{ id: REGION, name: REGION_NAMES[REGION] || REGION, url: null }, ...liveRegions()] : null, announcement: ops.announcementView(), maintenance: ops.state.maintenance.on ? { message: ops.maintenanceMessage() } : null, requireSteam: !!ops.state.steam.required,
    dlcApps: ops.dlcApps(),
  });
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }
}, 30000);

server.listen(PORT, () => log(`vangaurd matchmaking ${VERSION} on :${PORT} · ${REGION_NAMES[REGION] || REGION}${REGIONAL ? ` (match server for ${MAIN_URL})` : REGIONS.length ? ` · regions ${REGIONS.map((r) => r.id).join(', ')}` : ''} · min ${MIN_PLAYERS} · max ${MAX_PLAYERS}`));
