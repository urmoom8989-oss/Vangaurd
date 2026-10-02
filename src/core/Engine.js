import * as THREE from 'three';
import { LAYERS, settingsFovToVfov } from './constants.js';

const TONE_MAPPINGS = {
  none: THREE.NoToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
};

/**
 * Engine — owns the WebGLRenderer, the main Scene and the player PerspectiveCamera.
 *
 * Renderer contract (systems may rely on this):
 *  - WebGL2, antialias:false (postfx owns AA), alpha:false, stencil:false, high-performance GPU
 *  - outputColorSpace = SRGB, physically-correct lighting (three r155+ default; intensities in lux/candela)
 *  - toneMapping = settings.graphics.toneMapping (default AgX). If postfx does its own tonemapping it
 *    must set renderer.toneMapping = NoToneMapping while it is active.
 *  - shadowMap.enabled = true, type PCFShadowMap (PCFSoft was removed in r18x)
 *  - renderer.info.autoReset = false: core resets it once per frame so draw calls/triangles include
 *    ALL passes (postfx, shadow maps...).
 *  - camera is added to the scene so children (viewmodel) are rendered and lit. Camera layers:
 *    WORLD + VIEWMODEL + FX enabled.
 */
export class Engine {
  constructor({ container, settings, shotMode = false, width = null, height = null }) {
    this.container = container;
    this.settings = settings;
    this.shotMode = shotMode;
    this.fixedSize = width && height ? { width, height } : null;

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = TONE_MAPPINGS[settings.get('graphics.toneMapping')] ?? THREE.AgXToneMapping;
    renderer.toneMappingExposure = settings.get('graphics.exposure', 1);
    renderer.shadowMap.enabled = settings.get('graphics.shadows', true);
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.info.autoReset = false;
    renderer.domElement.tabIndex = 0;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.scene.name = 'MainScene';
    this.scene.background = new THREE.Color(0x6f7f8f);

    const vfov = settingsFovToVfov(settings.get('graphics.fov', 90));
    this.camera = new THREE.PerspectiveCamera(vfov, 16 / 9, 0.03, 1500);
    this.camera.name = 'PlayerCamera';
    this.camera.position.set(0, 1.64, 0);
    this.camera.layers.enable(LAYERS.WORLD);
    this.camera.layers.enable(LAYERS.VIEWMODEL);
    this.camera.layers.enable(LAYERS.FX);
    this.scene.add(this.camera);

    this.width = 1;
    this.height = 1;
    this.pixelRatio = 1;
    this.resizeListeners = [];
    this.rendererString = detectRendererString(renderer);

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  resize() {
    const w = this.fixedSize ? this.fixedSize.width : window.innerWidth;
    const h = this.fixedSize ? this.fixedSize.height : window.innerHeight;
    const pr = this.shotMode ? 1 : Math.min(window.devicePixelRatio || 1, this.settings.get('graphics.maxPixelRatio', 1.5));
    const scale = this.settings.get('graphics.renderScale', 1);
    this.width = w;
    this.height = h;
    this.pixelRatio = pr * scale;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const fn of this.resizeListeners) {
      try { fn(w, h, this.pixelRatio); } catch (e) { console.error('[engine] resize listener threw', e); }
    }
  }

  /** Drawing-buffer size in physical pixels. */
  getDrawingBufferSize(out = new THREE.Vector2()) {
    return this.renderer.getDrawingBufferSize(out);
  }

  setToneMapping(name) {
    this.renderer.toneMapping = TONE_MAPPINGS[name] ?? THREE.AgXToneMapping;
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

export function detectRendererString(renderer) {
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const v = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    return { renderer: String(r), vendor: String(v) };
  } catch {
    return { renderer: 'unknown', vendor: 'unknown' };
  }
}
