import { clamp, fmtTime } from './core.js';

const COMPASS_CARDINALS = [
  {label:'N', deg:0}, {label:'E', deg:90}, {label:'S', deg:180}, {label:'W', deg:270},
];

export function buildHud(root, label){
  const wrap = document.createElement('div');
  wrap.className = 'viewport-hud';
  wrap.innerHTML = `
    <div class="vh-top-left">
      <div class="vh-label">${label}</div>
      <div class="gauge-cluster">
        <div class="gauge">
          <div class="g-label">Speed</div>
          <div class="g-val"><span class="v-speed">0</span></div>
          <div class="g-unit">u/s</div>
          <div class="throttle-bar-wrap"><div class="throttle-bar-fill v-throttle"></div></div>
        </div>
        <div class="gauge">
          <div class="g-label">Camera</div>
          <div class="g-val" style="font-size:13px;" class="v-camlabel"><span class="v-camlabel">3RD</span></div>
        </div>
      </div>
    </div>
    <div class="vh-top-right">
      <div class="checkpoint-counter">
        <div class="cc-label">Checkpoint</div>
        <div class="cc-val"><span class="v-cpidx">0</span>/<span class="v-cptotal">0</span></div>
      </div>
      <div class="race-timer v-time">0:00.0</div>
    </div>
    <div class="altimeter-wrap">
      <div class="altimeter"><div class="alt-fill v-altfill" style="height:0%"></div><div class="alt-marker" style="bottom:12%"></div></div>
      <div class="alt-text"><span class="v-alt">0</span> ALT</div>
    </div>
    <div class="crosshair"></div>
    <div class="compass-wrap">
      <div class="compass-ring">
        <div class="compass-dial v-compassdial">
          ${COMPASS_CARDINALS.map(c=>`<div class="compass-cardinal ${c.label==='N'?'N':''}" style="transform:translateX(-50%) rotate(${c.deg}deg)">${c.label}</div>`).join('')}
        </div>
        <div class="compass-needle v-needle"></div>
        <div class="compass-center-dot"></div>
      </div>
      <div class="compass-readout"><span>DIST <b class="v-dist">--</b></span><span>ALT&Delta; <b class="v-altdelta">--</b></span></div>
    </div>
    <div class="boost-bar-wrap">
      <div class="boost-label">Boost</div>
      <div class="boost-bar"><div class="boost-fill v-boost" style="width:100%"></div></div>
    </div>
    <div class="message-banner v-banner">
      <div class="big v-bannerbig"></div>
      <div class="small v-bannersmall"></div>
    </div>
  `;
  root.appendChild(wrap);

  const q = sel=>wrap.querySelector(sel);
  const el = {
    speed:q('.v-speed'), throttle:q('.v-throttle'), camlabel:q('.v-camlabel'),
    cpidx:q('.v-cpidx'), cptotal:q('.v-cptotal'), time:q('.v-time'),
    altfill:q('.v-altfill'), alt:q('.v-alt'),
    compassdial:q('.v-compassdial'), needle:q('.v-needle'),
    dist:q('.v-dist'), altdelta:q('.v-altdelta'),
    boost:q('.v-boost'),
    banner:q('.v-banner'), bannerbig:q('.v-bannerbig'), bannersmall:q('.v-bannersmall'),
  };

  let bannerTimeout = null;
  function showBanner(big, small, duration=1600){
    el.bannerbig.textContent = big;
    el.bannersmall.textContent = small || '';
    el.banner.classList.add('show');
    clearTimeout(bannerTimeout);
    bannerTimeout = setTimeout(()=>el.banner.classList.remove('show'), duration);
  }

  function update(jet, checkpoints, totalCheckpoints){
    el.speed.textContent = Math.round(jet.speed);
    el.throttle.style.width = `${Math.round(jet.throttle*100)}%`;
    el.camlabel.textContent = jet.cameraMode === 'first' ? '1ST' : '3RD';
    el.cpidx.textContent = Math.min(jet.checkpointIndex, totalCheckpoints);
    el.cptotal.textContent = totalCheckpoints;
    el.time.textContent = fmtTime(jet.raceClock);

    const altVal = Math.max(0, jet.position.y);
    el.alt.textContent = Math.round(altVal);
    el.altfill.style.height = `${clamp(altVal/1200*100,0,100)}%`;

    el.boost.style.width = `${Math.round(jet.boostFuel*100)}%`;

    const target = checkpoints[jet.checkpointIndex];
    if (target && !jet.finished){
      const dx = target.position.x - jet.position.x;
      const dz = target.position.z - jet.position.z;
      const dist = Math.hypot(dx,dz, target.position.y-jet.position.y);
      el.dist.textContent = `${Math.round(dist)}m`;
      el.altdelta.textContent = `${target.position.y - jet.position.y > 0 ? '+' : ''}${Math.round(target.position.y - jet.position.y)}m`;

      const jetForward = jet.forward;
      const heading = Math.atan2(jetForward.x, -jetForward.z);
      const bearing = Math.atan2(dx, -dz);
      let rel = bearing - heading;
      while (rel > Math.PI) rel -= Math.PI*2;
      while (rel < -Math.PI) rel += Math.PI*2;

      el.compassdial.style.transform = `rotate(${-heading*180/Math.PI}deg)`;
      el.needle.style.transform = `rotate(${rel*180/Math.PI}deg)`;
    } else {
      el.dist.textContent = '--';
      el.altdelta.textContent = '--';
    }
  }

  return { root: wrap, update, showBanner };
}

export function setViewportRect(hud, xPct, yPct, wPct, hPct){
  hud.root.style.left = `${xPct*100}%`;
  hud.root.style.top = `${yPct*100}%`;
  hud.root.style.width = `${wPct*100}%`;
  hud.root.style.height = `${hPct*100}%`;
}
