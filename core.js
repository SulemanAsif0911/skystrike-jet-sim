import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* =========================================================================
   SKYSTRIKE — Fighter Jet Simulator
   Single-module game engine.
   ========================================================================= */

/* ---------------------------- constants ---------------------------- */
// flip180: manual safety-net — flip to true for a given jet if it ever appears to fly nose-backwards
// (auto-orientation detects the nose from geometry, but you can override it here in one line).
const JET_DEFS = [
  { id:'f16', name:'F-16C Block 50', file:'models/f16.glb', desc:'Agile multirole fighter', maxSpeed:210, accel:0.9, turnRate:2.6, flip180:false },
  { id:'f35', name:'F-35 Lightning II', file:'models/f35.glb', desc:'Stealth strike fighter', maxSpeed:195, accel:0.8, turnRate:2.3, flip180:false },
  { id:'f14', name:'F-14 Tomcat', file:'models/f14.glb', desc:'Heavy swing-wing interceptor', maxSpeed:225, accel:0.7, turnRate:2.0, flip180:false },
];
const TARGET_JET_LENGTH = 18;         // normalized in-game length (meters-ish) of every jet model
const SEA_LEVEL = 0;
const MIN_SAFE_ALT = 6;               // below this over the wave surface = crash/splash
const CHECKPOINT_RADIUS = 130;
const CHECKPOINT_TUBE = 7;
const CHECKPOINT_TRIGGER_DIST = 140;  // sphere trigger radius
const WORLD_UP = new THREE.Vector3(0,1,0);

const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const lerp = (a,b,t)=>a+(b-a)*t;
const rand = (a,b)=>a+Math.random()*(b-a);
const degToRad = THREE.MathUtils.degToRad;
const radToDeg = THREE.MathUtils.radToDeg;

function fmtTime(sec){
  if (sec == null || !isFinite(sec)) return '--:--.-';
  const m = Math.floor(sec/60);
  const s = (sec - m*60).toFixed(1).padStart(4,'0');
  return `${m}:${s}`;
}

/* ---------------------------- procedural audio ---------------------------- */
class FlightAudio {
  constructor(){
    this.ctx = null; this.engineOsc = null; this.engineGain = null; this.windGain = null; this.started = false;
  }
  ensure(){
    if (this.started) return;
    this.started = true;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    const ctx = this.ctx;

    // engine drone: two detuned saws through a lowpass, amplitude/pitch tied to throttle+speed
    this.master = ctx.createGain(); this.master.gain.value = 0.35; this.master.connect(ctx.destination);

    this.engineOsc = ctx.createOscillator(); this.engineOsc.type = 'sawtooth'; this.engineOsc.frequency.value = 60;
    this.engineOsc2 = ctx.createOscillator(); this.engineOsc2.type = 'sawtooth'; this.engineOsc2.frequency.value = 61.5;
    this.engineFilter = ctx.createBiquadFilter(); this.engineFilter.type='lowpass'; this.engineFilter.frequency.value = 500;
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0.0;
    this.engineOsc.connect(this.engineFilter); this.engineOsc2.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain); this.engineGain.connect(this.master);
    this.engineOsc.start(); this.engineOsc2.start();

    // wind noise
    const bufSize = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i=0;i<bufSize;i++) data[i] = Math.random()*2-1;
    this.noise = ctx.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true;
    this.windFilter = ctx.createBiquadFilter(); this.windFilter.type='bandpass'; this.windFilter.frequency.value=800; this.windFilter.Q.value=0.6;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0.0;
    this.noise.connect(this.windFilter); this.windFilter.connect(this.windGain); this.windGain.connect(this.master);
    this.noise.start();
  }
  update(speedFrac, boosting){
    if (!this.started) return;
    const t = this.ctx.currentTime;
    this.engineOsc.frequency.setTargetAtTime(50 + speedFrac*140, t, 0.08);
    this.engineOsc2.frequency.setTargetAtTime(51.5 + speedFrac*141, t, 0.08);
    this.engineFilter.frequency.setTargetAtTime(400 + speedFrac*2200, t, 0.1);
    this.engineGain.gain.setTargetAtTime(0.12 + speedFrac*0.22 + (boosting?0.1:0), t, 0.1);
    this.windGain.gain.setTargetAtTime(0.03 + speedFrac*0.22, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(500 + speedFrac*3000, t, 0.15);
  }
  blip(freqStart, freqEnd, dur, gainAmt=0.25, type='sine'){
    if (!this.started) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator(); osc.type = type;
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20,freqEnd), ctx.currentTime+dur);
    g.gain.setValueAtTime(gainAmt, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+dur);
    osc.connect(g); g.connect(this.master);
    osc.start(); osc.stop(ctx.currentTime+dur+0.02);
  }
  checkpointChime(){ this.blip(660,1320,0.35,0.3,'triangle'); setTimeout(()=>this.blip(880,1760,0.3,0.22,'triangle'),80); }
  splash(){
    if (!this.started) return;
    const ctx = this.ctx;
    const bufSize = ctx.sampleRate*0.4;
    const buf = ctx.createBuffer(1,bufSize,ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i=0;i<bufSize;i++) d[i] = (Math.random()*2-1) * (1 - i/bufSize);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter(); filt.type='lowpass'; filt.frequency.value=1200;
    const g = ctx.createGain(); g.gain.value = 0.5;
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start();
  }
  finishFanfare(){ this.blip(440,880,0.2,0.3,'square'); setTimeout(()=>this.blip(660,1320,0.25,0.3,'square'),150); setTimeout(()=>this.blip(880,1760,0.4,0.32,'square'),320); }
}
const audio = new FlightAudio();

export { THREE, GLTFLoader, JET_DEFS, TARGET_JET_LENGTH, SEA_LEVEL, MIN_SAFE_ALT, CHECKPOINT_RADIUS,
  CHECKPOINT_TUBE, CHECKPOINT_TRIGGER_DIST, WORLD_UP, clamp, lerp, rand, degToRad, radToDeg, fmtTime, audio };
