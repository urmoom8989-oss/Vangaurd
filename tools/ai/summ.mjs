// Summarize tools/shot.mjs JSON from stdin: node tools/shot.mjs ... 2>/dev/null | node tools/ai/summ.mjs
let s = '';
process.stdin.on('data', (d) => { s += d; });
process.stdin.on('end', () => {
  try {
    const o = JSON.parse(s);
    const bad = (o.systems || []).filter((x) => x.status !== 'active').map((x) => `${x.name}:${x.status}`);
    console.log(JSON.stringify({ ok: o.ok, error: o.error, png: o.png, sys: bad, systemErrors: (o.systemErrors || []).map((e) => e.system + ':' + e.phase + ':' + (e.message || '').slice(0, 160)), consoleErrors: (o.consoleErrors || []).map((e) => e.slice(0, 200)), pageErrors: o.pageErrors, tris: o.perf?.triangles, draws: o.perf?.drawCalls }, null, 1));
  } catch (e) { console.log('unparsable', s.slice(0, 500)); }
});
