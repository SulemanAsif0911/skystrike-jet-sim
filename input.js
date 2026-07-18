const keys = new Set();

window.addEventListener('keydown', e=>{
  keys.add(e.code);
  if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', e=>{ keys.delete(e.code); });
window.addEventListener('blur', ()=>{ keys.clear(); });

export function isDown(code){ return keys.has(code); }

// Player 1: WASD pitch/roll, Q/E yaw, Shift/Ctrl throttle, Space boost, C camera
export function p1Controls(){
  return {
    pitch: (isDown('KeyS')?1:0) + (isDown('KeyW')?-1:0),
    roll: (isDown('KeyD')?1:0) + (isDown('KeyA')?-1:0),
    yaw: (isDown('KeyE')?1:0) + (isDown('KeyQ')?-1:0),
    throttleUp: isDown('ShiftLeft') || isDown('ShiftRight'),
    throttleDown: isDown('ControlLeft') || isDown('ControlRight'),
    boost: isDown('Space'),
  };
}
export function p1CameraToggleJustPressed(){ return consumeEdge('KeyC'); }
export function p1PauseJustPressed(){ return consumeEdge('Escape'); }

// Player 2 (split-screen): Arrow keys pitch/roll, ,/. yaw, ]/[ throttle, / boost, M camera
export function p2Controls(){
  return {
    pitch: (isDown('ArrowDown')?1:0) + (isDown('ArrowUp')?-1:0),
    roll: (isDown('ArrowRight')?1:0) + (isDown('ArrowLeft')?-1:0),
    yaw: (isDown('Period')?1:0) + (isDown('Comma')?-1:0),
    throttleUp: isDown('BracketRight'),
    throttleDown: isDown('BracketLeft'),
    boost: isDown('Slash'),
  };
}
export function p2CameraToggleJustPressed(){ return consumeEdge('KeyM'); }

// simple edge-detection helper (fires once per physical keypress, ignoring OS auto-repeat and held state)
const heldState = {}; const pendingEdge = {};
window.addEventListener('keydown', e=>{
  if (!heldState[e.code]){ heldState[e.code] = true; pendingEdge[e.code] = true; }
});
window.addEventListener('keyup', e=>{ heldState[e.code] = false; });
function consumeEdge(code){
  if (pendingEdge[code]){ pendingEdge[code] = false; return true; }
  return false;
}
