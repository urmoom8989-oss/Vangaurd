#!/usr/bin/env bash
# A/B perf of material shading: tools/materials/perfab.sh [rounds=2] [presetA] [presetB]
cd "$(dirname "$0")/../.."
R=${1:-2}; A=${2:-materials-perf-full}; B=${3:-materials-perf-lite}
OUT=${TMPDIR:-/tmp}/perfab; mkdir -p "$OUT"
for i in $(seq 1 $R); do
  for p in $A $B; do
    for try in 1 2 3; do
      node tools/perf.mjs $p --duration 10 --out "$OUT/$p.json" >/dev/null 2>&1
      node -e "const j=require(process.argv[1]);if(!j.cpuMs)process.exit(1);console.log(process.argv[2],JSON.stringify({f:j.frames,p50:j.frameMs.p50,p95:j.frameMs.p95,gpu:j.gpuMs.avg,gpu95:j.gpuMs.p95,cpu:j.cpuMs.avg,dc:j.drawCalls,tri:j.triangles}))" "$OUT/$p.json" $p && break
    done
  done
done
