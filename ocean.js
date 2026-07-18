import { THREE } from './core.js';

const VERT = /* glsl */`
uniform float uTime;
uniform vec2 uOffset;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vHeight;

float waveHeight(vec2 p, float t){
  float h = 0.0;
  h += sin(p.x*0.018 + t*1.1) * 1.6;
  h += sin(p.y*0.031 - t*0.85) * 1.05;
  h += sin((p.x+p.y)*0.014 + t*0.55) * 1.3;
  h += sin((p.x*0.7-p.y*0.6)*0.021 - t*0.7) * 0.9;
  h += sin(length(p)*0.006 - t*0.4) * 1.1;
  return h;
}

void main(){
  vec2 wp = position.xz + uOffset;
  float h = waveHeight(wp, uTime);
  vec3 pos = position;
  pos.y += h;

  float eps = 3.0;
  float hx = waveHeight(wp + vec2(eps,0.0), uTime);
  float hz = waveHeight(wp + vec2(0.0,eps), uTime);
  vec3 tangentX = normalize(vec3(eps, hx-h, 0.0));
  vec3 tangentZ = normalize(vec3(0.0, hz-h, eps));
  vNormal = normalize(cross(tangentZ, tangentX));

  vHeight = h;
  vec4 worldPos = modelMatrix * vec4(pos,1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
`;

const FRAG = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uSunColor;
uniform vec3 uCameraPos;
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vHeight;

void main(){
  vec3 viewDir = normalize(uCameraPos - vWorldPos);
  vec3 n = normalize(vNormal);
  float fresnel = pow(1.0 - clamp(dot(n, viewDir),0.0,1.0), 3.0);

  vec3 base = mix(uDeepColor, uShallowColor, clamp(vHeight*0.18+0.4,0.0,1.0));

  vec3 halfDir = normalize(uSunDir + viewDir);
  float spec = pow(max(dot(n, halfDir), 0.0), 120.0);
  float spec2 = pow(max(dot(n, halfDir), 0.0), 12.0) * 0.25;

  float sparkle = pow(max(dot(n, WORLD_UP_PLACEHOLDER), 0.0), 3.0);

  vec3 color = base + uSunColor * (spec*1.6 + spec2);
  color = mix(color, uShallowColor*1.4, fresnel*0.55);

  // Whitecap foam: steep, tall wave faces (where the normal tips far from vertical) get a
  // soft white highlight, same trick real-time ocean shaders use in lieu of simulating spray.
  float steepness = 1.0 - clamp(n.y, 0.0, 1.0);
  float foam = smoothstep(0.55, 0.9, steepness) * smoothstep(0.4, 1.8, vHeight);
  color = mix(color, vec3(0.92, 0.97, 0.98), foam * 0.55);

  float dist = length(uCameraPos - vWorldPos);
  float fog = smoothstep(400.0, 5200.0, dist);
  vec3 fogColor = vec3(0.55,0.68,0.72);
  color = mix(color, fogColor, fog*0.92);

  gl_FragColor = vec4(color, 1.0);
}
`.replace('WORLD_UP_PLACEHOLDER', 'vec3(0.0,1.0,0.0)');

export class Ocean {
  constructor(scene){
    const size = 6000;
    const segs = 180;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI/2);

    this.uniforms = {
      uTime:{ value:0 },
      uOffset:{ value:new THREE.Vector2(0,0) },
      uSunDir:{ value:new THREE.Vector3(0.4,0.6,0.35).normalize() },
      uDeepColor:{ value:new THREE.Color(0x02445e) },
      uShallowColor:{ value:new THREE.Color(0x1fb8c9) },
      uSunColor:{ value:new THREE.Color(0xfff3d6) },
      uCameraPos:{ value:new THREE.Vector3() },
    };
    const mat = new THREE.ShaderMaterial({
      vertexShader:VERT, fragmentShader:FRAG, uniforms:this.uniforms, side:THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = false;
    scene.add(this.mesh);

    // subtle secondary far plane to hide any horizon seam / ensure "vast sea" feel to the clip distance
    const farGeo = new THREE.PlaneGeometry(60000,60000,2,2);
    farGeo.rotateX(-Math.PI/2);
    const farMat = new THREE.MeshBasicMaterial({ color:0x1a4f63, fog:false });
    this.farMesh = new THREE.Mesh(farGeo, farMat);
    this.farMesh.position.y = -6;
    scene.add(this.farMesh);
  }
  update(dt, camera){
    this.uniforms.uTime.value += dt;
    // Recenter the detailed patch under the camera so the "vast sea" is effectively infinite
    this.mesh.position.x = camera.position.x;
    this.mesh.position.z = camera.position.z;
    this.uniforms.uOffset.value.set(this.mesh.position.x, this.mesh.position.z);
    this.uniforms.uCameraPos.value.copy(camera.position);
    this.farMesh.position.x = camera.position.x;
    this.farMesh.position.z = camera.position.z;
  }
  // approximate wave height at world x,z (cheap CPU mirror of the shader function, used for collision)
  heightAt(x,z,t){
    const p = [x, z];
    let h = 0;
    h += Math.sin(p[0]*0.018 + t*1.1) * 1.6;
    h += Math.sin(p[1]*0.031 - t*0.85) * 1.05;
    h += Math.sin((p[0]+p[1])*0.014 + t*0.55) * 1.3;
    h += Math.sin((p[0]*0.7-p[1]*0.6)*0.021 - t*0.7) * 0.9;
    h += Math.sin(Math.hypot(p[0],p[1])*0.006 - t*0.4) * 1.1;
    return h;
  }
}
