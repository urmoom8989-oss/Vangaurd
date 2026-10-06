// Moderation: bans (accounts, and optionally the devices they played on), player reports from finished matches,
// and the API behind the moderation console at /admin.
//
// The console is served by this server and only talks to this server, so it keeps working whatever version of
// the game players have. Bans are enforced here too: a banned account cannot sign in, resume or queue on any
// version, and versions from Beta 0.95 on show a "banned" screen whose only button closes the game.
//
// First-time setup: while nobody owns the console, the server prints a one-time setup code in its log. Open
// /admin, enter the code and sign in with your game account to become the owner. After that you sign in to the
// console with your game account; the owner can add other moderators by username.
import fs from 'node:fs';
import pathMod from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = pathMod.dirname(fileURLToPath(import.meta.url));
export const REPORT_REASONS = {
  cheating: 'Cheating (aimbot, wallhack, speed)',
  exploit: 'Exploiting a bug',
  name: 'Offensive name',
  abuse: 'Abusive behaviour',
  other: 'Other',
};
const MAX_REPORTS = 5000, MAX_LOG = 2000, RECENT_MATCHES = 300, REPORT_WINDOW_MS = 3 * 3600e3;
const ADMIN_SESSION_DAYS = 14;
const STATIC = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

// The game's level curve (Beta 1.1 on): level n needs 5,000 + 500 x (n - 1) XP to reach level n + 1.
export const levelCost = (l) => 5000 + 500 * (l - 1);
export const xpForLevel = (level) => { let t = 0; for (let l = 1; l < level; l++) t += levelCost(l); return t; };
export function levelOf(xp) {
  let l = 1, t = Math.max(0, Math.floor(xp || 0));
  while (t >= levelCost(l) && l < 999) { t -= levelCost(l); l++; }
  return l;
}
// Moderators see a player's email partly hidden (enough to recognise it, not to copy it).
export function maskEmail(e) {
  const [a = '', d = ''] = String(e).split('@');
  return `${a.slice(0, Math.min(2, a.length))}${'•'.repeat(Math.max(2, Math.min(6, a.length - 2)))}@${d}`;
}
export const cleanDevice = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null);

export function createModeration(d) {
  // d: { DATA_DIR, accounts, saveAccounts, online, clients, statusOf, keyOf, userOf, nameOf, scrypt, now, log, send, kick, saveOf }
  const FILE = pathMod.join(d.DATA_DIR, 'moderation.json');
  const mod = { owner: null, admins: [], setup: null, sessions: {}, bans: {}, deviceBans: {}, reports: [], log: [], bugs: [], news: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') for (const k of Object.keys(mod)) if (raw[k] !== undefined) mod[k] = raw[k];
  } catch (e) { if (e.code !== 'ENOENT') console.error('could not read moderation data:', e.message); }
  let timer = null;
  function write() {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      fs.mkdirSync(d.DATA_DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(mod));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('could not save moderation data:', e.message); }
  }
  const save = (urgent = true) => (urgent ? write() : timer || (timer = setTimeout(write, 1500)));
  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const now = d.now;

  // ---------- first-time setup ----------
  function newCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 12; i++) s += A[crypto.randomInt(A.length)] + (i % 4 === 3 && i < 11 ? '-' : '');
    return s;
  }
  if (!mod.owner && !mod.setup) { mod.setup = { code: newCode(), created: now() }; write(); }
  if (!mod.owner) d.log(`moderation console is not set up yet: open /admin, enter setup code ${mod.setup.code} and sign in with your game account to become the owner`);

  function addLog(by, action, target, detail = '') {
    mod.log.unshift({ at: now(), by, action, target: target || null, detail: String(detail || '').slice(0, 300) });
    if (mod.log.length > MAX_LOG) mod.log.length = MAX_LOG;
  }

  // ---------- bans ----------
  function activeBan(key) {
    const b = key && mod.bans[key];
    if (!b) return null;
    if (b.until && b.until <= now()) {
      delete mod.bans[key];
      for (const [dev, v] of Object.entries(mod.deviceBans)) if (v.account === key) delete mod.deviceBans[dev];
      addLog('system', 'ban_expired', key);
      save();
      return null;
    }
    return b;
  }
  const banView = (key, b, viaDevice = false) => ({ account: d.nameOf(key), reason: b.reason, at: b.at, until: b.until || null, permanent: !b.until, device: viaDevice });
  function banMessage(v) {
    const when = v.permanent ? 'permanently' : `until ${new Date(v.until).toUTCString().replace(/:\d\d GMT$/, ' UTC')}`;
    return v.device
      ? `This device is banned from Vangaurd ${when} (account ${v.account}). Reason: ${v.reason}`
      : `This account is banned from Vangaurd ${when}. Reason: ${v.reason}`;
  }
  // A banned device: devices are banned together with the account they belong to, for as long as its ban lasts.
  function checkDevice(device) {
    const db = device && mod.deviceBans[device];
    if (!db) return null;
    const b = activeBan(db.account);
    if (!b || !b.devices) { delete mod.deviceBans[device]; save(false); return null; }
    return banView(db.account, b, true);
  }
  function checkAccount(key, device) {
    const b = activeBan(key);
    if (b) return banView(key, b, false);
    return checkDevice(device);
  }
  const bannedMsg = (v) => ({ type: 'banned', ban: v, message: banMessage(v) });
  function noteDevice(u, device) {
    if (!u || !device) return;
    u.devices ||= [];
    if (u.devices[u.devices.length - 1] === device) return;
    u.devices = [...u.devices.filter((x) => x !== device), device].slice(-10);
    d.saveAccounts(false);
  }
  // Disconnect everyone playing as this account (or on its devices, when they are banned too), showing the ban.
  function enforce(key) {
    const b = activeBan(key);
    if (!b) return 0;
    const devs = new Set(b.devices ? userOf(key)?.devices || [] : []);
    let n = 0;
    for (const c of d.clients.values()) {
      const mine = c.accountKey === key || (c.account && d.keyOf(c.account) === key);
      if (!mine && !(c.device && devs.has(c.device))) continue;
      d.kick(c, bannedMsg(banView(key, b, !mine)));
      n++;
    }
    return n;
  }
  const userOf = d.userOf;
  function ban(key, by, reason, hours, devices) {
    const until = hours ? now() + Math.round(hours * 3600e3) : null;
    mod.bans[key] = { by, at: now(), reason, until, devices: !!devices };
    if (devices) for (const dev of userOf(key)?.devices || []) mod.deviceBans[dev] = { account: key, at: now() };
    for (const r of mod.reports) if (r.target === key && r.status === 'open') Object.assign(r, { status: 'banned', handledBy: by, handledAt: now() });
    addLog(by, 'ban', key, `${reason}${until ? ` · ${hours} h` : ' · permanent'}${devices ? ' · devices blocked' : ''}`);
    save();
    const kicked = enforce(key);
    d.log(`moderation: ${d.nameOf(by)} banned ${d.nameOf(key)} (${until ? `${hours} h` : 'permanent'}${devices ? ', devices' : ''}): ${reason}`);
    return kicked;
  }
  function unban(key, by) {
    const had = !!mod.bans[key];
    delete mod.bans[key];
    for (const [dev, v] of Object.entries(mod.deviceBans)) if (v.account === key) delete mod.deviceBans[dev];
    if (had) { addLog(by, 'unban', key); save(); d.log(`moderation: ${d.nameOf(by)} unbanned ${d.nameOf(key)}`); }
    return had;
  }

  // ---------- reports ----------
  // Who played in which match (kept for a few hours after it ends), so players can report each other afterwards.
  const recent = new Map();
  function matchSeen(match) {
    let r = recent.get(match.id);
    if (!r) {
      r = { id: match.id, mode: match.mode, map: match.mapId || null, start: match.createdAt || now(), end: null, players: new Map() };
      recent.set(match.id, r);
      if (recent.size > RECENT_MATCHES) recent.delete(recent.keys().next().value);
    }
    r.map = match.mapId || r.map;
    for (const p of match.players.values()) {
      const k = p.key || d.keyOf(p.name);
      if (k) r.players.set(k, { name: p.name, team: p.team, kills: p.kills | 0, deaths: p.deaths | 0, score: p.score | 0 });
    }
    if (match.ended && !r.end) r.end = now();
  }
  function onReport(c, msg) {
    const fail = (message) => d.send(c, { type: 'report_error', message });
    if (!c.account) return fail('Sign in to report players.');
    const me = d.keyOf(c.account), target = d.keyOf(msg.target);
    if (!target || !userOf(target)) return fail('There is no player with that name.');
    if (target === me) return fail('You cannot report yourself.');
    let m = null;
    for (const r of recent.values()) {
      if (!r.players.has(me) || !r.players.has(target)) continue;
      if (r.end && now() - r.end > REPORT_WINDOW_MS) continue;
      if (!m || r.start > m.start) m = r;
    }
    if (!m) return fail('You can only report players from a match you played with them in the last few hours.');
    if (mod.reports.some((x) => x.reporter === me && x.target === target && x.match?.id === m.id)) return d.send(c, { type: 'report_ok', target: d.nameOf(target), duplicate: true });
    if (mod.reports.filter((x) => x.reporter === me && now() - x.at < 864e5).length >= 30) return fail('You have sent a lot of reports today. Try again tomorrow.');
    const reason = Object.hasOwn(REPORT_REASONS, msg.reason) ? msg.reason : 'other';
    const note = String(msg.note || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);
    const st = m.players.get(target);
    mod.reports.unshift({
      id: crypto.randomBytes(6).toString('hex'), at: now(), reporter: me, target, reason, note, status: 'open',
      match: { id: m.id, mode: m.mode, map: m.map, at: m.start, players: m.players.size },
      stats: st ? { team: st.team, kills: st.kills, deaths: st.deaths, score: st.score } : null, build: c.build || null,
    });
    if (mod.reports.length > MAX_REPORTS) mod.reports.length = MAX_REPORTS;
    save(false);
    d.log(`report: ${d.nameOf(me)} reported ${d.nameOf(target)} (${reason}) in match ${m.id}`);
    d.send(c, { type: 'report_ok', target: d.nameOf(target) });
  }

  // Players someone was recently in a match with (newest first), for the friends panel's "Recently played".
  function recentWith(key, limit = 12) {
    const out = new Map();
    for (const r of [...recent.values()].reverse()) {
      if (!r.players.has(key)) continue;
      for (const [k] of r.players) if (k !== key && !out.has(k) && userOf(k)) out.set(k, { key: k, name: d.nameOf(k), at: r.end || r.start, mode: r.mode, map: r.map });
      if (out.size >= limit) break;
    }
    return [...out.values()].slice(0, limit);
  }

  // ---------- bug reports (from the game's pause menu) ----------
  function onBug(c, msg) {
    const fail = (message) => d.send(c, { type: 'bug_error', message });
    if (!c.account) return fail('Sign in to send bug reports.');
    const me = d.keyOf(c.account);
    const text = String(msg.text || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, 1500);
    if (text.length < 8) return fail('Describe the bug in a few words (at least 8 characters).');
    if (mod.bugs.filter((x) => x.from === me && now() - x.at < 3600e3).length >= 8) return fail('You have sent a lot of bug reports in the last hour. Try again later.');
    const str = (v, n = 40) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : null);
    const m = msg.meta && typeof msg.meta === 'object' ? msg.meta : {};
    const category = ['gameplay', 'graphics', 'controls', 'online', 'menus', 'performance', 'other'].includes(msg.category) ? msg.category : 'other';
    mod.bugs.unshift({
      id: crypto.randomBytes(6).toString('hex'), at: now(), from: me, text, category, status: 'open',
      meta: { version: str(m.version, 24), build: Math.floor(Number(m.build)) || c.build || null, mode: str(m.mode, 24), map: str(m.map, 24), matchId: str(m.matchId, 40), screen: str(m.screen, 24), platform: str(m.platform, 60), fps: Number.isFinite(+m.fps) ? Math.round(+m.fps) : null },
    });
    if (mod.bugs.length > MAX_REPORTS) mod.bugs.length = MAX_REPORTS;
    save(false);
    d.log(`bug report from ${d.nameOf(me)} (${category}): ${text.slice(0, 80)}`);
    d.send(c, { type: 'bug_ok' });
  }
  const bugView = (b) => ({ ...b, from: d.nameOf(b.from), handledBy: b.handledBy ? d.nameOf(b.handledBy) : null });

  // ---------- news (shown in the game after sign-in; written in the console) ----------
  const newsPublic = () => mod.news.slice(0, 20).map((n) => ({ id: n.id, title: n.title, body: n.body, at: n.at, by: d.nameOf(n.by) }));

  // ---------- console sign-in ----------
  const roleOf = (key) => (key && key === mod.owner ? 'owner' : key && mod.admins.includes(key) ? 'moderator' : null);
  const fails = new Map();
  const limited = (ip) => { const f = fails.get(ip); return f && f.n >= 8 && now() - f.t < 10 * 60e3; };
  const failed = (ip) => { const f = fails.get(ip); if (!f || now() - f.t > 10 * 60e3) fails.set(ip, { n: 1, t: now() }); else f.n++; };
  async function checkPassword(name, pw) {
    const u = userOf(d.keyOf(name));
    const hash = await d.scrypt(String(pw || ''), u ? u.salt : '00'.repeat(16));
    return u && crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex')) ? u : null;
  }
  function newAdminSession(key) {
    const token = crypto.randomBytes(32).toString('hex');
    mod.sessions[sha(token)] = { user: key, created: now(), lastUsed: now() };
    for (const [k, s] of Object.entries(mod.sessions)) if (now() - s.lastUsed > ADMIN_SESSION_DAYS * 864e5) delete mod.sessions[k];
    save();
    return token;
  }
  function sessionOf(req) {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(String(req.headers.authorization || ''));
    if (!m) return null;
    const s = mod.sessions[sha(m[1])];
    if (!s || now() - s.lastUsed > ADMIN_SESSION_DAYS * 864e5 || !roleOf(s.user)) return null;
    if (now() - s.lastUsed > 600e3) { s.lastUsed = now(); save(false); }
    return { key: s.user, role: roleOf(s.user), hash: sha(m[1]) };
  }

  // ---------- views ----------
  const reportView = (r) => ({ id: r.id, at: r.at, reporter: d.nameOf(r.reporter), target: d.nameOf(r.target), reason: r.reason, reasonText: REPORT_REASONS[r.reason] || r.reason, note: r.note, status: r.status, match: r.match, stats: r.stats, handledBy: r.handledBy ? d.nameOf(r.handledBy) : null, handledAt: r.handledAt || null });
  function xpOf(key) {
    try { return Math.max(0, Number(JSON.parse(d.saveOf(key) || 'null')?.progression?.xp) || 0); } catch { return 0; }
  }
  function playerView(key) {
    const u = userOf(key);
    if (!u) return null;
    const b = activeBan(key), against = mod.reports.filter((r) => r.target === key);
    return {
      name: u.name, created: u.created || null, lastLogin: u.lastLogin || null, status: d.statusOf(key), role: roleOf(key),
      ban: b ? { ...banView(key, b), by: d.nameOf(b.by), devices: !!b.devices } : null,
      reportsOpen: against.filter((r) => r.status === 'open').length, reportsTotal: against.length,
      reportsMade: mod.reports.filter((r) => r.reporter === key).length, inMatch: d.statusOf(key) === 'match', devices: (u.devices || []).length, xp: xpOf(key), level: levelOf(xpOf(key)), friends: (u.friends || []).length,
      email: u.email ? maskEmail(u.email) : null, emailVerified: !!u.emailVerified,
    };
  }
  function groups(list) {
    const g = new Map();
    for (const r of list) {
      let x = g.get(r.target);
      if (!x) g.set(r.target, x = { name: d.nameOf(r.target), open: 0, total: 0, reasons: {}, reporters: new Set(), last: 0 });
      x.total++; if (r.status === 'open') x.open++;
      x.reasons[r.reason] = (x.reasons[r.reason] || 0) + 1; x.reporters.add(r.reporter); x.last = Math.max(x.last, r.at);
    }
    return [...g.entries()].map(([key, x]) => ({ ...x, reporters: x.reporters.size, status: d.statusOf(key), banned: !!activeBan(key) }))
      .sort((a, b) => b.open - a.open || b.reporters - a.reporters || b.last - a.last);
  }

  // ---------- HTTP ----------
  function send(res, code, obj) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
    res.end(JSON.stringify(obj));
  }
  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const parts = [];
      req.on('data', (b) => { size += b.length; if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else parts.push(b); });
      req.on('end', () => { try { const t = Buffer.concat(parts).toString('utf8'); resolve(t ? JSON.parse(t) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }
  const findKey = (name) => { const k = d.keyOf(name); return k && userOf(k) ? k : null; };

  async function http(req, res, path) {
    if (STATIC[path]) {
      if (path === '/admin') { res.writeHead(301, { location: '/admin/', ...SECURITY_HEADERS }); res.end(); return true; }
      const [file, type] = STATIC[path];
      try {
        const body = fs.readFileSync(pathMod.join(HERE, 'admin', file));
        res.writeHead(200, { 'content-type': type, ...SECURITY_HEADERS }); res.end(body);
      } catch { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('console files are missing'); }
      return true;
    }
    if (!path.startsWith('/admin/api/')) return false;
    const action = path.slice('/admin/api/'.length);
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
    let body = {};
    if (req.method === 'POST') {
      try { body = await readJson(req); } catch { send(res, 400, { error: 'Bad request.' }); return true; }
      if (!body || typeof body !== 'object') body = {};
    } else if (req.method !== 'GET') { send(res, 405, { error: 'Method not allowed.' }); return true; }
    const q = new URL(req.url, 'http://x').searchParams;

    // ----- signed-out actions
    if (action === 'status') {
      const s = sessionOf(req);
      send(res, 200, { setupNeeded: !mod.owner, me: s ? d.nameOf(s.key) : null, role: s?.role || null, owner: mod.owner ? d.nameOf(mod.owner) : null });
      return true;
    }
    if (action === 'setup' || action === 'login') {
      if (req.method !== 'POST') { send(res, 405, { error: 'Use POST.' }); return true; }
      if (limited(ip)) { send(res, 429, { error: 'Too many attempts. Wait ten minutes and try again.' }); return true; }
      if (action === 'setup') {
        if (mod.owner) { send(res, 409, { error: 'The console is already set up. Sign in instead.' }); return true; }
        const code = String(body.code || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!mod.setup || code !== mod.setup.code) { failed(ip); send(res, 403, { error: 'That setup code is not right. It is in the server log.' }); return true; }
      }
      const u = await checkPassword(body.username, body.password);
      if (!u) { failed(ip); send(res, 403, { error: 'Wrong username or password. Use your Vangaurd game account.' }); return true; }
      const key = d.keyOf(u.name);
      if (action === 'setup') {
        mod.owner = key; mod.setup = null; mod.admins = mod.admins.filter((k) => k !== key);
        addLog(key, 'setup', key, 'became the owner'); d.log(`moderation console: ${u.name} is now the owner`);
      } else if (!roleOf(key)) { failed(ip); send(res, 403, { error: `${u.name} is not a moderator. Ask the owner to add you.` }); return true; }
      send(res, 200, { token: newAdminSession(key), me: u.name, role: roleOf(key) });
      return true;
    }

    // ----- moderator actions
    const s = sessionOf(req);
    if (!s) { send(res, 401, { error: 'Please sign in again.' }); return true; }
    const by = s.key, post = req.method === 'POST';
    const need = (cond, msg, code = 400) => { if (!cond) send(res, code, { error: msg }); return !cond; };

    switch (action) {
      case 'logout': delete mod.sessions[s.hash]; save(); send(res, 200, { ok: true }); return true;
      case 'summary': {
        const open = mod.reports.filter((r) => r.status === 'open');
        send(res, 200, {
          me: d.nameOf(by), role: s.role, owner: d.nameOf(mod.owner),
          counts: { openBugs: mod.bugs.filter((b) => b.status === 'open').length, news: mod.news.length, openReports: open.length, reportedPlayers: new Set(open.map((r) => r.target)).size, bans: Object.keys(mod.bans).filter((k) => activeBan(k)).length, online: d.online.size, accounts: Object.keys(d.accounts.users).length, reports: mod.reports.length },
        });
        return true;
      }
      case 'reports': {
        const status = q.get('status') || 'open', target = q.get('target') ? d.keyOf(q.get('target')) : null;
        let list = mod.reports;
        if (status !== 'all') list = list.filter((r) => r.status === status);
        if (target) list = list.filter((r) => r.target === target);
        send(res, 200, { groups: groups(list), reports: list.slice(0, 500).map(reportView) });
        return true;
      }
      case 'reports/dismiss': case 'reports/reopen': {
        if (need(post, 'Use POST.', 405)) return true;
        const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []), target = body.target ? d.keyOf(body.target) : null;
        let n = 0;
        for (const r of mod.reports) {
          if (!(ids.has(r.id) || (target && r.target === target))) continue;
          if (action === 'reports/dismiss' && r.status === 'open') { Object.assign(r, { status: 'dismissed', handledBy: by, handledAt: now() }); n++; }
          if (action === 'reports/reopen' && r.status !== 'open') { Object.assign(r, { status: 'open', handledBy: null, handledAt: null }); n++; }
        }
        if (n) { addLog(by, action === 'reports/dismiss' ? 'dismiss' : 'reopen', target, `${n} report${n === 1 ? '' : 's'}`); save(); }
        send(res, 200, { ok: true, changed: n });
        return true;
      }
      case 'players': {
        const term = String(q.get('q') || '').trim().toLowerCase(), filter = q.get('filter') || '';
        let keys = Object.keys(d.accounts.users);
        if (term) keys = keys.filter((k) => k.includes(term));
        if (filter === 'online') keys = keys.filter((k) => d.statusOf(k) !== 'offline');
        if (filter === 'banned') keys = keys.filter((k) => activeBan(k));
        if (filter === 'reported') keys = keys.filter((k) => mod.reports.some((r) => r.target === k && r.status === 'open'));
        // exact name first, then most reported, then most recently active
        const list = keys.map(playerView).filter(Boolean)
          .sort((a, b) => (b.name.toLowerCase() === term) - (a.name.toLowerCase() === term) || b.reportsOpen - a.reportsOpen || (b.lastLogin || 0) - (a.lastLogin || 0));
        send(res, 200, { total: list.length, players: list.slice(0, 100) });
        return true;
      }
      case 'player': {
        const key = findKey(q.get('name'));
        if (need(key, 'There is no player with that name.', 404)) return true;
        send(res, 200, {
          player: playerView(key),
          reportsAgainst: mod.reports.filter((r) => r.target === key).slice(0, 200).map(reportView),
          reportsBy: mod.reports.filter((r) => r.reporter === key).slice(0, 100).map(reportView),
          history: mod.log.filter((l) => l.target === key).slice(0, 100).map((l) => ({ ...l, by: l.by === 'system' ? 'system' : d.nameOf(l.by), target: d.nameOf(l.target) })),
        });
        return true;
      }
      case 'ban': {
        if (need(post, 'Use POST.', 405)) return true;
        const key = findKey(body.name);
        if (need(key, 'There is no player with that name.', 404)) return true;
        if (need(key !== by, 'You cannot ban yourself.')) return true;
        if (need(!roleOf(key), `${d.nameOf(key)} is a moderator. Remove them from the moderators first.`)) return true;
        const reason = String(body.reason || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
        if (need(reason.length >= 3, 'Give a reason (the player sees it).')) return true;
        const hours = body.hours == null || body.hours === '' ? null : Math.max(1, Math.min(24 * 3650, Number(body.hours) || 0));
        const kicked = ban(key, by, reason, hours, body.devices !== false);
        send(res, 200, { ok: true, kicked, player: playerView(key) });
        return true;
      }
      case 'unban': {
        if (need(post, 'Use POST.', 405)) return true;
        const key = findKey(body.name);
        if (need(key, 'There is no player with that name.', 404)) return true;
        send(res, 200, { ok: true, wasBanned: unban(key, by), player: playerView(key) });
        return true;
      }
      case 'kick': {
        if (need(post, 'Use POST.', 405)) return true;
        const key = findKey(body.name);
        if (need(key, 'There is no player with that name.', 404)) return true;
        let n = 0;
        for (const c of d.clients.values()) if (c.accountKey === key) { d.kick(c, { type: 'kicked', message: 'A moderator disconnected you from the server.' }); n++; }
        if (n) { addLog(by, 'kick', key); save(false); }
        send(res, 200, { ok: true, kicked: n });
        return true;
      }
      case 'bans': {
        const list = Object.keys(mod.bans).filter((k) => activeBan(k)).map((k) => ({ ...banView(k, mod.bans[k]), by: d.nameOf(mod.bans[k].by), devices: !!mod.bans[k].devices, devicesBlocked: Object.values(mod.deviceBans).filter((v) => v.account === k).length }))
          .sort((a, b) => b.at - a.at);
        send(res, 200, { bans: list });
        return true;
      }
      case 'log': send(res, 200, { log: mod.log.slice(0, 400).map((l) => ({ ...l, by: l.by === 'system' ? 'system' : d.nameOf(l.by), target: l.target ? d.nameOf(l.target) : null })) }); return true;
      // Owner only: set a player's level, or copy another account's progress (XP, level, loadouts, camos, perks,
      // weapon stats) onto them. Their game picks it up straight away if they are online.
      case 'progress': {
        if (need(post, 'Use POST.', 405)) return true;
        if (need(s.role === 'owner', 'Only the owner can change progress.', 403)) return true;
        const key = findKey(body.name);
        if (need(key, 'There is no player with that name.', 404)) return true;
        const parse = (t) => { try { const o = JSON.parse(t || 'null'); return o && typeof o === 'object' ? o : null; } catch { return null; } };
        const cur = parse(d.saveOf(key)) || { v: 1, progression: null, records: null, settings: {} };
        let prog, detail;
        if (body.copyFrom) {
          const from = findKey(body.copyFrom);
          if (need(from, `There is no player called ${body.copyFrom}.`, 404)) return true;
          if (need(from !== key, 'Pick a different account to copy from.')) return true;
          const src = parse(d.saveOf(from))?.progression;
          if (need(src && typeof src === 'object', `${d.nameOf(from)} has no saved progress to copy.`)) return true;
          prog = JSON.parse(JSON.stringify(src));
          detail = `copied progress from ${d.nameOf(from)} (level ${levelOf(prog.xp)})`;
        } else {
          const level = Math.floor(Number(body.level));
          if (need(level >= 1 && level <= 500, 'Pick a level from 1 to 500.')) return true;
          prog = cur.progression && typeof cur.progression === 'object' ? cur.progression : { version: 1, xp: 0, kills: 0, headshots: 0, deaths: 0, weapons: {}, grenadeType: 'frag' };
          prog.version = 1; prog.xp = xpForLevel(level);
          detail = `set to level ${level}`;
        }
        cur.v = 1; cur.progression = prog;
        d.putSave(key, JSON.stringify(cur));
        addLog(by, 'progress', key, detail); save();
        send(res, 200, { ok: true, player: playerView(key) });
        return true;
      }
      case 'bugs': {
        const status = q.get('status') || 'open';
        const list = status === 'all' ? mod.bugs : mod.bugs.filter((b) => b.status === status);
        send(res, 200, { bugs: list.slice(0, 500).map(bugView), open: mod.bugs.filter((b) => b.status === 'open').length });
        return true;
      }
      case 'bugs/close': case 'bugs/reopen': case 'bugs/delete': {
        if (need(post, 'Use POST.', 405)) return true;
        const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
        let n = 0;
        if (action === 'bugs/delete') { const before = mod.bugs.length; mod.bugs = mod.bugs.filter((b) => !ids.has(b.id)); n = before - mod.bugs.length; }
        else for (const b of mod.bugs) {
          if (!ids.has(b.id)) continue;
          if (action === 'bugs/close' && b.status === 'open') { Object.assign(b, { status: 'closed', handledBy: by, handledAt: now() }); n++; }
          if (action === 'bugs/reopen' && b.status !== 'open') { Object.assign(b, { status: 'open', handledBy: null, handledAt: null }); n++; }
        }
        if (n) { addLog(by, action.replace('/', '_'), null, `${n} bug report${n === 1 ? '' : 's'}`); save(); }
        send(res, 200, { ok: true, changed: n });
        return true;
      }
      case 'news': send(res, 200, { news: newsPublic() }); return true;
      case 'news/add': {
        if (need(post, 'Use POST.', 405)) return true;
        const clean = (v, n) => String(v || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, n);
        const title = clean(body.title, 80), text = clean(body.body, 2000);
        if (need(title.length >= 2, 'Give the post a title.')) return true;
        if (need(text.length >= 2, 'Write something in the post.')) return true;
        mod.news.unshift({ id: crypto.randomBytes(6).toString('hex'), at: now(), by, title, body: text });
        if (mod.news.length > 50) mod.news.length = 50;
        addLog(by, 'news_add', null, title); save();
        send(res, 200, { ok: true, news: newsPublic() });
        return true;
      }
      case 'news/delete': {
        if (need(post, 'Use POST.', 405)) return true;
        const before = mod.news.length;
        mod.news = mod.news.filter((n) => n.id !== String(body.id || ''));
        if (mod.news.length !== before) { addLog(by, 'news_delete', null, String(body.id || '')); save(); }
        send(res, 200, { ok: true, news: newsPublic() });
        return true;
      }
      // Watch a player's match from inside the game: the offer goes to the moderator's own signed-in game.
      case 'spectate': {
        if (need(post, 'Use POST.', 405)) return true;
        const key = findKey(body.name);
        if (need(key, 'There is no player with that name.', 404)) return true;
        const r = d.spectateOffer ? d.spectateOffer(by, key) : { error: 'Spectating is not available on this server.' };
        if (need(!r.error, r.error, 409)) return true;
        addLog(by, 'spectate', key); save(false);
        send(res, 200, { ok: true, ...r });
        return true;
      }
      case 'mods': send(res, 200, { owner: d.nameOf(mod.owner), moderators: mod.admins.map((k) => ({ name: d.nameOf(k), status: d.statusOf(k) })) }); return true;
      case 'mods/add': case 'mods/remove': {
        if (need(post, 'Use POST.', 405)) return true;
        if (need(s.role === 'owner', 'Only the owner can change moderators.', 403)) return true;
        const key = findKey(body.name);
        if (need(key, 'There is no player with that name.', 404)) return true;
        if (need(key !== mod.owner, 'That is the owner.')) return true;
        if (action === 'mods/add') {
          if (need(!activeBan(key), 'That player is banned.')) return true;
          if (!mod.admins.includes(key)) { mod.admins.push(key); addLog(by, 'mod_add', key); save(); }
        } else if (mod.admins.includes(key)) {
          mod.admins = mod.admins.filter((k) => k !== key);
          for (const [h, ses] of Object.entries(mod.sessions)) if (ses.user === key) delete mod.sessions[h];
          addLog(by, 'mod_remove', key); save();
        }
        send(res, 200, { ok: true, moderators: mod.admins.map((k) => ({ name: d.nameOf(k), status: d.statusOf(k) })) });
        return true;
      }
      default: send(res, 404, { error: 'Unknown action.' }); return true;
    }
  }

  return { checkDevice, checkAccount, bannedMsg, banMessage, noteDevice, matchSeen, onReport, onBug, recentWith, newsPublic, roleOf, http, flush: () => timer && write(), stats: () => ({ setUp: !!mod.owner, bans: Object.keys(mod.bans).length, openReports: mod.reports.filter((r) => r.status === 'open').length }) };
}
