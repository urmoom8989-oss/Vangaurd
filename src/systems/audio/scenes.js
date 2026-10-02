/**
 * audio/scenes.js — scripted offline "scenes" rendered through the full runtime engine (buses, HRTF
 * panning, distance/air absorption, speed-of-sound delays, ducking, concussion, environment reverb).
 * They exist so a critic can judge the MIX, not just isolated one-shots:
 *   node tools/audio.mjs scene_firefight
 * Listener at the origin facing -Z (right = +X, up = +Y). Deterministic.
 */
import { AmbienceDirector } from './ambience.js';

const FEET = { x: 0, y: -1.62, z: 0 };
const v = (x, y, z) => ({ x, y, z });
const toward = (from, to, jitter = { x: 0, y: 0, z: 0 }) => {
  const d = { x: to.x + jitter.x - from.x, y: to.y + jitter.y - from.y, z: to.z + jitter.z - from.z };
  const l = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / l, y: d.y / l, z: d.z / l };
};

function burst(e, t, n, rpm, fn) { for (let i = 0; i < n; i++) fn(t + (i * 60) / rpm, i); return t + (n * 60) / rpm; }

export const SCENES = {
  scene_firefight: {
    duration: 12, env: 'street',
    description: 'Player bursts, hits and a kill; two enemies return fire (snaps, whizzes, impacts around you); distant fighting; reload.',
    build(e, r) {
      const enemy = v(-9, 1.4, -32), enemy2 = v(18, 1.5, -64), me = v(0, 0, 0);
      // player opens up
      burst(e, 0.25, 6, 780, (t, i) => {
        e.playerShot({ weaponId: 'rifle', ammoFrac: 0.8, surface: 'concrete', feet: FEET, at: t });
        const hitT = t + 0.05;
        if (i < 3) e.impact({ point: v(-8 + i * 0.6, 0.6 + i * 0.3, -31.5), surface: 'concrete', at: hitT });
        if (i === 3) { e.impact({ point: enemy, flesh: true, at: hitT }); e.play('hitmarker', { at: t + 0.04 }); }
        if (i === 5) { e.impact({ point: enemy, flesh: true, at: hitT }); e.play('hitmarker_kill', { at: t + 0.04 }); e.play('body_fall', { position: v(-9, 0.2, -32.5), at: t + 0.5 }); }
      });
      // enemy 2 answers with a burst that cracks past the listener, rounds slapping the wall beside you
      burst(e, 1.7, 4, 700, (t, i) => {
        e.remoteShot({ origin: enemy2, dir: toward(enemy2, me, v(i % 2 ? 1.4 : -1.1, 0.5, 0)), weaponId: 'rifle', at: t });
        const p = v(i % 2 ? 1.6 : -1.3, -0.6 + i * 0.35, 1.2);
        e.impact({ point: p, surface: i === 2 ? 'metal' : 'concrete', at: t + 72 / 880, near: true });
      });
      burst(e, 3.1, 3, 700, (t, i) => {
        e.remoteShot({ origin: enemy2, dir: toward(enemy2, me, v(-1.8 + i, 0.8, 0)), weaponId: 'rifle', at: t });
        e.impact({ point: v(-0.8 + i, -1.4, -3.5), surface: 'dirt', at: t + 68 / 880, near: true });
      });
      // player: ADS, controlled pairs
      e.play('ads_in', { at: 4.3 });
      for (const t of [4.65, 4.85, 5.4, 5.6]) e.playerShot({ weaponId: 'rifle', ammoFrac: 0.3, surface: 'concrete', feet: FEET, at: t });
      e.impact({ point: enemy2, flesh: true, at: 4.9 }); e.play('hitmarker', { at: 4.69 });
      e.impact({ point: enemy2, flesh: true, at: 5.65 }); e.play('hitmarker_headshot', { at: 5.44 }); e.play('hitmarker_kill', { at: 5.645 });
      e.play('ads_out', { at: 6.0 });
      // the wider battle
      e.play('amb_mg_far', { position: v(-320, 10, -420), at: 5.0, volume: 1 });
      e.explosion({ position: v(120, 0, -210), radius: 6, at: 6.2 });
      // reload
      e.play('mag_out', { at: 6.8 });
      e.play('cloth_rustle', { at: 7.2, volume: 0.8 });
      e.play('mag_in', { at: 7.75 });
      e.play('bolt_release', { at: 8.35 });
      e.play('fire_select', { at: 8.9 });
      // one more enemy from the right flank, closer; bullets snap by
      const enemy3 = v(26, 1.5, -14);
      burst(e, 9.3, 5, 680, (t, i) => e.remoteShot({ origin: enemy3, dir: toward(enemy3, me, v(0, 0.9 - i * 0.2, i % 2 ? 1.5 : -1.5)), weaponId: 'rifle', at: t }));
      e.playerShot({ weaponId: 'rifle', ammoFrac: 0.9, surface: 'concrete', feet: FEET, at: 10.2 });
      e.playerShot({ weaponId: 'rifle', ammoFrac: 0.9, surface: 'concrete', feet: FEET, at: 10.29 });
      e.impact({ point: enemy3, flesh: true, at: 10.33 }); e.play('hitmarker_kill', { at: 10.33 });
    },
  },

  scene_grenade: {
    duration: 9, env: 'street',
    description: 'Pin, throw, two bounces, detonation 9 m away: blast, debris rain, concussion muffling + tinnitus.',
    build(e) {
      e.play('grenade_pin', { at: 0.2 });
      e.play('grenade_throw', { at: 0.95 });
      e.play('grenade_bounce_concrete', { position: v(1, -1.5, -10), at: 1.55 });
      e.play('grenade_bounce_concrete', { position: v(1.6, -1.55, -9.2), at: 1.9, volume: 0.5 });
      e.explosion({ position: v(2, -1.4, -8.6), radius: 6, at: 3.2 });
      e.play('amb_debris', { position: v(-4, 2, -6), at: 6.2 });
    },
  },

  scene_reload: {
    duration: 7, env: 'room',
    description: 'Interior: fire-mode switch, tactical reload, empty reload (bolt release), charging handle, ADS in/out, dry fire.',
    build(e) {
      e.play('fire_select', { at: 0.2 });
      e.play('mag_out', { at: 0.6 });
      e.play('mag_in', { at: 1.5 });
      e.play('weapon_lower', { at: 2.3 });
      e.play('weapon_raise', { at: 2.8 });
      e.play('ads_in', { at: 3.4 });
      e.play('dry_fire', { at: 3.8 });
      e.play('ads_out', { at: 4.1 });
      e.play('mag_out', { at: 4.4 });
      e.play('mag_in', { at: 5.2 });
      e.play('charging_handle', { at: 5.85 });
    },
  },

  scene_footsteps: {
    duration: 13, env: 'street',
    description: 'Own steps: walk concrete, sprint gravel, walk metal, sprint wood, crouch dirt, walk glass, jump + land; then an enemy walks past on the left.',
    build(e) {
      let t = 0.2;
      const seq = [['concrete', 2.4, 4, 'stand'], ['gravel', 6.5, 5, 'stand'], ['metal', 2.4, 4, 'stand'], ['wood', 6.5, 5, 'stand'], ['dirt', 1.6, 3, 'crouch'], ['glass', 2.4, 4, 'stand']];
      for (const [s, speed, n, stance] of seq) {
        const gap = speed > 5 ? 0.34 : stance === 'crouch' ? 0.7 : 0.52;
        for (let i = 0; i < n; i++) { e.footstep({ surface: s, speed, stance, own: true, at: t }); t += gap; }
        t += 0.35;
      }
      e.play('jump', { at: t }); t += 0.55;
      e.play('land_concrete_heavy', { at: t }); t += 0.8;
      // enemy passing left to right, 5 m in front
      for (let i = 0; i < 8; i++) e.footstep({ surface: 'concrete', speed: 3, position: v(-6 + i * 1.5, -1.6, -5), at: t + i * 0.5 });
    },
  },

  scene_flyby: {
    duration: 6, env: 'open',
    description: 'Rounds from 90 m passing at 0.8, 2 and 4 m: the supersonic snap arrives before the muzzle report.',
    build(e) {
      const o = v(-30, 1.5, -85), me = v(0, 0, 0);
      e.remoteShot({ origin: o, dir: toward(o, me, v(0.8, 0, 0)), at: 0.2 });
      e.remoteShot({ origin: o, dir: toward(o, me, v(-2, 0.3, 0)), at: 1.9 });
      e.remoteShot({ origin: o, dir: toward(o, me, v(4, 0.5, 0)), at: 3.6 });
    },
  },

  scene_distance: {
    duration: 13, env: 'open',
    description: 'The same rifle at 8, 25, 60, 150, 400 and 900 m (layered 3P/far, air absorption, speed-of-sound delay).',
    build(e) {
      const ds = [8, 25, 60, 150, 400, 900];
      ds.forEach((d, i) => e.remoteShot({ origin: v(-d * 0.5, 1.5, -d * 0.866), weaponId: 'rifle', at: 0.2 + i * 1.5 }));
    },
  },

  scene_ambience: {
    duration: 30, env: 'street',
    description: '30 s of the Vardanek bed: wind, distant war rumble, artillery, far firefights, birds, tarp, creaks, a burning car nearby.',
    build(e, r) {
      const d = new AmbienceDirector(e, r);
      d.setEmitters({ fires: [v(9, -1, -7)], tarps: [v(-7, 2, -4)] });
      d.start(0, 2);
      // front-load a few events so the 30 s window is representative
      d.next[0] = 3; d.next[1] = 1.2; d.next[2] = 2.5; d.next[3] = 5; d.next[4] = 11; d.next[5] = 8;
      for (let t = 0; t < 29; t += 0.05) d.update(t);
    },
  },
};

for (const env of ['street', 'open', 'alley', 'room', 'hall']) {
  SCENES[`scene_env_${env}`] = {
    duration: 4.5, env,
    description: `Player rifle burst + single shot in the "${env}" reverb preset.`,
    build(e) {
      burst(e, 0.2, 3, 780, (t) => e.playerShot({ weaponId: 'rifle', surface: 'concrete', feet: FEET, at: t }));
      e.playerShot({ weaponId: 'rifle', surface: 'concrete', feet: FEET, at: 1.7 });
    },
  };
}
