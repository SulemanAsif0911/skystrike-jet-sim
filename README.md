# SKYSTRIKE — Fighter Jet Simulator

## Changelog (this pass)

**Fixed: jets flying nose-backwards.** The auto-orientation code in `jet.js` built its
right/up/forward basis with a cross-product in the wrong order (`up × nose` instead of
`nose × up`). That produces a mirror-image (reflection) matrix rather than a real rotation —
and `THREE.Quaternion.setFromRotationMatrix()` can't represent a reflection, so it silently
produced a corrupted orientation. That's what made the nose appear to point at the camera. Fixed
by swapping the cross-product order (see the comment in `analyzeAndNormalize()` in `jet.js`). If
any *specific* model still looks off after this fix, the one-line `flip180: true` override per
jet in `JET_DEFS` (core.js) is still there as a safety net — but it shouldn't be needed now.

**More realistic graphics:**
- ACES filmic tone mapping + tuned exposure for photographic-looking highlights instead of the
  flat/washed-out default.
- A PMREM environment map baked from the sky dome, so the jets' PBR metal/glass materials now
  pick up real sky/horizon reflections instead of looking matte and flat.
- A bloom + FXAA post-processing pass (single-viewport mode) for glow on the sun, canopy glint,
  and afterburner flame, plus smoother edges.
- Engine core glow (brightens with throttle) and an afterburner flame that flares up while
  boosting.
- Wingtip contrails that stream off at high speed / while boosting.
- A soft contact shadow under the jet on the sea surface, shrinking/fading with altitude.
- Whitecap foam highlighting on steep wave faces in the ocean shader.
- Higher anisotropic texture filtering (uses the renderer's actual max) for crisper panel lines
  at oblique angles.


A browser-based 3D fighter jet racer built with Three.js, using your F-16C, F-35, and F-14
Sketchfab models flying low over a shader-animated open sea, racing through glowing checkpoint
rings against configurable AI bots — solo or local split-screen multiplayer.

## Running it

Browsers block `fetch()`/module imports of local files over `file://` for security, so you need
to serve the folder over local HTTP. From inside this folder, run whichever you have available:

```bash
# Python 3
python3 -m http.server 8080

# Node (no install needed)
npx serve .

# VS Code
# Right-click index.html -> "Open with Live Server"
```

Then open **http://localhost:8080** (or whatever port/URL your tool prints) in a recent version
of Chrome, Edge, or Firefox (needs import-map support — Chrome/Edge 105+, Firefox 108+, Safari
16.4+).

## Controls

**Pilot 1** (solo, or left/top screen in split-screen):
- `W` / `S` — pitch nose down / up
- `A` / `D` — roll left / right
- `Q` / `E` — yaw left / right
- `Shift` / `Ctrl` — throttle up / down
- `Space` — afterburner boost (limited fuel, regenerates)
- `C` — toggle 3rd-person / cockpit camera
- `Esc` — pause / resume

**Pilot 2** (split-screen only):
- Arrow keys — pitch / roll
- `,` / `.` — yaw left / right
- `[` / `]` — throttle down / up
- `/` — boost
- `M` — toggle camera view

## What's in the box

- `index.html` — page shell, menus, HUD markup/CSS
- `main.js` — boot sequence, menu wiring, race setup, game loop, split-screen rendering
- `core.js` — shared constants, math helpers, procedural WebAudio engine sound
- `ocean.js` — infinite shader-based sea (follows the camera, wave-driven vertex + lighting shader)
- `sky.js` — gradient sky dome, sun, clouds
- `checkpoints.js` — glowing "electric ring" checkpoints + circuit generator
- `jet.js` — model loading/auto-orientation & normalization, flight physics, camera rig
- `bot.js` — AI autopilot (Easy/Medium/Hard/Ace)
- `input.js` — two-player keyboard mapping
- `hud.js` — gauges, compass, altimeter, messages (built per split-screen viewport)
- `models/*.glb` — your three jets, re-exported through Draco compression + texture recompression
  (94MB/36MB/42MB → ~2MB/1.7MB/0.4MB) so they load fast in a browser

## Notes on the jet models

Each model is auto-analyzed at load time to detect which axis is "forward" (the nose vs. tail,
found from geometry, not assumptions) and rescaled to a consistent in-game size — so all three
jets behave consistently no matter how the original file was authored. If any jet ever appears to
fly nose-backwards, open `core.js` and flip `flip180: true` for that jet's entry in `JET_DEFS` —
one-line fix, no need to re-run anything.

The F-35 source mesh is far higher-poly (millions of triangles, largely un-simplifiable — it's
built from many small disconnected greebled shapes rather than one continuous surface) than the
F-16/F-14, so **bots favor the lighter F-16/F-14 models** to keep multi-bot races and split-screen
smooth; the F-35 still shows up in rotation, just less often, and you can always fly it yourself.
If you hit a performance wall with lots of bots, pick F-16 or F-14 as your own jet too.

## Gameplay notes

- Checkpoints are big glowing light-blue rings; the compass at the bottom of each viewport always
  points to the next one, with distance and altitude-delta readouts.
- Flying too low over the water triggers a splash/crash penalty (brief speed loss + control lockout).
- A race ends 2 seconds after the first pilot (human or bot) completes every checkpoint; final
  standings are ranked by finish time, then by checkpoints completed for anyone still flying.
- Everything (bot count, difficulty, checkpoint count, circuit spread, jet choice per pilot) is
  configurable on the Mission Setup screen before launch.
