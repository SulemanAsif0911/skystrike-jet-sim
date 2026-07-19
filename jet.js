import { THREE, GLTFLoader, TARGET_JET_LENGTH, SEA_LEVEL, MIN_SAFE_ALT, WORLD_UP, clamp, lerp, degToRad, audio } from './core.js';

/* -------------------------------------------------------------------------
   Auto-orientation: figures out, from raw geometry, which local axis is
   "forward" (the long axis of the fuselage) and which end is the nose
   (the narrower / pointier end vs. the wider tail/wing end), then bakes a
   correction rotation + uniform scale so every jet model behaves the same
   way in-game regardless of how the source file was authored.
   ------------------------------------------------------------------------- */
function analyzeAndNormalize(root){
  root.updateWorldMatrix(true, true);

  // Sample world-space vertices (subsampled for perf on dense meshes)
  const pts = [];
  root.traverse(obj=>{
    if (!obj.isMesh || !obj.geometry || !obj.geometry.attributes.position) return;
    const pos = obj.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 6000)); // cap ~6000 samples per mesh
    const v = new THREE.Vector3();
    for (let i=0;i<pos.count;i+=step){
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      v.applyMatrix4(obj.matrixWorld);
      pts.push(v.x, v.y, v.z);
    }
  });

  const n = pts.length/3;
  let minX=Infinity,minY=Infinity,minZ=Infinity,maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for (let i=0;i<n;i++){
    const x=pts[i*3],y=pts[i*3+1],z=pts[i*3+2];
    if (x<minX)minX=x; if (x>maxX)maxX=x;
    if (y<minY)minY=y; if (y>maxY)maxY=y;
    if (z<minZ)minZ=z; if (z>maxZ)maxZ=z;
  }
  const size = new THREE.Vector3(maxX-minX, maxY-minY, maxZ-minZ);
  const center = new THREE.Vector3((minX+maxX)/2, (minY+maxY)/2, (minZ+maxZ)/2);

  // "up" is whichever axis has the smallest footprint relative to the other two combined AND
  // is not simply the smallest by accident — for aircraft the vertical extent is reliably the
  // smallest of the three dimensions (fuselage length and wingspan both exceed height).
  const dims = [ {axis:'x', val:size.x}, {axis:'y', val:size.y}, {axis:'z', val:size.z} ];
  const byAsc = [...dims].sort((a,b)=>a.val-b.val);
  const upAxis = byAsc[0].axis;              // smallest extent -> vertical (height)
  const remaining = byAsc.slice(1);
  // Of the two remaining (length vs wingspan), the longer one is the fuselage/forward axis
  // *unless* wingspan happens to exceed length (delta-wing / swing-wing jets) — to disambiguate
  // we use pointiness: the true nose-to-tail axis has one end much narrower than the other.
  function crossSectionArea(axisName, atMinEnd){
    const idxMap = {x:0,y:1,z:2};
    const idx = idxMap[axisName];
    const lo = [minX,minY,minZ][idx], hi=[maxX,maxY,maxZ][idx];
    const span = hi-lo;
    const t = atMinEnd ? lo+span*0.04 : hi-span*0.04;
    const tol = span*0.025 || 0.01;
    let cnt=0, o1min=Infinity,o1max=-Infinity,o2min=Infinity,o2max=-Infinity;
    const others = [0,1,2].filter(k=>k!==idx);
    for (let i=0;i<n;i++){
      const c = pts[i*3+idx];
      if (Math.abs(c - t) > tol) continue;
      const a = pts[i*3+others[0]], b = pts[i*3+others[1]];
      if (a<o1min)o1min=a; if(a>o1max)o1max=a;
      if (b<o2min)o2min=b; if(b>o2max)o2max=b;
      cnt++;
    }
    if (cnt < 3) return {area:Infinity, cnt};
    return { area:(o1max-o1min)*(o2max-o2min), cnt };
  }

  let fwdAxis, noseAtMin;
  const candidates = remaining.map(r=>r.axis);
  let best = null;
  for (const axisName of candidates){
    const a0 = crossSectionArea(axisName, true);
    const a1 = crossSectionArea(axisName, false);
    const ratio = Math.max(a0.area,1e-4) / Math.max(a1.area,1e-4);
    const asym = Math.abs(Math.log(ratio));
    if (!best || asym > best.asym){
      best = { axis:axisName, asym, noseAtMin: a0.area < a1.area };
    }
  }
  fwdAxis = best.axis; noseAtMin = best.noseAtMin;

  // Build rotation that maps: fwdAxis(nose direction) -> world -Z, upAxis -> world +Y
  const axisVec = (name, positive)=>{
    const v = new THREE.Vector3();
    if (name==='x') v.set(positive?1:-1,0,0);
    if (name==='y') v.set(0,positive?1:-1,0);
    if (name==='z') v.set(0,0,positive?1:-1);
    return v;
  };
  const noseLocal = axisVec(fwdAxis, !noseAtMin); // unit vector pointing FROM tail TO nose, in local space
  const upLocalRaw = axisVec(upAxis, true);
  // orthonormal local triad, built so {right, trueUp, noseLocal} is RIGHT-HANDED like three.js's
  // (+X right, +Y up, -Z forward) convention: right = nose x up, trueUp = right x nose.
  // (The previous order — up x nose / nose x right — produces a mirror-image basis with
  // determinant -1. THREE.Quaternion.setFromRotationMatrix() assumes a proper rotation matrix
  // and silently corrupts the result for a reflection, which is what made jets fly nose-backwards.)
  const right = new THREE.Vector3().crossVectors(noseLocal, upLocalRaw).normalize();
  const trueUp = new THREE.Vector3().crossVectors(right, noseLocal).normalize();

  // We want a rotation T such that T*right=(1,0,0), T*trueUp=(0,1,0), T*noseLocal=(0,0,-1)
  // (three.js forward convention is -Z). Since {right,trueUp,noseLocal} is orthonormal,
  // T*v = (right.v, trueUp.v, -(noseLocal.v)) satisfies exactly this for all three basis vectors.
  const m = new THREE.Matrix4().set(
    right.x, right.y, right.z, 0,
    trueUp.x, trueUp.y, trueUp.z, 0,
    -noseLocal.x, -noseLocal.y, -noseLocal.z, 0,
    0, 0, 0, 1
  );
  const correction = new THREE.Quaternion().setFromRotationMatrix(m);

  // scale: normalize using the fuselage length (the extent along fwdAxis)
  const lengthVal = size[fwdAxis];
  const scale = TARGET_JET_LENGTH / Math.max(lengthVal, 0.001);

  console.log(`[jet-orient] up=${upAxis} fwd=${fwdAxis} noseAtMin=${noseAtMin} asym=${best.asym.toFixed(2)} size=`, size);

  return { correction, scale, center, rawSize:size };
}

/* ----------------------- shared FX textures (built once, reused by every jet) ----------------------- */
let _glowTex = null;
function glowTexture(){
  if (_glowTex) return _glowTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(255,255,255,1)');
  g.addColorStop(0.35,'rgba(255,255,255,0.75)');
  g.addColorStop(1,'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
  _glowTex = new THREE.CanvasTexture(c);
  return _glowTex;
}
let _shadowTex = null;
function shadowTexture(){
  if (_shadowTex) return _shadowTex;
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0,'rgba(0,8,14,0.55)');
  g.addColorStop(0.55,'rgba(0,8,14,0.25)');
  g.addColorStop(1,'rgba(0,8,14,0)');
  ctx.fillStyle = g; ctx.fillRect(0,0,64,64);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}

export class JetTemplate {
  constructor(def, gltf, maxAnisotropy=8){
    this.def = def;
    const root = gltf.scene;
    const info = analyzeAndNormalize(root);

    // wrapper we can scale/rotate cleanly, keeping the imported hierarchy pristine inside
    const inner = new THREE.Group();
    inner.add(root);
    root.position.sub(info.center);
    inner.quaternion.copy(info.correction);
    if (def.flip180){
      inner.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), Math.PI));
    }
    inner.scale.setScalar(info.scale);

    root.traverse(o=>{
      if (o.isMesh){
        o.castShadow = false; o.receiveShadow = false;
        if (o.material){
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach(m=>{ if (m.map) m.map.anisotropy = maxAnisotropy; m.side = THREE.FrontSide; });
        }
      }
    });

    this.template = new THREE.Group();
    this.template.add(inner);

    // Recompute normalized bounding box for camera placement heuristics
    const box = new THREE.Box3().setFromObject(this.template);
    this.box = box; // in template-local space (post normalize/orient), pre any instance transform
    this.length = box.max.z - box.min.z; // should be ~TARGET_JET_LENGTH (forward is -Z so nose is min.z... check sign)
    // determine which end (min z or max z) is now the nose (should be -Z per our construction, i.e. min.z)
    this.noseZ = box.min.z;
    this.tailZ = box.max.z;
    this.halfWidth = (box.max.x - box.min.x)/2;
    this.topY = box.max.y;
    this.bottomY = box.min.y;
  }
  instantiate(){
    return this.template.clone(true);
  }
}

/* ------------------------------- Jet ------------------------------- */
export class Jet {
  constructor(scene, template, opts={}){
    this.scene = scene;
    this.template = template;
    this.object = template.instantiate();
    scene.add(this.object);

    this.isPlayer = !!opts.isPlayer;
    this.isBot = !!opts.isBot;
    this.playerIndex = opts.playerIndex ?? null;

    this.def = template.def;
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();

    this.speed = 40;
    this.throttle = 0.5;
    this.minSpeed = 22;
    this.maxSpeed = this.def.maxSpeed;
    this.accel = this.def.accel;
    this.turnRate = this.def.turnRate;

    this.pitchInput = 0; this.rollInput = 0; this.yawInput = 0;
    this.rollAngleSmoothed = 0;

    this.boosting = false;
    this.boostFuel = 1;
    this.crashedTimer = 0;

    this.checkpointIndex = 0;
    this.finished = false;
    this.finishTime = null;
    this.raceClock = 0;

    this.cameraMode = opts.cameraMode || 'third'; // 'third' | 'first'
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 24000);
    this.camPos = new THREE.Vector3();
    this.camLookAt = new THREE.Vector3();
    this._camInit = false;

    this.name = opts.name || this.def.name;
    this.color = opts.color || '#28f0ff';

    this._buildFx(template);
  }

  _buildFx(template){
    const scene = this.scene;

    // Engine core glow — always-on, brightens with throttle.
    const glowMat = new THREE.SpriteMaterial({ map:glowTexture(), color:0xffb066, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0 });
    this._engineGlow = new THREE.Sprite(glowMat);
    this._engineGlow.scale.setScalar(2.0);
    this._engineGlow.position.set(0, template.bottomY*0.12 + template.topY*0.06, template.tailZ*0.97);
    this.object.add(this._engineGlow);

    // Afterburner flame — only flares up while boosting.
    const flameMat = new THREE.SpriteMaterial({ map:glowTexture(), color:0x5fb4ff, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, opacity:0 });
    this._flame = new THREE.Sprite(flameMat);
    this._flame.scale.set(2.0, 6.5, 1);
    this._flame.position.set(0, template.bottomY*0.12 + template.topY*0.06, template.tailZ*1.05);
    this.object.add(this._flame);

    // Wingtip contrails — small pool of world-space puffs recycled as they age out.
    const wingX = template.halfWidth*0.9;
    const wingY = template.topY*0.05 + template.bottomY*0.05;
    const wingZ = template.length*0.02;
    this._trailAnchor = {
      L: new THREE.Vector3(-wingX, wingY, wingZ),
      R: new THREE.Vector3(wingX, wingY, wingZ),
    };
    const TRAIL_COUNT = 18;
    this._trailPool = { L:[], R:[] };
    ['L','R'].forEach(side=>{
      for (let i=0;i<TRAIL_COUNT;i++){
        const m = new THREE.SpriteMaterial({ map:glowTexture(), color:0xffffff, transparent:true, depthWrite:false, opacity:0 });
        const s = new THREE.Sprite(m);
        s.visible = false;
        scene.add(s);
        this._trailPool[side].push({ sprite:s, life:0, maxLife:1.6 });
      }
    });
    this._trailCursor = { L:0, R:0 };
    this._trailTimer = 0;

    // Contact shadow on the sea surface — cheap stand-in for a real shadow map over water.
    const shadowMat = new THREE.MeshBasicMaterial({ map:shadowTexture(), transparent:true, depthWrite:false, side:THREE.DoubleSide });
    this._shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1,1), shadowMat);
    this._shadowMesh.rotation.x = -Math.PI/2;
    this._shadowSize = Math.max(template.length, template.halfWidth*2) * 1.3;
    scene.add(this._shadowMesh);
  }

  _updateFx(dt, waterHeightFn, worldTime){
    const speedFrac = clamp((this.speed - this.minSpeed) / (this.maxSpeed - this.minSpeed), 0, 1);

    // Engine glow scales with throttle/speed, with a little flicker.
    const flicker = 0.9 + Math.sin(worldTime*23 + this.position.x*0.01)*0.1;
    const glowTarget = (0.18 + speedFrac*0.55) * flicker;
    this._engineGlow.material.opacity = lerp(this._engineGlow.material.opacity, glowTarget, clamp(dt*6,0,1));
    const glowScale = 1.5 + speedFrac*1.3;
    this._engineGlow.scale.setScalar(glowScale);

    // Afterburner flame flares when boosting, otherwise fades out.
    const flameTarget = this.boosting ? 0.85*flicker : 0;
    this._flame.material.opacity = lerp(this._flame.material.opacity, flameTarget, clamp(dt*10,0,1));
    const flameLen = 5.5 + Math.sin(worldTime*31)*1.2;
    this._flame.scale.set(1.8 + (this.boosting?0.6:0), this.boosting ? flameLen : 3, 1);

    // Wingtip contrails: spawn while boosting or flying fast, always advect/fade what's already out.
    this._trailTimer -= dt;
    const shouldEmit = (this.boosting || speedFrac > 0.82) && this.crashedTimer <= 0;
    if (shouldEmit && this._trailTimer <= 0){
      this._trailTimer = 0.045;
      ['L','R'].forEach(side=>{
        const worldPos = this._trailAnchor[side].clone().applyQuaternion(this.quaternion).add(this.position);
        const pool = this._trailPool[side];
        const idx = this._trailCursor[side];
        this._trailCursor[side] = (idx+1) % pool.length;
        const entry = pool[idx];
        entry.life = 0;
        entry.sprite.position.copy(worldPos);
        entry.sprite.scale.setScalar(1.4);
        entry.sprite.visible = true;
        entry.sprite.material.opacity = 0.42;
      });
    }
    ['L','R'].forEach(side=>{
      this._trailPool[side].forEach(entry=>{
        if (!entry.sprite.visible) return;
        entry.life += dt;
        if (entry.life >= entry.maxLife){
          entry.sprite.visible = false;
          entry.sprite.material.opacity = 0;
          return;
        }
        const t = entry.life / entry.maxLife;
        entry.sprite.material.opacity = 0.42 * (1-t);
        entry.sprite.scale.setScalar(1.4 + t*3.2);
      });
    });

    // Sea-surface contact shadow, fading and shrinking with altitude.
    const waterY = SEA_LEVEL + (waterHeightFn ? waterHeightFn(this.position.x, this.position.z, worldTime) : 0);
    const altAbove = this.position.y - waterY;
    if (altAbove > 700 || this.finished){
      this._shadowMesh.visible = false;
    } else {
      this._shadowMesh.visible = true;
      this._shadowMesh.position.set(this.position.x, waterY+0.6, this.position.z);
      const shrink = clamp(1 - altAbove/700, 0.18, 1);
      this._shadowMesh.scale.setScalar(this._shadowSize * shrink);
      this._shadowMesh.material.opacity = clamp(0.85 * shrink, 0.05, 0.85);
    }
  }

  dispose(){
    this.scene.remove(this.object);
    this.scene.remove(this._shadowMesh);
    this._shadowMesh.geometry.dispose(); this._shadowMesh.material.dispose();
    ['L','R'].forEach(side=>{
      this._trailPool[side].forEach(entry=>{
        this.scene.remove(entry.sprite);
        entry.sprite.material.dispose();
      });
    });
  }

  spawn(position, headingRad){
    this.position.copy(position);
    const q = new THREE.Quaternion().setFromAxisAngle(WORLD_UP, headingRad);
    this.quaternion.copy(q);
    this.speed = this.minSpeed + (this.maxSpeed-this.minSpeed)*0.35;
    this.throttle = 0.55;
    this.finished = false; this.finishTime = null; this.checkpointIndex = 0; this.raceClock = 0;
    this._syncObject();
  }

  get forward(){ return new THREE.Vector3(0,0,-1).applyQuaternion(this.quaternion); }
  get up(){ return new THREE.Vector3(0,1,0).applyQuaternion(this.quaternion); }
  get right(){ return new THREE.Vector3(1,0,0).applyQuaternion(this.quaternion); }

  setControls(c){
    this.pitchInput = clamp(c.pitch||0,-1,1);
    this.rollInput = clamp(c.roll||0,-1,1);
    this.yawInput = clamp(c.yaw||0,-1,1);
    this.throttleUp = !!c.throttleUp;
    this.throttleDown = !!c.throttleDown;
    this.boosting = !!c.boost && this.boostFuel > 0.05;
  }

  update(dt, waterHeightFn, worldTime){
    if (this.finished){ this._updateCameraOnly(dt); this._updateFx(dt, waterHeightFn, worldTime); return; }
    this.raceClock += dt;

    if (this.crashedTimer > 0){
      this.crashedTimer -= dt;
      this.speed = lerp(this.speed, this.minSpeed*0.6, dt*1.5);
      this._integrate(dt, waterHeightFn, worldTime);
      this._syncObject();
      this._updateCamera(dt);
      this._updateFx(dt, waterHeightFn, worldTime);
      return;
    }

    // throttle
    if (this.throttleUp) this.throttle = clamp(this.throttle + dt*0.6, 0, 1);
    if (this.throttleDown) this.throttle = clamp(this.throttle - dt*0.6, 0, 1);

    // boost fuel
    if (this.boosting){ this.boostFuel = clamp(this.boostFuel - dt*0.35, 0, 1); }
    else { this.boostFuel = clamp(this.boostFuel + dt*0.14, 0, 1); }

    const targetSpeed = (this.minSpeed + (this.maxSpeed-this.minSpeed)*this.throttle) * (this.boosting?1.55:1);
    this.speed = lerp(this.speed, targetSpeed, clamp(dt*this.accel,0,1));

    // rotation: pitch about local right, yaw about local up, roll about local forward(-fwd = local Z axis is tail dir)
    const rollSpeed = this.turnRate * 1.15;
    const pitchSpeed = this.turnRate * 0.85;
    const yawSpeed = this.turnRate * 0.5;

    const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), -this.rollInput*rollSpeed*dt);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), this.pitchInput*pitchSpeed*dt);
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), -this.yawInput*yawSpeed*dt);
    this.quaternion.multiply(qRoll).multiply(qPitch).multiply(qYaw);
    this.quaternion.normalize();

    // arcade auto-yaw coupling from bank angle (helps turns feel natural)
    const localRight = this.right;
    const bank = Math.asin(clamp(localRight.y, -1, 1)); // roughly bank angle
    this.rollAngleSmoothed = lerp(this.rollAngleSmoothed, bank, 0.15);
    const autoYaw = -this.rollAngleSmoothed * 0.7 * dt;
    const qAuto = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), autoYaw);
    this.quaternion.premultiply(qAuto); // apply the bank-into-turn yaw in world space

    this._integrate(dt, waterHeightFn, worldTime);
    this._syncObject();
    this._updateCamera(dt);
    this._updateFx(dt, waterHeightFn, worldTime);
  }

  _integrate(dt, waterHeightFn, worldTime){
    const fwd = this.forward;
    this.velocity.copy(fwd).multiplyScalar(this.speed);
    this.position.addScaledVector(this.velocity, dt);

    const waterY = SEA_LEVEL + (waterHeightFn ? waterHeightFn(this.position.x, this.position.z, worldTime) : 0);
    if (this.position.y < waterY + MIN_SAFE_ALT){
      if (this.crashedTimer <= 0){
        this.crashedTimer = 1.1;
        this.speed *= 0.35;
        audio.splash();
        this._onSplash && this._onSplash();
      }
      this.position.y = waterY + MIN_SAFE_ALT;
      // nose up a bit on impact
      const pitchUp = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), -0.6*dt);
      this.quaternion.multiply(pitchUp);
    }
    const CEILING = 3200;
    if (this.position.y > CEILING) this.position.y = CEILING;
  }

  _syncObject(){
    this.object.position.copy(this.position);
    this.object.quaternion.copy(this.quaternion);
  }

  _updateCameraOnly(dt){ this._updateCamera(dt); }

  _updateCamera(dt){
    const t = this.template;
    let desiredPos, desiredLook, fov;
    if (this.cameraMode === 'first'){
      // Cockpit eye point — canopy height, sitting back from the nose tip rather than at it
      // (a real cockpit is set back behind the radome/intakes, not out at the very point).
      const cockpitZ = lerp(t.tailZ, t.noseZ, 0.58);
      const localOffset = new THREE.Vector3(0, t.topY*0.55, cockpitZ);
      desiredPos = localOffset.clone().applyQuaternion(this.quaternion).add(this.position);
      desiredLook = desiredPos.clone().add(this.forward.clone().multiplyScalar(200));
      fov = 75;
    } else {
      const behind = Math.max(28, t.length*1.9);
      const localOffset = new THREE.Vector3(0, t.topY + 7, behind);
      desiredPos = localOffset.clone().applyQuaternion(this.quaternion).add(this.position);
      desiredLook = this.position.clone().add(this.forward.clone().multiplyScalar(t.length*1.2)).add(new THREE.Vector3(0,t.topY*0.3,0));
      fov = 62;
    }
    // Fixed camera: rigidly locked to the jet's current transform every frame — no
    // positional/rotational lag and no speed-based FOV zoom, so it reads as bolted-on rather
    // than a floaty chase-cam.
    this.camPos.copy(desiredPos);
    this.camLookAt.copy(desiredLook);
    this._camInit = true;

    this.camera.position.copy(this.camPos);
    this.camera.up.set(0,1,0);
    this.camera.lookAt(this.camLookAt);
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }
  toggleCamera(){ this.cameraMode = this.cameraMode==='third' ? 'first' : 'third'; this._camInit=false; }

  distanceTo(pointVec3){ return this.position.distanceTo(pointVec3); }
}
