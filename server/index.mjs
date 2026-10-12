// Vangaurd matchmaking + match relay server.
// Speaks the same WebSocket protocol as the game client (path /ws).
// Railway: root directory /server, start command `npm start`; it listens on $PORT.
import http from 'node:http';
import { createModeration, cleanDevice } from './moderation.mjs';
import { createMailer, codeEmail } from './mailer.mjs';
import { createOps } from './ops.mjs';
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
const VERSION = '4.0.0';
// Where this server runs (shown in the game and on /health). The main server is NA East from Beta 1.3.
const REGION = String(process.env.REGION || 'na-east').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16) || 'na-east';
const REGION_NAMES = { 'na-east': 'NA East', 'na-west': 'NA West', eu: 'Europe', 'eu-west': 'EU West' };
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
  return GATE && (c.build || 0) > latest.build && !ops.isOwner(key);
}
function authOk(c, u, token, created = false) {
  const key = keyOf(u.name), g = ops.gate(c, key);
  if (g) return refuseGate(c, g);
  if (unreleasedFor(c, key)) { log(`refused unreleased build ${c.build} for ${u.name}`); return refuseGate(c, { code: 'unavailable', message: UNAVAILABLE }); }
  c.account = u.name;
  c.name = u.name;
  send(c, { type: 'auth_ok', username: u.name, token, created, developer: ops.isDev(key), moderator: !!mod.roleOf(key), dlc: ops.dlcOf(key) });
  mod.noteDevice(u, c.device);
  goOnline(c);
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
  if (match.spectators?.size) for (const id of match.spectators) send(clients.get(id), msg);
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
  const live = modeMatch(mode), full = !!live && live.players.size >= MAX_PLAYERS;
  q.forEach((id, i) => send(clients.get(id), { type: 'queue_status', mode, queued: q.length, minimum: MIN_PLAYERS, maximum: MAX_PLAYERS, startsIn: full ? null : startsIn, full, position: i + 1, inMatch: live ? live.players.size : 0, scoreLimit: live?.scoreLimit || null, score: live && !live.ffa ? { ...live.score } : null }));
}
// Beta 1.3: each mode has one match running at a time (one "server"). While it has room, players join it in the
// middle of the game; while it is full (12), new players wait in line for a free spot or for the match to end,
// and then the next match starts with the players who waited.
function modeMatch(mode) {
  let best = null;
  for (const m of matches.values()) if (m.mode === mode && !m.ended && m.players.size > 0 && (!best || m.players.size > best.players.size)) best = m;
  return best;
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
        if (m && !m.ended && m.mode === mode && m.players.size < MAX_PLAYERS) return m;
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
  const mode = modeOf(msg.mode);
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
  match.players.delete(c.id);
  if (notify) send(c, { type: 'match_left', matchId: match.id });
  broadcast(match, { type: 'player_left', matchId: match.id, playerId: c.id });
  if (match.players.size > 0) { broadcast(match, { type: 'match_update', matchId: match.id, roster: rosterOf(match) }); broadcastVote(match); if (match.ffa) broadcast(match, scoreMsg(match)); }
  else if (match.droneWait > 0 || [...match.spectators || []].some((id) => clients.get(id)?.drone)) {
    // a developer's drone is still flying over the map: keep it for them (nobody else is put into an empty match)
    clearTimeout(match.vote?.timer);
    for (const id of [...match.spectators || []]) { const sc = clients.get(id); if (sc && !sc.drone) { sc.spectating = null; match.spectators.delete(id); send(sc, { type: 'spectate_end', reason: 'Everyone left the match.' }); } }
    broadcast(match, { type: 'match_update', matchId: match.id, roster: [] });
  } else { clearTimeout(match.vote?.timer); spectatorsOut(match, 'Everyone left the match.'); matches.delete(match.id); log(`match ${match.id} closed`); }
  if (queues[match.mode]?.length) setTimeout(() => checkQueue(match.mode), 0); // a spot opened (or the match closed)
}
function endMatch(match, winner) {
  if (match.ended) return;
  match.ended = true;
  mod.matchSeen(match); regionSeen(match);
  const msg = { type: 'match_ended', matchId: match.id, winner, score: { ...match.score } };
  if (match.ffa) { msg.ffa = true; msg.players = boardOf(match); msg.winnerName = match.players.get(winner)?.name || null; msg.scoreLimit = match.scoreLimit; }
  broadcast(match, msg);
  for (const p of match.players.values()) if (p.key) pushSocial(p.key); // "Recently played" now lists this match
  log(`match ${match.id} ended · winner ${winner}`);
  if (queues[match.mode]?.length) setTimeout(() => checkQueue(match.mode), 0); // the players who waited start the next match
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
  broadcast(match, { type: 'player_killed', matchId: match.id, attackerId: attacker.id, targetId: target.id, zone, attackerName: attacker.name, targetName: target.name, ...(streak ? { streak: msg.streak } : {}) });
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
    moving: !!s.moving, sprinting: !!s.sprinting, sliding: !!s.sliding, quiet: !!s.quiet,
    weaponId: typeof s.weaponId === 'string' ? s.weaponId.slice(0, 24) : null,
    variant: typeof s.variant === 'string' ? s.variant.slice(0, 24) : null,
    op: typeof s.op === 'string' && /^[a-z0-9_-]{1,24}$/.test(s.op) ? s.op : null, // Release 1.0: the player's operator
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
  const match = c.spectating && matches.get(c.spectating);
  if (match) {
    if (match.spectators?.has(c.id)) match.spectators.delete(c.id);
    else if (c.drone) match.droneWait = Math.max(0, (match.droneWait || 1) - 1); // left while its map was loading
  }
  if (c.spectating && notify) send(c, { type: 'spectate_end', reason: 'left' });
  if (match && !match.players.size && !match.spectators?.size && !match.droneWait && matches.get(match.id) === match) {
    // a developer's drone was the last one there
    clearTimeout(match.vote?.timer); matches.delete(match.id); log(`match ${match.id} closed`);
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
  for (const id of match.spectators) { const sc = clients.get(id); if (sc) { sc.spectating = null; send(sc, { type: 'spectate_end', reason }); } }
  match.spectators.clear();
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
  kick: kickClient, kickKey: (key, msg) => (REGIONS.length ? regionKick(key, msg) : Promise.resolve(0)), saveOf: (key) => saves[key]?.blob || null, spectateOffer,
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
  view: () => ({ ...ops.view(), latest: { build: latest.build, label: latest.label, source: latest.source }, region: REGION, live: Object.fromEntries(Object.keys(MODES).map((m) => { const lm = modeMatch(m); return [m, { inMatch: lm ? lm.players.size : 0, waiting: queues[m].length, max: MAX_PLAYERS }]; })) }),
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
  dlcApp(id, appId) {
    const r = ops.setDlcApp(id, appId);
    if (!r.error) broadcastAll({ type: 'dlc_apps', dlcApps: ops.dlcApps() });
    return r;
  },
  release(by, body) {
    const r = ops.setRelease(by, body);
    if (!r.error) { const prev = latest.build; latest.build = 0; raiseLatest(Math.max(r.release.build, Math.floor(Number(process.env.MIN_CLIENT_BUILD) || 0)), r.release.label, 'console'); if (latest.build < prev) log(`latest client build lowered ${prev} -> ${latest.build} by the console`); }
    return r;
  },
});
function handle(c, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg !== 'object') return;
  if (typeof msg.clientBuild === 'number' && Number.isFinite(msg.clientBuild)) c.build = Math.floor(msg.clientBuild);
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
      handleSocial(c, msg); break;
    case 'bug_report': mod.onBug(c, msg); break;
    case 'spectate_join': msg.drone ? droneJoin(c, msg) : spectateJoin(c, msg); break;
    case 'drone_info': droneInfo(c, msg); break;
    case 'spectate_ready': droneReady(c); break;
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
    req.on('data', (b) => { body += b; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', async () => {
      let v = null, out = { error: 'Unknown.' };
      try { v = JSON.parse(body); } catch { /* bad */ }
      try {
        if (!v) out = { error: 'Bad JSON.' };
        else if (path === '/internal/session' && !REGIONAL) out = await internalSession(v);
        else if (path === '/internal/seen' && !REGIONAL && v.match?.id) {
          const m = v.match;
          mod.matchSeen({ id: String(m.id).slice(0, 40), mode: m.mode, mapId: m.mapId, createdAt: m.createdAt, ended: !!m.ended, players: new Map((Array.isArray(m.players) ? m.players : []).slice(0, 24).map((p) => [String(p.key), { key: String(p.key), name: String(p.name || p.key).slice(0, 20), team: p.team, kills: p.kills | 0, deaths: p.deaths | 0, score: p.score | 0 }])) });
          out = { ok: true };
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
      queued: queues.tdm.length + queues.kc.length, queuedByMode: { tdm: queues.tdm.length, kc: queues.kc.length },
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
    type: 'connected', playerId: c.id, version: VERSION, matchMinSize: MIN_PLAYERS, matchMaxSize: MAX_PLAYERS, minClientBuild: GATE ? latest.build : 0, latestLabel: latest.label, emailAuth: mailer.enabled, steamUpdates: !RELEASE_PAGE,
    region: REGION, regionName: REGION_NAMES[REGION] || REGION.toUpperCase(), regions: !REGIONAL && REGIONS.length ? [{ id: REGION, name: REGION_NAMES[REGION] || REGION, url: null }, ...REGIONS] : null, announcement: ops.announcementView(), maintenance: ops.state.maintenance.on ? { message: ops.maintenanceMessage() } : null, requireSteam: !!ops.state.steam.required,
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
