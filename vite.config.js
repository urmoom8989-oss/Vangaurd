import { defineConfig } from 'vite';

// NOTE (core, frozen): dependency pre-bundling is disabled on purpose.
//  * Many agents run tools/shot.mjs concurrently; each spins up its own Vite server. A shared
//    optimizer cache (node_modules/.vite) would race, and runtime dep discovery triggers full page
//    reloads that would corrupt deterministic captures.
//  * Serving raw ESM from node_modules guarantees a single `three` instance for all deps
//    (postprocessing, n8ao, three-mesh-bvh all resolve to the same file).
export default defineConfig({
  clearScreen: false,
  server: {
    port: 5173,
    // The Vite error overlay would cover the canvas; core shows its own small diagnostics instead.
    hmr: { overlay: false },
  },
  optimizeDeps: { noDiscovery: true, include: [] },
  assetsInclude: ['**/*.hdr', '**/*.exr', '**/*.ktx2', '**/*.glb', '**/*.gltf', '**/*.bin'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
});
