// Release 1.0: tournaments. The owner creates them in the /admin console (Tournaments tab, the Tournament Creator);
// players see them in the game (Multiplayer > Tournaments), register their party as a team and, while a round is
// live, play tournament-only matches that earn points on its leaderboard. Kept in DATA_DIR/tournaments.json on the
// main server.
//
// Formats: Solo = just you (no one else in your party), Duo = you and exactly one other player in your party,
// Squad = you and exactly three others. Duo and Squad matches are one team against another (Team Deathmatch or
// Blackout); Solo matches are free-for-all (Kill Confirmed or Gun Game) with up to 8 players.
//
// Rounds: a tournament has 1 to 10 rounds. The first round runs from its start to its end; the others repeat it every
// day or every week. Each team plays up to the match limit in every round, and points add up over all the rounds.
// Points: a team-mode win is 10 points and every elimination 1 point. In a free-for-all, 1st place is 10 points,
// 2nd 7, 3rd 5, 4th 3, 5th to 8th 1, plus 1 point for every elimination. The leaderboard ranks by points, then wins,
// then eliminations, then who got there first.
//
// Participation: Public (everyone sees it) or Invite only (only the players on its list see it and can register; the
// whole team has to be on the list).
import fs from 'node:fs';
import pathMod from 'node:path';
import crypto from 'node:crypto';

export const T_FORMATS = { solo: { name: 'Solo', size: 1 }, duo: { name: 'Duo', size: 2 }, squad: { name: 'Squad', size: 4 } };
// which modes each format can use, and the default score limit of a tournament match
export const T_MODES = { solo: ['kc', 'gg'], duo: ['tdm', 'blackout'], squad: ['tdm', 'blackout'] };
export const T_LIMITS = { solo: { kc: 15, gg: 11 }, duo: { tdm: 30, blackout: 30 }, squad: { tdm: 50, blackout: 50 } };
export const T_WIN = 10, T_PLACE = [10, 7, 5, 3, 1, 1, 1, 1], T_FFA_MAX = 8;
// poster art (the default and free Season Pass operators) and backgrounds
export const T_ARTS = [['vanguard', 'Vanguard'], ['frostline', 'Frostline'], ['nightshade', 'Nightshade'], ['ember', 'Ember'], ['duo', 'Frostline & Nightshade'], ['duo2', 'Vanguard & Ember'], ['squad', 'Squad']];
export const T_THEMES = [['gold', 'Gold'], ['crimson', 'Crimson'], ['royal', 'Royal'], ['violet', 'Violet'], ['teal', 'Teal'], ['orange', 'Orange'], ['sunset', 'Sunset'], ['twilight', 'Twilight'], ['ocean', 'Ocean'], ['toxic', 'Toxic'], ['inferno', 'Inferno'], ['midnight', 'Midnight'], ['arctic', 'Arctic']];
export const T_PRIZES = [0, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
const EVERY = { day: 864e5, week: 7 * 864e5 }, DAYS = { day: 1, week: 7 };
// a time zone name the console sent (e.g. America/New_York), if this server knows it
const zoneOk = (tz) => { if (typeof tz !== 'string' || !tz || tz.length > 64) return false; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };
const zoneFmt = new Map();
// the same clock time `days` days later in the owner's time zone, so a round at 8 PM stays at 8 PM when daylight saving
// time starts or ends (without a time zone it is exactly days × 24 hours later)
export function addDays(ms, days, tz) {
  if (!days || !zoneOk(tz)) return ms + days * 864e5;
  let f = zoneFmt.get(tz);
  if (!f) zoneFmt.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  const off = (x) => { const p = Object.fromEntries(f.formatToParts(x).filter((q) => q.type !== 'literal').map((q) => [q.type, Number(q.value)])); return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - (x - (((x % 1000) + 1000) % 1000)); };
  const wall = ms + off(ms) + days * 864e5;
  let t = wall - off(ms);
  t = wall - off(t);
  return wall - off(t);
}

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f<>]+/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const cleanText = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f<>]+/g, ' ').trim().slice(0, n);

export function createTourneys(d) {
  // d: { DATA_DIR, now, log, nameOf, keyOf, userOf, staff(key), modeName(mode), regions() -> [{ id, name, url }], mainRegion: { id, name } }
  const FILE = pathMod.join(d.DATA_DIR, 'tournaments.json');
  const st = { list: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && Array.isArray(raw.list)) st.list = raw.list.filter((t) => t && typeof t.id === 'string');
  } catch (e) { if (e.code !== 'ENOENT') console.error('could not read tournaments:', e.message); }
  // tournaments saved before rounds and posters existed
  for (const t of st.list) {
    t.rounds ||= 1; t.every ||= 'day'; t.roundLen ||= Math.max(10 * 60e3, (t.endsAt || 0) - (t.startsAt || 0));
    t.art ||= t.format === 'squad' ? 'squad' : t.format === 'duo' ? 'duo' : 'vanguard'; t.theme ||= 'gold'; t.description ??= '';
    t.prizePool ??= 0; t.participation ||= 'public'; t.invites ||= []; t.tz ??= null;
    for (const tm of Object.values(t.teams || {})) tm.rm ||= tm.matches ? { 0: tm.matches } : {};
  }
  let saveTimer = null;
  function write() {
    saveTimer = null;
    try {
      fs.mkdirSync(d.DATA_DIR, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, FILE);
    } catch (e) { console.error('could not save tournaments:', e.message); }
  }
  const save = (urgent = false) => { if (urgent) { clearTimeout(saveTimer); write(); } else if (!saveTimer) saveTimer = setTimeout(write, 800); };
  const get = (id) => st.list.find((t) => t.id === String(id || '')) || null;
  // the rounds' start and end times
  const windows = (t) => Array.from({ length: t.rounds || 1 }, (_, i) => { const s = addDays(t.startsAt, i * (DAYS[t.every] || 1), t.tz); return [s, s + t.roundLen]; });
  function roundAt(t, n = d.now()) {
    const W = windows(t);
    for (let i = 0; i < W.length; i++) {
      if (n < W[i][0]) return { cur: null, next: i, W };
      if (n < W[i][1]) return { cur: i, next: i + 1 < W.length ? i + 1 : null, W };
    }
    return { cur: null, next: null, W };
  }
  const status = (t, n = d.now()) => { const r = roundAt(t, n); return r.cur != null ? 'live' : r.next != null ? 'upcoming' : 'ended'; };
  const regionList = () => [{ id: d.mainRegion.id, name: d.mainRegion.name, url: null }, ...d.regions().filter((r) => r.id !== d.mainRegion.id)];
  const regionOf = (t) => regionList().find((r) => r.id === t.region) || null;
  const teamsOf = (t) => Object.values(t.teams || {});
  const teamOf = (t, key) => teamsOf(t).find((tm) => tm.members.includes(key)) || null;
  const teamName = (tm) => tm.members.map(d.nameOf).join(' · ');
  const canSee = (t, key) => t.participation !== 'invite' || (key && (t.invites.includes(key) || d.staff?.(key)));
  const rankSort = (a, b) => b.points - a.points || b.wins - a.wins || b.kills - a.kills || (a.reachedAt || 0) - (b.reachedAt || 0) || a.registeredAt - b.registeredAt;
  function ranked(t) {
    const rows = teamsOf(t).sort(rankSort);
    let rank = 0, prev = null;
    return rows.map((tm, i) => {
      // teams that haven't played share the last place (no rank shown)
      if (!tm.matches) return { tm, rank: null };
      if (!prev || rankSort(prev, tm) !== 0) rank = i + 1;
      prev = tm;
      return { tm, rank };
    });
  }

  // ---------- the owner's console (the Tournament Creator)
  function validate(body, old) {
    const name = clean(body.name, 40);
    if (name.length < 3) return { error: 'Give the tournament a title (3 to 40 characters).' };
    const description = clean(body.description, 60);
    const format = String(body.format || '');
    if (!T_FORMATS[format]) return { error: 'Pick Solo, Duo or Squad in Format.' };
    const mode = String(body.mode || T_MODES[format][0]);
    if (!T_MODES[format].includes(mode)) return { error: `${T_FORMATS[format].name} tournaments can use ${T_MODES[format].map(d.modeName).join(' or ')}.` };
    const region = String(body.region || d.mainRegion.id);
    if (!regionList().some((r) => r.id === region)) return { error: 'Pick a server region in Format.' };
    const art = T_ARTS.some(([k]) => k === body.art) ? body.art : format === 'squad' ? 'squad' : format === 'duo' ? 'duo' : 'vanguard';
    const theme = T_THEMES.some(([k]) => k === body.theme) ? body.theme : 'gold';
    const rounds = Math.floor(Number(body.rounds) || 1);
    if (rounds < 1 || rounds > 10) return { error: 'Rounds: 1 to 10.' };
    const every = EVERY[body.every] ? body.every : 'day';
    // the first round's start and end (endsAt is accepted for one-round tournaments)
    const startsAt = Math.floor(Number(body.startsAt)), roundEnd = Math.floor(Number(body.roundEnd ?? body.endsAt));
    if (!Number.isFinite(startsAt) || !Number.isFinite(roundEnd) || startsAt <= 0) return { error: 'Set when the first round starts and ends in Schedule.' };
    const roundLen = roundEnd - startsAt;
    if (roundLen < 10 * 60e3) return { error: 'A round has to last at least 10 minutes.' };
    // (2 hours less than a day or a week, so a round still ends first when the clocks change)
    if (rounds > 1 && roundLen > EVERY[every] - 2 * 3600e3) return { error: `Each round has to end before the next one starts (they repeat every ${every}).` };
    if (rounds === 1 && roundLen > 14 * 864e5) return { error: 'A round can last at most 14 days.' };
    const tz = zoneOk(body.tz) ? body.tz : old?.tz || null;
    const endsAt = addDays(startsAt, (rounds - 1) * DAYS[every], tz) + roundLen;
    if (!old && endsAt <= d.now()) return { error: 'That time is already over.' };
    const maxMatches = Math.floor(Number(body.maxMatches) || 10);
    if (maxMatches < 1 || maxMatches > 50) return { error: 'Matches per round: 1 to 50.' };
    let scoreLimit = Math.floor(Number(body.scoreLimit) || 0);
    if (!scoreLimit) scoreLimit = T_LIMITS[format][mode];
    if (scoreLimit < 5 || scoreLimit > 200) return { error: 'Score limit: 5 to 200 (or leave it empty for the default).' };
    const prizePool = Math.max(0, Math.min(1e6, Math.floor(Number(body.prizePool) || 0)));
    const participation = body.participation === 'invite' ? 'invite' : 'public';
    const invites = [];
    if (participation === 'invite') {
      const names = (Array.isArray(body.invites) ? body.invites : String(body.invites || '').split(/[\s,;]+/)).map((x) => String(x).trim()).filter(Boolean);
      for (const n of names.slice(0, 500)) {
        const k = d.keyOf(n);
        if (!d.userOf(k)) return { error: `There is no player called ${n.slice(0, 24)}.` };
        invites.includes(k) || invites.push(k);
      }
      if (!invites.length) return { error: 'Add the players who can join (Invite only).' };
    }
    if (old && old.format !== format && teamsOf(old).length) return { error: "Teams have already registered, so the format can't change. Make a new tournament instead." };
    return { ok: true, v: { name, description, format, mode, region, art, theme, rounds, every, tz, startsAt, roundLen, endsAt, maxMatches, scoreLimit, prizePool, prize: clean(body.prize, 120), rules: cleanText(body.rules, 800), participation, invites } };
  }
  function upsert(by, body) {
    const old = body.id ? get(body.id) : null;
    if (body.id && !old) return { error: 'That tournament no longer exists.' };
    const r = validate(body, old);
    if (r.error) return r;
    let t = old;
    if (t) Object.assign(t, r.v, { updatedAt: d.now(), updatedBy: by });
    else st.list.push(t = { id: `t_${crypto.randomBytes(5).toString('hex')}`, ...r.v, teams: {}, results: [], createdAt: d.now(), createdBy: by });
    save(true);
    return { ok: true, tournament: t };
  }
  function remove(id) {
    const i = st.list.findIndex((t) => t.id === String(id || ''));
    if (i < 0) return { error: 'That tournament no longer exists.' };
    const [t] = st.list.splice(i, 1);
    save(true);
    return { ok: true, tournament: t };
  }
  function removeTeam(id, teamId) {
    const t = get(id);
    if (!t?.teams?.[teamId]) return { error: 'That team is not in this tournament.' };
    const tm = t.teams[teamId];
    delete t.teams[teamId];
    save(true);
    return { ok: true, team: tm, tournament: t };
  }
  function adminView() {
    const n = d.now();
    return {
      regions: regionList().map((r) => ({ id: r.id, name: r.name })),
      formats: Object.entries(T_FORMATS).map(([id, f]) => ({ id, name: f.name, size: f.size, modes: T_MODES[id].map((m) => ({ id: m, name: d.modeName(m), scoreLimit: T_LIMITS[id][m] })) })),
      arts: T_ARTS.map(([id, name]) => ({ id, name })), themes: T_THEMES.map(([id, name]) => ({ id, name })), prizes: T_PRIZES,
      // in date order: a tournament that's over keeps its place
      list: st.list.slice().sort((a, b) => a.startsAt - b.startsAt).map((t) => ({
        ...pub(t, n), invites: t.invites.map(d.nameOf), prize: t.prize,
        teams: ranked(t).map(({ tm, rank }) => ({ id: tm.id, name: teamName(tm), members: tm.members.map(d.nameOf), rank, points: tm.points, matches: tm.matches, wins: tm.wins, kills: tm.kills, registeredAt: tm.registeredAt })),
        results: (t.results || []).slice(-30).reverse(),
      })),
    };
  }

  // ---------- what players see
  function pub(t, n = d.now()) {
    const r = regionOf(t), ra = roundAt(t, n);
    return {
      id: t.id, name: t.name, description: t.description, format: t.format, size: T_FORMATS[t.format].size, mode: t.mode, modeName: d.modeName(t.mode),
      region: t.region, regionName: r?.name || t.region, art: t.art, theme: t.theme,
      startsAt: t.startsAt, endsAt: t.endsAt, rounds: t.rounds, every: t.every, roundLen: t.roundLen, windows: ra.W, round: ra.cur, nextRound: ra.next,
      maxMatches: t.maxMatches, scoreLimit: t.scoreLimit, prizePool: t.prizePool, prize: t.prize, rules: t.rules, participation: t.participation,
      status: ra.cur != null ? 'live' : ra.next != null ? 'upcoming' : 'ended', teams: teamsOf(t).length,
    };
  }
  function mine(t, key) {
    const tm = teamOf(t, key);
    if (!tm) return null;
    const row = ranked(t).find((x) => x.tm === tm), ra = roundAt(t), ri = ra.cur ?? ra.next;
    return { teamId: tm.id, members: tm.members.map(d.nameOf), leader: d.nameOf(tm.leader), isLeader: tm.leader === key, points: tm.points, matches: tm.matches, wins: tm.wins, kills: tm.kills, rank: row?.rank ?? null, left: ri == null ? 0 : Math.max(0, t.maxMatches - (tm.rm?.[ri] || 0)) };
  }
  function listFor(key) {
    const n = d.now();
    // live and upcoming ones, and the ones that ended in the last 7 days, in date order (one that's over keeps its
    // place instead of moving to the end)
    return st.list.filter((t) => t.endsAt > n - 7 * 864e5 && canSee(t, key)).sort((a, b) => a.startsAt - b.startsAt)
      .map((t) => ({ ...pub(t, n), my: key ? mine(t, key) : null }));
  }
  function board(id, key, limit = 50) {
    const t = get(id);
    if (!t || !canSee(t, key)) return null;
    // (teams join the leaderboard with their first match: Play registers them, nobody registers by hand)
    const rows = ranked(t).filter(({ tm }) => tm.matches > 0);
    return { id: t.id, total: rows.length, rows: rows.slice(0, limit).map(({ tm, rank }) => ({ rank, name: teamName(tm), points: tm.points, matches: tm.matches, wins: tm.wins, kills: tm.kills, me: !!key && tm.members.includes(key) })), my: key ? mine(t, key) : null };
  }

  // party: the player's current party members (account keys), or [key] when they aren't in one
  function sizeRule(t, party) {
    const f = T_FORMATS[t.format], n = party.length;
    if (n === f.size) return null;
    if (t.format === 'solo') return 'Solo tournaments are just you. Leave your party to play.';
    if (t.format === 'duo') return n < 2 ? 'Duo tournaments need one other player in your party with you. Invite a friend from the Friends panel.' : `Duo tournaments are 2 players: your party has ${n}.`;
    return n < 4 ? `Squad tournaments need three others in your party with you (your party has ${n}). Invite more friends from the Friends panel.` : `Squad tournaments are 4 players: your party has ${n}.`;
  }
  function register(key, id, party, leaderKey) {
    const t = get(id);
    if (!t || !canSee(t, key)) return { error: 'That tournament no longer exists.' };
    if (status(t) === 'ended') return { error: 'That tournament has ended.' };
    const err = sizeRule(t, party);
    if (err) return { error: err };
    if (party.length > 1 && leaderKey !== key) return { error: `${d.nameOf(leaderKey)} starts your party's tournament matches.` };
    if (t.participation === 'invite') for (const k of party) if (!t.invites.includes(k)) return { error: `${d.nameOf(k)} isn't invited to this tournament.` };
    const mineNow = teamOf(t, key);
    if (mineNow && mineNow.members.length === party.length && party.every((k) => mineNow.members.includes(k))) return { error: "You're already registered." };
    for (const k of party) {
      const tm = teamOf(t, k);
      if (!tm) continue;
      if (tm.matches) return { error: `${d.nameOf(k)} has already played in this tournament with another team.` };
      // a team that hasn't played yet is replaced (e.g. the party changed)
      delete t.teams[tm.id];
    }
    const tm = { id: `tm_${crypto.randomBytes(4).toString('hex')}`, leader: party.length > 1 ? leaderKey : key, members: party.slice(), registeredAt: d.now(), points: 0, matches: 0, wins: 0, kills: 0, reachedAt: 0, rm: {} };
    t.teams ||= {};
    t.teams[tm.id] = tm;
    save();
    return { ok: true, tournament: t, team: tm };
  }
  function unregister(key, id) {
    const t = get(id), tm = t && teamOf(t, key);
    if (!tm) return { error: "You aren't registered for that tournament." };
    if (tm.members.length > 1 && tm.leader !== key) return { error: 'Only your team leader can withdraw the team.' };
    if (tm.matches) return { error: "Your team has already played, so it can't withdraw." };
    delete t.teams[tm.id];
    save();
    return { ok: true, tournament: t, team: tm };
  }

  // ---------- playing: the main server hands each team member a ticket for the tournament's match server
  const tickets = new Map(); // ticket -> { tid, teamId, key, until }
  function play(key, id, party, busy = () => null, leaderKey = key) {
    const t = get(id);
    if (!t || !canSee(t, key)) return { error: 'That tournament no longer exists.' };
    const ra = roundAt(t);
    if (ra.cur == null) return { error: ra.next == null ? 'That tournament has ended.' : ra.next === 0 ? 'That tournament has not started yet.' : `Round ${ra.next + 1} hasn't started yet.` };
    // like Fortnite: there's no registering by hand. Play makes the party a team (the first time, or after the party
    // changed and the old team never played); a team that has played stays together for the whole tournament.
    let tm = teamOf(t, key);
    const same = tm && tm.members.length === party.length && party.every((k) => tm.members.includes(k));
    if (!same) {
      if (tm?.matches) return { error: `You've already played in this tournament as ${teamName(tm)}. Play with that ${t.format === 'solo' ? 'party (just you)' : 'party'} to keep your points.` };
      const r = register(key, id, party, leaderKey);
      if (r.error) return r;
      tm = r.team;
    }
    const joined = !same;
    if (tm.members.length > 1 && tm.leader !== key) return { error: `${d.nameOf(tm.leader)} starts your team's matches.` };
    if ((tm.rm?.[ra.cur] || 0) >= t.maxMatches) return { error: t.rounds > 1 ? `Your team has played all ${t.maxMatches} of its matches in this round.` : `Your team has played all ${t.maxMatches} of its matches.` };
    if (party.length !== tm.members.length || !party.every((k) => tm.members.includes(k))) return { error: `Your party has to be exactly your registered team: ${teamName(tm)}.` };
    const region = regionOf(t);
    if (!region) return { error: "That tournament's servers aren't available." };
    const why = busy(tm.members, region);
    if (why) return { error: why };
    const until = d.now() + 3 * 60e3, out = [];
    for (const k of tm.members) {
      const ticket = crypto.randomBytes(18).toString('hex');
      tickets.set(ticket, { tid: t.id, teamId: tm.id, key: k, until, round: ra.cur });
      out.push({ key: k, ticket });
    }
    for (const [tk, v] of tickets) if (v.until < d.now()) tickets.delete(tk);
    return { ok: true, tournament: t, team: tm, region, tickets: out, joined };
  }
  // a match server checks a ticket (one use per queue); returns what it needs to run the team's matches
  function ticketCheck(ticket, key) {
    const v = tickets.get(String(ticket || ''));
    if (!v || v.until < d.now() || v.key !== key) return { error: 'Your tournament entry expired. Press Play again.' };
    const t = get(v.tid), tm = t?.teams?.[v.teamId];
    if (!t || !tm) return { error: 'That tournament or team no longer exists.' };
    const ra = roundAt(t);
    if (ra.cur == null) return { error: 'That tournament is not live.' };
    if ((tm.rm?.[ra.cur] || 0) >= t.maxMatches) return { error: `Your team has played all ${t.maxMatches} of its matches${t.rounds > 1 ? ' in this round' : ''}.` };
    tickets.delete(String(ticket));
    return { ok: true, conf: { id: t.id, name: t.name, format: t.format, size: T_FORMATS[t.format].size, mode: t.mode, scoreLimit: t.scoreLimit, endsAt: ra.W[ra.cur][1], round: ra.cur }, team: { id: tm.id, members: tm.members.slice(), name: teamName(tm), points: tm.points } };
  }
  // a tournament match ended: [{ teamId, won, place, kills }] (place for free-for-all, won for team modes)
  function result(tid, matchId, rows, round = null) {
    const t = get(tid);
    if (!t || !Array.isArray(rows)) return { error: 'Unknown tournament.' };
    t.results ||= [];
    if (t.results.some((r) => r.matchId === matchId)) return { ok: true, dup: true };
    const ri = Number.isInteger(round) && round >= 0 && round < t.rounds ? round : roundAt(t).cur ?? 0;
    const out = [];
    for (const r of rows.slice(0, 16)) {
      const tm = t.teams?.[String(r.teamId)];
      if (!tm) continue;
      tm.rm ||= {};
      if ((tm.rm[ri] || 0) >= t.maxMatches) continue;
      const kills = Math.max(0, Math.min(500, Math.floor(Number(r.kills) || 0)));
      const place = Math.floor(Number(r.place) || 0), won = !!r.won;
      const pts = (t.format === 'solo' ? (place >= 1 ? T_PLACE[place - 1] || 0 : 0) : won ? T_WIN : 0) + kills;
      tm.rm[ri] = (tm.rm[ri] || 0) + 1, tm.matches++, tm.points += pts, tm.kills += kills, (won || place === 1) && tm.wins++, pts > 0 && (tm.reachedAt = d.now());
      out.push({ teamId: tm.id, name: teamName(tm), points: pts, kills, won: won || place === 1, place: place || null });
    }
    t.results.push({ matchId: String(matchId).slice(0, 48), at: d.now(), round: ri, teams: out });
    if (t.results.length > 400) t.results.splice(0, t.results.length - 400);
    save();
    return { ok: true, tournament: t, teams: out };
  }

  return { get, status, upsert, remove, removeTeam, adminView, listFor, board, register, unregister, play, ticketCheck, result, teamOf, membersOf: (t) => teamsOf(t).flatMap((tm) => tm.members), pub, mine };
}
