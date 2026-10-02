/**
 * Diagnostics (core, frozen): uniform error reporting for systems.
 * Every system error is logged as  "[system:<name>] <phase> failed: <message>"  with the stack,
 * collected in window.__SYSTEM_ERRORS__ (read by tools/shot.mjs) and shown in the small #core-diag
 * panel in normal play (hidden in shot mode unless ?debug=1).
 */
export function createDiagnostics({ showPanel }) {
  const errors = [];
  window.__SYSTEM_ERRORS__ = errors;
  const panel = document.getElementById('core-diag');

  function render() {
    if (!panel || !showPanel) return;
    panel.style.display = errors.length ? 'block' : 'none';
    panel.textContent = errors.slice(-8).map((e) => `[system:${e.system}] ${e.phase}: ${e.message}`).join('\n');
  }

  function reportError(system, phase, err) {
    const message = String(err?.message || err);
    const stack = err?.stack ? String(err.stack) : '';
    console.error(`[system:${system}] ${phase} failed: ${message}`, err);
    errors.push({ system, phase, message, stack: stack.split('\n').slice(0, 6).join('\n') });
    render();
  }

  return { errors, reportError };
}
