#!/usr/bin/env bash
# Shoot several materials presets: tools/materials/shoot.sh preset1 preset2 ...  (outputs shots/materials/<preset>.png)
cd "$(dirname "$0")/../.."
for p in "$@"; do
  node tools/shot.mjs "$p" --out "shots/materials/${p#materials-}.png" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const w=(j.consoleWarnings||[]).filter(x=>!/X4122|X3577|X3557|X3571|X4000|Program Info Log/.test(x));console.log('$p', j.ok?'ok':'FAIL', 'gpu', j.perf&&j.perf.gpuAvg, 'errs', JSON.stringify(j.systemErrors), JSON.stringify(j.consoleErrors).slice(0,600), JSON.stringify(j.pageErrors).slice(0,400), w.length?JSON.stringify(w).slice(0,600):'')}catch(e){console.log('$p parse fail', s.slice(0,300))}})"
done
