import { THREE, clamp, rand } from './core.js';

const DIFFICULTY_PRESETS = {
  easy:   { turnSkill:0.35, throttle:0.55, noise:0.35, reaction:0.35, altAvoid:0.6 },
  medium: { turnSkill:0.6,  throttle:0.75, noise:0.18, reaction:0.6,  altAvoid:0.8 },
  hard:   { turnSkill:0.85, throttle:0.92, noise:0.08, reaction:0.85, altAvoid:0.95 },
  ace:    { turnSkill:1.0,  throttle:1.0,  noise:0.02, reaction:1.0,  altAvoid:1.0 },
};

export class BotPilot {
  constructor(jet, difficulty='medium'){
    this.jet = jet;
    this.preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.medium;
    this.wobbleSeed = Math.random()*1000;
    this.boostCooldown = rand(2,6);
  }

  computeControls(targetCheckpoint, dt, waterHeightFn, worldTime){
    const jet = this.jet;
    if (!targetCheckpoint){
      return { pitch:0, roll:0, yaw:0, throttleUp:true, throttleDown:false, boost:false };
    }
    const toTarget = new THREE.Vector3().subVectors(targetCheckpoint.position, jet.position);
    const dist = toTarget.length();
    const dirWorld = toTarget.clone().normalize();

    // express desired direction in jet's local space
    const invQ = jet.quaternion.clone().invert();
    const localDir = dirWorld.clone().applyQuaternion(invQ);

    // desired yaw/pitch from local direction (localDir.z negative = ahead)
    const desiredYaw = Math.atan2(localDir.x, -localDir.z);   // + = need to turn right
    const desiredPitch = Math.atan2(-localDir.y, Math.hypot(localDir.x, -localDir.z));

    const skill = this.preset.turnSkill;
    const noise = this.preset.noise;

    const n1 = Math.sin(worldTime*0.7 + this.wobbleSeed) * noise;
    const n2 = Math.cos(worldTime*0.5 + this.wobbleSeed*1.3) * noise;

    // roll toward the direction with skill-scaled aggressiveness, bank into turns
    let rollTarget = clamp(desiredYaw*1.4 + n1, -1, 1);
    let pitchTarget = clamp(-desiredPitch*1.6 + n2, -1, 1); // positive pitchInput pulls the nose up toward the target
    let yawTarget = clamp(desiredYaw*0.5, -1, 1);

    rollTarget *= skill; pitchTarget *= skill; yawTarget *= skill*0.6;

    // sea-avoidance: if low altitude, prioritize pulling up hard regardless of target
    const waterY = waterHeightFn ? waterHeightFn(jet.position.x, jet.position.z, worldTime) : 0;
    const altAbove = jet.position.y - waterY;
    if (altAbove < 140){
      const urgency = clamp((140-altAbove)/100, 0, 1) * this.preset.altAvoid;
      pitchTarget = clamp(pitchTarget - urgency*1.2, -1, 1);
      rollTarget *= (1-urgency*0.6);
    }

    const turnSeverity = Math.abs(desiredYaw)+Math.abs(desiredPitch);
    const throttle = clamp(this.preset.throttle - (this.preset.reaction*0.15*Math.min(turnSeverity,1)), 0.3, 1);

    this.boostCooldown -= dt;
    let boost = false;
    if (dist > 500 && this.boostCooldown <= 0 && Math.abs(desiredYaw) < 0.3){
      boost = true;
      if (this.boostCooldown <= -1.5) this.boostCooldown = rand(4,9);
    }

    return {
      pitch: pitchTarget, roll: rollTarget, yaw: yawTarget,
      throttleUp: throttle > jet.throttle, throttleDown: throttle < jet.throttle - 0.05,
      boost,
    };
  }
}
