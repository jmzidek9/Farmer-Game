# Harvest Haven — module contract

Browser game, plain ES modules, no build step. Served by `python -m http.server 8080` from the project root
(open http://localhost:8080). Three.js r170 from jsDelivr via the import map in `index.html`:

```html
<script type="importmap">{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"}}</script>
<script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js"></script>  <!-- window.Peer -->
```

Game design source of truth: the approved plan (`C:\Users\jmzid\.claude\plans\humble-tickling-clover-of-09efb226-fda3-4481-87ac-6aa5408ccd06.md`).
Every number is in `src/data.js`. Every rule is in `src/state.js` (read it — it is the API you call).

## Coordinates
- World units are metres. Y up. Farm grid: 40×40 tiles of 2 m; tile (i,j) centre = `tileX(i), tileZ(j)` from
  `src/terrain.js` (x = -40 + 2i + 1, z = -40 + 2j + 1). `tileAt(x,z)` → [i,j]. `heightAt(x,z)` → ground height.
- Island ~±100 m. Ocean at y = 0 (y = `TIDE_HIGH` 0.95 during a high-tide disaster). South beach z≈+80 (spawn,
  shipwreck at (10, 100) on a reef). Trader pier on the west beach: pier runs from x=-82 to x=-106 at z=12
  (`PIER` in data.js). Mountain to the north (z≈-116). River = tile columns 34–36 (x 28–34), runs north→south to the sea.
- Plots: 8×8 plots of 5×5 tiles. Starting plots (3,3),(4,3),(3,4),(4,4) = tiles 15–24.
- Models from Blender are in `assets/models.glb` (one named object each, origin at its base centre, facing −Y
  in Blender = **+Z in three.js** after the glTF Y-up conversion; "front" of buildings faces +Z (south)).

## Model names (assets/models.glb)
- `island` (terrain mesh, per-face material colours)
- Crops: `crop_<id>_<stage>` stage 0–3 for the 24 non-tree crops; trees: `tree_<id>_<stage>` (banana, coconut,
  orange, mango, apple, papaya). Stage from `stageOf(crop, now)` in state.js.
- Produce/icons: `produce_<cropId>`, `good_<id>` (bread, juice, sugar, cloth, chocolate, roastcoffee),
  `item_wood`, `item_stone`, `item_gem`, `item_coin`, `seed_packet` (material `tint` = recolour per crop), `sapling`.
- Scenery: `palm_a|b|c`, `jungle_a|b`, `rock_s|m|l`, `bush_a`, `fern`, `grass_tuft`, `flower_a|b|c`,
  `stump_tree`, `stump_palm`, `log`, `cloud_a|b`.
- Buildings: `farmhouse_1..5`, `barn`, `silo`, `well`, `market_stall`, `shop_stall`, `beach_shack`,
  `trader_pier`, `trader_boat`, `intro_ship`, `shipwreck`, `bakery`, `juicer`, `sugar_mill`, `loom`,
  `chocolate_maker`, `coffee_roaster`, `greenhouse`, `crop_cover`, `bridge` (deck runs along model Z — rotate 90°
  about Y so it spans the river along X), `sea_wall`, `lightning_rod`, `rain_barrel`, `windbreak`, `raised_bed`,
  `sprinkler` + `sprinkler_head`, `sprinkler_big` + `sprinkler_big_head`, `scarecrow`, `auto_planter`,
  `harvester_bot` (the rover), `bot_dock` (the placed building), `conveyor`, `auto_market`, `fence`, `path`,
  `flowers`, `statue`, `sign_forsale`, `soil_tile`, `soil_fertile`, `quest_board`, `crate`, `barrel`, `lantern`,
  `fire`, `ruin_pillar`, `ruin_arch`, `journal`, `chest`.
- Tools/characters: `tool_hoe|axe|pickaxe|sickle|bucket|seeds|fertilizer|coinbag|blueprint|basket|broom`
  (material `metal` = recolour by tool level: broken #8a6a52 rust, normal #9aa3ab, iron #c9d2d8, golden #f2c94c),
  `fp_arm` (material `shirt` = outfit colour), `player` (material `shirt`), `trader`, `donkey`, `donkey_bags`,
  `donkey_cart`, `crow`.
- Special materials by name: `glass`, `net` (transparent), `emit_warm|emit_eye|emit_fire|emit_gold` (emissive,
  should bloom), `shirt`, `metal`, `tint` (recolourable), `sail`, `cloud`. Every other material is a flat colour
  named `c_rrggbb`.

## Look (cinematic, from the plan)
Peak-like low-poly, soft toon/cel lighting with soft gradient ramps, animated ocean (depth colour, shoreline foam,
waves, fresnel sky reflection, sun glint), wind sway on grass/palms/crops, soft shadows, cheap contact AO,
god rays through palms (High quality), dynamic 20-minute day/night with golden-hour sunsets, fog + bloom,
wet-soil darkening, outline/rim on the targeted interactable, storm/rain/lightning effects. Low/High graphics
setting; target 60 fps at High on a mid-range laptop. Tone mapping ACES, sRGB output.

UI direction (frontend-design + ui-ux-pro-max): rounded type — **Fredoka** (display) + **Nunito** (body) from
Google Fonts. Palette: driftwood glass panels `rgba(40,28,20,0.72)` with `backdrop-filter: blur(10px)`,
sail text `#F3E3C3`, lagoon `#2FB7B0` (primary), mango `#F2B33D` (coins/highlight), hibiscus `#E8536B`
(warnings), palm `#3F7D4A` (success), gem `#3FD0C9`. Generous radii on panels (16px) and slots (10px) — hierarchy,
not one radius everywhere. Icons are 3D thumbnails of the Blender models (no emoji). Sentence case, plain verbs.
One cinematic moment carries the boldness: the title screen over a slow island flyover with letterbox bars.
Visible keyboard focus, `prefers-reduced-motion` respected.

## The game object (`src/main.js`, owned by the lead) — what every module receives
```js
game = {
  state,                 // the world (shape in state.js newWorld). Treat as read-only outside game.do().
  pid,                   // this machine's player id; me = state.players[pid]
  role,                  // 'solo' | 'host' | 'guest'
  now(),                 // ms clock (guests: host-synced). Use this, never Date.now(), for game time.
  do(action),            // dispatch an action object {type, ...} (see state.js A.* for every type).
                         //   pid is added automatically. Result arrives async for guests; failures show a toast.
  settings,              // {quality:'high'|'low', sens:1, music:0.6, sfx:0.8, name:'Castaway'}
  world, view, player, ui, audio, net,   // module instances (created in this order)
  remotes,               // Map pid -> {x,y,z,yaw,pitch,name,outfit,held,anim} other players (multiplayer)
  donkey,                // {x,z,yaw,moving} runtime position, updated by view (follows the host's player)
  trader,                // {x,z} trader NPC position (pier)
  on(evt, fn), emit(evt, data),   // tiny event bus: 'fail' {msg}, 'saved', 'ui-open', 'ui-close'
  save(), exportSave(), importSave(file), newGame(), continueGame(), host(), join(code), quitToTitle(),
  setQuality(q),
}
```
`fx` (exported from state.js) is drained once per frame by main.js and handed to `view.onFx(list)` and
`audio.onFx(list)`. `dirty` (exported from state.js) is consumed by `view.sync()` / `ui.update()`.

## Module APIs (each module default-exports nothing; use named exports exactly as below)

### src/assets.js
```js
export async function loadAssets(onProgress)   // loads models.glb + heights.json (calls setHeights), builds lib
export const lib                               // name -> { geo, specials:[{geo, mat}], size:Vector3, top:number }
                                               //   geo: merged BufferGeometry with vertex colours (all plain
                                               //   c_ materials baked in) or null; specials keep their own mat
export const mats                              // { static, foliage, glass, net, emit:{warm,eye,fire,gold}, sail, cloud }
                                               //   static/foliage: MeshToonMaterial(vertexColors) + soft ramp;
                                               //   foliage adds wind sway (uses uniforms) + contact AO; static gets AO
export const uniforms                          // { uTime:{value}, uWind:{value}, uWindDir:{value:Vector2} }
export function makeMesh(name, opts)           // -> THREE.Group (fresh, cast/receive shadow). opts:{foliage, tint:{shirt,metal,tint}}
export function makeInstanced(name, capacity, opts) // -> THREE.Group of InstancedMesh (one per geo/special),
                                               //   with .setAt(k, matrix, color?) .count(n) .capacity
export async function thumbnail(name, opts)    // -> dataURL 96x96 PNG of the model on transparent bg (cached).
                                               //   opts: {tint:{tint:'#hex', metal:'#hex'}, gold:true}
```

### src/world.js
```js
export function createWorld(canvas, game)  // -> world
world = {
  renderer, scene, camera,                 // PerspectiveCamera fov 70, near .05
  vmScene, vmCamera,                       // first-person viewmodel scene, rendered after the main scene with a cleared depth buffer
  sunDir,                                  // Vector3 toward the sun
  dayTime(),                               // 0..1 (0.25 sunrise, 0.5 noon, 0.75 sunset)
  update(dt, now),                         // animates water, sky, day/night, weather visuals (reads game.state.weather), clouds, trader boat
  render(),                                // composer render incl. viewmodel pass, outline, grade
  resize(),
  setQuality(q),
  setOutline(objects),                     // outline/rim the targeted interactable (array of Object3D)
  cine: { letterbox:0..1, fade:0..1, title:'' }, // read every frame by the grade pass / ui
  flash(strength),                         // lightning flash
  waterLevel(),                            // current ocean height (rises at high tide)
  addToScene(obj), groundGroup             // groundGroup holds terrain-like things the player ray hits
}
```
world.js owns: renderer, post-processing, sky + sun + stars + clouds, ocean/river/pond water (one shader plane;
water depth from heights), the island mesh, all non-interactive scenery OUTSIDE the 40×40 farm grid (palms,
jungle, rocks, ferns, grass tufts, flowers — instanced, deterministic), the pier + trader boat (boat sails in
when `state.trader.at` is recent and leaves after 3 min), the shipwreck, the beach shack at (0, 72),
ruins on the mountain path, lightning bolts + flashes, rain/acid rain/storm wind/heat haze/tide.

### src/view.js
```js
export function createView(game)   // -> view
view = {
  sync(),                    // consume state.js `dirty` (tiles, b, all) and rebuild only what changed
  update(dt, now),           // per frame: crop stages (time-based), sprinkler heads, bots, crows, donkey follow,
                             //   remotes' avatars, trader NPC idle, fire, particles, floating text
  onFx(list),                // particles + floating text for fx events (see state.js fx.push calls)
  pickables,                 // THREE.Group of proxy meshes for raycasting entities
  pick(raycaster),           // -> {kind:'building', id} | {kind:'obstacle', i, j} | {kind:'crow', id}
                             //    | {kind:'donkey'} | {kind:'trader'} | {kind:'board'} | {kind:'sign', px, py}
                             //    | {kind:'water'} (fresh water you can refill from) | null
  highlight(target),         // ask world.setOutline with the right object(s); null clears
  ghost(type, i, j, rot, ok),// show/hide a build ghost (green ok / red not ok); type null hides
  tileCursor(cells, ok),     // show a soft cursor on these [i,j] cells; [] hides
}
```
Rendering rules: soil = instanced `soil_tile` (dry colour; wet = ×0.62 darker via instance colour; fertile uses
`soil_fertile`; raised bed = `raised_bed` model under the soil). Crops/trees instanced per model name.
Obstacles instanced (`palm_*`/`jungle_*` by o.v, `rock_s|m|l` by o.v, `bush_a`, `stump_palm|stump_tree`).
Grass tiles in the grid show sparse `grass_tuft` instances. Buildings are individual meshes (farmhouse model =
`farmhouse_${state.fh}`; harvester_bot = dock + a rover that drives to the harvested tile on `bot` fx; disabled
buildings (`b.off > now`) smoke; burning (`b.fire`/`tile.fire`) shows `fire` + flicker light). Unowned plots get
a rope boundary + `sign_forsale` at the plot edge facing owned land when `plotState(...).ok` or its reason is
interesting. Crows fly in on `crowSpawn`, peck, fly off. The donkey follows the host player (stays 3 m behind,
model by `state.donkey.lv`: donkey / donkey_bags / donkey_cart). Remote players use `player` with their outfit.
The trader stands at the land end of the pier (x=-82, z=12) beside the `quest_board`.

### src/player.js
```js
export function createPlayer(game)  // -> player
player = {
  pos: Vector3, yaw, pitch, enabled,
  update(dt),             // movement, collision, targeting, held-item viewmodel, hold-to-repeat use
  spawn(x, z, yaw),
  lock(), unlock(),       // pointer lock helpers (click canvas to lock)
  target,                 // current target info for the UI tooltip: {kind, i, j, id, label, detail, action}
  buildMode,              // true while B mode is on
}
```
Controls (from the plan): WASD move, mouse look, Shift sprint, left-click use the held item, 1–9 / wheel select
hotbar slot (dispatch `{type:'sel', slot}`), E interact / open inventory, B build mode (look at a placed
building, click to pick it up, click to put it down, R rotate, X store it back in your backpack), Esc pause.
Use rules by held item kind: hoe→`till`, seeds→`plant`, bucket→`water` (on fire/soil) or `refill` (when
`view.pick` says water/well/rain_barrel), sickle/empty hand→`harvest` (also clicking a crow → `scare`),
axe/pickaxe→`hit` (obstacle), boost→`fertilize`, place→`place` with ghost (R rotates). Area tools pass
`dir` (0 = facing ±x, 1 = facing ±z). Hold left mouse to repeat every 0.35 s while sweeping across new tiles
(broken hoe 0.8 s). E on: market stall → ui sell, shop stall → ui shop, silo/barn → ui storage, factory → ui
factory, harvester bot → ui bot, auto-market → ui market, donkey → ui donkey, trader/board → ui quests, sign →
buy plot confirm, anything else → inventory. Reach 5.5 m. Collisions: buildings (footprint boxes, except
path/flowers/overlays), obstacles (radius 0.6), deep water (`heightAt < -0.35`, except on the bridge deck),
island edge. Camera eye height 1.65 m above `heightAt`, walk 4.5 m/s, sprint 7.5.

### src/ui.js (+ index.html + styles.css)
```js
export function createUI(game)  // -> ui
ui = {
  update(dt),                     // refresh HUD from state when dirty.ui (then clear it) + timers
  open(panel, ctx), close(), isOpen(), // panels: 'inventory','shop','sell','storage'{store},'factory'{bid},
                                  //   'bot'{bid},'market'{bid},'donkey','quests','plot'{px,py},'pause','settings','multiplayer'
  toast(msg, kind),               // kind: 'info'|'good'|'warn'
  setTarget(info),                // crosshair tooltip from player.target
  title(show), loading(p, label), // title screen / loading bar
  banner(text, sub),              // big centered moment (level up, disaster warning, new island day)
  onFx(list),                     // coins counters, level-up banner, achievement toast, quest done
}
```
DOM ids/classes are the UI agent's choice. The canvas is `<canvas id="game">`. UI must call `player.unlock()`
when opening a panel and relock on close (click to resume). Hotbar shows 9 slots with thumbnails, stack
counts, held item name, bucket water dots on the bucket. HUD: coins, gems, level + xp bar, field tiles left,
day clock, active weather / warning with countdown, tutorial objective (state.tut 0–5 → 6 steps from the plan),
multiplayer code when hosting. Title: Continue (if a save exists), New world, Join a friend (code input),
Settings. Pause: Resume, Invite a friend (host code), Settings, Export save, Import save, Quit to title.

### src/audio.js, src/net.js, src/cinematic.js (lead)
`audio.play(name)`, `audio.onFx(list)`, `audio.update(dt)` (ambience by weather/time). `net` wraps PeerJS:
host-authoritative; guests send actions, host resolves/applies/broadcasts. `cinematic.intro()` plays the
storm → crash → title card → wake-up sequence using world.cine + camera.
