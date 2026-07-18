import { THREE, CHECKPOINT_RADIUS, CHECKPOINT_TUBE, CHECKPOINT_TRIGGER_DIST, SEA_LEVEL, clamp, rand } from './core.js';

const RING_VERT = /* glsl */`
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}
`;
const RING_FRAG = /* glsl */`
varying vec2 vUv;
uniform float uTime;
uniform vec3 uColor;
uniform float uActive;
float rand1(float n){ return fract(sin(n)*43758.5453123); }
void main(){
  float ang = vUv.x;
  float band = floor(ang*36.0);
  float flick = rand1(band + floor(uTime*10.0));
  float streak = smoothstep(0.80, 1.0, flick);
  float pulse = 0.55 + 0.45*sin(uTime*2.4 + ang*24.0);
  vec3 base = uColor * pulse;
  vec3 col = base + streak * vec3(0.75,1.0,1.0) * 2.2;
  float edge = smoothstep(0.0,0.15,vUv.y) * smoothstep(1.0,0.85,vUv.y);
  float alpha = (0.45 + streak*0.55) * mix(0.5,1.0,edge) * (0.55 + uActive*0.6);
  gl_FragColor = vec4(col, alpha);
}
`;

function ringMaterial(color, uniforms){
  return new THREE.ShaderMaterial({
    vertexShader: RING_VERT, fragmentShader: RING_FRAG,
    uniforms, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide,
  });
}

export class Checkpoint {
  constructor(scene, index, position, lookTarget){
    this.index = index;
    this.position = position.clone();
    this.radius = CHECKPOINT_RADIUS;

    this.uniforms = { uTime:{value:0}, uColor:{value:new THREE.Color(0x28f0ff)}, uActive:{value:0} };
    const geo = new THREE.TorusGeometry(CHECKPOINT_RADIUS, CHECKPOINT_TUBE, 14, 90);
    this.mesh = new THREE.Mesh(geo, ringMaterial(0x28f0ff, this.uniforms));
    this.mesh.position.copy(this.position);
    this.mesh.lookAt(lookTarget);
    scene.add(this.mesh);

    // inner soft glow disc
    const glowGeo = new THREE.CircleGeometry(CHECKPOINT_RADIUS*0.92, 40);
    const glowMat = new THREE.MeshBasicMaterial({ color:0x28f0ff, transparent:true, opacity:0.05, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide });
    this.glow = new THREE.Mesh(glowGeo, glowMat);
    this.glow.position.copy(this.position);
    this.glow.lookAt(lookTarget);
    scene.add(this.glow);

    // number sprite
    this.mesh.userData.checkpointIndex = index;

    this.passed = false;
  }
  setActive(active){
    this.uniforms.uActive.value = active ? 1 : 0;
    this.mesh.visible = true;
    this.glow.visible = active;
  }
  update(dt){
    this.uniforms.uTime.value += dt;
    if (this.glow.visible){
      const s = 1 + Math.sin(this.uniforms.uTime.value*2)*0.03;
      this.glow.scale.set(s,s,1);
    }
  }
  dispose(scene){
    scene.remove(this.mesh); scene.remove(this.glow);
    this.mesh.geometry.dispose(); this.mesh.material.dispose();
    this.glow.geometry.dispose(); this.glow.material.dispose();
  }
}

// Generates a winding circuit of checkpoints over the sea with gentle altitude/heading variation.
export function generateCircuit(scene, count, spreadLevel, startPos, startHeadingRad){
  const checkpoints = [];
  const segMin = [500,650,800][spreadLevel-1] || 650;
  const segMax = [850,1050,1350][spreadLevel-1] || 1050;
  const altMin = 70, altMax = 420;

  let heading = startHeadingRad;
  let pos = startPos.clone().addScaledVector(new THREE.Vector3(Math.sin(heading),0,-Math.cos(heading)), 700);
  pos.y = rand(altMin, altMax);

  const positions = [pos.clone()];
  for (let i=1;i<count;i++){
    heading += rand(-0.62, 0.62); // limit turn sharpness so paths stay flyable
    const dist = rand(segMin, segMax);
    const next = pos.clone().addScaledVector(new THREE.Vector3(Math.sin(heading),0,-Math.cos(heading)), dist);
    next.y = clamp(pos.y + rand(-90,90), altMin, altMax);
    positions.push(next);
    pos = next;
  }

  for (let i=0;i<positions.length;i++){
    const lookTarget = positions[i+1] ? positions[i+1] : positions[i].clone().add(new THREE.Vector3(0,0,-100));
    const cp = new Checkpoint(scene, i, positions[i], lookTarget);
    cp.setActive(false);
    checkpoints.push(cp);
  }
  if (checkpoints[0]) checkpoints[0].setActive(true);
  return checkpoints;
}

export function checkpointTriggerDistance(){ return CHECKPOINT_TRIGGER_DIST; }
