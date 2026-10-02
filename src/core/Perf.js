/**
 * Perf — frame statistics published to window.__PERF__.
 *
 *   frameMs   wall-clock time between rAF callbacks (what the player feels; vsync-capped unless the
 *             browser runs with --disable-gpu-vsync --disable-frame-rate-limit, as tools/perf.mjs does)
 *   cpuMs     time spent in JS for update + render submission
 *   gpuMs     GPU time for the frame via EXT_disjoint_timer_query_webgl2 (null if unavailable)
 *   drawCalls / triangles / points / lines: summed over ALL passes of the last frame
 */

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export class Perf {
  constructor(renderer, rendererInfo, { capacity = 600, autoPublish = true, measureGpu = true } = {}) {
    this.autoPublish = autoPublish;
    const N = capacity;
    this.N = N;
    this.renderer = renderer;
    this.rendererInfo = rendererInfo;
    this.frame = new Float32Array(N);
    this.cpu = new Float32Array(N);
    this.gpu = new Float32Array(N);
    this.count = 0;
    this.gpuCount = 0;
    this.idx = 0;
    this.gpuIdx = 0;
    this.last = { drawCalls: 0, triangles: 0, points: 0, lines: 0 };
    this.maxDrawCalls = 0;
    this.maxTriangles = 0;
    this._lastStamp = -1;
    this._cpuStart = 0;
    this._publishCounter = 0;

    const gl = renderer.getContext();
    this.gl = gl;
    this.timerExt = null;
    if (measureGpu) {
      try { this.timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2'); } catch { /* ignore */ }
    }
    this._queries = [];
    this._activeQuery = null;

    this.published = {};
    this.publish();
  }

  reset() {
    this.count = 0;
    this.gpuCount = 0;
    this.idx = 0;
    this.gpuIdx = 0;
    this._lastStamp = -1;
    this.maxDrawCalls = 0;
    this.maxTriangles = 0;
  }

  beginFrame(now) {
    if (this._lastStamp >= 0) {
      this.frame[this.idx] = now - this._lastStamp;
    } else {
      this.frame[this.idx] = 0;
    }
    this._lastStamp = now;
    this._cpuStart = performance.now();
    this.renderer.info.reset();
    this._pollQueries();
  }

  beginGpu() {
    if (!this.timerExt || this._activeQuery) return;
    const q = this.gl.createQuery();
    this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, q);
    this._activeQuery = q;
  }

  endGpu() {
    if (!this._activeQuery) return;
    this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT);
    this._queries.push(this._activeQuery);
    this._activeQuery = null;
  }

  _pollQueries() {
    const gl = this.gl;
    while (this._queries.length) {
      const q = this._queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.timerExt.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        this.gpu[this.gpuIdx] = ns / 1e6;
        this.gpuIdx = (this.gpuIdx + 1) % this.N;
        this.gpuCount = Math.min(this.N, this.gpuCount + 1);
      }
      gl.deleteQuery(q);
      this._queries.shift();
    }
    if (this._queries.length > 8) { // runaway guard
      for (const q of this._queries) gl.deleteQuery(q);
      this._queries.length = 0;
    }
  }

  endFrame() {
    this.cpu[this.idx] = performance.now() - this._cpuStart;
    const info = this.renderer.info;
    this.last.drawCalls = info.render.calls;
    this.last.triangles = info.render.triangles;
    this.last.points = info.render.points;
    this.last.lines = info.render.lines;
    // skip the very first frame delta (0)
    if (this.frame[this.idx] > 0) {
      this.idx = (this.idx + 1) % this.N;
      this.count = Math.min(this.N, this.count + 1);
      if (info.render.calls > this.maxDrawCalls) this.maxDrawCalls = info.render.calls;
      if (info.render.triangles > this.maxTriangles) this.maxTriangles = info.render.triangles;
    }
    if (this.autoPublish && ++this._publishCounter >= 60) {
      this._publishCounter = 0;
      this.publish(); // allocates (sorting) — only once per second
    }
  }

  stats() {
    const n = this.count;
    const frames = Array.from(this.frame.subarray(0, n)).sort((a, b) => a - b);
    const cpus = Array.from(this.cpu.subarray(0, n)).sort((a, b) => a - b);
    const gpus = Array.from(this.gpu.subarray(0, this.gpuCount)).sort((a, b) => a - b);
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
    const r = (x) => Math.round(x * 100) / 100;
    const info = this.renderer.info;
    return {
      samples: n,
      avg: r(avg(frames)),
      p50: r(percentile(frames, 50)),
      p95: r(percentile(frames, 95)),
      p99: r(percentile(frames, 99)),
      max: r(frames[frames.length - 1] || 0),
      fps: frames.length ? r(1000 / avg(frames)) : 0,
      cpuAvg: r(avg(cpus)),
      cpuP95: r(percentile(cpus, 95)),
      gpuAvg: gpus.length ? r(avg(gpus)) : null,
      gpuP95: gpus.length ? r(percentile(gpus, 95)) : null,
      drawCalls: this.last.drawCalls,
      triangles: this.last.triangles,
      maxDrawCalls: this.maxDrawCalls,
      maxTriangles: this.maxTriangles,
      points: this.last.points,
      lines: this.last.lines,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs ? info.programs.length : 0,
      renderer: this.rendererInfo.renderer,
      vendor: this.rendererInfo.vendor,
      gpuTimer: !!this.timerExt,
    };
  }

  publish() {
    this.published = this.stats();
    window.__PERF__ = this.published;
    return this.published;
  }
}
