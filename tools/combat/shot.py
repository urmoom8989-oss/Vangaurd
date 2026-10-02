"""Summarize tools/shot.mjs JSON (stdin) for the combat agent: ok, errors, perf."""
import json
import sys

raw = sys.stdin.read()
i = raw.find('{\n')
d = json.loads(raw[i:]) if i >= 0 else {}
errs = d.get('systemErrors') or []
print('ok=%s png=%s' % (d.get('ok'), d.get('png') or d.get('contactSheet')))
print('systemErrors:', [(e.get('system'), e.get('phase'), str(e.get('message'))[:120]) for e in errs])
ce = d.get('consoleErrors') or []
print('consoleErrors(%d):' % len(ce), [c[:160] for c in ce if 'combat' in c.lower()][:5])
print('pageErrors:', (d.get('pageErrors') or [])[:3])
p = d.get('perf') or {}
print('perf avg=%s p95=%s gpu=%s draws=%s tris=%s' % (p.get('avg'), p.get('p95'), p.get('gpuAvg'), p.get('drawCalls'), p.get('triangles')))
if d.get('error'):
    print('error:', d.get('error'))
