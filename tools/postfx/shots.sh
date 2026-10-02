#!/bin/sh
# usage: tools/postfx/shots.sh <prefix> preset1 preset2 ...   (extra shot args via SHOT_ARGS env)
cd "$(dirname "$0")/../.."
prefix=$1; shift
for p in "$@"; do
  node tools/shot.mjs $p --out shots/postfx/${prefix}_$p.png $SHOT_ARGS 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log(j.preset,j.ok,'sysErr',JSON.stringify(j.systemErrors).slice(0,300),'conErr',JSON.stringify(j.consoleErrors).slice(0,400),'pageErr',JSON.stringify(j.pageErrors).slice(0,300),'dc',j.perf&&j.perf.drawCalls)}catch(e){console.log('PARSE FAIL',s.slice(0,500))}})"
done
