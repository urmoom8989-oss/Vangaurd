#!/bin/sh
# quick shot: qs.sh <tag> <preset>... -> shots/materials/<tag>-<preset>.png, one summary line each
tag=$1; shift
for p in "$@"; do
  node tools/shot.mjs $p --out shots/materials/$tag-$p.png 2>&1 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s.slice(s.indexOf('{')));console.log(j.preset,j.ok,'sysErr',JSON.stringify(j.systemErrors).slice(0,400),'conErr',JSON.stringify(j.consoleErrors).slice(0,400),'dc',j.perf&&j.perf.drawCalls)}catch(e){console.log(s.slice(-1200))}})"
done
