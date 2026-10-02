import * as THREE from 'three';

const SNAPSHOT_INTERVAL = 0.1;

export default function createSystem(ctx) {
  const { events, scene } = ctx;
  const remotes = new Map();
  let session = null;
  let localPlayerId = null;
  let sendClock = 0;

  function emitSend(message) {
    events.emit('network:send', message);
  }

  function makeNameplate(name, team) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 96;
    const g = canvas.getContext('2d');
    g.fillStyle = 'rgba(8,12,14,.78)';
    g.fillRect(0, 10, canvas.width, 76);
    g.fillStyle = team === 'alpha' ? '#76c9ff' : '#ff766b';
    g.fillRect(0, 10, 7, 76);
    g.font = '700 34px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillStyle = '#f3efe4';
    g.fillText(String(name || 'Player').slice(0, 20), 24, 48, 455);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(material);
    sprite.position.y = 2.25;
    sprite.scale.set(1.6, 0.3, 1);
    return sprite;
  }

  function makeRemote(member) {
    const group = new THREE.Group();
    group.name = `remote-player:${member.id}`;
    const primary = member.team === 'alpha' ? 0x467f9e : 0x963f38;
    const cloth = new THREE.MeshStandardMaterial({ color: primary, roughness: 0.84, metalness: 0.04 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x252a28, roughness: 0.92 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x9b765d, roughness: 0.88 });
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.72, 3, 8), cloth);
    torso.position.y = 1.06;
    torso.castShadow = true;
    torso.userData.zone = 'torso';
    group.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), skin);
    head.position.y = 1.72;
    head.castShadow = true;
    head.userData.zone = 'head';
    group.add(head);
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.185, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.58), dark);
    helmet.position.y = 1.77;
    helmet.castShadow = true;
    group.add(helmet);
    for (const x of [-0.34, 0.34]) {
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.085, 0.48, 2, 6), cloth);
      arm.position.set(x, 1.04, 0.02);
      arm.rotation.z = x < 0 ? -0.13 : 0.13;
      arm.castShadow = true;
      group.add(arm);
      const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.55, 2, 6), dark);
      leg.position.set(x * 0.48, 0.45, 0);
      leg.castShadow = true;
      group.add(leg);
    }
    const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.72), dark);
    rifle.position.set(0, 1.24, -0.42);
    rifle.rotation.x = -0.08;
    group.add(rifle);
    const muzzleMaterial = new THREE.MeshBasicMaterial({ color: 0xffb44d, transparent: true, opacity: 0 });
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), muzzleMaterial);
    muzzle.position.set(0, 1.25, -0.82);
    group.add(muzzle);
    group.add(makeNameplate(member.name, member.team));
    scene.add(group);
    const initial = new THREE.Vector3();
    const remote = {
      id: member.id,
      name: member.name,
      team: member.team,
      group,
      torso,
      head,
      muzzle,
      target: initial.clone(),
      hasState: false,
      yaw: 0,
      pitch: 0,
      targetYaw: 0,
      targetPitch: 0,
      alive: true,
      fireFlash: 0,
      materials: [cloth, dark, skin, muzzleMaterial],
      damageable: null,
    };
    remote.damageable = ctx.services.combat.registerDamageable({
      object: group,
      hitboxes: [torso, head],
      health: 100,
      maxHealth: 100,
      team: member.team === 'alpha' ? 'blue' : 'red',
      key: `player:${member.id}`,
      name: member.name,
      isPlayer: true,
      onDamage(amount, info) {
        emitSend({ type: 'player_hit', targetId: member.id, amount, zone: info?.zone || 'torso' });
      },
      onDeath() { group.visible = false; },
    });
    remotes.set(member.id, remote);
    return remote;
  }

  function disposeRemote(remote) {
    remote.damageable?.unregister?.();
    scene.remove(remote.group);
    remote.group.traverse((object) => {
      object.geometry?.dispose();
      if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose());
      else object.material?.dispose();
      object.material?.map?.dispose();
    });
    remotes.delete(remote.id);
  }

  function setSession(match) {
    if (session?.matchId === match?.matchId) return;
    clearSession();
    if (!match?.matchId || !Array.isArray(match.roster)) return;
    session = match;
    localPlayerId = match.playerId;
    for (const member of match.roster) {
      if (!member?.id || member.id === localPlayerId) continue;
      makeRemote(member);
    }
  }

  function clearSession() {
    for (const remote of remotes.values()) disposeRemote(remote);
    session = null;
  }

  function receiveState(message) {
    if (!session || message.matchId && message.matchId !== session.matchId) return;
    const remote = remotes.get(message.playerId);
    const state = message.state;
    if (!remote || !state || ![state.x, state.y, state.z, state.yaw, state.pitch].every(Number.isFinite)) return;
    remote.target.set(state.x, state.y, state.z);
    remote.targetYaw = state.yaw;
    remote.targetPitch = state.pitch;
    remote.alive = state.alive !== false;
    remote.group.visible = remote.alive;
    if (!remote.hasState) {
      remote.group.position.copy(remote.target);
      remote.yaw = state.yaw;
      remote.hasState = true;
    }
  }

  function onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'player_state') receiveState(message);
    else if (message.type === 'player_damaged' && session?.matchId === message.matchId) {
      if (message.targetId === localPlayerId) {
        ctx.services.player.damage(message.amount, {
          source: `player:${message.attackerId}`,
          type: 'bullet',
          zone: message.zone,
          network: true,
        });
      } else {
        const remote = remotes.get(message.targetId);
        if (remote?.damageable) {
          remote.damageable.health = message.health;
          remote.damageable.alive = message.health > 0;
          remote.group.visible = message.health > 0;
        }
      }
    } else if (message.type === 'player_respawned' && session?.matchId === message.matchId) {
      const remote = remotes.get(message.playerId);
      if (remote) {
        remote.damageable.health = 100;
        remote.damageable.alive = true;
        remote.group.visible = true;
        const state = message.state;
        if (state && [state.x, state.y, state.z].every(Number.isFinite)) {
          remote.target.set(state.x, state.y, state.z);
          remote.hasState = true;
        }
      }
    } else if (message.type === 'match_score' && session?.matchId === message.matchId) {
      events.emit('network:score', message);
    } else if (message.type === 'player_left' && (!session || message.matchId === session.matchId)) {
      const player = remotes.get(message.playerId);
      if (player) disposeRemote(player);
    } else if (message.type === 'weapon_fired' && (!session || message.matchId === session.matchId)) {
      const remote = remotes.get(message.playerId);
      if (remote) remote.fireFlash = 0.12;
    } else if (message.type === 'match_left') clearSession();
  }

  const onWeaponFired = (event) => {
    if (!session) return;
    emitSend({ type: 'weapon_fired', weaponId: event?.weaponId });
  };
  const onPlayerRespawn = (event) => {
    if (!session) return;
    const p = event?.position;
    if (p && [p.x, p.y, p.z].every(Number.isFinite)) emitSend({ type: 'player_respawn', position: { x: p.x, y: p.y, z: p.z } });
  };
  const onGamemodeStart = () => { if (session) emitSend({ type: 'player_ready' }); };
  const onNetworkMessage = (message) => onMessage(message);
  const onNetworkSession = (match) => setSession(match);
  const onNetworkClear = () => clearSession();

  return {
    name: 'network',
    init() {
      events.on('network:message', onNetworkMessage);
      events.on('network:session', onNetworkSession);
      events.on('network:clear', onNetworkClear);
      events.on('weapon:fired', onWeaponFired);
      events.on('player:respawn', onPlayerRespawn);
      events.on('gamemode:start', onGamemodeStart);
    },
    update(dt) {
      if (!session) return;
      const gameStage = ctx.services.gamemode.state?.stage;
      if (!['match-live', 'match-dead'].includes(gameStage)) return;
      const player = ctx.services.player.state;
      sendClock += dt;
      if (sendClock >= SNAPSHOT_INTERVAL) {
        sendClock %= SNAPSHOT_INTERVAL;
        const p = player.position;
        emitSend({
          type: 'player_state',
          state: {
            position: { x: p.x, y: p.y, z: p.z },
            yaw: player.yaw,
            pitch: player.pitch,
            stance: player.stance,
            moving: !!player.moving,
            sprinting: !!player.sprinting,
            weaponId: ctx.services.weapons.state?.id,
            alive: player.alive !== false,
          },
        });
      }
      for (const remote of remotes.values()) {
        if (!remote.hasState) continue;
        remote.group.position.lerp(remote.target, Math.min(1, dt * 12));
        const angle = Math.atan2(Math.sin(remote.targetYaw - remote.yaw), Math.cos(remote.targetYaw - remote.yaw));
        remote.yaw += angle * Math.min(1, dt * 12);
        remote.group.rotation.y = remote.yaw;
        remote.head.rotation.x += (remote.targetPitch - remote.head.rotation.x) * Math.min(1, dt * 12);
        remote.fireFlash = Math.max(0, remote.fireFlash - dt);
        remote.muzzle.material.opacity = remote.fireFlash > 0 ? Math.min(0.95, remote.fireFlash * 9) : 0;
      }
    },
    dispose() {
      events.off('network:message', onNetworkMessage);
      events.off('network:session', onNetworkSession);
      events.off('network:clear', onNetworkClear);
      events.off('weapon:fired', onWeaponFired);
      events.off('player:respawn', onPlayerRespawn);
      events.off('gamemode:start', onGamemodeStart);
      clearSession();
    },
    get state() { return { active: !!session, matchId: session?.matchId || null, players: remotes.size }; },
  };
}
