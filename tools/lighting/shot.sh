#!/usr/bin/env bash
# usage: tools/lighting/shot.sh <preset> <outname> [extra args]   -> compact summary of tools/shot.mjs
cd "$(dirname "$0")/../.."
p=$1; o=$2; shift 2
node tools/shot.mjs "$p" --out "shots/lighting/$o.png" "$@" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const errs=(j.consoleErrors||[]).filter(e=>!/X4122/.test(e));console.log(j.ok?'OK':'FAIL',j.png||'', 'sysErr:'+JSON.stringify((j.systemErrors||[]).map(e=>e.system+':'+e.phase+':'+e.message.slice(0,300))), 'console:'+JSON.stringify(errs.map(e=>e.slice(0,600))).slice(0,2500), 'pageErr:'+JSON.stringify(j.pageErrors||[]).slice(0,800), 'perf gpu', j.perf&&j.perf.gpuAvg, 'dc', j.perf&&j.perf.drawCalls)}catch(e){console.log('PARSE FAIL',s.slice(0,2000))}})"
