'use strict';
// Vangaurd Anti-Cheat console. Talks only to this server's /admin/api, so it works with every game version.
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const app = $('#app');
  const TOKEN_KEY = 'vg-anticheat-token';
  const MAPS = { vardanek: 'Vardanek', kessel: 'Kessel Yard', lindenhof: 'Lindenhof', foundry: 'Foundry', freighter: 'Freighter', airfield: 'Airfield' };
  const MODES = { tdm: 'Team Deathmatch', kc: 'Kill Confirmed' };
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
  const TABS = [['reports', 'Reports'], ['players', 'Players'], ['bans', 'Bans'], ['activity', 'Activity'], ['mods', 'Moderators']];
  function shell() {
    app.innerHTML = `<header class="top"><div class="brand">${SHIELD}<div><b>VANGAURD</b><small>Anti-Cheat</small></div></div>
      <div class="me">Signed in as <b>${esc(ui.me)}</b><span class="role">${esc(ui.role)}</span><button class="btn sm" id="signout">Sign out</button></div></header>
      <section class="stats" id="stats"></section>
      <nav class="tabs" role="tablist">${TABS.map(([k, t]) => `<button class="tab" role="tab" data-tab="${k}">${t}${k === 'reports' ? '<span class="n" id="nrep"></span>' : ''}</button>`).join('')}</nav>
      <main id="view"></main>`;
    $('#signout').onclick = async () => { try { await api('logout', { body: {} }); } catch { /* ignore */ } setToken(null); boot(); };
    $$('.tab').forEach((b) => { b.onclick = () => show(b.dataset.tab); });
    summary(); show(ui.tab);
    ui.timer = setInterval(() => { summary(); if (ui.tab === 'reports' && !$('.modal')) groupsList(true); }, 15000);
  }
  async function summary() {
    try {
      const s = ui.summary = await api('summary');
      const c = s.counts;
      $('#stats').innerHTML = [['Open reports', c.openReports, c.openReports > 0], ['Reported players', c.reportedPlayers], ['Active bans', c.bans], ['Players online', c.online], ['Accounts', c.accounts]]
        .map(([k, v, hot]) => `<div class="stat${hot ? ' hot' : ''}"><span class="k">${k}</span><b>${Number(v).toLocaleString()}</b></div>`).join('');
      $('#nrep').textContent = c.openReports ? String(c.openReports) : '';
    } catch { /* handled by api() */ }
  }
  function show(tab) {
    ui.tab = tab;
    $$('.tab').forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', on); });
    ({ reports: viewReports, players: viewPlayers, bans: viewBans, activity: viewActivity, mods: viewMods })[tab]();
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
        ${r.status !== 'open' ? `<button class="btn sm" data-reopen="${esc(r.id)}">Reopen</button>` : by ? `<button class="btn sm" data-dismiss="${esc(r.id)}">Dismiss</button>` : ''}</div></article>`;
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
        <div class="facts"><span>${esc(STATUS[p.status] || p.status)}</span><span>${Number(p.xp).toLocaleString()} XP</span><span>Joined ${esc(fmt(p.created))}</span><span>Last sign-in ${esc(ago(p.lastLogin))}</span><span>${plural(p.devices, 'device')}</span></div></div>
        <div class="acts">${p.ban ? '<button class="btn" data-act="unban">Unban</button>' : p.role ? '' : '<button class="btn danger" data-act="ban">Ban</button>'}
          ${p.status !== 'offline' ? '<button class="btn" data-act="kick">Disconnect</button>' : ''}
          ${open ? `<button class="btn" data-act="dismiss-all">Dismiss ${plural(open, 'open report')}</button>` : ''}</div></div>
      ${p.ban ? `<div class="banbox"><b>Banned</b> by ${esc(p.ban.by)} · ${esc(ago(p.ban.at))} · ${esc(banEnds(p.ban))}${p.ban.devices ? ' · devices blocked' : ''}<div class="mt4">Reason: ${esc(p.ban.reason)}</div></div>` : ''}
      <div class="section"><span class="k">Reports against ${esc(p.name)} (${d.reportsAgainst.length})</span>${d.reportsAgainst.length ? d.reportsAgainst.map((r) => reportCard(r)).join('') : '<div class="empty pad14">No reports against this player.</div>'}</div>
      ${d.reportsBy.length ? `<div class="section"><span class="k">Reports made by ${esc(p.name)} (${d.reportsBy.length})</span>${d.reportsBy.map((r) => reportCard(r, false)).join('')}</div>` : ''}
      ${d.history.length ? `<div class="section"><span class="k">Moderation history</span><div class="pane log">${d.history.map(logItem).join('')}</div></div>` : ''}
    </div>`;
    const again = () => { detail(name, box); summary(); if (ui.tab === 'reports') groupsList(true); if (ui.tab === 'players') playersList(true); };
    $$('[data-act]', box).forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'ban') return banDialog(p.name, d.reportsAgainst, again);
        try {
          if (act === 'unban') { if (!confirm(`Unban ${p.name}? They can sign in and play again right away.`)) return; await api('unban', { body: { name: p.name } }); toast(`${p.name} is unbanned.`); }
          if (act === 'kick') { const r = await api('kick', { body: { name: p.name } }); toast(r.kicked ? `Disconnected ${p.name}.` : `${p.name} is not connected.`); }
          if (act === 'dismiss-all') { const r = await api('reports/dismiss', { body: { target: p.name } }); toast(`Dismissed ${plural(r.changed, 'report')}.`); }
          again();
        } catch (e) { fail(e); }
      };
    });
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
      <section class="pane"><header class="wrap"><input id="pq" placeholder="Search by username" value="${esc(ui.q)}" autocomplete="off" spellcheck="false" class="input grow">
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
        <span class="sub">${esc(STATUS[p.status] || p.status)} · ${Number(p.xp).toLocaleString()} XP · last sign-in ${esc(ago(p.lastLogin))}</span></span></button>`).join('')
        + (r.total > r.players.length ? `<div class="empty">Showing ${r.players.length} of ${r.total}. Search to narrow it down.</div>` : '');
      $$('.row', box).forEach((b) => { b.onclick = () => { $$('.row', box).forEach((x) => x.classList.toggle('on', x === b)); detail(b.dataset.name); }; });
    } catch (e) { if (!quiet) fail(e); }
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
  const ACT = { ban: 'banned', unban: 'unbanned', kick: 'disconnected', dismiss: 'dismissed reports against', reopen: 'reopened reports against', mod_add: 'made a moderator:', mod_remove: 'removed moderator', setup: 'set up the console', ban_expired: 'ban ended for' };
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
