/**
 * audio/sounds/index.js — the full sound catalog: name -> definition.
 *
 * Definition fields:
 *   gen(rng, sr, params) -> Float32Array[]   deterministic synthesis (1 = mono, 2 = stereo channels)
 *   variants     number of baked variants (runtime picks one with the seeded rng, avoiding repeats)
 *   bus          'sfx' | 'ui' | 'music' | 'voice' | 'amb'  (default 'sfx')
 *   group        voice-limit group, maxVoices per group, priority (higher survives stealing)
 *   vol          linear gain, volVar (± dB), pitchVar (± semitones)
 *   reverb       environment reverb send (0..1)
 *   spatial      { ref, max } distance attenuation (meters) when played with playAt
 *   loop         true -> baked as a seamless loop
 *   duck         true -> ducks ambience/music when played
 *   tone         optional octave target curve (dB at 40,85,175,350,700,1.4k,2.8k,5.6k,11k,18k Hz): after synthesis
 *                the sound is tone-matched toward it (peak level preserved). toneWin = [t0, t1] analysis window.
 *   minGap       min seconds between two 2D plays of this name (dedupes cues reported by several systems)
 */
import weapons from './weapons.js';
import surfaces from './surfaces.js';
import combat from './combat.js';
import ui from './ui.js';
import ambience from './ambience.js';
import music from './music.js';
import { toneMatch, peakOf, scale } from '../dsp.js';

const catalog = { ...weapons, ...surfaces, ...combat, ...ui, ...ambience, ...music };

// reference spectral balances used by several recipes (see `tone` above)
export const TONES = {
  // gun mechanics: metal-on-metal clack, some low-mid body, no kick-drum boom
  mech: [-28, -17, -7, -3, -1, 0, 0, -2, -6, -13],
  // soft body hits: flesh / fabric / melee: dull mid "thwack", low end felt not boomy
  soft: [-22, -7, 0, 0, -3, -6, -9, -13, -18, -28],
  // bodies / prone / slides on the ground
  body: [-16, -4, 0, -2, -4, -6, -8, -11, -16, -26],
  // a steel grenade clunking on hard ground
  clunk: [-24, -11, -3, 0, -1, -2, -3, -6, -11, -21],
};
const TONE_OF = {
  bolt_release: 'mech', charging_handle: 'mech', mag_in: 'mech', pistol_mag_in: 'mech', pistol_slide_release: 'mech', mag_tap: 'mech',
  impact_flesh: 'soft', impact_fabric: 'soft', melee_hit: 'soft', player_hit: 'soft',
  body_fall: 'body', stance_prone: 'body', stance_crouch: 'body', jump: 'body', slide: 'body',
  grenade_bounce_concrete: 'clunk', grenade_bounce_metal: 'clunk',
};
for (const [k, t] of Object.entries(TONE_OF)) if (catalog[k] && !catalog[k].tone) catalog[k].tone = TONES[t];

for (const def of Object.values(catalog)) {
  if (!def.tone) continue;
  const gen = def.gen;
  def.gen = (rng, sr, params) => {
    const out = gen(rng, sr, params);
    const p0 = peakOf(out);
    const [t0, t1] = def.toneWin || [0, 4];
    toneMatch(out, sr, def.tone, { t0, t1, strength: 0.75, maxDb: 14 });
    const p1 = peakOf(out);
    if (p1 > 0) for (const c of out) scale(c, p0 / p1);
    return out;
  };
}

export default catalog;
export function soundNames() { return Object.keys(catalog); }
