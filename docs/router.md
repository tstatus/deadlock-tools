# Midtown Box Router

Part of [Deadlock Tools](../README.md). A browser-based 3D planner for farming routes on Deadlock's `dl_midtown`: boxes, jungle camps and
Sinner's Sacrifices. Routes follow
Valve's navmesh, so they go around walls. Ledge drops, jump-ups, gap jumps, ropes, jump pads,
teleporters, ziplines and (for small heroes) tunnels are modeled as moves with their own costs.
Spawn timers, soul values and buff drops come from deadlock.wiki.

## Run

Double-click **Start.bat**. It opens http://localhost:5178/router/ in your browser. Keep the black
window open while you use the router, and close it when you're done.

Or, from a terminal in this folder, run `node server.mjs`. Either way you need Node.js
(https://nodejs.org); Three.js loads from a CDN, so nothing else needs installing.

## Using it

1. **Match**: choose the hero type, how spawn timers are handled, the run speed, and which box types
   to farm. Choose *Tunnel hero* for Rem, Rat King, Mo & Krill or Calico, the only heroes that fit
   through tunnels. *Ignore isolated golden statues* drops any statue that adds more than a few seconds (you set
   how many) compared with going straight past it, so statues are only taken when they're on the
   way. *Prioritize tough crates* doubles their value in time-limited routes (they give double souls
   and always drop).
2. **Farm**: tick *Boxes* (and which box types), *Jungle camps* (and which tiers: small T1, medium T2,
   large T3, since not every hero can clear large camps) and/or *Sinner's Sacrifices*. Camp souls
   come from their haunts (small 41, medium 68, large 181, each +1.08%/min); clear time is the haunts'
   health (rising 2.1%/min) divided by your camp DPS (default 120 at 0:00 plus 25 per minute). Time-limited
   routes take a camp only when it pays more souls per second than the boxes it replaces; if none are
   taken, the status line says why. A Sinner's Sacrifice is
   310 + 3.35/min souls and is always played as a jackpot (4 buffs), takes about 10 s to break, first
   spawns at 8:00 and respawns 5 min after breaking (the Bell Tower camp has three: ~30 s, 12 buffs).
   *Always take targets that add at most N s* makes sure a route never passes a box right next to it.
3. **Route** (top of the sidebar): *Optimize route*, *Follow path* and *Clear* first, then the active
   route's settings. *Starts*: at a game clock, or after the previous route (plus a wait).
   *Start* / *Finish*: pick points on the map; finish back at the start, at a point, or at the last stop.
   *Goal*: every target fastest, or most value within N seconds. *Radius* (slider) limits targets to within that distance of the start; a translucent sphere
   shows the range while you drag it.
   The **route panel** (top left of the map) has one collapsible card per route showing its time, stops,
   souls and buffs, with the stops listed underneath (time added, game clock, souls or buffs; colored
   like their markers; drag to reorder). ⌖ points the camera at a route and ⤢ zooms the minimap to it. ✎ (or double-click the name) renames a route; Enter saves, Esc cancels. The *Name* row in the route settings does the same.
   **★ Find best start** tries every enabled target as the start (about 3 s), builds the best route within the
   *Goal* time limit from each, and lists the top 6 in different parts of the map by souls collected (with
   souls/min). The best one is applied; click another to switch. The route ends at its last stop, or back at
   the start when *Finish* is *Back at the start*. It uses the route's start clock, so spawn timers count.
4. **Optimize route**, then **Follow path**. **▶ Play** runs the route in real time at its estimated
   pace (0.5×–2×), holding at each box for its break time, so you can follow it on a second monitor;
   ❚❚ pauses, ■ stops, ◀ / ▶ (or the arrow keys) jump between stops, and Space toggles play. **+ Route** plans a follow-up run; targets broken earlier come back only after their
   respawn timer.

**Right-click anywhere on the map** to *Start* or *End* the active route at that spot, or fly the
camera there (clicking a wall uses the floor below it). Right-drag still pans the camera.

**Saved routes** (top of the sidebar): *Save current…* stores the whole plan under a name with a team and a
lane. Filter by team and lane, then *Load* it or press **▶** to load and play it straight away. Saved routes
live in this browser; *Export* / *Import* back them up or move them to another browser.

**Click (or right-click) a box or camp** for its menu: spawn and respawn info, and actions with their cost in time:
*Add to* / *Remove from* the active route (the button shows the time it adds or saves; added boxes
are pinned 📌, so *Optimize route* always keeps them and orders the rest around them, even past a
filter or a tight time limit; *Clear* or *Remove* unpins), *Start route
here*, *End route here*, exclude it, fly the camera to it, and *I can reach this* / *Mark as not
reachable*. Boxes outside the tunnels that the navmesh can't reach count as reachable by default
(routed via the nearest floor plus a climb), since they can be reached in game.

Colors: wood = crate, teal = tough crate, gold = golden statue, red = jungle camp (bigger cube =
higher tier: small, medium, large), purple = Sinner's Sacrifice camp (bigger = more machines), dark red = unreachable for the current hero and settings, dim = not up yet when the route starts.

**Camera:** drag to orbit, right-drag to pan, wheel to zoom. **WASD** flies (Q/E down/up, hold
Shift for speed). **Follow path** flies a chase camera along the route: → / ↓ next stop, ← / ↑
previous, Esc to stop. The **minimap** (bottom left) is drawn from the navmesh with your team's base at the bottom (*Team*
button above it switches between Hidden King/Amber and Archmother/Sapphire, and also turns the top-down
view); *Whole map* undoes a route zoom. It it shows the routes, selectable boxes, and the camera with its view direction. Click it
to move the camera there. The toolbar at the top right of the 3D view has *Cutaway* (dissolves buildings between the camera and
the point you're looking at; the slider sets its size, up to 120 m), *Hide above* (cuts off everything
above a height), and *Through walls* (draws boxes and the route faintly through buildings).

## Calibrating against the game

From in-game timings (2026-10-29, saved in `docs/calibration/calibration-2026-10-29.json`): zipline 27 m/s, rope climb
14 m/s (in-game velocity 551 u/s), jump pad flight, and from four timed routes: run 10.5 m/s with slide-hop
momentum, 12 m per dash-slide, 0.15 s per box, 0.05 s per running jump, 0.7 s extra per wall climb, 0.03 s
per meter of plain fall and 0.045 s per meter down-dashed. Ziplines: latch from up to 5 m to the side and
22 m below the cable (the latch pulls you up, so it costs only 0.1 s), and crouching off carries 15 m of
dash-speed momentum. Dash jumps cross gaps at dash speed, and stamina use looks ahead across the whole route.
To calibrate further:

1. Open *Calibrate with in-game times* and click *Suggest test runs*. It finds box pairs whose path is
   mostly one kind of move (flat run, zipline, rope, drops, jump-ups, jump pad).
2. *Load* a test. In game, stand at the start box, break it, start a timer, follow the drawn line,
   and stop when the target box breaks.
3. Enter the seconds and click *Record*. Any normal route works as a sample too.
4. After several varied runs, click *Fit movement model*. It solves for all speeds and costs at once
   (each weight stays within 0.25×–4× of its current value) and shows the error before and after.
   About ten varied runs give a solid fit; with fewer, some values can drift.
5. *Export* saves the samples, so they can be shared or re-imported later.

Changing *max wall climb*, *max height gained on a gap jump*, *max rooftop gap*, the hero type, or a move toggle (ziplines, ropes, pads, teleporters)
changes which paths exist. When that happens, the app recomputes the box-to-box travel table in the
background (about 40 s). Speed and cost changes apply instantly.

## Box data (deadlock.wiki, checked 2026-10-29)

| Type | Souls | Drop |
|---|---|---|
| Crate | 23 + 2/min | 60% |
| Tough crate | 46 + 4/min | 100% |
| Buff container | 0 | 50% buff; level 2 from 10:00, level 3 from 30:00 |

| Spawn group (from the entity file) | First spawn | Respawn |
|---|---|---|
| Standard | 3:00 | 3 min |
| Tunnels | 5:00 | 5 min |
| Bell Tower / Sunken Plaza | 5:00 | 3 min |
| Midboss room | 10:00 | 3 min |

These live in `site/router/game.js` and in `SPAWN` in `tools/router/build-nav.mjs`.

## Rebuilding the data

Run these after re-exporting from Source 2 Viewer (for example after a patch). All three read
from the export folder one level up.

```
node --max-old-space-size=12000 tools/router/build-map.mjs .. site/router/data 0.5
node --max-old-space-size=12000 tools/router/build-nav.mjs .. site/router/data 1
node --max-old-space-size=12000 tools/router/build-matrix.mjs site/router/data
```

| Script | Reads | Writes |
|---|---|---|
| build-map | `dl_midtown_d.gltf` (+ `.bin`), `dl_midtown_d_physics.gltf` | `map.bin` (display mesh), `map.json` (landmark volumes) |
| build-nav | `dl_midtown.glb` (navmesh), `default_ents.vents`, `map.bin` | `nav.bin` (routing graph), `nav.json` (boxes, start points, ziplines) |
| build-matrix | `nav.bin`, `nav.json` | `matrix-normal.bin`, `matrix-tunnel.bin` (travel components for default settings) |

## Stamina

Most heroes have 3 stamina charges, each recharging in 4.5 s. The router simulates stamina along
every route, carrying it from leg to leg and into follow-up routes:

- **Dash-slides on runs:** each charge covers *distance per dash + slide* (default 9 m) at dash speed
  (14.7 m/s) instead of run speed.
- **Moves that cost stamina:** climbs taller than *climb without air jump* (2.5 m) cost 1, and gaps
  longer than *gap without dash jump* (6 m) cost 2. If you are short, the route waits for the recharge
  and the leg shows it.
- **Down dashes:** drops of at least 4 m use a down dash when half a charge is spare, descending at
  0.065 s/m instead of a plain fall.
- **Holding charges:** a dash-slide is skipped when spending the charge would leave you short for an
  upcoming air jump or dash jump.
- **Optimizer:** uses steady-state costs. Running is credited with the dashes recharging allows, and
  each charge a jump spends costs the dash it replaces. The choice of when to dash or hold a charge is
  made by `shouldDash` in `site/router/nav-core.js`.

## How travel time works

Every move carries a component vector: run meters, ramp/stair climb, jumps, jump height, drop height,
zipline meters, latches, rope meters, and fixed seconds (pad flight, teleporter delay).
Time = components · weights, where the weights come from the movement model. Paths are string-pulled
through the navmesh (funnel algorithm), so distances are close to the real walking line.

Links the navmesh doesn't have are generated by probing out from every navmesh border, and each one
is checked for clearance against the world mesh (walls, headroom):
- **Drops and wall climbs** at ledges. Climbs are taken from right against the wall (wall jump + double
  jump), generated up to 12 m and capped by the *max wall climb* setting (default 10 m).
- **Rooftop gap jumps** up to 28 m across, straight out and at ±25°, onto level, higher or lower roofs.
  The arc is checked for walls. At runtime the *max rooftop gap* setting (default 20 m, a dash jump) and *max height gained on a gap
  jump* (default 4 m) apply an envelope:
  the full gap on the level, shorter the higher the landing, longer when landing lower.
- **Ropes:** bottom to top landing.
- **Jump pads:** to their `info_target`, with flight time from `launch_speed`.
- **Teleporters:** to their exit, with the entity's delay.
- **Ziplines:** latch, ride and dismount anywhere along the cable.
- **Tunnels:** pockets are linked to the street right above them.

## Known limits

- **Movement tricks:** wall jumps, dash jumps and slides aren't modeled. They show up as calibration
  error, and as boxes that need a higher jump setting.
- **Unreachable boxes:** with the defaults (10 m wall climb, 20 m gap) 6 standard boxes have no route, 2 of
  them off the navmesh. Click one and use *I can reach this box* if you know it is reachable in game.
- **Tunnel entrances** are placed at the closest point to the street above each tunnel pocket, not
  at the exact hole. Everything inside the game's tunnel trigger volumes is off limits to other heroes.
- **Respawns inside one route:** a single long route never re-breaks a box; use additional routes for respawn laps.
