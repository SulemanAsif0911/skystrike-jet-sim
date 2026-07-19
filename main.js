import { THREE, GLTFLoader, JET_DEFS, TARGET_JET_LENGTH, CHECKPOINT_TRIGGER_DIST, clamp, lerp, rand, fmtTime, audio } from './core.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { Ocean } from './ocean.js';
import { buildSky, buildClouds } from './sky.js';
import { generateCircuit } from './checkpoints.js';
import { JetTemplate, Jet } from './jet.js';
import { BotPilot } from './bot.js';
import { buildHud, setViewportRect } from './hud.js';
import * as Input from './input.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

/* ------------------------------ DOM refs ------------------------------ */
const canvas = document.getElementById('gl');
const loadingScreen = document.getElementById('loading-screen');
const loadbarFill = document.getElementById('loadbar-fill');
const loadpct = document.getElementById('loadpct');
const mainMenu = document.getElementById('main-menu');
const setupScreen = document.getElementById('setup-screen');
const hudLayer = document.getElementById('hud-layer');
const splitDivider = document.getElementById('split-divider');
const pauseScreen = document.getElementById('pause-screen');
const resultsScreen = document.getElementById('results-screen');
const resultList = document.getElementById('result-list');

/* ------------------------------ renderer / scene ------------------------------ */
const renderer = new THREE.WebGLRenderer({ canvas, antialias:true, powerPreference:'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Filmic tone mapping gives highlights (sun glare, canopy glint, afterburner) a much more
// photographic rolloff instead of the flat/washed-out look of the default linear mapping.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
const MAX_ANISOTROPY = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x8fc3cc, 1800, 6200);

const ocean = new Ocean(scene);
const sky = buildSky(scene);
const clouds = buildClouds(scene);

// Bake the sky dome into a PMREM environment map once, so every PBR jet material (metal
// fuselage, glass canopy) picks up realistic sky/horizon reflections instead of looking flat.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
pmremGenerator.compileEquirectangularShader();
{
  const envScene = new THREE.Scene();
  envScene.add(sky.mesh.clone());
  const envRT = pmremGenerator.fromScene(envScene, 0.02, 1, 25000);
  scene.environment = envRT.texture;
  pmremGenerator.dispose();
}

let idleCamAngle = 0;
const idleCamera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.5, 20000);

/* ------------------------------ post-processing (single-viewport only) ------------------------------ */
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, idleCamera);
composer.addPass(renderPass);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.6, 0.86);
composer.addPass(bloomPass);
const fxaaPass = new ShaderPass(FXAAShader);
fxaaPass.renderToScreen = true;
composer.addPass(fxaaPass);

function resize(){
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  idleCamera.aspect = w/h;
  idleCamera.updateProjectionMatrix();
  composer.setSize(w, h);
  const pr = renderer.getPixelRatio();
  fxaaPass.material.uniforms['resolution'].value.set(1/(w*pr), 1/(h*pr));
  bloomPass.setSize(w, h);
}
window.addEventListener('resize', resize);
resize();

/* ------------------------------ state machine ------------------------------ */
let appState = 'loading'; // loading | menu | setup | playing | paused | results
let config = {
  mode: 'solo',
  players: [ { jetId:'f16' } ],
  botCount: 2,
  botDifficulty: 'medium',
  checkpointCount: 8,
  circuitSpread: 2,
};

/* ------------------------------ model loading ------------------------------ */
const jetTemplates = {};

function loadJetTemplates(onProgress){
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://unpkg.com/three@0.161.0/examples/jsm/libs/draco/gltf/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(draco);

  const progressPerFile = {};
  JET_DEFS.forEach(d=>progressPerFile[d.id]=0);
  function reportProgress(){
    const total = JET_DEFS.length;
    const sum = JET_DEFS.reduce((a,d)=>a+progressPerFile[d.id],0);
    onProgress(sum/total);
  }

  return Promise.all(JET_DEFS.map(def=>new Promise((resolve,reject)=>{
    loader.load(def.file, gltf=>{
      jetTemplates[def.id] = new JetTemplate(def, gltf, MAX_ANISOTROPY);
      progressPerFile[def.id] = 1; reportProgress();
      resolve();
    }, evt=>{
      if (evt.total){ progressPerFile[def.id] = clamp(evt.loaded/evt.total,0,1); reportProgress(); }
    }, err=>{
      console.error('Failed to load', def.file, err);
      reject(err);
    });
  })));
}

/* ------------------------------ race runtime state ------------------------------ */
let race = null; // { participants:[...], checkpoints:[...], viewports:[...], startTime, finished:false }

function buildPlayersConfigUI(){
  const container = document.getElementById('players-config');
  const numPlayers = config.mode === 'split' ? 2 : 1;
  while (config.players.length < numPlayers) config.players.push({ jetId:'f16' });
  config.players.length = numPlayers;

  container.innerHTML = '';
  for (let i=0;i<numPlayers;i++){
    const block = document.createElement('div');
    block.className = 'player-block';
    block.innerHTML = `
      <div class="ptitle">Pilot ${i+1}${numPlayers>1?'':''} — ${i===0?'WASD / Q,E / Shift,Ctrl / C':'Arrows / , . / [ ] / M'}</div>
      <div class="jet-grid" data-player="${i}"></div>
    `;
    const grid = block.querySelector('.jet-grid');
    JET_DEFS.forEach(def=>{
      const card = document.createElement('div');
      card.className = 'jet-card' + (config.players[i].jetId===def.id ? ' selected':'');
      card.dataset.jet = def.id;
      card.innerHTML = `<div class="jet-silhouette">✈️</div><div class="jetname">${def.name}</div><div class="jetdesc">${def.desc}</div>`;
      card.addEventListener('click', ()=>{
        config.players[i].jetId = def.id;
        [...grid.children].forEach(c=>c.classList.toggle('selected', c.dataset.jet===def.id));
      });
      grid.appendChild(card);
    });
    container.appendChild(block);
  }

  document.getElementById('controls-recap').innerHTML = `
    <label class="head">Controls</label>
    <div class="controls-hint">
      <b>Pilot 1:</b> W/S pitch · A/D roll · Q/E yaw · Shift/Ctrl throttle · Space boost · C camera view · Esc pause<br>
      <b>Pilot 2 (split-screen):</b> Arrows pitch/roll · , / . yaw · [ / ] throttle · / boost · M camera view
    </div>`;
}

/* ------------------------------ menu wiring ------------------------------ */
document.querySelectorAll('.mode-card').forEach(card=>{
  card.addEventListener('click', ()=>{
    document.querySelectorAll('.mode-card').forEach(c=>c.classList.remove('selected'));
    card.classList.add('selected');
    config.mode = card.dataset.mode;
  });
});
document.getElementById('btn-to-setup').addEventListener('click', ()=>{
  buildPlayersConfigUI();
  appState = 'setup'; showScreen('setup-screen');
});
document.getElementById('btn-back-menu').addEventListener('click', ()=>{ appState='menu'; showScreen('main-menu'); });

const botCountEl = document.getElementById('bot-count');
const botCountVal = document.getElementById('bot-count-val');
botCountEl.addEventListener('input', ()=>{ config.botCount = +botCountEl.value; botCountVal.textContent = botCountEl.value; });

document.querySelectorAll('#bot-difficulty button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('#bot-difficulty button').forEach(b=>b.classList.remove('on'));
    btn.classList.add('on'); config.botDifficulty = btn.dataset.v;
  });
});

const cpCountEl = document.getElementById('checkpoint-count');
const cpCountVal = document.getElementById('checkpoint-count-val');
cpCountEl.addEventListener('input', ()=>{ config.checkpointCount = +cpCountEl.value; cpCountVal.textContent = cpCountEl.value; });

const spreadEl = document.getElementById('circuit-spread');
const spreadVal = document.getElementById('circuit-spread-val');
const spreadLabels = {1:'Tight',2:'Standard',3:'Vast'};
spreadEl.addEventListener('input', ()=>{ config.circuitSpread = +spreadEl.value; spreadVal.textContent = spreadLabels[spreadEl.value]; });
spreadVal.textContent = spreadLabels[spreadEl.value];

document.getElementById('btn-launch').addEventListener('click', ()=>{ startRace(); });

document.getElementById('btn-resume').addEventListener('click', ()=>{ resumeRace(); });
document.getElementById('btn-restart').addEventListener('click', ()=>{ startRace(true); });
document.getElementById('btn-quit').addEventListener('click', ()=>{ endToMenu(); });
document.getElementById('btn-again').addEventListener('click', ()=>{ startRace(); });
document.getElementById('btn-results-menu').addEventListener('click', ()=>{ endToMenu(); });

function endToMenu(){
  teardownRace();
  appState = 'menu'; showScreen('main-menu');
}

/* ------------------------------ race construction ------------------------------ */
function teardownRace(){
  if (!race) return;
  race.participants.forEach(p=>{ p.jet.dispose(); });
  race.checkpoints.forEach(cp=>cp.dispose(scene));
  hudLayer.innerHTML = '';
  hudLayer.classList.add('hidden');
  splitDivider.classList.add('hidden');
  race = null;
}

function startRace(){
  teardownRace();
  audio.ensure();

  const startPos = new THREE.Vector3(0, 160, 0);
  const startHeading = 0;
  const checkpoints = generateCircuit(scene, config.checkpointCount, config.circuitSpread, startPos, startHeading);

  const participants = [];
  const numHumans = config.mode === 'split' ? 2 : 1;

  for (let i=0;i<numHumans;i++){
    const tmpl = jetTemplates[config.players[i].jetId];
    const jet = new Jet(scene, tmpl, { isPlayer:true, playerIndex:i, name:`Pilot ${i+1}`, cameraMode:'third' });
    const offsetX = (i - (numHumans-1)/2) * 46;
    jet.spawn(startPos.clone().add(new THREE.Vector3(offsetX,0,20)), startHeading);
    participants.push({ jet, isHuman:true, playerIndex:i, bot:null });
  }

  // F35's source mesh is far higher-poly than the other two jets and can't be simplified further
  // without visible damage, so bots favor the lighter F16/F14 models to keep multi-bot and
  // split-screen framerates healthy; F35 still appears, just less often.
  const botJetCycle = ['f16','f14','f16','f35','f14','f16'];
  for (let i=0;i<config.botCount;i++){
    const def = JET_DEFS.find(d=>d.id===botJetCycle[i % botJetCycle.length]) || JET_DEFS[0];
    const tmpl = jetTemplates[def.id];
    const jet = new Jet(scene, tmpl, { isBot:true, name:`Bot ${i+1} (${def.name})`, cameraMode:'third' });
    const offsetX = (i+numHumans - (numHumans+config.botCount-1)/2) * 46;
    jet.spawn(startPos.clone().add(new THREE.Vector3(offsetX,0,-40 - i*10)), startHeading);
    const bot = new BotPilot(jet, config.botDifficulty);
    participants.push({ jet, isHuman:false, bot });
  }

  // viewports
  hudLayer.innerHTML = '';
  hudLayer.classList.remove('hidden');
  const viewports = [];
  if (config.mode === 'split'){
    splitDivider.classList.remove('hidden');
    splitDivider.style.left = '0'; splitDivider.style.top = '50%'; splitDivider.style.width='100%'; splitDivider.style.height='2px';
    const hud0 = buildHud(hudLayer, 'PILOT 1'); setViewportRect(hud0, 0,0,1,0.5);
    const hud1 = buildHud(hudLayer, 'PILOT 2'); setViewportRect(hud1, 0,0.5,1,0.5);
    viewports.push({ jet:participants[0].jet, hud:hud0, rect:[0,0.5,1,0.5] }); // x,y,w,h in GL coords (y from bottom)
    viewports.push({ jet:participants[1].jet, hud:hud1, rect:[0,0,1,0.5] });
  } else {
    splitDivider.classList.add('hidden');
    const hud0 = buildHud(hudLayer, participants[0].jet.name.toUpperCase()); setViewportRect(hud0, 0,0,1,1);
    viewports.push({ jet:participants[0].jet, hud:hud0, rect:[0,0,1,1] });
  }

  race = {
    participants, checkpoints, viewports,
    clock: 0, ended:false, worldTime:0,
    activeIndices: new Set([0]),
  };

  appState = 'playing';
  showScreen('__none__');
  pauseScreen.classList.add('hidden'); resultsScreen.classList.add('hidden');
}

function pauseRace(){ if (appState!=='playing') return; appState='paused'; showScreenOverlayOnly('pause-screen'); }
function resumeRace(){ if (appState!=='paused') return; appState='playing'; hideOverlay('pause-screen'); }
function showScreenOverlayOnly(id){ document.getElementById(id).classList.remove('hidden'); }
function hideOverlay(id){ document.getElementById(id).classList.add('hidden'); }

/* ------------------------------ checkpoint / race logic ------------------------------ */
function updateCheckpointProgress(p){
  const jet = p.jet;
  if (jet.finished) return;
  const target = race.checkpoints[jet.checkpointIndex];
  if (!target) return;
  const d = jet.position.distanceTo(target.position);
  if (d < CHECKPOINT_TRIGGER_DIST){
    jet.checkpointIndex++;
    const vp = race.viewports.find(v=>v.jet===jet);
    if (jet.checkpointIndex >= race.checkpoints.length){
      jet.finished = true;
      jet.finishTime = jet.raceClock;
      audio.finishFanfare();
      if (vp) vp.hud.showBanner('CIRCUIT COMPLETE', `${fmtTime(jet.finishTime)}`, 3000);
      checkRaceEnd();
    } else {
      audio.checkpointChime();
      if (vp) vp.hud.showBanner(`CHECKPOINT ${jet.checkpointIndex}/${race.checkpoints.length}`, 'Next waypoint locked', 1200);
    }
    recomputeActiveCheckpoints();
  }
}

function recomputeActiveCheckpoints(){
  const idxSet = new Set();
  race.participants.forEach(p=>{ if (!p.jet.finished) idxSet.add(p.jet.checkpointIndex); });
  race.checkpoints.forEach((cp,i)=>cp.setActive(idxSet.has(i)));
}

let raceEndedAt = 0;
function checkRaceEnd(){
  if (race.ended) return;
  race.ended = true;
  raceEndedAt = performance.now();
}

function buildResults(){
  const rows = [...race.participants].map(p=>({
    name: p.jet.name, finished: p.jet.finished, time: p.jet.finishTime,
    idx: p.jet.checkpointIndex, dist: p.jet.position.distanceTo((race.checkpoints[p.jet.checkpointIndex]||race.checkpoints[race.checkpoints.length-1]).position),
    isHuman: p.isHuman,
  }));
  rows.sort((a,b)=>{
    if (a.finished && b.finished) return a.time - b.time;
    if (a.finished) return -1;
    if (b.finished) return 1;
    if (a.idx !== b.idx) return b.idx - a.idx;
    return a.dist - b.dist;
  });
  resultList.innerHTML = rows.map((r,i)=>`
    <div class="result-row ${i===0?'win':''}">
      <div class="place">${i+1}</div>
      <div class="name">${r.name}${r.isHuman?' (You)':''}</div>
      <div class="time">${r.finished ? fmtTime(r.time) : `CP ${r.idx}/${race.checkpoints.length}`}</div>
    </div>`).join('');
}

/* ------------------------------ render helpers ------------------------------ */
function renderSplit(){
  const w = renderer.domElement.clientWidth, h = renderer.domElement.clientHeight;
  renderer.setScissorTest(true);
  race.viewports.forEach(vp=>{
    const [x,y,rw,rh] = vp.rect;
    const px = Math.round(x*w), py = Math.round(y*h), pw = Math.round(rw*w), ph = Math.round(rh*h);
    renderer.setViewport(px,py,pw,ph);
    renderer.setScissor(px,py,pw,ph);
    vp.jet.camera.aspect = pw/ph;
    vp.jet.camera.updateProjectionMatrix();
    renderer.render(scene, vp.jet.camera);
  });
  renderer.setScissorTest(false);
}

/* ------------------------------ main loop ------------------------------ */
const clock = new THREE.Clock();
function animate(){
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.08);

  const escPressed = Input.p1PauseJustPressed();
  if (escPressed){
    if (appState === 'playing') pauseRace();
    else if (appState === 'paused') resumeRace();
  }

  if (appState === 'playing' && race){
    race.worldTime += dt;

    race.participants.forEach(p=>{
      const jet = p.jet;
      let controls;
      if (p.isHuman){
        controls = p.playerIndex === 1 ? Input.p2Controls() : Input.p1Controls();
        const toggled = p.playerIndex === 1 ? Input.p2CameraToggleJustPressed() : Input.p1CameraToggleJustPressed();
        if (toggled) jet.toggleCamera();
      } else {
        const target = race.checkpoints[jet.checkpointIndex];
        controls = p.bot.computeControls(target, dt, (x,z,t)=>ocean.heightAt(x,z,t), race.worldTime);
      }
      jet.setControls(controls);
      jet.update(dt, (x,z,t)=>ocean.heightAt(x,z,t), race.worldTime);
      updateCheckpointProgress(p);
    });

    race.checkpoints.forEach(cp=>cp.update(dt));
    ocean.update(dt, race.viewports[0].jet.camera);

    const audioSource = race.participants.find(p=>p.isHuman && (p.playerIndex??0)===0) || race.participants.find(p=>p.isHuman);
    if (audioSource){
      const aj = audioSource.jet;
      const speedFrac = clamp((aj.speed - aj.minSpeed) / (aj.maxSpeed - aj.minSpeed), 0, 1);
      audio.update(speedFrac, aj.boosting);
    }

    race.viewports.forEach(vp=>vp.hud.update(vp.jet, race.checkpoints, race.checkpoints.length));

    if (race.ended && performance.now() - raceEndedAt > 2200){
      buildResults();
      appState = 'results';
      resultsScreen.classList.remove('hidden');
    }

    renderer.setScissorTest(false);
    if (race.viewports.length > 1) renderSplit();
    else {
      const jetCam = race.viewports[0].jet.camera;
      jetCam.aspect = renderer.domElement.clientWidth / renderer.domElement.clientHeight;
      jetCam.updateProjectionMatrix();
      renderer.setViewport(0,0,renderer.domElement.clientWidth, renderer.domElement.clientHeight);
      renderPass.camera = jetCam;
      composer.render();
    }
  } else if (appState === 'paused' && race){
    ocean.update(0, race.viewports[0].jet.camera);
    if (race.viewports.length > 1) renderSplit();
    else {
      const jetCam = race.viewports[0].jet.camera;
      renderPass.camera = jetCam;
      composer.render();
    }
  } else {
    // idle render (menu backdrop) using a slowly orbiting camera over the ocean
    idleCamAngle += dt*0.03;
    idleCamera.position.set(Math.sin(idleCamAngle)*260, 90, Math.cos(idleCamAngle)*260);
    idleCamera.lookAt(0,20,0);
    ocean.update(dt, idleCamera);
    renderer.setViewport(0,0,renderer.domElement.clientWidth, renderer.domElement.clientHeight);
    renderPass.camera = idleCamera;
    composer.render();
  }
}

/* ------------------------------ boot ------------------------------ */
loadJetTemplates(frac=>{
  const pct = Math.round(frac*100);
  loadbarFill.style.width = pct+'%';
  loadpct.textContent = pct+'%';
}).then(()=>{
  setTimeout(()=>{
    appState = 'menu';
    showScreen('main-menu');
  }, 250);
}).catch(err=>{
  loadpct.textContent = 'Failed to load models — check console (run via local server, not file://)';
  console.error(err);
});

function showScreen(id){
  const map = { 'loading-screen':loadingScreen, 'main-menu':mainMenu, 'setup-screen':setupScreen };
  Object.values(map).forEach(el=>el.classList.add('hidden'));
  if (map[id]) map[id].classList.remove('hidden');
  pauseScreen.classList.add('hidden');
  resultsScreen.classList.add('hidden');
}

animate();
