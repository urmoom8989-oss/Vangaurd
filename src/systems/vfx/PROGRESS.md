# vfx — progress log (resume point for any agent)

## Audit (session 2)
Existing: ParticleBatch (CPU sim, instanced, sorted), lit 6-way smoke shader, glow batch, Debris (mesh particles),
Decals (instanced, normal-mapped atlas), MuzzleFlash rig (8 quads), LightPool, DustMotes, effects recipes, bake tools.

Problems found in audit shots:
- Weapon sockets are named `socket:muzzle` / `socket:eject` -> anchor resolver missed them and fell back to mesh bounds
  of an empty object (flash floated 0.25 m ahead of the gun in first person; auto-eject produced a 2nd shell).
- Explosion: fireball rose as a popcorn ball 3-4 m above the ground, disconnected from the dust; looked cartoony.
- Smoke atlas too dense (cotton balls, hard silhouettes); smoke grenade looked like beige cartoon clouds.
- Muzzle flash: blurry blob + lens-star glint; no flame structure.
- Bullet-hole decals: white paper-cutout spall rims. Scorch: hairy starburst. Blood splats: star shapes.
- vfx-shells preset camera framed the floor; shells not visible.
- Blood / scorch decals doubled (combat places its own decal and vfx placed one too).

## Done
(see below, updated as work lands)

## In progress / next
