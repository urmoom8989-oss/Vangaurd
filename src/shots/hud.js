/**
 * Shot presets owned by the HUD agent. Names must start with "hud-".
 * Scripted HUD events are fired through `input: [{frame, call}]` so they land at deterministic
 * frames relative to the capture (capture happens after `warmup` frames).
 */
const H = (ctx) => ctx.services.hud;
const call = (frame, fn) => ({ frame, call: fn });

export default {
  'hud-gameplay': {
    description: 'Gameplay HUD: compass, minimap with enemy pings, ammo, crosshair, killfeed, wave panel, XP popup.',
    player: { position: [0, null, 8], yaw: 20, pitch: -2 },
    weapon: { state: 'hip' },
    warmup: 90,
    input: [
      call(0, (ctx) => {
        H(ctx).setMatchInfo?.({ wave: 3, hostiles: 7, lives: { left: 2, max: 2 }, score: 1850 });
        H(ctx).setObjective('Hold the plaza');
      }),
      call(20, (ctx) => H(ctx).killfeed({ killer: 'Kovac', victim: 'Vigil-2', weapon: 'rifle', killerTeam: 'enemy', victimTeam: 'friendly' })),
      call(40, (ctx) => H(ctx).killfeed({ killer: 'Vigil-1', victim: 'Drazen', weapon: 'rifle', headshot: true, victimTeam: 'enemy' })),
      call(40, (ctx) => {
        H(ctx).ping?.({ x: -9, z: -18 }, { duration: 30, kind: 'enemy' });
        H(ctx).ping?.({ x: 6, z: -24 }, { duration: 30, kind: 'enemy' });
        H(ctx).ping?.({ x: 14, z: -6 }, { duration: 30, kind: 'enemy' });
      }),
      call(72, (ctx) => {
        H(ctx).scorePopup?.(100, 'Kill');
        H(ctx).scorePopup?.(50, 'Headshot');
      }),
    ],
  },

  'hud-ads': {
    description: 'ADS: crosshair hidden, hitmarker on a target, ammo counter active.',
    player: { position: [0, null, 8], yaw: 0, pitch: -1 },
    weapon: { state: 'ads' },
    warmup: 60,
    input: [
      call(0, (ctx) => H(ctx).setMatchInfo?.({ wave: 3, hostiles: 6 })),
      call(57, (ctx) => H(ctx).hitmarker('hit')),
    ],
  },

  'hud-damage': {
    description: 'Taking fire from the left-rear and right: directional damage arcs, blood-edge vignette at low health.',
    player: { position: [0, null, 8], yaw: 0, pitch: -2 },
    weapon: { state: 'hip' },
    warmup: 110,
    input: [
      call(0, (ctx) => H(ctx).setMatchInfo?.({ wave: 5, hostiles: 11 })),
      call(40, (ctx) => ctx.services.player.damage(34, { source: 'ai:1', sourcePosition: { x: -14, y: 1.6, z: 16 } })),
      call(78, (ctx) => ctx.services.player.damage(24, { source: 'ai:2', sourcePosition: { x: 18, y: 1.6, z: 4 } })),
      call(98, (ctx) => ctx.services.player.damage(18, { source: 'ai:3', sourcePosition: { x: 2, y: 1.6, z: -20 } })),
    ],
  },

  'hud-killfeed': {
    description: 'Multi-kill moment: killfeed stack, red kill hitmarker, medal, XP popup chain.',
    player: { position: [0, null, 8], yaw: -15, pitch: -2 },
    weapon: { state: 'hip' },
    warmup: 80,
    input: [
      call(0, (ctx) => H(ctx).setMatchInfo?.({ wave: 4, hostiles: 5 })),
      call(10, (ctx) => H(ctx).killfeed({ killer: 'Sokol', victim: 'Vigil-3', weapon: 'lmg', killerTeam: 'enemy', victimTeam: 'friendly' })),
      call(30, (ctx) => H(ctx).killfeed({ killer: 'Vigil-2', victim: 'Radan', weapon: 'frag', kind: 'explosion', victimTeam: 'enemy' })),
      call(55, (ctx) => {
        H(ctx).killfeed({ killer: 'Vigil-1', victim: 'Merak', weapon: 'rifle', headshot: true, victimTeam: 'enemy' });
        H(ctx).scorePopup?.(100, 'Kill');
        H(ctx).scorePopup?.(50, 'Headshot');
      }),
      call(68, (ctx) => {
        H(ctx).killfeed({ killer: 'Vigil-1', victim: 'Tesar', weapon: 'pistol', victimTeam: 'enemy' });
        H(ctx).scorePopup?.(100, 'Kill');
        H(ctx).scorePopup?.(50, 'Multi kill');
        H(ctx).medal?.({ title: 'Double Kill', sub: '+50', kind: 'multi', tier: 2, count: 2 });
      }),
      call(77, (ctx) => H(ctx).hitmarker('kill')),
    ],
  },

  'hud-mainmenu': {
    description: 'Main menu over the live fly-through of the level.',
    weapon: { state: 'hip' },
    warmup: 150,
    input: [call(0, (ctx) => H(ctx).openMenu?.('main'))],
  },

  'hud-pause-settings': {
    description: 'Pause menu -> settings (graphics tab) over the blurred game.',
    player: { position: [0, null, 8], yaw: 30, pitch: -3 },
    weapon: { state: 'hip' },
    warmup: 30,
    input: [
      call(0, (ctx) => H(ctx).openMenu?.('pause')),
      call(2, (ctx) => H(ctx).openMenu?.('settings')),
    ],
  },

  'hud-pause': {
    description: 'Pause menu with operation stats.',
    player: { position: [0, null, 8], yaw: 30, pitch: -3 },
    weapon: { state: 'hip' },
    warmup: 30,
    input: [
      call(0, (ctx) => {
        H(ctx).setMatchInfo?.({ wave: 6, hostiles: 9, score: 5350, kills: 23, headshots: 7 });
        const st = H(ctx).stats;
        if (st) { st.shotsFired = 412; st.shotsHit = 131; st.combatTime = 754; }
      }),
      call(1, (ctx) => H(ctx).openMenu?.('pause')),
    ],
  },

  'hud-death': {
    description: 'Replay-first 3.5-second eliminator POV, then killer card, stats, and redeploy.',
    player: { position: [0, null, 8], yaw: 0, pitch: -3 },
    weapon: { state: 'hip' },
    warmup: 120,
    setup(ctx) {
      ctx.services.gamemode.state.matchType = 'tdm';
      const frames = [
        { t: 0, x: 5.5, y: 1.62, z: -18, cx: 5.75, cy: 1.66, cz: -17.69, yaw: -0.25, pitch: -0.02 },
        { t: 0.75, x: 5.8, y: 1.62, z: -18.5, cx: 6.04, cy: 1.66, cz: -18.20, yaw: -0.23, pitch: -0.01 },
        { t: 1.5, x: 6.1, y: 1.62, z: -19.2, cx: 6.34, cy: 1.66, cz: -18.91, yaw: -0.21, pitch: 0.01 },
        { t: 2.5, x: 6.2, y: 1.62, z: -19.5, cx: 6.44, cy: 1.66, cz: -19.21, yaw: -0.19, pitch: 0 },
        { t: 3.5, x: 6.5, y: 1.62, z: -20, cx: 6.75, cy: 1.66, cz: -19.72, yaw: -0.17, pitch: 0 },
      ];
      ctx.services.ai.getReplayFrames = () => frames.map((frame) => ({ ...frame }));
    },
    input: [
      call(0, (ctx) => H(ctx).setMatchInfo?.({ wave: 6, hostiles: 9, lives: { left: 1, max: 2 }, score: 5350, kills: 23, headshots: 7 })),
      call(5, (ctx) => ctx.services.player.damage(160, { source: 'ai:2', weaponId: 'rifle', sourcePosition: { x: 6, y: 1.6, z: -22 } })),
      call(119, (ctx) => {
        const position = H(ctx).getKillReplayCameraPosition?.();
        if (!position || position.x < 5.9 || position.x > 6.75) throw new Error(`killcam camera did not advance along the external attacker view: ${position?.x}`);
      }),
    ],
  },

  'hud-prompts': {
    description: 'Low ammo: amber mag count + reload prompt; interaction prompt with hold progress ring; enemy under crosshair (red).',
    player: { position: [0, null, 8], yaw: 0, pitch: -2 },
    weapon: { state: 'hip' },
    warmup: 60,
    setup(ctx) { const s = ctx.services.weapons.state; s.ammo = 6; },
    input: [
      call(0, (ctx) => {
        H(ctx).setMatchInfo?.({ wave: 2, hostiles: 4, score: 640 });
        // pseudo-agent on the posed soldier at the fountain (AI system may not spawn agents yet)
        const y = ctx.services.world.groundHeight?.(0, 0) ?? 0;
        if (H(ctx).debugAgents) H(ctx).debugAgents.push({ id: 'shot-dummy', alive: true, team: 'enemy', position: { x: 0, y, z: 0 } });
      }),
      call(1, (ctx) => { ctx.services.weapons.state.ammo = 6; }),
      call(30, (ctx) => H(ctx).setInteraction?.('Resupply ammunition', { progress: 0.42 })),
    ],
  },

  'hud-banner': {
    description: 'Wave start banner under the compass + killstreak medal + streak counter.',
    player: { position: [0, null, 8], yaw: 160, pitch: 0 },
    weapon: { state: 'hip' },
    warmup: 70,
    input: [
      call(0, (ctx) => H(ctx).setMatchInfo?.({ wave: 5, hostiles: 14, score: 4200, streak: 5 })),
      call(40, (ctx) => H(ctx).banner?.('Wave 5', { kicker: 'Hold Vardanek', sub: 'Heavy contact from the depot road', duration: 3.4 })),
      call(52, (ctx) => H(ctx).medal?.({ title: 'Iron Nerve', sub: '5 kill streak · +250', kind: 'streak', tier: 2 })),
    ],
  },
};
