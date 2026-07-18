import { THREE } from './core.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main(){
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
}
`;
const SKY_FRAG = /* glsl */`
varying vec3 vDir;
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
void main(){
  float h = clamp(vDir.y*0.5+0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h,0.55));
  float sunAmt = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 220.0);
  float sunHalo = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 8.0) * 0.35;
  col += vec3(1.0,0.92,0.72) * (sunAmt*2.2 + sunHalo);
  gl_FragColor = vec4(col,1.0);
}
`;

export function buildSky(scene){
  const geo = new THREE.SphereGeometry(20000, 24, 16);
  const uniforms = {
    uTop:{ value:new THREE.Color(0x1a5c9e) },
    uHorizon:{ value:new THREE.Color(0xbfe3e8) },
    uSunDir:{ value:new THREE.Vector3(0.4,0.6,0.35).normalize() },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader:SKY_VERT, fragmentShader:SKY_FRAG, uniforms, side:THREE.BackSide, fog:false, depthWrite:false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  scene.add(mesh);

  const sun = new THREE.DirectionalLight(0xfff2da, 2.2);
  sun.position.copy(uniforms.uSunDir.value).multiplyScalar(3000);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(0xbfe3e8, 0x0c2233, 0.85);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0xffffff, 0.25);
  scene.add(amb);

  return { mesh, uniforms, sun, hemi };
}

// simple cloud sprites scattered around for extra sense of scale
export function buildClouds(scene){
  const group = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(128,64,10,128,64,120);
  grad.addColorStop(0,'rgba(255,255,255,0.95)');
  grad.addColorStop(0.5,'rgba(255,255,255,0.55)');
  grad.addColorStop(1,'rgba(255,255,255,0.0)');
  ctx.fillStyle = grad; ctx.fillRect(0,0,256,128);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map:tex, transparent:true, depthWrite:false, opacity:0.8, fog:false });

  const clouds = [];
  for (let i=0;i<60;i++){
    const s = new THREE.Sprite(mat);
    const ang = Math.random()*Math.PI*2;
    const dist = rand(400, 4500);
    s.position.set(Math.cos(ang)*dist, rand(180,900), Math.sin(ang)*dist);
    const sc = rand(150,420);
    s.scale.set(sc, sc*0.5, 1);
    group.add(s);
    clouds.push(s);
  }
  scene.add(group);
  function rand(a,b){ return a+Math.random()*(b-a); }
  return { group, clouds, follow(camPos){
    group.position.x = 0; group.position.z = 0; // static field is fine given large spread + fog
  }};
}
