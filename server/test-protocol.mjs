// Protocol test for the matchmaking server using plain ws clients.
// Run the server with MATCH_COUNTDOWN=2 MAP_VOTE_SECONDS=2 KC_SCORE_LIMIT=3 PORT=8099, then: node test-protocol.mjs
import { WebSocket } from 'ws';
const URL = process.argv[2] || 'ws://127.0.0.1:8099/ws';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, label) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); if (!cond) failures++; };
const MAPS = ['vardanek', 'kessel', 'foundry', 'freighter', 'airfield', 'lindenhof'];

function client(name) {
  const ws = new WebSocket(URL);
  const c = { name, ws, msgs: [], id: null };
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); c.msgs.push(m); if (m.type === 'connected') c.id = m.playerId; });
  c.send = (o) => ws.send(JSON.stringify(o));
  c.last = (t) => [...c.msgs].reverse().find((m) => m.type === t);
  c.all = (t) => c.msgs.filter((m) => m.type === t);
  c.open = new Promise((r) => ws.on('open', r));
  c.at = (x, z) => { c.send({ type: 'player_respawn', position: { x, y: 0, z } }); c.send({ type: 'player_state', state: { position: { x, y: 0, z }, alive: true } }); };
  return c;
}
const waitFor = async (c, type, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const m = c.last(type); if (m) return m; await sleep(50); } return null; };

(async () => {
  // --- Team Deathmatch: queue, map vote, play, late joiner ---
  const a = client('Alpha'), b = client('Bravo');
  await Promise.all([a.open, b.open]); await sleep(100);
  check(!!a.id && !!b.id, 'both clients receive connected with a playerId');
  a.send({ type: 'join_queue', mode: 'tdm', name: 'Alpha' });
  await sleep(200);
  check(a.last('queue_status')?.queued === 1, 'first player waits in queue');
  b.send({ type: 'join_queue', mode: 'tdm', name: 'Bravo' });
  const mfA = await waitFor(a, 'match_found'), mfB = await waitFor(b, 'match_found');
  check(!!mfA && !!mfB && mfA.matchId === mfB.matchId, 'two players are matched together');
  check(mfA?.roster.length === 2 && mfA.playerId === a.id, 'roster has both players and playerId is the receiver');
  const teamA = mfA.roster.find((p) => p.id === a.id).team, teamB = mfA.roster.find((p) => p.id === b.id).team;
  check(teamA !== teamB && /alpha|bravo/.test(teamA), 'TDM players are on opposite teams');
  const opts = mfA.vote?.options || [];
  check(mfA.phase === 'vote' && opts.length === 3 && new Set(opts).size === 3 && opts.every((m) => MAPS.includes(m)), `match opens with a vote on 3 of ${MAPS.length} maps (${opts.join(', ')})`);
  check(JSON.stringify(mfB.vote.options) === JSON.stringify(opts), 'everyone in the match votes on the same three maps');
  a.at(1, 2); b.at(5, 6);
  a.send({ type: 'player_hit', targetId: b.id, amount: 30, zone: 'torso' });
  await sleep(150);
  check(!b.last('player_damaged'), 'no damage while the vote is open');
  a.send({ type: 'vote_map', mapId: opts[1] });
  b.send({ type: 'vote_map', mapId: opts[2] });
  b.send({ type: 'vote_map', mapId: 'not-a-map' });
  await sleep(150);
  b.send({ type: 'vote_map', mapId: opts[1] });
  await sleep(150);
  const mv = a.last('map_vote');
  check(mv?.tallies?.[opts[1]] === 2 && mv.tallies[opts[2]] === 0, 'votes are tallied and a changed vote moves');
  const sel = await waitFor(a, 'map_selected', 4000);
  check(sel?.mapId === opts[1] && b.last('map_selected')?.mapId === opts[1], 'the map with the most votes is selected for everyone');
  // Clients load the map and respawn; spawn protection then expires.
  a.at(3, 4); b.at(5, 6);
  await sleep(2200);
  const st = b.last('player_state');
  check(st?.playerId === a.id && st.state.position.x === 3 && st.state.x === 3, 'movement is relayed with nested and flat position');
  for (let i = 0; i < 4; i++) a.send({ type: 'player_hit', targetId: b.id, amount: 30, zone: 'torso' });
  await sleep(200);
  check(b.all('player_damaged').length === 4 && b.last('player_damaged').health === 0, 'damage is applied by the server once the map is live');
  check(!!a.last('player_killed'), 'kill is announced');
  check(a.last('match_score')?.score[teamA] === 1, 'TDM kill scores for the attacker team');
  b.at(9, 9);
  await sleep(150);
  check(a.last('player_respawned')?.playerId === b.id, 'respawn is relayed');
  const c = client('Charlie');
  await c.open;
  c.send({ type: 'join_queue', mode: 'tdm', name: 'Charlie' });
  const mfC = await waitFor(c, 'match_found', 2000);
  check(mfC?.matchId === mfA.matchId && mfC.roster.length === 3, 'late joiner drops into the running match');
  check(mfC?.phase === 'live' && mfC.mapId === opts[1] && !mfC.vote, 'late joiner is told which map is being played');
  check(c.all('player_state').length >= 2, 'late joiner gets everyone\'s last position');
  check(a.last('player_joined')?.player.id === c.id && a.last('match_update')?.roster.length === 3, 'existing players are told about the late joiner');
  c.ws.close();
  await sleep(200);
  check(a.last('player_left')?.playerId === c.id, 'leaving is announced');
  a.ws.close(); b.ws.close();

  // --- Kill Confirmed: free-for-all ---
  const d = client('Delta'), e = client('Echo'), f = client('Foxtrot');
  await Promise.all([d.open, e.open, f.open]);
  for (const x of [d, e, f]) x.send({ type: 'join_queue', mode: 'kc', name: x.name });
  const mfD = await waitFor(d, 'match_found');
  check(mfD?.mode === 'kc' && mfD.ffa === true && mfD.roster.length === 3, 'kill confirmed match starts as free-for-all');
  check(mfD.roster.every((p) => p.team === 'ffa'), 'nobody is on a team');
  check(mfD.phase === 'vote' && mfD.vote.options.length === 3, 'kill confirmed opens with a map vote too');
  const sel2 = await waitFor(d, 'map_selected', 4000);
  check(!!sel2 && mfD.vote.options.includes(sel2.mapId), `with no votes a random option is chosen (${sel2?.mapId})`);
  d.at(0, 0); e.at(10, 0); f.at(-10, 0);
  await sleep(2200);
  // Delta kills Echo and confirms.
  d.send({ type: 'player_hit', targetId: e.id, amount: 120, zone: 'head' });
  await sleep(150);
  const t1 = d.last('tag_spawned')?.tag;
  check(!!t1 && Math.abs(t1.x - 10) < 0.01 && t1.victimId === e.id, 'a tag drops where the victim died');
  check(!d.last('match_score') || (d.last('match_score').players || []).every((p) => p.score === 0), 'a kill alone does not score');
  d.send({ type: 'tag_pickup', tagId: t1.id });
  await sleep(150);
  check(!d.last('tag_removed'), 'picking up a tag from too far away is refused');
  d.send({ type: 'player_state', state: { position: { x: 9.5, y: 0, z: 0.5 }, alive: true } });
  await sleep(50);
  d.send({ type: 'tag_pickup', tagId: t1.id });
  await sleep(150);
  check(d.last('tag_removed')?.confirmed === true && e.last('tag_removed')?.tagId === t1.id, 'tag pickup is confirmed for everyone');
  const sc1 = d.last('match_score');
  check(sc1?.ffa === true && sc1.players.find((p) => p.id === d.id)?.score === 1 && sc1.players.filter((p) => p.score > 0).length === 1, 'the confirm scores for Delta alone');
  // Foxtrot kills Delta, Delta denies its own tag.
  f.send({ type: 'player_hit', targetId: d.id, amount: 150, zone: 'head' });
  await sleep(150);
  const t2 = d.last('tag_spawned')?.tag;
  check(t2?.victimId === d.id, 'Delta\'s death drops Delta\'s tag');
  d.at(9.5, 0.5);
  await sleep(100);
  d.send({ type: 'tag_pickup', tagId: t2.id });
  await sleep(150);
  check(d.last('tag_removed')?.tagId === t2.id && d.last('tag_removed').confirmed === false, 'grabbing your own tag denies it');
  check(d.last('match_score').players.find((p) => p.id === d.id).score === 1, 'a denial does not score');
  // Echo kills Foxtrot; Delta (not involved) confirms it.
  e.at(-9, 0);
  await sleep(2200);
  e.send({ type: 'player_hit', targetId: f.id, amount: 150, zone: 'head' });
  await sleep(150);
  const t3 = d.last('tag_spawned')?.tag;
  check(t3?.victimId === f.id && t3.killerId === e.id, 'Echo kills Foxtrot');
  d.send({ type: 'player_state', state: { position: { x: -10, y: 0, z: 0.4 }, alive: true } });
  await sleep(50);
  d.send({ type: 'tag_pickup', tagId: t3.id });
  await sleep(150);
  check(d.last('tag_removed')?.confirmed === true && d.last('match_score').players.find((p) => p.id === d.id).score === 2, 'any player except the victim can confirm a tag');
  // Third confirm wins (KC_SCORE_LIMIT=3).
  e.at(30, 0); f.at(-30, 0);
  await sleep(2200);
  d.send({ type: 'player_state', state: { position: { x: 29, y: 0, z: 0 }, alive: true } });
  d.send({ type: 'player_hit', targetId: e.id, amount: 150, zone: 'head' });
  await sleep(150);
  const t4 = d.last('tag_spawned')?.tag;
  d.send({ type: 'tag_pickup', tagId: t4.id });
  await sleep(200);
  const end = d.last('match_ended');
  check(end?.ffa === true && end.winner === d.id && end.winnerName === 'Delta' && end.players[0].id === d.id, 'first to the score limit wins the free-for-all');
  d.ws.close(); e.ws.close(); f.ws.close();
  await sleep(100);
  console.log(failures ? `${failures} FAILED` : 'ALL PASSED');
  process.exit(failures ? 1 : 0);
})();
