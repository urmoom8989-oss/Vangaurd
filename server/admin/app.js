'use strict';
// Vangaurd Anti-Cheat console. Talks only to this server's /admin/api, so it works with every game version.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const app = $('#app');
  const TOKEN_KEY = 'vg-anticheat-token';
  const MAPS = { vardanek: 'Vardanek', kessel: 'Kessel Yard', lindenhof: 'Lindenhof', foundry: 'Foundry', freighter: 'Freighter', airfield: 'Airfield' };
  const MODES = { tdm: 'Team Deathmatch', kc: 'Kill Confirmed', gg: 'Gun Game', blackout: 'Blackout' };
  const REASONS = { cheating: 'Cheating', exploit: 'Exploiting a bug', name: 'Offensive name', abuse: 'Abusive behaviour', other: 'Other' };
  const STATUS = { online: 'Online', searching: 'Searching for a match', match: 'In a match', offline: 'Offline' };
  const LENGTHS = [['1 hour', 1], ['1 day', 24], ['3 days', 72], ['7 days', 168], ['30 days', 720], ['Permanent', null]];
  const SHIELD = '<svg viewBox="0 0 120 120" aria-hidden="true"><path fill="none" stroke="#f2c14e" stroke-width="7" d="M60 8 L104 23 V57 C104 84 85 101 60 111 C35 101 16 84 16 57 V23 Z"/><path fill="#f2c14e" d="M60 32 L88 49 V60 L60 43 L32 60 V49 Z"/><path fill="#f2c14e" opacity=".6" d="M60 57 L88 74 V85 L60 68 L32 85 V74 Z"/></svg>';

  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* private mode */ }
  const ui = { me: null, role: null, tab: 'reports', status: 'open', selected: null, q: '', filter: '', summary: null, timer: 0 };

  // ---------- helpers ----------
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  function ago(ms) {
    if (!ms) return 'never';
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 45) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 36) return `${h} h ago`;
    const d = Math.round(h / 24); return d < 60 ? `${d} days ago` : fmt(ms);
  }
  function left(ms) {
    const h = Math.max(0, (ms - Date.now()) / 3600e3);
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} min left` : h < 48 ? `${Math.round(h)} h left` : `${Math.round(h / 24)} days left`;
  }
  const banEnds = (b) => (b.permanent ? 'Permanent' : `Ends ${fmt(b.until)} · ${left(b.until)}`);
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  function setToken(t) {
    token = t;
    try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }
  async function api(action, { body, query } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''))}` : '';
    const res = await fetch(`/admin/api/${action}${qs}`, {
      method: body ? 'POST' : 'GET', cache: 'no-store',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && action !== 'login' && action !== 'setup') { setToken(null); boot(); throw new Error(data.error || 'Please sign in again.'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }
  function toast(text, bad = false) {
    const t = document.createElement('div');
    t.className = `toast${bad ? ' bad' : ''}`; t.textContent = text;
    $('#toasts').appendChild(t);
    setTimeout(() => t.remove(), 4200);
  }
  const fail = (e) => toast(e.message || String(e), true);
  const dot = (st) => `<span class="dot ${esc(st)}" title="${esc(STATUS[st] || st)}"></span>`;
  const reasonTag = (r, text) => `<span class="tag ${r === 'cheating' ? 'cheating' : ''}">${esc(text || REASONS[r] || r)}</span>`;
  const playerTags = (p) => `${p.ban ? '<span class="tag banned">Banned</span>' : ''}${p.role ? `<span class="tag mod">${esc(p.role)}</span>` : ''}`;

  // ---------- sign-in / setup ----------
  async function boot() {
    clearInterval(ui.timer);
    let st;
    try { st = await api('status'); } catch (e) { app.innerHTML = `<div class="gate"><div class="card"><div class="brand">${SHIELD}<div><b>VANGAURD</b><small>Anti-Cheat</small></div></div><h1>Can't reach the server</h1><p class="lead">${esc(e.message)}</p><button class="btn pri" id="retry">Try again</button></div></div>`; $('#retry').onclick = boot; return; }
    if (st.me) { ui.me = st.me; ui.role = st.role; return shell(); }
    gate(st.setupNeeded);
  }
  function gate(setup) {
    app.innerHTML = `<div class="gate"><form class="card" novalidate>
      <div class="brand">${SHIELD}<div><b>VANGAURD</b><small>Anti-Cheat</small></div></div>
      <h1>${setup ? 'Set up the console' : 'Moderator sign-in'}</h1>
      <p class="lead">${setup ? 'Enter the one-time setup code from the server log, then sign in with your Vangaurd game account. That account becomes the owner of this console.' : 'Sign in with your Vangaurd game account. Only the owner and moderators can use the console.'}</p>
      ${setup ? '<label class="f"><span class="k">Setup code</span><input class="input mono" name="code" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX" required></label>' : ''}
      <label class="f"><span class="k">Username</span><input class="input" name="username" autocomplete="username" spellcheck="false" autocapitalize="off" required></label>
      <label class="f"><span class="k">Password</span><input class="input" type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn pri" type="submit">${setup ? 'Become the owner' : 'Sign in'}</button>
      <div class="err" role="alert"></div></form></div>`;
    const f = $('form', app), err = $('.err', f);
    $('input', f).focus();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const v = Object.fromEntries(new FormData(f));
      if (!v.username || !v.password || (setup && !v.code)) { err.textContent = 'Fill in every field.'; return; }
      const b = $('button[type=submit]', f); b.disabled = true; err.textContent = '';
      try {
        const r = await api(setup ? 'setup' : 'login', { body: v });
        setToken(r.token); ui.me = r.me; ui.role = r.role;
        shell();
        if (setup) toast(`You are the owner of the console, ${r.me}.`);
      } catch (e) { err.textContent = e.message; b.disabled = false; }
    };
  }

  // ---------- shell ----------
  const TABS = [['reports', 'Reports'], ['flags', 'Cheat flags'], ['players', 'Players'], ['chat', 'Chat'], ['bugs', 'Bugs'], ['bans', 'Bans'], ['news', 'News'], ['server', 'Server'], ['activity', 'Activity'], ['mods', 'Moderators']];
  const BUGCAT = { gameplay: 'Gameplay', graphics: 'Graphics', controls: 'Controls', online: 'Online', menus: 'Menus', performance: 'Performance', other: 'Other' };
  function shell() {
    app.innerHTML = `<header class="top"><div class="brand">${SHIELD}<div><b>VANGAURD</b><small>Anti-Cheat</small></div></div>
      <div class="me">Signed in as <b>${esc(ui.me)}</b><span class="role">${esc(ui.role)}</span><button class="btn sm" id="signout">Sign out</button></div></header>
      <section class="stats" id="stats"></section>
      <nav class="tabs" role="tablist">${TABS.map(([k, t]) => `<button class="tab" role="tab" data-tab="${k}">${t}${k === 'reports' ? '<span class="n" id="nrep"></span>' : k === 'flags' ? '<span class="n" id="nflag"></span>' : k === 'bugs' ? '<span class="n" id="nbug"></span>' : ''}</button>`).join('')}</nav>
      <main id="view"></main>`;
    $('#signout').onclick = async () => { try { await api('logout', { body: {} }); } catch { /* ignore */ } setToken(null); boot(); };
    $$('.tab').forEach((b) => { b.onclick = () => show(b.dataset.tab); });
    summary(); show(ui.tab);
    ui.timer = setInterval(() => { summary(); if (ui.tab === 'reports' && !$('.modal')) groupsList(true); if (ui.tab === 'flags' && !$('.modal')) flagList(true); if (ui.tab === 'chat' && !$('.modal')) chatList(true); }, 15000);
  }
  async function summary() {
    try {
      const s = ui.summary = await api('summary');
      const c = s.counts;
      $('#stats').innerHTML = [['Open reports', c.openReports, c.openReports > 0], ['Open cheat flags', c.openFlags || 0, c.openFlags > 0], ['Reported players', c.reportedPlayers], ['Active bans', c.bans], ['Players online', c.online], ['Accounts', c.accounts]]
        .map(([k, v, hot]) => `<div class="stat${hot ? ' hot' : ''}"><span class="k">${k}</span><b>${Number(v).toLocaleString()}</b></div>`).join('');
      $('#nrep').textContent = c.openReports ? String(c.openReports) : '';
      $('#nflag').textContent = c.openFlags ? String(c.openFlags) : '';
      $('#nbug').textContent = c.openBugs ? String(c.openBugs) : '';
    } catch { /* handled by api() */ }
  }
  function show(tab) {
    ui.tab = tab;
    $$('.tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    ({ reports: viewReports, flags: viewFlags, chat: viewChat, players: viewPlayers, bugs: viewBugs, bans: viewBans, news: viewNews, server: viewServer, activity: viewActivity, mods: viewMods })[tab]();
  }

  // ---------- reports ----------
  function viewReports() {
    $('#view').innerHTML = `<div class="split">
      <section class="pane"><header><span class="k">Reported players</span><span class="sp"></span>
        <div class="seg" role="group" aria-label="Report status">${[['open', 'Open'], ['banned', 'Banned'], ['dismissed', 'Dismissed'], ['all', 'All']].map(([k, t]) => `<button data-st="${k}" class="${ui.status === k ? 'on' : ''}">${t}</button>`).join('')}</div></header>
        <div class="list" id="groups"></div></section>
      <section class="pane" id="detail"><div class="empty"><b>Select a reported player</b>Their reports, match stats and ban options appear here.</div></section></div>`;
    $$('[data-st]').forEach((b) => { b.onclick = () => { ui.status = b.dataset.st; $$('[data-st]').forEach((x) => x.classList.toggle('on', x === b)); groupsList(); }; });
    groupsList();
    if (ui.selected) detail(ui.selected);
  }
  async function groupsList(quiet = false) {
    const box = $('#groups');
    if (!box) return;
    try {
      const r = await api('reports', { query: { status: ui.status } });
      if (!r.groups.length) {
        box.innerHTML = `<div class="empty"><b>${ui.status === 'open' ? 'No open reports' : 'Nothing here'}</b>${ui.status === 'open' ? 'Players can report each other from the end-of-match screen.' : ''}</div>`;
        return;
      }
      box.innerHTML = r.groups.map((g) => {
        const reasons = Object.entries(g.reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${REASONS[k] || k}${n > 1 ? ` ×${n}` : ''}`).join(', ');
        const n = ui.status === 'open' ? g.open : g.total;
        return `<button class="row${ui.selected === g.name ? ' on' : ''}" data-name="${esc(g.name)}">
          <span class="count${n ? '' : ' zero'}">${n}</span>
          <span class="main"><span class="nm">${dot(g.status)}${esc(g.name)}${g.banned ? '<span class="tag banned">Banned</span>' : ''}</span>
          <span class="sub">${plural(g.reporters, 'reporter')} · ${esc(reasons)} · ${ago(g.last)}</span></span></button>`;
      }).join('');
      $$('.row', box).forEach((b) => { b.onclick = () => { ui.selected = b.dataset.name; $$('.row', box).forEach((x) => x.classList.toggle('on', x === b)); detail(b.dataset.name); }; });
    } catch (e) { if (!quiet) fail(e); }
  }
  function reportCard(r, by = true) {
    const m = r.match || {}, st = r.stats;
    const handled = r.status !== 'open' ? `<span class="tag">${esc(r.status === 'banned' ? 'Player banned' : 'Dismissed')}${r.handledBy ? ` by ${esc(r.handledBy)}` : ''}</span>` : '';
    return `<article class="report${r.status !== 'open' ? ' handled' : ''}">
      <div class="top-line">${reasonTag(r.reason, r.reasonText)}<span>${by ? `reported by <b>${esc(r.reporter)}</b>` : `reported <b>${esc(r.target)}</b>`}</span>${handled}
        <span class="when" title="${esc(fmt(r.at))}">${ago(r.at)}</span></div>
      ${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}
      <div class="meta"><span>${esc(MODES[m.mode] || m.mode || 'Match')} · ${esc(MAPS[m.map] || m.map || 'map not picked')}</span>${m.players ? `<span>${plural(m.players, 'player')}</span>` : ''}
        ${st && by ? `<span>${esc(r.target)} in that match: <b>${st.kills} kills · ${st.deaths} deaths · ${st.score} score</b></span>` : ''}
        ${r.replay ? `<button class="btn sm pri" data-replay="${esc(r.id)}">Watch replay</button>` : ''}
        ${r.status !== 'open' ? `<button class="btn sm" data-reopen="${esc(r.id)}">Reopen</button>` : by ? `<button class="btn sm" data-dismiss="${esc(r.id)}">Dismiss</button>` : ''}</div></article>`;
  }

  // ---------- Release 1.0: cheat flags ----------
  // Players the server's anti-cheat flagged, highest suspicion first. Each flag is one match: what was flagged and how
  // often, and its recording with the flagged moments marked. Verdicts: Watch (keep an eye on them), Clear (a false
  // alarm: closes the report it filed) or Ban (the usual ban dialog).
  const FLAGS = { range: 'Out of range', origin: 'From the wrong place', wall: 'No line of sight', snap: 'Aim snap', phantom: 'Hit without a shot', rate: 'Impossible fire rate', damage: 'Impossible damage', speed: 'Too fast', teleport: 'Teleport', headshots: 'Headshot rate', accuracy: 'Accuracy' };
  const FLAG_HELP = { range: 'Hits from further than the gun reaches (not counted).', origin: 'Hits claimed from somewhere the player was not (not counted).', wall: 'Hits with no line of sight. Bullets do go through thin walls, so only many of them matter.', snap: 'The view swung 35° or more in a tenth of a second and stopped within 3° of the target as the hit landed.', phantom: 'Hits that came with no shot fired before them.', rate: 'More shots in two seconds than the gun can fire.', damage: 'More damage in one hit than the weapon can do (not counted).', speed: 'Moving faster than anyone can run for a second or more.', teleport: 'A jump of 25 m or more between two updates.', headshots: 'Nearly every kill a headshot (15 kills or more).', accuracy: 'Nearly every shot a hit (60 shots or more).' };
  ui.fstatus = 'open';
  const sevClass = (s) => (s >= 16 ? 'hi' : s >= 8 ? 'mid' : 'lo');
  function viewFlags() {
    $('#view').innerHTML = `<div class="split">
      <section class="pane"><header><span class="k">Flagged players</span><span class="sp"></span>
        <div class="seg" role="group" aria-label="Flag status">${[['open', 'Open'], ['watch', 'Watch'], ['cleared', 'Cleared'], ['banned', 'Banned'], ['all', 'All']].map(([k, t]) => `<button data-fst="${k}" class="${ui.fstatus === k ? 'on' : ''}">${t}</button>`).join('')}</div></header>
        <div class="list" id="flaggroups"></div></section>
      <section class="pane" id="flagdetail"><div class="empty"><b>Select a flagged player</b>What was flagged, the replay with each flagged moment marked, and the verdict buttons appear here.</div></section></div>`;
    $$('[data-fst]').forEach((b) => { b.onclick = () => { ui.fstatus = b.dataset.fst; $$('[data-fst]').forEach((x) => x.classList.toggle('on', x === b)); flagList(); }; });
    flagList();
  }
  async function flagList(quiet = false) {
    const box = $('#flaggroups');
    if (!box) return;
    try {
      const r = await api('flags', { query: { status: ui.fstatus } });
      ui.flagGroups = r.groups;
      if (!r.groups.length) { box.innerHTML = `<div class="empty"><b>${ui.fstatus === 'open' ? 'No open cheat flags' : 'Nothing here'}</b>${ui.fstatus === 'open' ? 'The server flags players by itself during online matches.' : ''}</div>`; return; }
      box.innerHTML = r.groups.map((g) => {
        const cats = {};
        for (const f of g.flags) for (const [k, n] of Object.entries(f.counts || {})) cats[k] = (cats[k] || 0) + n;
        const top = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${FLAGS[k] || k} ×${n}`).join(', ');
        return `<button class="row${ui.fselected === g.name ? ' on' : ''}" data-fname="${esc(g.name)}"><span class="count sev ${sevClass(g.max)}" title="Highest suspicion">${Math.round(g.max)}</span>
          <span class="main"><span class="nm">${dot(g.status)}${esc(g.name)}${g.banned ? '<span class="tag banned">Banned</span>' : ''}</span>
          <span class="sub">${plural(g.flags.length, 'match')} flagged${g.history > g.flags.length ? ` · ${g.history} in all` : ''} · ${esc(top)} · ${ago(g.last)}</span></span></button>`;
      }).join('');
      $$('.row', box).forEach((b) => { b.onclick = () => { ui.fselected = b.dataset.fname; $$('.row', box).forEach((x) => x.classList.toggle('on', x === b)); flagDetail(b.dataset.fname); }; });
      if (ui.fselected && !quiet) flagDetail(ui.fselected);
    } catch (e) { if (!quiet) fail(e); }
  }
  function flagCard(f) {
    const cats = Object.entries(f.counts || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
    const st = f.status === 'open' ? '' : `<span class="tag ${f.status === 'banned' ? 'banned' : ''}">${esc(f.status === 'watch' ? 'Watching' : f.status === 'cleared' ? 'Cleared' : 'Banned')}${f.handledBy ? ` by ${esc(f.handledBy)}` : ''}</span>`;
    return `<article class="report flag${f.status !== 'open' && f.status !== 'watch' ? ' handled' : ''}">
      <div class="top-line"><span class="sevbar ${sevClass(f.score)}"><i style="width:${Math.min(100, f.score / 24 * 100).toFixed(0)}%"></i></span><b>Suspicion ${Math.round(f.score * 10) / 10}</b>${st}<span class="when" title="${esc(fmt(f.at))}">${ago(f.at)}</span></div>
      <div class="chips">${cats.map(([k, n]) => `<span class="chip flagc" title="${esc(FLAG_HELP[k] || '')}">${esc(FLAGS[k] || k)} <b>×${n}</b></span>`).join('')}</div>
      <div class="meta"><span>${esc(MODES[f.match?.mode] || f.match?.mode || 'Match')} · ${esc(MAPS[f.match?.map] || f.match?.map || 'map not known')}${f.match?.region ? ` · ${esc(f.match.region.toUpperCase())}` : ''}</span>
        ${f.reportId ? `<button class="btn sm pri" data-freplay="${esc(f.reportId)}">Review replay</button>` : ''}
        ${f.status !== 'watch' && f.status !== 'banned' ? `<button class="btn sm" data-fv="watch" data-fid="${esc(f.id)}">Watch</button>` : ''}
        ${f.status !== 'cleared' && f.status !== 'banned' ? `<button class="btn sm" data-fv="cleared" data-fid="${esc(f.id)}">Clear · false alarm</button>` : ''}
        ${f.status === 'cleared' || f.status === 'watch' ? `<button class="btn sm" data-fv="open" data-fid="${esc(f.id)}">Reopen</button>` : ''}</div></article>`;
  }
  async function flagDetail(name) {
    const box = $('#flagdetail');
    if (!box) return;
    const g = (ui.flagGroups || []).find((x) => x.name === name);
    if (!g) { box.innerHTML = '<div class="empty">This player has no flags in this list.</div>'; return; }
    box.innerHTML = `<div class="detail"><div class="section"><span class="k">Cheat flags · ${esc(g.name)} (${g.flags.length})</span>
      <p class="fhelp">Open <b>Review replay</b> to watch the match from above: every flagged moment is marked on the timeline and listed on the right, so you can jump straight to it. Then clear it as a false alarm, keep watching, or ban the player below.</p>
      ${g.flags.map(flagCard).join('')}</div><div id="flagplayer"></div></div>`;
    $$('[data-freplay]', box).forEach((b) => { b.onclick = () => replayDialog(b.dataset.freplay); });
    $$('[data-fv]', box).forEach((b) => {
      b.onclick = async () => {
        try {
          await api('flags/review', { body: { ids: [b.dataset.fid], verdict: b.dataset.fv } });
          toast(b.dataset.fv === 'cleared' ? 'Cleared as a false alarm (its report is dismissed).' : b.dataset.fv === 'watch' ? `Watching ${g.name}.` : 'Reopened.');
          summary(); await flagList(true); flagDetail(name);
        } catch (e) { fail(e); }
      };
    });
    detail(g.name, $('#flagplayer', box));
  }

  // ---------- Release 1.0: lobby chat ----------
  function viewChat() {
    $('#view').innerHTML = `<div class="split">
      <section class="pane"><header><span class="k">All chat · newest first</span><span class="sp"></span><button class="btn sm" id="chatref">Refresh</button></header><div class="list chatlist" id="chatbox"></div></section>
      <section class="pane"><header><span class="k">Muted in chat</span></header><div id="chatmuted" class="pad14"></div>
        <p class="fhelp pad14">A player muted in chat can still play and use party voice, but can't send chat messages until the mute ends. Party chat isn't kept on the server; players can block or mute each other in the game.</p></section></div>`;
    $('#chatref').onclick = () => chatList();
    chatList();
  }
  async function chatList(quiet = false) {
    const box = $('#chatbox'), mb = $('#chatmuted');
    if (!box) return;
    try {
      const r = await api('chat');
      box.innerHTML = r.messages.length ? r.messages.map((m) => `<div class="chatmsg"><span class="mono when">${esc(new Date(m.at).toLocaleTimeString())}</span><b>${esc(m.from)}</b><span class="tx">${esc(m.text)}</span><span class="acts"><button class="btn sm" data-cmute="${esc(m.from)}" data-h="1">Mute 1 h</button><button class="btn sm" data-cmute="${esc(m.from)}" data-h="24">24 h</button><button class="btn sm" data-cplayer="${esc(m.from)}">Player</button></span></div>`).join('') : '<div class="empty"><b>No chat yet</b>Messages players send in All chat appear here.</div>';
      mb.innerHTML = r.muted.length ? r.muted.map((m) => `<div class="chatmsg"><b>${esc(m.name)}</b><span class="tx">until ${esc(fmt(m.until))}</span><span class="acts"><button class="btn sm" data-cunmute="${esc(m.name)}">Unmute</button></span></div>`).join('') : '<div class="muted">Nobody is muted.</div>';
      $$('[data-cmute]').forEach((b) => { b.onclick = async () => { try { await api('chat/mute', { body: { name: b.dataset.cmute, hours: +b.dataset.h } }); toast(`${b.dataset.cmute} is muted in chat for ${b.dataset.h === '1' ? '1 hour' : '24 hours'}.`); chatList(true); } catch (e) { fail(e); } }; });
      $$('[data-cunmute]').forEach((b) => { b.onclick = async () => { try { await api('chat/mute', { body: { name: b.dataset.cunmute, hours: 0 } }); toast(`${b.dataset.cunmute} can chat again.`); chatList(true); } catch (e) { fail(e); } }; });
      $$('[data-cplayer]').forEach((b) => { b.onclick = () => { ui.q = b.dataset.cplayer; ui.selected = b.dataset.cplayer; show('players'); }; });
    } catch (e) { if (!quiet) fail(e); }
  }

  // ---------- Release 1.0: replay of a reported player ----------
  // The server records every match (where each player is and looks, five times a second, and every shot, hit and
  // kill) and keeps the last minutes with each report. Shown from above: the walls, every player (the reported one
  // in yellow, with their view cone), shots as lines, hits and kills. Red lines are hits the server found had no
  // line of sight.
  async function replayDialog(id) {
    let data;
    try { data = await api('replay', { query: { id } }); } catch (e) { return fail(e); }
    const R = data.replay, rep = data.report, names = R.players || {}, tid = R.target;
    const m = document.createElement('div');
    m.className = 'modal replay';
    m.innerHTML = `<div class="card wide" role="dialog" aria-modal="true" aria-labelledby="rp-h">
      <div class="rp-top"><div><h3 id="rp-h">Replay · ${esc(rep.target)}</h3><p class="sub">${esc(MODES[R.mode] || R.mode || 'Match')} · ${esc(MAPS[R.map] || R.map || 'unknown map')} · the last ${(() => { const ms = (R.frames.at(-1)?.[0] || 0) - (R.frames[0]?.[0] || 0); return ms < 90e3 ? `${Math.max(1, Math.round(ms / 1000))} seconds` : `${Math.round(ms / 6e4 * 10) / 10} minutes`; })()} before the report · ${esc(rep.reasonText)}${rep.note ? ` · “${esc(rep.note)}”` : ''}</p></div><button class="btn" data-close>Close</button></div>
      <div class="rp-body"><canvas width="900" height="620"></canvas><aside class="rp-side"><span class="k">Players</span><div class="rp-list"></div><span class="k rp-fk" hidden>Flagged moments</span><div class="rp-flags" hidden></div><span class="k">What happens</span><div class="rp-log"></div></aside></div>
      <div class="rp-bar"><button class="btn sm" data-play>Pause</button><button class="btn sm" data-speed>1×</button><button class="btn sm" data-follow>Following ${esc(rep.target)}</button><button class="btn sm" data-nextflag hidden>Next flag ›</button><div class="rp-track"><input type="range" min="0" max="1000" value="0" aria-label="Time"><div class="rp-marks" aria-hidden="true"></div></div><span class="rp-t mono">0:00</span></div>
      <p class="rp-key"><i class="y"></i>${esc(rep.target)} <i class="b"></i>their team <i class="r"></i>the other team <i class="s"></i>shot <i class="h"></i>hit <i class="w"></i>hit with no line of sight <i class="kk"></i>kill <i class="fl"></i>flagged moment</p></div>`;
    document.body.appendChild(m);
    const cv = $('canvas', m), g = cv.getContext('2d'), range = $('input[type=range]', m), tEl = $('.rp-t', m), list = $('.rp-list', m), logEl = $('.rp-log', m);
    const frames = R.frames || [], ev = R.ev || [], t0 = frames[0]?.[0] ?? 0, t1 = Math.max(t0 + 1, frames.at(-1)?.[0] ?? 0);
    const byId = {};
    for (const f of frames) (byId[f[1]] ||= []).push(f);
    const tTeam = names[tid]?.team;
    // Release 1.0: the anti-cheat's flagged moments (['F', player, category, detail, target])
    const FL = ev.filter((e) => e[1] === 'F');
    // the walls, drawn once
    let wall = null, W = 160, Hh = 160, minX = 0, minZ = 0, res = 1;
    if (R.plan) {
      const P = R.plan, raw = atob(P.cells);
      W = P.w * P.res, Hh = P.h * P.res, minX = P.min[0], minZ = P.min[2], res = P.res;
      wall = document.createElement('canvas'), wall.width = P.w, wall.height = P.h;
      const wg = wall.getContext('2d'), img = wg.createImageData(P.w, P.h);
      for (let i = 0; i < raw.length; i++) { const c = raw.charCodeAt(i); if (!c) continue; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 90 + c * 45; img.data[i * 4 + 3] = 255; }
      wg.putImageData(img, 0, 0);
    } else {
      let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
      for (const f of frames) x0 = Math.min(x0, f[2]), x1 = Math.max(x1, f[2]), z0 = Math.min(z0, f[4]), z1 = Math.max(z1, f[4]);
      minX = x0 - 10, minZ = z0 - 10, W = Math.max(40, x1 - x0 + 20), Hh = Math.max(40, z1 - z0 + 20);
    }
    let t = t0, play = true, speed = 1, follow = !!tid, zoom = 1, last = performance.now(), raf = 0, logI = 0;
    const pose = (id, at) => {
      const L = byId[id];
      if (!L) return null;
      let lo = 0, hi = L.length - 1;
      if (at < L[0][0] || at > L[hi][0] + 1500) return null;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; L[mid][0] <= at ? lo = mid : hi = mid - 1; }
      const a = L[lo], b = L[Math.min(L.length - 1, lo + 1)], k = b[0] > a[0] ? Math.min(1, Math.max(0, (at - a[0]) / (b[0] - a[0]))) : 0;
      return { x: a[2] + (b[2] - a[2]) * k, z: a[4] + (b[4] - a[4]) * k, yaw: a[5], alive: a[8] === 1, st: a[7] };
    };
    const fmtT = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    const nm = (id) => names[id]?.name || 'Player';
    const draw = () => {
      const cw = cv.width, ch = cv.height, me = tid ? pose(tid, t) : null;
      let sc = Math.min(cw / W, ch / Hh) * zoom, cx = minX + W / 2, cz = minZ + Hh / 2;
      if (follow && me && zoom > 1) cx = me.x, cz = me.z;
      const X = (x) => cw / 2 + (x - cx) * sc, Z = (z) => ch / 2 + (z - cz) * sc;
      g.fillStyle = '#0b0f12', g.fillRect(0, 0, cw, ch);
      if (wall) { g.imageSmoothingEnabled = false; g.drawImage(wall, X(minX), Z(minZ), wall.width * res * sc, wall.height * res * sc); }
      // shots and hits in the last 0.6 s
      for (const e of ev) {
        if (e[0] > t || e[0] < t - 600) continue;
        const age = (t - e[0]) / 600;
        if (e[1] === 'f') {
          const p = pose(e[2], e[0]);
          if (!p) continue;
          g.strokeStyle = `rgba(255,236,160,${0.75 * (1 - age)})`, g.lineWidth = e[2] === tid ? 2 : 1, g.beginPath(), g.moveTo(X(p.x), Z(p.z)), g.lineTo(X(p.x - Math.sin(p.yaw) * 60), Z(p.z - Math.cos(p.yaw) * 60)), g.stroke();
        } else if (e[1] === 'd' || e[1] === 'k') {
          const a = pose(e[2], e[0]), b = pose(e[3], e[0]);
          if (!a || !b) continue;
          const bad = e[1] === 'd' && e[6] === 1;
          g.strokeStyle = bad ? `rgba(255,70,60,${1 - age})` : `rgba(255,255,255,${0.9 * (1 - age)})`, g.lineWidth = bad ? 3 : 2, g.beginPath(), g.moveTo(X(a.x), Z(a.z)), g.lineTo(X(b.x), Z(b.z)), g.stroke();
          if (e[1] === 'k') g.strokeStyle = `rgba(255,70,60,${1 - age})`, g.lineWidth = 3, g.beginPath(), g.moveTo(X(b.x) - 7, Z(b.z) - 7), g.lineTo(X(b.x) + 7, Z(b.z) + 7), g.moveTo(X(b.x) + 7, Z(b.z) - 7), g.lineTo(X(b.x) - 7, Z(b.z) + 7), g.stroke();
        }
      }
      // flagged moments: a red ring round the player for a second and a half, with what was flagged
      for (const e of FL) {
        if (e[0] > t || e[0] < t - 1500) continue;
        const p = pose(e[2], e[0]);
        if (!p) continue;
        const age = (t - e[0]) / 1500;
        g.strokeStyle = `rgba(255,70,60,${1 - age})`, g.lineWidth = 3, g.beginPath(), g.arc(X(p.x), Z(p.z), 12 + age * 18, 0, 7), g.stroke();
        g.fillStyle = `rgba(255,120,110,${1 - age})`, g.font = '700 12px system-ui', g.fillText(FLAGS[e[3]] || e[3], X(p.x) + 14, Z(p.z) + 18);
        const tp = e[5] ? pose(e[5], e[0]) : null;
        tp && (g.setLineDash([5, 4]), g.beginPath(), g.moveTo(X(p.x), Z(p.z)), g.lineTo(X(tp.x), Z(tp.z)), g.stroke(), g.setLineDash([]));
      }
      for (const id of Object.keys(byId)) {
        const p = pose(id, t);
        if (!p) continue;
        const isT = id === tid, col = isT ? '#f2c14e' : names[id]?.team === tTeam && R.mode !== 'kc' && R.mode !== 'gg' ? '#5fa8ff' : '#ff6b5e';
        if (isT && p.alive) {
          g.fillStyle = 'rgba(242,193,78,.16)', g.beginPath(), g.moveTo(X(p.x), Z(p.z));
          for (let i = -1; i <= 1; i += 0.1) g.lineTo(X(p.x - Math.sin(p.yaw + i * 0.55) * 30), Z(p.z - Math.cos(p.yaw + i * 0.55) * 30));
          g.closePath(), g.fill();
        }
        g.globalAlpha = p.alive ? 1 : 0.35, g.fillStyle = col, g.beginPath(), g.arc(X(p.x), Z(p.z), isT ? 7 : 5, 0, 7), g.fill();
        g.strokeStyle = col, g.lineWidth = 2, g.beginPath(), g.moveTo(X(p.x), Z(p.z)), g.lineTo(X(p.x - Math.sin(p.yaw) * 2.6), Z(p.z - Math.cos(p.yaw) * 2.6)), g.stroke();
        g.fillStyle = '#e9ece6', g.font = `${isT ? 700 : 500} 11px system-ui`, g.fillText(nm(id), X(p.x) + 9, Z(p.z) - 8), g.globalAlpha = 1;
      }
      tEl.textContent = `${fmtT(t - t0)} / ${fmtT(t1 - t0)}`, range.value = String(Math.round((t - t0) / (t1 - t0) * 1000));
    };
    const evText = (e) => e[1] === 'F' ? `<b class="bad">Flag · ${esc(FLAGS[e[3]] || e[3])}</b> ${esc(nm(e[2]))}${e[4] ? ` · ${esc(e[4])}` : ''}` : e[1] === 'k' ? `${nm(e[2])} killed ${nm(e[3])}` : e[1] === 'd' ? `${nm(e[2])} hit ${nm(e[3])} · ${e[4]} damage · ${e[7]} m${e[6] === 1 ? ' · <b class="bad">no line of sight</b>' : ''}` : e[1] === 'x' ? `<b class="bad">Thrown out:</b> ${nm(e[2])} hit ${nm(e[3])} ${e[4] === 'range' ? `from ${e[5]} m (too far for the gun)` : `from ${e[5]} m away from where they were`}` : '';
    const logTo = () => {
      const items = ev.filter((e) => e[0] <= t && e[1] !== 'f' && (e[2] === tid || e[3] === tid || e[1] === 'F' && e[5] === tid)).slice(-60).reverse();
      logEl.innerHTML = items.length ? items.map((e) => `<div><span class="mono">${fmtT(e[0] - t0)}</span> ${evText(e)}</div>`).join('') : '<div class="muted">Nothing yet.</div>';
    };
    const ids = Object.keys(byId);
    list.innerHTML = ids.map((id) => { const kills = ev.filter((e) => e[1] === 'k' && e[2] === id).length, walls = ev.filter((e) => e[1] === 'd' && e[2] === id && e[6] === 1).length, hits = ev.filter((e) => e[1] === 'd' && e[2] === id).length; return `<div class="${id === tid ? 'on' : ''}"><b>${esc(nm(id))}</b><span>${kills} kills · ${hits} hits${walls ? ` · <b class="bad">${walls} without line of sight</b>` : ''}</span></div>`; }).join('');
    const tick = (now) => {
      const dt = Math.min(100, now - last); last = now;
      if (play) { t = Math.min(t1, t + dt * speed); t >= t1 && (play = false, $('[data-play]', m).textContent = 'Play'); }
      draw();
      if (now - logI > 250) logI = now, logTo();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const close = () => { cancelAnimationFrame(raf); m.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev2) => { if (ev2.key === 'Escape') close(); if (ev2.key === ' ') { ev2.preventDefault(); $('[data-play]', m).click(); } };
    document.addEventListener('keydown', onKey);
    $('[data-close]', m).onclick = close, m.onclick = (ev2) => { if (ev2.target === m) close(); };
    $('[data-play]', m).onclick = (ev2) => { if (t >= t1) t = t0; play = !play; ev2.currentTarget.textContent = play ? 'Pause' : 'Play'; };
    $('[data-speed]', m).onclick = (ev2) => { speed = speed === 1 ? 2 : speed === 2 ? 4 : speed === 4 ? 0.5 : 1; ev2.currentTarget.textContent = `${speed}×`; };
    $('[data-follow]', m).onclick = (ev2) => { follow = !follow; zoom = follow ? 2.4 : 1; ev2.currentTarget.textContent = follow ? `Following ${rep.target}` : 'Whole map'; };
    range.oninput = () => { t = t0 + (t1 - t0) * Number(range.value) / 1000; };
    cv.onwheel = (ev2) => { ev2.preventDefault(); zoom = Math.max(1, Math.min(6, zoom * (ev2.deltaY < 0 ? 1.15 : 1 / 1.15))); };
    if (follow) zoom = 2.4;
    // start a few seconds before the reported player's first hit or kill, when there is one
    const first = FL.find((e) => e[2] === tid) || ev.find((e) => (e[1] === 'd' || e[1] === 'k') && e[2] === tid);
    first && (t = Math.max(t0, first[0] - 4000));
    // the flagged moments: ticks on the timeline, a list to jump from, and Next flag
    if (FL.length) {
      const marks = $('.rp-marks', m), fl = $('.rp-flags', m);
      marks.innerHTML = FL.map((e, i) => `<i style="left:${((e[0] - t0) / (t1 - t0) * 100).toFixed(2)}%" title="${esc(FLAGS[e[3]] || e[3])} · ${fmtT(e[0] - t0)}" data-fi="${i}"></i>`).join('');
      fl.innerHTML = FL.map((e, i) => `<button class="rp-flag" data-fi="${i}"><span class="mono">${fmtT(e[0] - t0)}</span><b>${esc(FLAGS[e[3]] || e[3])}</b><small>${esc(nm(e[2]))}${e[4] ? ` · ${esc(e[4])}` : ''}</small></button>`).join('');
      fl.hidden = false, $('.rp-fk', m).hidden = false, $('[data-nextflag]', m).hidden = false;
      const jump = (i) => { const e = FL[i]; if (!e) return; t = Math.max(t0, e[0] - 2500); play = true; $('[data-play]', m).textContent = 'Pause'; $$('.rp-flag', m).forEach((b) => b.classList.toggle('on', +b.dataset.fi === i)); };
      $$('[data-fi]', m).forEach((b) => { b.onclick = () => jump(+b.dataset.fi); });
      $('[data-nextflag]', m).onclick = () => { const i = FL.findIndex((e) => e[0] - 2500 > t + 50); jump(i >= 0 ? i : 0); };
    }
  }

  // ---------- player detail (used by Reports and Players) ----------
  async function detail(name, box = $('#detail')) {
    if (!box) return;
    box.innerHTML = '<div class="empty">Loading…</div>';
    let d;
    try { d = await api('player', { query: { name } }); } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const p = d.player, open = d.reportsAgainst.filter((r) => r.status === 'open').length;
    box.innerHTML = `<div class="detail">
      <div class="head"><div><h2>${dot(p.status)}${esc(p.name)}${playerTags(p)}</h2>
        <div class="facts"><span>${esc(STATUS[p.status] || p.status)}</span>${p.uid ? `<span>User ID ${esc(p.uid)}</span>` : ''}<span>Level ${p.level} · ${Number(p.xp).toLocaleString()} XP</span><span>Joined ${esc(fmt(p.created))}</span><span>Last sign-in ${esc(ago(p.lastLogin))}</span><span>${plural(p.devices, 'device')}</span><span>${p.email ? `Email ${esc(p.email)}${p.emailVerified ? ' (confirmed)' : ' (not confirmed)'}` : 'No email yet'}</span></div></div>
        <div class="acts">${p.ban ? '<button class="btn" data-act="unban">Unban</button>' : p.role ? '' : '<button class="btn danger" data-act="ban">Ban</button>'}
          ${p.inMatch ? '<button class="btn pri" data-act="spectate" title="Watch their match from inside your game">Spectate</button>' : ''}
          ${p.status !== 'offline' ? '<button class="btn" data-act="kick">Disconnect</button>' : ''}
          ${open ? `<button class="btn" data-act="dismiss-all">Dismiss ${plural(open, 'open report')}</button>` : ''}</div></div>
      ${p.ban ? `<div class="banbox"><b>Banned</b> by ${esc(p.ban.by)} · ${esc(ago(p.ban.at))} · ${esc(banEnds(p.ban))}${p.ban.devices ? ' · devices blocked' : ''}<div class="mt4">Reason: ${esc(p.ban.reason)}</div></div>` : ''}
      ${ui.role === 'owner' ? `<div class="section"><span class="k">Progress (owner only)</span><div class="pane progress">
        <p>Level ${p.level} · ${Number(p.xp).toLocaleString()} XP. Changes apply to their account straight away, and to their game if they are playing.</p>
        <form data-prog="level" class="inline"><label>Set level <input class="input" name="level" type="number" min="1" max="500" value="${p.level}"></label><button class="btn" type="submit">Set level</button></form>
        <form data-prog="copy" class="inline"><label>Copy progress from <input class="input" name="from" placeholder="another username" autocomplete="off" spellcheck="false"></label><button class="btn" type="submit">Copy</button></form>
        <small>Copying brings over XP, level, loadouts, camos, perks and weapon stats, replacing theirs. Useful when an account's progress was saved under another account.</small></div></div>` : ''}
      <div class="section"><span class="k">Reports against ${esc(p.name)} (${d.reportsAgainst.length})</span>${d.reportsAgainst.length ? d.reportsAgainst.map((r) => reportCard(r)).join('') : '<div class="empty pad14">No reports against this player.</div>'}</div>
      ${d.reportsBy.length ? `<div class="section"><span class="k">Reports made by ${esc(p.name)} (${d.reportsBy.length})</span>${d.reportsBy.map((r) => reportCard(r, false)).join('')}</div>` : ''}
      ${d.history.length ? `<div class="section"><span class="k">Moderation history</span><div class="pane log">${d.history.map(logItem).join('')}</div></div>` : ''}
    </div>`;
    const again = () => { detail(name, box); summary(); if (ui.tab === 'reports') groupsList(true); if (ui.tab === 'players') playersList(true); };
    $$('form[data-prog]', box).forEach((f) => {
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const copy = f.dataset.prog === 'copy', from = copy ? f.from.value.trim() : '', level = copy ? null : Number(f.level.value);
        if (copy ? !from : !(level >= 1 && level <= 500)) return toast(copy ? 'Enter the username to copy from.' : 'Pick a level from 1 to 500.', true);
        if (!confirm(copy ? `Replace ${p.name}'s progress with ${from}'s? This overwrites their XP, loadouts, camos and perks.` : `Set ${p.name} to level ${level}?`)) return;
        try {
          const r = await api('progress', { body: copy ? { name: p.name, copyFrom: from } : { name: p.name, level } });
          toast(`${p.name} is now level ${r.player.level}.`); again();
        } catch (e) { fail(e); }
      };
    });
    $$('[data-act]', box).forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'ban') return banDialog(p.name, d.reportsAgainst, again);
        try {
          if (act === 'unban') { if (!confirm(`Unban ${p.name}? They can sign in and play again right away.`)) return; await api('unban', { body: { name: p.name } }); toast(`${p.name} is unbanned.`); }
          if (act === 'kick') { const r = await api('kick', { body: { name: p.name } }); toast(r.kicked ? `Disconnected ${p.name}.` : `${p.name} is not connected.`); }
          if (act === 'spectate') { const r = await api('spectate', { body: { name: p.name } }); toast(`Sent to your game: accept "Spectate ${p.name}" there to watch their match (${plural(r.players, 'player')}).`); return; }
          if (act === 'dismiss-all') { const r = await api('reports/dismiss', { body: { target: p.name } }); toast(`Dismissed ${plural(r.changed, 'report')}.`); }
          again();
        } catch (e) { fail(e); }
      };
    });
    $$('[data-replay]', box).forEach((b) => { b.onclick = () => replayDialog(b.dataset.replay); });
    $$('[data-dismiss],[data-reopen]', box).forEach((b) => {
      b.onclick = async () => {
        try { await api(b.dataset.dismiss ? 'reports/dismiss' : 'reports/reopen', { body: { ids: [b.dataset.dismiss || b.dataset.reopen] } }); again(); } catch (e) { fail(e); }
      };
    });
  }

  // ---------- ban dialog ----------
  function banDialog(name, reports, done) {
    const top = Object.entries(reports.filter((r) => r.status === 'open').reduce((a, r) => ((a[r.reason] = (a[r.reason] || 0) + 1), a), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
    const reason = top === 'cheating' ? 'Cheating' : top === 'name' ? 'Offensive username' : top === 'abuse' ? 'Abusive behaviour' : top === 'exploit' ? 'Exploiting bugs' : '';
    let hours = top === 'cheating' ? null : 168;
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = `<form class="card" role="dialog" aria-modal="true" aria-labelledby="ban-h" novalidate>
      <h3 id="ban-h">Ban ${esc(name)}</h3>
      <p class="sub">They are disconnected right away. Every version of the game refuses to let them sign in, and the game shows them this reason with only a Close game button.</p>
      <label class="f"><span class="k">Reason (the player sees this)</span><textarea class="input" name="reason" maxlength="200">${esc(reason)}</textarea></label>
      <span class="k">Length</span>
      <div class="chips mt8">${LENGTHS.map(([t, h]) => `<button type="button" class="chip${h === hours ? ' on' : ''}" data-h="${h ?? ''}">${t}</button>`).join('')}</div>
      <label class="check"><input type="checkbox" name="devices" checked><span>Also block the devices they played on, so they can't sign in again or make a new account on them.</span></label>
      <div class="err" role="alert"></div>
      <div class="acts"><button type="button" class="btn" data-cancel>Cancel</button><button type="submit" class="btn danger">Ban ${esc(name)}</button></div></form>`;
    document.body.appendChild(m);
    const f = $('form', m), err = $('.err', f), close = () => { m.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    $$('.chip', f).forEach((c) => { c.onclick = () => { hours = c.dataset.h === '' ? null : Number(c.dataset.h); $$('.chip', f).forEach((x) => x.classList.toggle('on', x === c)); }; });
    $('[data-cancel]', f).onclick = close;
    m.onclick = (ev) => { if (ev.target === m) close(); };
    $('textarea', f).focus();
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const r = f.reason.value.trim();
      if (r.length < 3) { err.textContent = 'Give a reason. The player sees it.'; return; }
      const b = $('button[type=submit]', f); b.disabled = true;
      try {
        const res = await api('ban', { body: { name, reason: r, hours, devices: f.devices.checked } });
        close();
        toast(`${name} is banned${hours ? ` for ${LENGTHS.find((x) => x[1] === hours)?.[0] || `${hours} h`}` : ' permanently'}.${res.kicked ? ` Disconnected ${plural(res.kicked, 'session')}.` : ''}`);
        done();
      } catch (e2) { err.textContent = e2.message; b.disabled = false; }
    };
  }

  // ---------- players ----------
  function viewPlayers() {
    $('#view').innerHTML = `<div class="split">
      <section class="pane"><header class="wrap"><input id="pq" placeholder="Search by username or user ID" value="${esc(ui.q)}" autocomplete="off" spellcheck="false" class="input grow">
        <div class="seg" role="group" aria-label="Filter">${[['', 'All'], ['online', 'Online'], ['reported', 'Reported'], ['banned', 'Banned']].map(([k, t]) => `<button data-f="${k}" class="${ui.filter === k ? 'on' : ''}">${t}</button>`).join('')}</div></header>
        <div class="list" id="players"></div></section>
      <section class="pane" id="detail"><div class="empty"><b>Select a player</b>Search above, then pick a player to see their reports and ban or unban them.</div></section></div>`;
    let t = 0;
    $('#pq').oninput = (ev) => { ui.q = ev.target.value; clearTimeout(t); t = setTimeout(() => playersList(), 220); };
    $$('[data-f]').forEach((b) => { b.onclick = () => { ui.filter = b.dataset.f; $$('[data-f]').forEach((x) => x.classList.toggle('on', x === b)); playersList(); }; });
    playersList();
  }
  async function playersList(quiet = false) {
    const box = $('#players');
    if (!box) return;
    try {
      const r = await api('players', { query: { q: ui.q, filter: ui.filter } });
      if (!r.players.length) { box.innerHTML = '<div class="empty"><b>No players found</b></div>'; return; }
      box.innerHTML = r.players.map((p) => `<button class="row" data-name="${esc(p.name)}">
        <span class="count${p.reportsOpen ? '' : ' zero'}" title="Open reports">${p.reportsOpen}</span>
        <span class="main"><span class="nm">${dot(p.status)}${esc(p.name)}${playerTags(p)}</span>
        <span class="sub">${esc(STATUS[p.status] || p.status)} · Level ${p.level} · last sign-in ${esc(ago(p.lastLogin))}</span></span></button>`).join('')
        + (r.total > r.players.length ? `<div class="empty">Showing ${r.players.length} of ${r.total}. Search to narrow it down.</div>` : '');
      $$('.row', box).forEach((b) => { b.onclick = () => { $$('.row', box).forEach((x) => x.classList.toggle('on', x === b)); detail(b.dataset.name); }; });
    } catch (e) { if (!quiet) fail(e); }
  }

  // ---------- bug reports ----------
  async function viewBugs() {
    const v = $('#view');
    ui.bugSt ||= 'open';
    v.innerHTML = `<div class="pane"><header><span class="k">Bug reports from the game's pause menu</span><span class="sp"></span>
      <div class="seg" role="group" aria-label="Bug status">${[['open', 'Open'], ['closed', 'Fixed / closed'], ['all', 'All']].map(([k, t]) => `<button data-bst="${k}" class="${ui.bugSt === k ? 'on' : ''}">${t}</button>`).join('')}</div></header><div id="bugs"><div class="empty">Loading…</div></div></div>`;
    $$('[data-bst]', v).forEach((b) => { b.onclick = () => { ui.bugSt = b.dataset.bst; viewBugs(); }; });
    try {
      const { bugs } = await api('bugs', { query: { status: ui.bugSt } });
      const box = $('#bugs');
      if (!bugs.length) { box.innerHTML = `<div class="empty"><b>${ui.bugSt === 'open' ? 'No open bug reports' : 'Nothing here'}</b>Players send these from Report → Report a bug in the pause menu.</div>`; return; }
      box.innerHTML = bugs.map((b) => {
        const m = b.meta || {};
        const where = [m.version, m.build ? `build ${m.build}` : null, m.mode, MAPS[m.map] || m.map, m.screen ? `on ${m.screen}` : null, m.fps ? `${m.fps} fps` : null, m.platform].filter(Boolean).map(esc).join(' · ');
        return `<article class="report${b.status !== 'open' ? ' handled' : ''}">
          <div class="top-line"><span class="tag">${esc(BUGCAT[b.category] || b.category)}</span><span>from <b>${esc(b.from)}</b></span>${b.status !== 'open' ? `<span class="tag">Closed${b.handledBy ? ` by ${esc(b.handledBy)}` : ''}</span>` : ''}<span class="when" title="${esc(fmt(b.at))}">${ago(b.at)}</span></div>
          <p class="note">${esc(b.text)}</p>
          <div class="meta"><span>${where || 'no details'}</span>
            ${b.status === 'open' ? `<button class="btn sm" data-bug="close" data-id="${esc(b.id)}">Mark fixed</button>` : `<button class="btn sm" data-bug="reopen" data-id="${esc(b.id)}">Reopen</button>`}
            <button class="btn sm ghost-danger" data-bug="delete" data-id="${esc(b.id)}">Delete</button></div></article>`;
      }).join('');
      $$('[data-bug]', box).forEach((b) => {
        b.onclick = async () => {
          if (b.dataset.bug === 'delete' && !confirm('Delete this bug report?')) return;
          try { await api(`bugs/${b.dataset.bug}`, { body: { ids: [b.dataset.id] } }); summary(); viewBugs(); } catch (e) { fail(e); }
        };
      });
    } catch (e) { fail(e); }
  }

  // ---------- news (shown in the game after sign-in) ----------
  async function viewNews() {
    const v = $('#view');
    try {
      const { news } = await api('news');
      v.innerHTML = `<div class="pane narrow"><header><span class="k">Post news</span></header>
        <form id="newsf" class="newsform"><input class="input" name="title" maxlength="80" placeholder="Title, e.g. Double XP this weekend" autocomplete="off">
        <textarea class="input" name="body" maxlength="2000" placeholder="What players see under the title in the game's News screen"></textarea>
        <button class="btn pri" type="submit">Post to the game</button></form>
        <header><span class="k">Posted (${news.length}) · newest first · players see the latest 20</span></header>
        ${news.length ? news.map((n) => `<article class="report"><div class="top-line"><b>${esc(n.title)}</b><span class="when" title="${esc(fmt(n.at))}">${ago(n.at)} · ${esc(n.by)}</span></div><p class="note">${esc(n.body)}</p><div class="meta"><span></span><button class="btn sm ghost-danger" data-del="${esc(n.id)}">Delete</button></div></article>`).join('') : '<div class="empty">No news yet. Posts appear in the News screen players see after signing in.</div>'}</div>`;
      $('#newsf').onsubmit = async (ev) => {
        ev.preventDefault();
        const f = ev.target;
        try { await api('news/add', { body: { title: f.title.value, body: f.body.value } }); toast('Posted. Players see it next time they sign in.'); viewNews(); } catch (e) { fail(e); }
      };
      $$('[data-del]', v).forEach((b) => { b.onclick = async () => { if (!confirm('Delete this post?')) return; try { await api('news/delete', { body: { id: b.dataset.del } }); viewNews(); } catch (e) { fail(e); } }; });
    } catch (e) { fail(e); }
  }

  // ---------- server: lobby announcement, maintenance, Steam, developers, game version ----------
  async function viewServer() {
    const v = $('#view'), owner = ui.role === 'owner';
    let o;
    try { o = await api('ops'); } catch (e) { fail(e); return; }
    const a = o.announcement, m = o.maintenance, live = o.live || {};
    const when = (t) => (t ? `${fmt(t)} (${t > Date.now() ? `in ${Math.max(1, Math.round((t - Date.now()) / 60e3))} min` : 'passed'})` : '');
    const people = (list, kind) => (list.length ? list.map((x) => `<div class="row static"><span class="main"><span class="nm">${esc(x.name)}</span></span>${owner ? `<button class="btn sm ghost-danger" data-rm-${kind}="${esc(x.name)}">Remove</button>` : ''}</div>`).join('') : '<div class="empty">Nobody yet.</div>');
    v.innerHTML = `<div class="ops">
      <section class="pane"><header><span class="k">Lobby announcement</span><span class="sp"></span>${a ? '<span class="tag hot">Showing in the game</span>' : '<span class="tag">None</span>'}</header>
        ${a ? `<article class="report"><div class="top-line"><span class="tag ${a.kind === 'downtime' ? 'cheating' : ''}">${a.kind === 'downtime' ? 'Downtime warning' : 'Announcement'}</span><b>${esc(a.title)}</b><span class="when">${ago(a.at)}</span></div>${a.text ? `<p class="note">${esc(a.text)}</p>` : ''}<div class="meta"><span>${a.startsAt ? `Downtime starts ${esc(when(a.startsAt))}` : ''}${a.until ? ` · Hidden after ${esc(fmt(a.until))}` : ' · Shows until you clear it'}</span><button class="btn sm" id="anclear">Clear</button></div></article>` : ''}
        <form id="anf" class="newsform">
          <div class="seg" role="group" aria-label="Kind"><button type="button" data-kind="info" class="on">Announcement</button><button type="button" data-kind="downtime">Downtime warning</button></div>
          <input class="input" name="title" maxlength="60" placeholder="Title (optional), e.g. Downtime begins soon" autocomplete="off">
          <textarea class="input" name="text" maxlength="240" placeholder="What players see at the bottom of the lobby, e.g. Servers go down for the Beta 1.4 update."></textarea>
          <div class="inline"><label data-dt hidden>Downtime starts in <input class="input" name="startsIn" type="number" min="0" max="10080" value="15"> min</label><label>Hide after <input class="input" name="minutes" type="number" min="0" max="10080" value="0"> min (0 = until cleared)</label></div>
          <button class="btn pri" type="submit">Show in the lobby</button></form>
        <p class="hint">Everyone signed in sees it at the bottom of the lobby straight away; players who sign in later see it too.</p></section>
      <section class="pane"><header><span class="k">Maintenance</span><span class="sp"></span>${m.on ? '<span class="tag banned">On</span>' : '<span class="tag">Off</span>'}</header>
        ${m.on ? `<p>Started ${esc(ago(m.since))}${m.by ? ` by ${esc(m.by)}` : ''}. Players see "Login failed" with your message and a Retry button. The owner, moderators and developers can still sign in.</p>` : '<p>While maintenance is on, everyone except the owner, moderators and developers is signed out, and the game shows "Login failed · Vangaurd is undergoing maintenance" with a Retry button.</p>'}
        <form id="mtf" class="newsform"><textarea class="input" name="message" maxlength="240" placeholder="Vangaurd is undergoing maintenance. Please try again later.">${esc(m.message || '')}</textarea>
          ${owner ? `<button class="btn ${m.on ? 'pri' : 'danger'}" type="submit">${m.on ? 'End maintenance' : 'Start maintenance'}</button>` : '<p class="hint">Only the owner can start or end maintenance.</p>'}</form></section>
      <section class="pane"><header><span class="k">Steam</span><span class="sp"></span>${o.steam.required ? '<span class="tag hot">Steam required</span>' : '<span class="tag">Not required</span>'}</header>
        <p>${o.steam.required ? 'Players have to start Vangaurd from Steam to sign in or play online.' : 'Anyone can sign in, with or without Steam.'} ${o.steam.verify ? 'Steam tickets are checked with Steam.' : 'The game reports whether Steam is running (set STEAM_WEB_API_KEY and STEAM_APP_ID on the server to check tickets with Steam too).'} You (the owner) can always play without Steam.</p>
        ${owner ? `<button class="btn ${o.steam.required ? '' : 'pri'}" id="steamreq">${o.steam.required ? 'Stop requiring Steam' : 'Require Steam'}</button>` : ''}
        <header><span class="k">Allowed to play without Steam (${o.steam.allow.length})</span></header>${people(o.steam.allow, 'steam')}
        ${owner ? '<form id="steamf" class="addform"><input class="input" name="name" placeholder="Username" autocomplete="off" spellcheck="false"><button class="btn pri" type="submit">Allow</button></form>' : ''}</section>
      <section class="pane"><header><span class="k">Developers</span></header>
        <p>Developers get the in-game replay recorder (F8 to record, F9 to watch) for trailers, and can sign in during maintenance. The owner is always a developer.</p>
        <div class="row static"><span class="main"><span class="nm">${esc(o.owner || '')}<span class="tag mod">owner</span></span></span></div>${people(o.devs, 'dev')}
        ${owner ? '<form id="devf" class="addform"><input class="input" name="name" placeholder="Username" autocomplete="off" spellcheck="false"><button class="btn pri" type="submit">Add developer</button></form>' : ''}</section>
      ${o.weekly ? `<section class="pane"><header><span class="k">Weekly mode</span><span class="sp"></span><span class="tag hot">${esc(o.weekly.name)}</span></header>
        <p>Online play always has Team Deathmatch plus this week's mode. It changes every Monday at 00:00 UTC (next change ${esc(fmt(o.weekly.endsAt))}) and goes round ${esc(o.weekly.pool.map((m) => m.name).join(', then '))}. ${o.weekly.pinned ? '<b>Pinned by you</b>: it stays until you set it back to automatic.' : 'It is on automatic.'}</p>
        ${owner ? `<div class="seg" role="group" aria-label="Weekly mode"><button type="button" data-weekly="" class="${o.weekly.pinned ? '' : 'on'}">Automatic</button>${o.weekly.pool.map((m) => `<button type="button" data-weekly="${esc(m.id)}" class="${o.weekly.pinned && o.weekly.mode === m.id ? 'on' : ''}">${esc(m.name)}</button>`).join('')}</div>` : ''}</section>` : ''}
      ${(() => {
        const vs = o.versions || [], open = vs.filter((v) => !v.released), early = o.early || [];
        const opt = (v) => `<option value="${esc(v.build)}" data-url="${esc(v.url || '')}"${v.released ? ' disabled' : ''}>${esc(v.label)} · build ${esc(v.build)}${v.released ? ' · released' : v.prerelease ? ' · pre-release' : ''}${v.seen && !v.tag ? ' · seen in a game' : ''}</option>`;
        return `<section class="pane"><header><span class="k">Early access</span><span class="sp"></span><span class="tag">${early.length} player${early.length === 1 ? '' : 's'}</span></header>
        <p>Let players play an update before it is released. They can sign in and play online with that version (and anything older); everyone else still sees "Version unavailable". Early access ends by itself when the version is released.</p>
        ${owner ? (open.length ? `<form id="earlyf" class="addform"><select class="input" name="build" aria-label="Version">${vs.map(opt).join('')}</select><input class="input" name="name" placeholder="Username" autocomplete="off" spellcheck="false"><button class="btn pri" type="submit">Give early access</button></form><p class="hint early-dl"></p>` : '<p class="hint">No unreleased versions right now. A version shows up here once it is published as a pre-release on GitHub, or as soon as a game on a newer build connects.</p>') : '<p class="hint">Only the owner can give early access.</p>'}
        ${early.length ? early.map((e) => `<div class="row static"><span class="main"><span class="nm">${esc(e.name)}</span><span class="sub">${esc(e.label)} · build ${esc(e.build)} · ${esc(ago(e.at))}${e.by ? ` by ${esc(e.by)}` : ''}</span></span>${owner ? `<button class="btn sm ghost-danger" data-rm-early="${esc(e.name)}">Take away</button>` : ''}</div>`).join('') : '<div class="empty">Nobody has early access.</div>'}</section>`;
      })()}
      ${(o.dlcs || []).map((x) => `<section class="pane dlc"><header><span class="k">DLC · ${esc(x.name)}</span><span class="sp"></span><span class="tag">${esc(x.price)} on Steam</span></header>
        <p>${esc(x.items)}. Players get it by buying it on Steam${x.steamAppId ? '' : ' (set its Steam App ID below first)'} or when you grant it here. You (the owner) always have it.</p>
        ${owner ? `<form class="inline dlcapp" data-dlc="${esc(x.id)}"><label>Steam App ID <input class="input" name="appId" type="number" min="0" value="${x.steamAppId || ''}" placeholder="from Steamworks"></label><button class="btn" type="submit">Save</button></form>` : ''}
        <header><span class="k">Granted to (${x.owners.length})</span></header>
        ${x.owners.length ? x.owners.map((p) => `<div class="row static"><span class="main"><span class="nm">${esc(p.name)}</span></span>${owner ? `<button class="btn sm ghost-danger" data-rm-dlc="${esc(x.id)}" data-name="${esc(p.name)}">Take back</button>` : ''}</div>`).join('') : '<p class="hint">Nobody yet.</p>'}
        ${owner ? `<form class="addform dlcgrant" data-dlc="${esc(x.id)}"><input class="input" name="name" placeholder="Username" autocomplete="off" spellcheck="false"><button class="btn pri" type="submit">Grant ${esc(x.name)}</button></form>` : '<p class="hint">Only the owner can grant DLC.</p>'}</section>`).join('')}
      <section class="pane"><header><span class="k">Game version</span></header>
        <p>Only <b>${esc(o.latest?.label || '')}</b> (build ${esc(o.latest?.build)}) and newer can play online. ${o.release ? `Last set ${esc(ago(o.release.at))} by ${esc(o.release.by)}.` : ''}</p>
        ${owner ? '<form id="relf" class="inline"><label>Build <input class="input" name="build" type="number" min="1" placeholder="26"></label><label>Name <input class="input" name="label" placeholder="Beta 1.3" maxlength="40"></label><button class="btn" type="submit">Set latest build</button></form><p class="hint">Set this when a new version is live on Steam, so older versions are asked to update.</p>' : ''}</section>
      <section class="pane"><header><span class="k">Matchmaking · ${esc(o.region || '')}</span></header>
        ${Object.entries(live).map(([k, x]) => `<div class="row static"><span class="main"><span class="nm">${esc(MODES[k] || k)}</span><span class="sub">${x.inMatch ? `${x.inMatch} / ${x.max} in the match` : 'No match running'}${x.waiting ? ` · ${x.waiting} waiting for a spot` : ''}</span></span></div>`).join('')}</section>
    </div>`;
    let kind = 'info';
    const af = $('#anf');
    $$('[data-kind]', af).forEach((b) => { b.onclick = () => { kind = b.dataset.kind; $$('[data-kind]', af).forEach((x) => x.classList.toggle('on', x === b)); $('[data-dt]', af).hidden = kind !== 'downtime'; }; });
    af.onsubmit = async (ev) => {
      ev.preventDefault();
      try { await api('ops/announce', { body: { kind, title: af.title.value, text: af.text.value, minutes: af.minutes.value, startsIn: kind === 'downtime' ? af.startsIn.value : '' } }); toast('Showing in the lobby.'); viewServer(); } catch (e) { fail(e); }
    };
    const ac = $('#anclear');
    if (ac) ac.onclick = async () => { try { await api('ops/announce/clear', { body: {} }); toast('Announcement cleared.'); viewServer(); } catch (e) { fail(e); } };
    const mf = $('#mtf');
    mf.onsubmit = async (ev) => {
      ev.preventDefault();
      if (!owner) return;
      const on = !m.on;
      if (on && !confirm('Start maintenance? Everyone except the owner, moderators and developers is signed out right away.')) return;
      try { const r = await api('ops/maintenance', { body: { on, message: mf.message.value } }); toast(on ? `Maintenance started. ${plural(r.kicked || 0, 'player')} signed out.` : 'Maintenance is over. Players can sign in again.'); viewServer(); } catch (e) { fail(e); }
    };
    const sr = $('#steamreq');
    if (sr) sr.onclick = async () => {
      if (!o.steam.required && !confirm('Require Steam? Players who start the game without Steam (and are not on the list) can no longer sign in.')) return;
      try { await api('ops/steam', { body: { required: !o.steam.required } }); viewServer(); } catch (e) { fail(e); }
    };
    const listForm = (id, action, okText) => {
      const f = $(id);
      if (f) f.onsubmit = async (ev) => { ev.preventDefault(); const name = f.name.value.trim(); if (!name) return; try { await api(action, { body: { name, add: true } }); toast(okText(name)); viewServer(); } catch (e) { fail(e); } };
    };
    listForm('#steamf', 'ops/steam/allow', (n) => `${n} can play without Steam.`);
    listForm('#devf', 'ops/devs', (n) => `${n} is now a developer.`);
    $$('[data-rm-steam]', v).forEach((b) => { b.onclick = async () => { try { await api('ops/steam/allow', { body: { name: b.dataset.rmSteam, add: false } }); viewServer(); } catch (e) { fail(e); } }; });
    $$('[data-rm-dev]', v).forEach((b) => { b.onclick = async () => { try { await api('ops/devs', { body: { name: b.dataset.rmDev, add: false } }); viewServer(); } catch (e) { fail(e); } }; });
    $$('form.dlcgrant', v).forEach((f) => { f.onsubmit = async (ev) => { ev.preventDefault(); const name = f.name.value.trim(); if (!name) return; try { await api('ops/dlc', { body: { name, dlc: f.dataset.dlc, add: true } }); toast(`${name} now has the ${(o.dlcs || []).find((x) => x.id === f.dataset.dlc)?.name || 'DLC'}.`); viewServer(); } catch (e) { fail(e); } }; });
    $$('[data-rm-dlc]', v).forEach((b) => { b.onclick = async () => { if (!confirm(`Take the DLC back from ${b.dataset.name}?`)) return; try { await api('ops/dlc', { body: { name: b.dataset.name, dlc: b.dataset.rmDlc, add: false } }); viewServer(); } catch (e) { fail(e); } }; });
    {
      const ef = $('#earlyf', v);
      if (ef) {
        const first = [...ef.build.options].find((x) => !x.disabled);
        first && (ef.build.value = first.value);
        const dl = () => { const u = ef.build.selectedOptions[0]?.dataset.url, p = $('.early-dl', v); if (p) p.innerHTML = u ? `Players download it from <a href="${esc(u)}" target="_blank" rel="noopener">its pre-release page</a>.` : 'This build is not on GitHub yet; send the player the game files yourself.'; };
        ef.build.onchange = dl, dl();
        ef.onsubmit = async (ev) => { ev.preventDefault(); const name = ef.name.value.trim(); if (!name) return; try { await api('ops/early', { body: { name, build: Number(ef.build.value), add: true } }); toast(`${name} has early access to ${ef.build.selectedOptions[0]?.textContent.split(' · ')[0] || 'that version'}.`); viewServer(); } catch (e) { fail(e); } };
      }
      $$('[data-rm-early]', v).forEach((b) => { b.onclick = async () => { try { await api('ops/early', { body: { name: b.dataset.rmEarly, add: false } }); toast(`${b.dataset.rmEarly} no longer has early access.`); viewServer(); } catch (e) { fail(e); } }; });
    }
    $$('[data-weekly]', v).forEach((b) => { b.onclick = async () => { try { await api('ops/weekly', { body: { mode: b.dataset.weekly || null } }); toast(b.dataset.weekly ? `${b.textContent} is pinned as this week's mode.` : 'The weekly mode is back on automatic.'); viewServer(); } catch (e) { fail(e); } }; });
    $$('form.dlcapp', v).forEach((f) => { f.onsubmit = async (ev) => { ev.preventDefault(); try { await api('ops/dlc/app', { body: { dlc: f.dataset.dlc, appId: f.appId.value } }); toast('Steam App ID saved. Games pick it up when they next connect.'); viewServer(); } catch (e) { fail(e); } }; });
    const rf = $('#relf');
    if (rf) rf.onsubmit = async (ev) => {
      ev.preventDefault();
      const build = Number(rf.build.value);
      if (!(build > 0)) return toast('Enter the build number.', true);
      if (!confirm(`Only build ${build} and newer may play online after this. Continue?`)) return;
      try { await api('ops/release', { body: { build, label: rf.label.value } }); toast('Latest build updated.'); viewServer(); } catch (e) { fail(e); }
    };
  }

  // ---------- bans ----------
  async function viewBans() {
    const v = $('#view');
    v.innerHTML = '<div class="pane"><div class="empty">Loading…</div></div>';
    try {
      const { bans } = await api('bans');
      if (!bans.length) { v.innerHTML = '<div class="pane"><div class="empty"><b>No active bans</b>Ban a player from their reports or the Players tab.</div></div>'; return; }
      v.innerHTML = `<div class="pane table-wrap"><table><thead><tr><th>Player</th><th>Reason</th><th>Banned by</th><th>When</th><th>Length</th><th>Devices</th><th></th></tr></thead><tbody>
        ${bans.map((b) => `<tr><td><b>${esc(b.account)}</b></td><td>${esc(b.reason)}</td><td>${esc(b.by)}</td><td title="${esc(fmt(b.at))}">${esc(ago(b.at))}</td><td>${esc(banEnds(b))}</td><td class="num">${b.devices ? b.devicesBlocked : '—'}</td><td><button class="btn sm" data-unban="${esc(b.account)}">Unban</button></td></tr>`).join('')}
      </tbody></table></div>`;
      $$('[data-unban]', v).forEach((b) => {
        b.onclick = async () => {
          if (!confirm(`Unban ${b.dataset.unban}? They can sign in and play again right away.`)) return;
          try { await api('unban', { body: { name: b.dataset.unban } }); toast(`${b.dataset.unban} is unbanned.`); summary(); viewBans(); } catch (e) { fail(e); }
        };
      });
    } catch (e) { fail(e); }
  }

  // ---------- activity ----------
  const ACT = { early_grant: 'gave early access', early_revoke: 'took away early access', weekly: 'changed the weekly mode', announce: 'posted a lobby announcement', announce_clear: 'cleared the lobby announcement', maintenance_on: 'started maintenance', maintenance_off: 'ended maintenance', steam_required: 'turned on "Steam required"', steam_optional: 'turned off "Steam required"', steam_allow_add: 'let this player play without Steam:', steam_allow_remove: 'removed from the no-Steam list:', dev_add: 'made a developer:', dev_remove: 'removed developer', dlc_grant: 'granted DLC to', dlc_revoke: 'took DLC back from', dlc_app: 'set a DLC Steam App ID', release: 'set the latest game build', spectate: 'spectated', news_add: 'posted news', news_delete: 'deleted a news post', bugs_close: 'closed', bugs_reopen: 'reopened', bugs_delete: 'deleted', progress: 'changed the progress of', ban: 'banned', unban: 'unbanned', kick: 'disconnected', dismiss: 'dismissed reports against', reopen: 'reopened reports against', mod_add: 'made a moderator:', mod_remove: 'removed moderator', setup: 'set up the console', ban_expired: 'ban ended for' };
  const logItem = (l) => `<div class="item"><time title="${esc(fmt(l.at))}">${esc(fmt(l.at))}</time><div><b>${esc(l.by)}</b> ${esc(ACT[l.action] || l.action)} ${l.action === 'setup' ? '' : `<b>${esc(l.target || '')}</b>`}${l.detail && l.action !== 'setup' ? ` <span class="muted">· ${esc(l.detail)}</span>` : ''}</div></div>`;
  async function viewActivity() {
    const v = $('#view');
    try {
      const { log } = await api('log');
      v.innerHTML = log.length ? `<div class="pane log">${log.map(logItem).join('')}</div>` : '<div class="pane"><div class="empty"><b>No moderation activity yet</b></div></div>';
    } catch (e) { fail(e); }
  }

  // ---------- moderators ----------
  async function viewMods() {
    const v = $('#view');
    try {
      const r = await api('mods');
      const owner = ui.role === 'owner';
      v.innerHTML = `<div class="pane narrow"><header><span class="k">Owner</span></header>
        <div class="row static"><span class="main"><span class="nm">${esc(r.owner)}<span class="tag mod">owner</span></span><span class="sub">Can ban players and manage moderators.</span></span></div>
        <header><span class="k">Moderators</span></header>
        ${r.moderators.length ? r.moderators.map((m) => `<div class="row static">${dot(m.status)}<span class="main"><span class="nm">${esc(m.name)}</span><span class="sub">Can review reports and ban or unban players.</span></span>${owner ? `<button class="btn sm ghost-danger" data-rm="${esc(m.name)}">Remove</button>` : ''}</div>`).join('') : '<div class="empty">No moderators yet.</div>'}
        ${owner ? '<form id="addmod" class="addform"><input class="input" name="name" placeholder="Username of a player to make moderator" autocomplete="off" spellcheck="false"><button class="btn pri" type="submit">Add</button></form>' : ''}</div>`;
      $$('[data-rm]', v).forEach((b) => {
        b.onclick = async () => {
          if (!confirm(`Remove ${b.dataset.rm} as a moderator?`)) return;
          try { await api('mods/remove', { body: { name: b.dataset.rm } }); toast(`${b.dataset.rm} is no longer a moderator.`); viewMods(); } catch (e) { fail(e); }
        };
      });
      const f = $('#addmod');
      if (f) f.onsubmit = async (ev) => {
        ev.preventDefault();
        const name = f.name.value.trim();
        if (!name) return;
        try { await api('mods/add', { body: { name } }); toast(`${name} is now a moderator. They sign in here with their game account.`); viewMods(); } catch (e) { fail(e); }
      };
    } catch (e) { fail(e); }
  }

  boot();
})();
