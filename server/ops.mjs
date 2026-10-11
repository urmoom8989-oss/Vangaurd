// Server operations (Beta 1.3): lobby announcements, maintenance mode, the Steam requirement and its allowlist,
// the developer list and the latest game build. Set from the /admin console; kept in DATA_DIR/ops.json.
//
// Maintenance: while it is on, everyone except the owner, moderators and developers is signed out and new
// sign-ins are refused with the code "maintenance" (the game shows its "Login failed · Retry" screen).
// Steam: while "require Steam" is on, the game must say it was started from Steam (and, when STEAM_WEB_API_KEY and
// STEAM_APP_ID are set, prove it with a session ticket that the server checks with Steam). The owner and the
// players on the allowlist may play without Steam.
import fs from 'node:fs';
import pathMod from 'node:path';

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, n);

export function createOps(d) {
  // d: { DATA_DIR, now, log, keyOf, nameOf, userOf, roleOf, ownerKey, env }
  const FILE = pathMod.join(d.DATA_DIR, 'ops.json');
  const st = { announcement: null, maintenance: { on: false, message: '', since: 0, by: null }, steam: { required: false, allow: [] }, devs: [], release: null };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object') for (const k of Object.keys(st)) if (raw[k] !== undefined) st[k] = raw[k];
  } catch (e) { if (e.code !== 'ENOENT') console.error('could not read ops data:', e.message); }
  if (!Array.isArray(st.devs)) st.devs = [];
  if (!st.steam || typeof st.steam !== 'object') st.steam = { required: false, allow: [] };
  if (!Array.isArray(st.steam.allow)) st.steam.allow = [];
  function save() {
    try {
      fs.mkdirSync(d.DATA_DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('could not save ops data:', e.message); }
  }
  const env = d.env || process.env;
  const STEAM_KEY = String(env.STEAM_WEB_API_KEY || '').trim(), STEAM_APP = String(env.STEAM_APP_ID || '').trim();
  const steamVerify = !!(STEAM_KEY && /^\d+$/.test(STEAM_APP));

  // ---------- who is who
  const isOwner = (key) => !!key && key === d.ownerKey();
  const isMod = (key) => !!key && !!d.roleOf(key);
  const isDev = (key) => !!key && (isOwner(key) || st.devs.includes(key));
  const staff = (key) => isOwner(key) || isMod(key) || isDev(key);

  // ---------- announcements
  function announcementView() {
    const a = st.announcement;
    if (!a) return null;
    if (a.until && a.until <= d.now()) { st.announcement = null; save(); return null; }
    return { id: a.id, kind: a.kind, title: a.title, text: a.text, startsAt: a.startsAt || null, until: a.until || null, at: a.at };
  }
  function setAnnouncement(by, body) {
    const kind = body.kind === 'downtime' ? 'downtime' : 'info';
    const text = clean(body.text, 240), title = clean(body.title, 60) || (kind === 'downtime' ? 'Downtime begins soon' : 'Announcement');
    const minutes = Math.max(0, Math.min(7 * 24 * 60, Number(body.minutes) || 0));
    const startsIn = body.startsIn === '' || body.startsIn == null ? null : Math.max(0, Math.min(7 * 24 * 60, Number(body.startsIn) || 0));
    if (kind === 'info' && text.length < 2) return { error: 'Write the announcement.' };
    const t = d.now();
    st.announcement = { id: `a${t.toString(36)}`, kind, title, text, at: t, by, startsAt: kind === 'downtime' && startsIn != null ? t + startsIn * 60e3 : null, until: minutes ? t + minutes * 60e3 : null };
    save();
    return { announcement: announcementView() };
  }
  function clearAnnouncement() { st.announcement = null; save(); }

  // ---------- maintenance
  const maintenanceMessage = () => st.maintenance.message || 'Vangaurd is undergoing maintenance. Please try again later.';
  function setMaintenance(by, on, message) {
    st.maintenance = { on: !!on, message: clean(message, 240), since: on ? d.now() : 0, by: on ? by : null };
    if (on && st.announcement?.kind === 'downtime') st.announcement = null; // downtime has begun
    save();
    return st.maintenance;
  }

  // ---------- Steam
  function cleanSteam(v) {
    if (!v || typeof v !== 'object') return null;
    const id = /^\d{17}$/.test(String(v.id || '')) ? String(v.id) : null;
    const ticket = /^[0-9a-fA-F]{16,4096}$/.test(String(v.ticket || '')) ? String(v.ticket) : null;
    return { present: v.present === true, id, ticket, kind: v.kind === 'web' ? 'web' : 'session', app: /^\d{1,10}$/.test(String(v.app || '')) ? String(v.app) : null };
  }
  async function checkTicket(s) {
    if (!steamVerify) return s?.present === true;
    if (!s?.ticket) return false;
    try {
      const url = `https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/?key=${encodeURIComponent(STEAM_KEY)}&appid=${STEAM_APP}&ticket=${s.ticket}${s.kind === 'web' ? '&identity=vangaurd' : ''}`;
      const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(to));
      const j = await res.json();
      const p = j?.response?.params;
      return !!p && p.result === 'OK' && (!s.id || p.steamid === s.id) && !p.vacbanned && !p.publisherbanned;
    } catch (e) {
      d.log(`steam ticket check failed: ${e.message}`);
      return false;
    }
  }
  // Called when a sign-in, resume or queue message arrives: remembers what the game says about Steam and,
  // when tickets are checked, checks it once per connection.
  async function noteSteam(c, msg) {
    const s = cleanSteam(msg?.steam);
    if (!s) return;
    c.steam = s;
    if (!st.steam.required) return;
    if (c.steamOkFor === (s.ticket || s.present)) return;
    c.steamOk = await checkTicket(s);
    c.steamOkFor = s.ticket || s.present;
  }
  const steamAllowed = (key) => isOwner(key) || st.steam.allow.includes(key);
  const STEAM_MSG = 'Vangaurd has to be started from Steam. Open Steam, then launch Vangaurd from your Library.';

  // The checks every sign-in (and every queue join) goes through. Returns null, or { code, message }.
  function gate(c, key) {
    if (st.maintenance.on && !staff(key)) return { code: 'maintenance', message: maintenanceMessage() };
    if (st.steam.required && !steamAllowed(key)) {
      const ok = steamVerify ? c.steamOk === true : c.steam?.present === true;
      if (!ok) return { code: 'steam_required', message: STEAM_MSG };
    }
    return null;
  }

  // ---------- latest build (the release pipeline posts it; the console can set it too)
  function setRelease(by, body) {
    const build = Math.floor(Number(body.build));
    if (!(build > 0 && build < 1e6)) return { error: 'Give the build number.' };
    st.release = { build, label: clean(body.label, 40) || `Build ${build}`, at: d.now(), by: by || 'pipeline', version: clean(body.version, 24) || null };
    save();
    return { release: st.release };
  }

  const names = (keys) => keys.map((k) => ({ name: d.nameOf(k) || k }));
  function view() {
    return {
      announcement: announcementView(),
      maintenance: { ...st.maintenance, by: st.maintenance.by ? d.nameOf(st.maintenance.by) : null, message: st.maintenance.message },
      steam: { required: !!st.steam.required, verify: steamVerify, allow: names(st.steam.allow) },
      devs: names(st.devs), owner: d.nameOf(d.ownerKey()), release: st.release,
    };
  }
  function listEdit(list, key, add) {
    const has = list.includes(key);
    if (add && !has) list.push(key);
    if (!add && has) list.splice(list.indexOf(key), 1);
    save();
    return add !== has;
  }

  return {
    state: st, view, gate, noteSteam, cleanSteam, isDev, isOwner, staff,
    announcementView, setAnnouncement, clearAnnouncement, setMaintenance, maintenanceMessage, setRelease,
    steamAllowEdit: (key, add) => listEdit(st.steam.allow, key, add),
    devEdit: (key, add) => listEdit(st.devs, key, add),
    setSteamRequired: (on) => { st.steam.required = !!on; save(); },
    steamVerify,
  };
}
