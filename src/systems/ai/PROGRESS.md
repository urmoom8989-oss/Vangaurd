# AI system — progress log

## State (audited this session)
Everything below exists and works (shots render with no system/console errors):
- character/: procedural sculpt (soldier.js, sculpt.js), builder w/ skin weights, 24-bone rig, SoldierBody
  (SkinnedMesh + invisible hitbox capsules under a hidden hitRoot + muzzle/eject anchors), one uber
  material (material.js: per-vertex material id palette + procedural DataArrayTexture detail + macro wrinkles),
  factory.js: 3 variants x 3 LODs (60k / 22k / 5.6k tris), 4 tints. Geometry is BAKED OFFLINE:
  `node tools/ai/bake.mjs` -> public/assets/ai/soldiers.bin (runtime fallback builds if missing).
  **Any change to soldier.js geometry requires re-running bake.mjs.**
- anim/: procedural Animator (gait, aim, recoil, reload, throw, hit springs), IK, verlet Ragdoll.
- brain/: agent.js (state machine: patrol/cover/standFire/peek/flank/grenade), squad.js, cover.js, config.js.
- index.js: spawn/pool, LOD pass w/ hysteresis, anim rate throttling, corpses sink, shot-config puppets/kills.
- Perf: 1 draw call per soldier (+shadow), ai cpu ~0.7 ms with 5 soldiers.
- Tools: tools/ai/probe.mjs (eval expr in a preset), tools/ai/summ.mjs (summarize shot JSON).

## Audit findings (critic view)
- Soldier reads as a flat dark clay figure: all parts nearly the same dark value; armband tiny.
- Limbs look thin/mannequin-like vs gear-bulky CoD enemies; crotch bulge visible in full-body view.
- Closeup preset framed in shade and crops the head.

## Work log
### Session 3 (resumed after usage-limit cut)
1. **Material calibration** (character/material.js, factory.js; runtime only, no rebake):
   - Soldiers rendered as flat light-khaki clay because (a) the scene is calibrated so linear ~0.2 is
     near white in sun (sun 15, AgX-like grade), and (b) a plain 4% dielectric specular dominated the
     dark albedos, so every part read as the same grey. Fixes: palette gets scaled in linear space
     (`ALBEDO_SCALE` 0.42, with per-id overrides for crimson/skin/metal); per-material specular scale
     `SPEC[]` (cloth 0.2-0.4, leather 0.55-0.6, metal 1) injected after `lights_physical_fragment`
     (r186 needs `specularColorBlended` scaled too); dirt made patchy, capped, and scaled to the scene;
     removed the additive `+0.01` edge-wear term that lifted black parts to grey; ripstop grid/MOLLE
     bartacks toned down (the pants read as waffle knit and the vest as bricks); stronger macro folds on
     fatigues (1.7); cavity AO 0.5. New tints: fatigues are mid olive/charcoal, the carrier is darker,
     gloves/balaclava/pads are near black.
2. **Crotch bulge removed**: TK rows 0.785-0.90 in soldier.js recessed/narrowed; soldiers.bin re-baked.
3. **ai-soldier-closeup reframed**: 3/4 front-left at 3 m, hfov 32. Head, rifle and armband are all in frame.
4. **Ragdoll launch bug fixed** (anim/ragdoll.js `guardEnergy`): ~0.3 s after landing, constraint and
   contact projection pumped energy and the corpse flew head-over-heels out of frame. Fix: cap net
   upward COM speed (2 m/s during the first 0.2 s, then 0.35 m/s), cap particle speed at 7 m/s, and
   apply a progressive settle damping after 0.8 s to particles on or near the ground. Traced with probe: the corpse now
   stays down and sleeps at ~3.6 s.
Shots: shots/ai/s3/ (close6, full5, death3, squad1).

## Next steps (prioritized)
1. Ragdoll: one leg still lifts and waves between 0.8 and 1.6 s while lying on the back. Suspects are
   `kneeHinge` (it pushes the knee along the foot direction, which points up when supine) and minD
   knee->chestTop/shoulder. Try: skip the hinge when the leg is nearly straight, or push only by half.
   Also the pre-fall "arms flung up" pose (frames at 200-400 ms) is too theatrical. Lower TONE_W for the
   arms or aim the impulse at the chest.
2. Boots still read as brown lumps (dirt 0.55-0.9 baked). Lower dirtBoot in soldier.js, add a
   visible welt/sole contrast, and rebake.
3. Knee pads use the STIPPLE layer (pebbly). Molded hard caps want a smooth low-roughness shell plus
   a strap.
4. Fatigue folds are still mostly a normal-map effect. Add geometric fold displacement at the elbows,
   the waist and the backs of the knees (soldier.js pantsRadius/sleeve), then rebake.
5. The closeup puppet's support arm is fully straight. Bend the elbow slightly (animator aim IK
   pole/elbow target).
