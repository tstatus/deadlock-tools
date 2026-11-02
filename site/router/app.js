import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { computeBoundsTree, acceleratedRaycast } from "three-mesh-bvh";
import { loadNav, snap, trisAt, rowComps, exactLeg, planWeights, simulatePieces, lookAhead, newStamina, regen, DEFAULT_PARAMS, structuralKey, NC, EC, C } from "./nav-core.js";
import { solve, simulate } from "./solver.js";
import { BOX_TYPES, CATEGORIES, SOUL_ICON, isBox, targetSouls, serviceTime, targetBuffs, fmtClock, parseClock } from "./game.js";
import { featuresOf, weightsOf, paramsOf, fit, upgradeSample, FEATURES } from "./calibrate.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);
const progress = (f) => { $("progress").hidden = f == null; if (f != null) $("progress").firstElementChild.style.width = `${Math.round(f * 100)}%`; };

// ---------------------------------------------------------------- state
const STORE = "midtown-router-v3";
const ROUTE_COLORS = ["#f2b544", "#5ec8e5", "#e889c4", "#7ed47a", "#b98cf0", "#ef7b6c"];
const newRoute = (n, prev) => ({
  name: `Route ${n}`,
  startWhen: prev ? "after" : "fixed", clock: 180, gap: 0,
  start: null,          // {tri, point, label}; null on later routes = where the previous route ended
  endMode: "loop", end: null,
  mode: "all", budget: 60, radius: 0,
  stops: [],            // box indices in order
});
const S = {
  params: { ...DEFAULT_PARAMS },
  spawnMode: "wait", hero: "normal",
  types: { crate: true, tough: true, buff: true },
  categories: { box: true, camp: false, sinner: false },
  campTiers: { small: true, medium: true, large: true }, // not every hero can clear large (T3) camps
  grabNearby: 3,     // s: always take targets that add at most this much to a route
  team: "amber",     // your side: its base is drawn at the bottom of the minimap and top-down view
  ignoreIsolated: true, statueDetour: 4, prioritizeTough: false, buffValue: 120,
  routes: [newRoute(1)], active: 0,
  excluded: {},        // box id -> true
  reachOverride: {},   // box id -> true: user says it's reachable; path to the nearest reachable floor
  samples: [],
  view: { cutaway: true, cutRadius: 14, xray: true },
};
let nav = null, g = null, boxes = [], matrixInfo = null, navBuffer = null;
let plan = [];       // per route: {startClock, startPt, endPt, legs, endClock, brokenBefore}
let selectedBox = -1;
const R = () => S.routes[S.active];
const eff = () => ({ ...S.params, useTunnels: S.hero === "tunnel" });

const MOVE_STYLE = {
  walk: ["#f2b544", "Run"], zip: ["#5ec8e5", "Zipline"], latch: ["#5ec8e5", null], dismount: ["#9aa4b8", null],
  rope: ["#7ed47a", "Rope"], jump: ["#ffffff", "Jump up / gap"], gap: ["#ffffff", null], climb: ["#ffffff", null], drop: ["#9aa4b8", "Drop"],
  pad: ["#6f8cff", "Jump pad"], teleport: ["#b98cf0", "Teleporter"], tunnel: ["#b07a4f", "Tunnel"],
};

// ---------------------------------------------------------------- scene
const viewport = $("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#0f1115");
const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 6000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;
controls.maxPolarAngle = Math.PI * 0.499;
function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

// World mesh. Flat-shaded from screen-space derivatives (no normals buffer). The cutaway
// dissolves geometry inside a cylinder from the camera to the orbit focus, and in a sphere
// around the camera, with an ordered-dither fade so no sorting is needed.
const mapUniforms = {
  uSlice: { value: 1e9 }, uMinY: { value: 0 }, uMaxY: { value: 1 },
  uCam: { value: new THREE.Vector3() }, uFocus: { value: new THREE.Vector3() }, uCut: { value: 14 }, uCutOn: { value: 1 },
};
const mapMaterial = new THREE.ShaderMaterial({
  uniforms: mapUniforms, side: THREE.DoubleSide,
  vertexShader: `varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform float uSlice, uMinY, uMaxY, uCut, uCutOn; uniform vec3 uCam, uFocus; varying vec3 vPos;
    float bayer(vec2 p) {
      ivec2 q = ivec2(mod(p, 4.0));
      int i = q.x + q.y * 4;
      int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
      return (float(m[i]) + 0.5) / 16.0;
    }
    void main() {
      if (vPos.y > uSlice) discard;
      if (uCutOn > 0.5) {
        vec3 d = uFocus - uCam; float L = length(d); vec3 u = d / max(L, 1e-3);
        float t = dot(vPos - uCam, u);
        float r = length(vPos - (uCam + u * clamp(t, 0.0, L)));
        // full strength along the sight line, tapering off just before the focus
        float along = smoothstep(L, L - uCut * 0.6, t) * step(0.0, t);
        float fade = along * (1.0 - smoothstep(uCut * 0.55, uCut, r));
        fade = max(fade, 1.0 - smoothstep(uCut * 0.3, uCut * 0.6, length(vPos - uCam)));
        if (bayer(gl_FragCoord.xy) < fade * 0.88) discard;
      }
      vec3 n = normalize(cross(dFdx(vPos), dFdy(vPos)));
      float h = clamp((vPos.y - uMinY) / (uMaxY - uMinY), 0.0, 1.0);
      vec3 floorCol = mix(vec3(0.30, 0.33, 0.40), vec3(0.62, 0.66, 0.74), h);
      vec3 wallCol = mix(vec3(0.16, 0.18, 0.23), vec3(0.34, 0.37, 0.45), h);
      vec3 col = mix(wallCol, floorCol, smoothstep(0.55, 0.85, abs(n.y)));
      gl_FragColor = vec4(col * (0.55 + 0.45 * abs(dot(n, normalize(vec3(0.45, 0.8, 0.3))))), 1.0);
    }`,
});
let mapMesh = null;

async function loadAll() {
  const [meta, bin, navBin, navJson, mj] = await Promise.all([
    fetch("data/map.json").then((r) => r.json()), fetch("data/map.bin").then((r) => r.arrayBuffer()),
    fetch("data/nav.bin").then((r) => r.arrayBuffer()), fetch("data/nav.json").then((r) => r.json()),
    fetch("data/matrix.json").then((r) => r.json()),
  ]);
  const dv = new DataView(bin), vc = dv.getUint32(4, true), tc = dv.getUint32(8, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(bin, 12, vc * 3), 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, 12 + vc * 12, tc * 3), 1));
  geo.computeBoundingBox(); geo.computeBoundsTree();
  mapMesh = new THREE.Mesh(geo, mapMaterial);
  scene.add(mapMesh);
  mapUniforms.uMinY.value = meta.bounds.min[1]; mapUniforms.uMaxY.value = meta.bounds.max[1];

  navBuffer = navBin.slice(0);
  g = loadNav(navBin); nav = navJson; boxes = nav.boxes; matrixInfo = mj;
  buildLandmarks(meta.landmarks);
  buildNavLayers();
  buildMinimap();
  resetView();
  status(`${boxes.filter(isBox).length} boxes, ${boxes.length - boxes.filter(isBox).length} camps · navmesh ${nav.triangles} triangles · ${nav.edges} moves`);
}

// ---------------------------------------------------------------- layers
function addLayer(label, color, group, on, count) {
  group.visible = on;
  scene.add(group);
  const lab = document.createElement("label");
  lab.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}><span class="swatch" style="background:${color}"></span>${label} <span class="muted">${count ?? ""}</span>`;
  lab.querySelector("input").onchange = (e) => (group.visible = e.target.checked);
  $("landmarkToggles").appendChild(lab);
}
function buildLandmarks(list) {
  const STYLE = {
    rope: ["#7ed47a", "Climb ropes", true], jumppad: ["#6f8cff", "Jump pads", true], teleport: ["#b98cf0", "Teleporters", true],
    shop: ["#f2b544", "Shops", true], base: ["#ef7b6c", "Team bases", false], midboss: ["#ef7b6c", "Mid-boss", false],
    district: ["#8b93a6", "District volumes", false],
  };
  for (const [kind, [color, label, on]] of Object.entries(STYLE)) {
    const items = list.filter((l) => l.kind === kind);
    if (!items.length) continue;
    const grp = new THREE.Group();
    const line = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false });
    for (const l of items) {
      const box = new THREE.BoxGeometry(...l.max.map((v, i) => Math.max(v - l.min[i], 0.2)));
      const c = l.min.map((v, i) => (v + l.max[i]) / 2);
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(box), line), s = new THREE.Mesh(box, fill);
      e.position.set(...c); s.position.set(...c);
      grp.add(e, s);
    }
    addLayer(label, color, grp, on, items.length);
  }
}
function buildNavLayers() {
  const zg = new THREE.Group(), zm = new THREE.MeshBasicMaterial({ color: "#5ec8e5", transparent: true, opacity: 0.8 });
  for (const pts of nav.ziplines) zg.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p))), pts.length * 2, 0.3, 5), zm));
  addLayer("Ziplines", "#5ec8e5", zg, true, nav.ziplines.length);
  const ng = new THREE.Group(), geo = new THREE.BufferGeometry();
  const tv = new Float32Array(g.triVerts.length);
  for (let i = 0; i < tv.length; i++) tv[i] = g.triVerts[i] + (i % 3 === 1 ? 0.08 : 0);
  geo.setAttribute("position", new THREE.BufferAttribute(tv, 3));
  ng.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: "#7ed47a", transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })));
  addLayer("Walkable navmesh", "#7ed47a", ng, false);
}

// ---------------------------------------------------------------- box targets (with "I can reach this" overrides)
// An overridden box is routed to the nearest floor normal heroes can round-trip, plus a climb
// up to the box and a drop back down.
const overrideCache = new Map();
function overrideTarget(i) {
  const b = boxes[i];
  const ck = `${b.id}|${S.params.freeJumpUp}|${S.params.wallClimbTime}`;
  if (overrideCache.has(ck)) return overrideCache.get(ck);
  let best = null;
  for (let t = 0; t < g.nTri; t++) {
    if (!g.mainland[t]) continue;
    const dx = g.nodePos[t * 3] - b.pos[0], dy = g.nodePos[t * 3 + 1] - b.pos[1], dz = g.nodePos[t * 3 + 2] - b.pos[2];
    const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5;
    if (!best || d < best.d) best = { d, t };
  }
  const point = [g.nodePos[best.t * 3], g.nodePos[best.t * 3 + 1], g.nodePos[best.t * 3 + 2]];
  const rise = Math.max(0, b.pos[1] - point[1]);
  const inC = new Float64Array(NC), outC = new Float64Array(NC);
  inC[C.walk] = Math.hypot(b.pos[0] - point[0], b.pos[2] - point[2]); inC[C.jumps] = rise > 0.6 ? 1 : 0; inC[C.jumpUp] = rise;
  inC[C.stamina] = rise > S.params.freeJumpUp ? 1 : 0;
  if (rise > 0.6) inC[C.fixed] = S.params.wallClimbTime;
  outC[C.walk] = inC[C.walk]; outC[C.drop] = rise;
  const o = { tri: best.t, point, inC, outC };
  overrideCache.set(ck, o);
  return o;
}
// Boxes outside the tunnels that the navmesh can't reach are reachable in game (wall holes and
// ledges the navmesh misses), so they count as marked reachable unless you unmark them.
const autoReach = (b) => b.groupName !== "Tunnels" && isBox(b) && !(S.hero === "tunnel" ? b.reachableTunnel : b.reachable);
const overridden = (i) => { const v = S.reachOverride[boxes[i].id]; return v === undefined ? autoReach(boxes[i]) : v; };
// Boxes added by hand (box menu) are pinned: re-optimizing keeps them and orders around them.
const pinnedOf = (r) => { const byId = new Map(boxes.map((b, i) => [b.id, i])); return (r.pinned ?? []).map((id) => byId.get(id)).filter((i) => i != null); };
const unpin = (r, i) => { r.pinned = (r.pinned ?? []).filter((id) => id !== boxes[i].id); };
const overrideIds = () => boxes.filter((_, i) => overridden(i)).map((b) => b.id).sort();
const campTier = (b) => ({ "Small camp": "small", "Medium camp": "medium", "Large camp": "large" })[b.groupName];
const typeOn = (b) => S.categories[BOX_TYPES[b.type].category] && (isBox(b) ? S.types[b.type] : b.type !== "camp" || (S.campTiers ?? {})[campTier(b)] !== false);
const valueText = (b, t) => b.type === "buff" ? "50% buff"
  : b.type === "sinner" ? `${soulsHTML(targetSouls(b, t))} + ${buffsText(targetBuffs(b, S.params))} · ~${serviceTime(b, t, S.params).toFixed(0)}s`
  : b.type === "camp" ? `${soulsHTML(targetSouls(b, t))} · ~${serviceTime(b, t, S.params).toFixed(0)}s to clear`
  : soulsHTML(targetSouls(b, t));
// Camp markers keep one color per kind; the cube grows with the camp tier (or number of machines).
const markerScale = (b) => b.type === "sinner" ? 1.4 + 0.45 * Math.min(b.sinners, 3) : { "Small camp": 1.3, "Medium camp": 1.9, "Large camp": 2.6 }[b.groupName] ?? 1.9;
const targetName = (b) => (isBox(b) ? `${BOX_TYPES[b.type].label}${b.group ? ` · ${b.groupName}` : ""}` : b.groupName);
// Two marked boxes close together at about the same height are on the same ledge: just run.
function sameLedge(i, j) {
  if (i < 0 || j < 0 || !overridden(i) || !overridden(j)) return null;
  const a = boxes[i].pos, b = boxes[j].pos, d = Math.hypot(a[0] - b[0], a[2] - b[2]);
  if (d > 15 || Math.abs(a[1] - b[1]) > 1.5) return null;
  const c = new Float64Array(NC); c[C.walk] = d;
  return c;
}
const boxTarget = (i) => (overridden(i) ? overrideTarget(i) : boxes[i].tri >= 0 ? { tri: boxes[i].tri, point: boxes[i].navPoint } : null);
const allTargets = () => boxes.map((_, i) => boxTarget(i));

// ---------------------------------------------------------------- travel data
let worker = null, workerJob = 0;
const matrices = new Map();   // key -> Float32Array(B*B*NC)
async function baseMatrix() {
  const p = eff(), key = structuralKey(p);
  if (matrices.has(key)) return matrices.get(key);
  const pre = Object.values(matrixInfo.matrices).find((m) => m.key === key);
  let M;
  if (pre) {
    status("Loading travel times…");
    M = new Float32Array(await fetch(`data/${pre.file}`).then((r) => r.arrayBuffer()));
  } else {
    status("Movement settings changed which moves are possible: recomputing travel times…");
    worker ??= new Worker("matrix-worker.js", { type: "module" });
    const id = ++workerJob, first = !worker.hasNav;
    worker.hasNav = true;
    M = await new Promise((resolve) => {
      worker.onmessage = (e) => {
        if (e.data.id !== id) return;
        if (e.data.progress != null) progress(e.data.progress);
        if (e.data.matrix) resolve(e.data.matrix);
      };
      const pts = boxes.map((b) => (b.tri >= 0 ? { tri: b.tri, point: b.navPoint } : { tri: -1 }));
      worker.postMessage({ id, navBuffer: first ? navBuffer.slice(0) : null, pts, params: p });
    });
    progress(null);
  }
  matrices.set(key, M);
  return M;
}
// Base matrix with the rows/columns of overridden boxes recomputed (two searches per box).
async function getMatrix() {
  const base = await baseMatrix(), ids = overrideIds();
  if (!ids.length) return base;
  const key = `${structuralKey(eff())}#${ids.join(",")}`;
  if (matrices.has(key)) return matrices.get(key);
  const M = base.slice(), B = boxes.length, p = eff(), pts = allTargets();
  boxes.forEach((b, i) => {
    if (!overridden(i)) return;
    const fwd = rowComps(g, pts[i], pts, p), back = rowComps(g, pts[i], pts, p, true);
    for (let j = 0; j < B; j++) {
      M.set(fwd.subarray(j * NC, j * NC + NC), (i * B + j) * NC);
      M.set(back.subarray(j * NC, j * NC + NC), (j * B + i) * NC);
    }
  });
  matrices.set(key, M);
  return M;
}
const rowCache = new Map();
function pointRows(pt, reverse) {
  const key = `${pt.tri}|${pt.point.join(",")}|${reverse}|${structuralKey(eff())}|${overrideIds().join(",")}`;
  if (!rowCache.has(key)) {
    if (rowCache.size > 24) rowCache.clear();
    rowCache.set(key, rowComps(g, pt, allTargets(), eff(), reverse));
  }
  return rowCache.get(key);
}
const dot = (arr, off, w) => { let t = 0; for (let j = 0; j < NC; j++) t += arr[off + j] * w[j]; return t; };
const dotV = (v, w) => dot(v, 0, w);

// ---------------------------------------------------------------- plan: routes in sequence, tracking breaks
// readyAt(i) = game clock when box i is up: first spawn, or last break + respawn.
function readyAt(i, broken) {
  const b = boxes[i];
  const first = S.spawnMode === "ignore" ? 0 : b.firstSpawn;
  return broken.has(i) ? Math.max(first, broken.get(i) + b.respawn) : first;
}
function computePlan() {
  stopFollow(); // its stops belong to the old plan
  plan = [];
  const p = eff(), broken = new Map();
  let prevEnd = null, prevClock = null, stam = null;
  S.routes.forEach((r, k) => {
    const startClock = r.startWhen === "after" && prevClock != null ? prevClock + (r.gap || 0) : r.clock;
    const startPt = r.start ?? prevEnd;
    const endPt = r.endMode === "loop" ? startPt : r.endMode === "point" ? r.end : null;
    const P = { startClock, startPt, endPt, legs: [], endClock: startClock, brokenBefore: new Map(broken), finalPt: startPt };
    plan.push(P);
    if (!startPt) { prevEnd = null; prevClock = startClock; return; }
    // stamina carries over from the previous route and recharges during any gap
    if (!stam || prevClock == null) stam = newStamina(p); else regen(stam, Math.max(0, startClock - prevClock), p);
    let from = startPt, fromBox = -1, clock = startClock;
    const leg = (to, toBox) => {
      const target = toBox >= 0 ? boxTarget(toBox) : to;
      if (!target) return null;
      const ledge = sameLedge(fromBox, toBox);
      if (ledge) return { comps: ledge, points: [boxes[fromBox].pos, boxes[toBox].pos], kinds: ["walk"], pieces: [{ kind: "walk", len: ledge[C.walk], up: 0 }] };
      const l = exactLeg(g, from, target, p);
      if (!l) return null;
      // overridden endpoints: climb onto / drop off the box
      if (fromBox >= 0 && overridden(fromBox)) { const o = overrideTarget(fromBox); for (let j = 0; j < NC; j++) l.comps[j] += o.outC[j]; l.points.unshift(boxes[fromBox].pos); l.kinds.unshift("drop"); l.pieces.unshift({ kind: "drop", comps: o.outC.slice(0, EC), stamina: 0 }); }
      if (toBox >= 0 && overridden(toBox)) { const o = overrideTarget(toBox); for (let j = 0; j < NC; j++) l.comps[j] += o.inC[j]; l.points.push(boxes[toBox].pos); l.kinds.push("climb"); l.pieces.push({ kind: "climb", comps: o.inC.slice(0, EC), stamina: o.inC[C.stamina] }); }
      return l;
    };
    // paths first, so each leg's stamina use can look ahead to dash jumps in the legs after it
    const geo = [];
    for (const i of r.stops) {
      const l = leg(null, i);
      geo.push({ i, l });
      if (l) { from = boxTarget(i); fromBox = i; }
    }
    const endLeg = endPt && (r.stops.length || r.endMode === "point") ? leg(endPt, -1) : null;
    const tails = new Array(geo.length);
    let tail = endLeg ? lookAhead(endLeg.pieces) : { need: 0, run: 0 };
    for (let k = geo.length - 1; k >= 0; k--) { tails[k] = tail; if (geo[k].l) tail = lookAhead(geo[k].l.pieces, tail); }
    for (const [k, { i, l }] of geo.entries()) {
      if (!l) { P.legs.push({ box: i, unreachable: true }); continue; }
      const sim = simulatePieces(l.pieces, stam, p, tails[k]), travel = sim.time;
      clock += travel;
      let wait = 0;
      const ready = readyAt(i, broken);
      if (S.spawnMode !== "ignore" || broken.has(i)) if (clock < ready) { wait = ready - clock; clock = ready; regen(stam, wait, p); }
      const arrive = clock;
      const svc = serviceTime(boxes[i], clock, p);
      clock += svc; regen(stam, svc, p);
      broken.set(i, clock);
      P.legs.push({ box: i, ...l, sim, travel, wait, arrive, done: clock, souls: targetSouls(boxes[i], clock), svc, staminaLeft: stam.s });
    }
    if (endLeg) {
      const sim = simulatePieces(endLeg.pieces, stam, p), travel = sim.time;
      clock += travel;
      P.legs.push({ box: -1, ...endLeg, sim, travel, wait: 0, arrive: clock, done: clock, souls: 0, svc: 0, staminaLeft: stam.s });
    }
    P.endClock = clock;
    P.finalPt = endPt ?? (fromBox >= 0 ? { ...boxTarget(fromBox), label: `End of ${r.name}` } : startPt);
    prevEnd = P.finalPt ? { tri: P.finalPt.tri, point: P.finalPt.point, label: `End of ${r.name}` } : null;
    prevClock = clock;
  });
  drawPlan();
}

// ---------------------------------------------------------------- candidates + solving
function boxReachable(i) {
  const P = plan[S.active];
  if (P?.startPt) return !Number.isNaN(pointRows(P.startPt, false)[i * NC]);
  if (overridden(i)) return true;
  const b = boxes[i];
  return S.hero === "tunnel" ? b.reachableTunnel : (b.minJump ?? 99) <= S.params.wallClimb;
}
function boxCandidates(k = S.active) {
  const r = S.routes[k], P = plan[k];
  return boxes.map((b, i) => i).filter((i) => {
    const b = boxes[i];
    if (!typeOn(b) || S.excluded[b.id] || !boxReachable(i)) return false;
    if (S.spawnMode === "now" && P && readyAt(i, P.brokenBefore) > P.startClock) return false;
    if (r.radius > 0 && P?.startPt && Math.hypot(b.pos[0] - P.startPt.point[0], b.pos[1] - P.startPt.point[1], b.pos[2] - P.startPt.point[2]) > r.radius) return false;
    return true;
  });
}
async function optimize() {
  computePlan();
  const r = R(), P = plan[S.active];
  if (!P.startPt) { status(S.active ? "Pick a start, or optimize the previous route first." : "Choose a start point first."); return; }
  if (r.endMode === "point" && !r.end) { status("Choose the end point (or change Finish)."); return; }
  const p = eff(), w = planWeights(p), M = await getMatrix();
  const fwd = pointRows(P.startPt, false);
  const back = P.endPt ? pointRows(P.endPt, true) : null;
  // boxes you added by hand are always candidates, even when a filter would hide them
  const pinned = pinnedOf(r).filter((i) => boxReachable(i));
  // a time-limited route can't use targets that only spawn after its limit runs out
  const inTime = (i) => r.mode !== "budget" || readyAt(i, P.brokenBefore) - P.startClock < r.budget;
  const cands = [...new Set([...boxCandidates().filter(inTime), ...pinned])];
  if (!cands.length) { status("No reachable boxes match the filters."); return; }
  const pinNodes = new Set(pinned.map((i) => cands.indexOf(i) + 1));
  const B = boxes.length, n = cands.length + 1, D = new Float64Array(n * n).fill(1e6);
  const val = (x) => (Number.isFinite(x) ? x : 1e6);
  const svcAt = P.startClock + (r.mode === "budget" ? r.budget / 2 : 0);
  const svc = cands.map((i) => serviceTime(boxes[i], svcAt, p));
  const extraIn = cands.map((i) => (overridden(i) ? dotV(overrideTarget(i).inC, w) : 0));
  const extraOut = cands.map((i) => (overridden(i) ? dotV(overrideTarget(i).outC, w) : 0));
  for (let j = 1; j < n; j++) D[j] = val(dot(fwd, cands[j - 1] * NC, w) + extraIn[j - 1] + svc[j - 1]);
  for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) if (i !== j) {
    const ledge = sameLedge(cands[i - 1], cands[j - 1]);
    D[i * n + j] = ledge ? dotV(ledge, w) + svc[j - 1] : val(dot(M, (cands[i - 1] * B + cands[j - 1]) * NC, w) + extraOut[i - 1] + extraIn[j - 1] + svc[j - 1]);
  }
  const backArr = back ? Float64Array.from({ length: n }, (_, i) => (i ? val(dot(back, cands[i - 1] * NC, w) + extraOut[i - 1]) : 0)) : null;
  const ready = S.spawnMode === "ignore" && !P.brokenBefore.size ? null
    : Float64Array.from({ length: n }, (_, i) => (i ? Math.max(0, readyAt(cands[i - 1], P.brokenBefore) - P.startClock) : 0));
  const mid = P.startClock + (r.mode === "budget" ? r.budget / 2 : 0);
  const values = Float64Array.from({ length: n }, (_, i) => {
    if (!i) return 0;
    if (pinNodes.has(i)) return 1e7; // taken first; the rest of the time goes around them
    const b = boxes[cands[i - 1]];
    const v = targetSouls(b, mid) + targetBuffs(b, S.params) * S.buffValue;
    return b.type === "tough" && S.prioritizeTough ? v * 2 : v;
  });
  const t0 = performance.now();
  let order = solve(D, n, { mode: r.mode, budget: r.budget, values, back: backArr, ready });
  // Ignore isolated statues: drop any statue whose detour costs more than the limit, then
  // (time-limited routes) re-solve without them so the freed time goes to other boxes.
  let dropped = 0;
  if (S.ignoreIsolated) {
    for (let pass = 0; pass < 3; pass++) {
      const pruned = pruneStatues(order, D, n, backArr, cands, pinNodes);
      if (pruned.removed.length === 0) break;
      dropped += pruned.removed.length;
      for (const k of pruned.removed) values[k] = 0;
      if (r.mode !== "budget") { order = pruned.order; break; }
      // block the dropped statues and solve again
      for (const k of pruned.removed) for (let j = 0; j < n; j++) { D[j * n + k] = 1e6; D[k * n + j] = 1e6; }
      order = solve(D, n, { mode: r.mode, budget: r.budget, values, back: backArr, ready }).filter((k) => !pruned.removed.includes(k));
    }
  }
  // the greedy build favours cheap nearby boxes; try trading some of them for bigger targets
  if (r.mode === "budget") order = swapForValue(order, D, n, backArr, ready, values, pinNodes, r.budget);
  // never skip a target sitting right next to the route
  const before = order.length;
  if (S.grabNearby > 0) order = grabNearby(order, D, n, backArr, ready);
  const grabbed = order.length - before;
  // anything pinned that still didn't fit goes in at its cheapest spot
  order = insertCheapest(order, [...pinNodes], D, n, backArr, ready);
  if (r.mode === "budget") order = trimToBudget(order, D, n, backArr, ready, values, pinNodes, r.budget);
  r.stops = order.map((k) => cands[k - 1]);
  status(`${r.name}: optimized ${r.stops.length} of ${cands.length} boxes in ${(performance.now() - t0).toFixed(0)} ms` + (dropped ? ` · skipped ${dropped} isolated statue${dropped > 1 ? "s" : ""}` : "") + (grabbed ? ` · added ${grabbed} right on the way` : "") + (pinned.length ? ` · kept ${pinned.length} you added` : "") + campNote(r, cands));
  computePlan(); save();
}

// ---------------------------------------------------------------- find the best start
// Tries every enabled target as the start of the active route and builds the best time-limited
// route from each (a quick solve on the box-to-box matrix), then runs the full optimizer on the
// most promising starts in different parts of the map and lists them by souls collected within
// the time limit. The route finishes at its last stop unless Finish is "Back at the start".
let bestStarts = [];
async function findBestStarts() {
  stopFollow(); closeBoxMenu();
  computePlan();
  const r = R(), P = plan[S.active], k0 = S.active;
  const budget = r.budget > 0 ? r.budget : 60, loop = r.endMode === "loop";
  const p = eff(), w = planWeights(p), M = await getMatrix(), B = boxes.length;
  const clock = P.startClock, mid = clock + budget / 2;
  const reach = (i) => overridden(i) || (S.hero === "tunnel" ? boxes[i].reachableTunnel : (boxes[i].minJump ?? 99) <= S.params.wallClimb);
  const cands = boxes.map((_, i) => i).filter((i) => {
    const b = boxes[i];
    if (!typeOn(b) || S.excluded[b.id] || !boxTarget(i) || !reach(i)) return false;
    const ready = readyAt(i, P.brokenBefore);
    return S.spawnMode === "now" ? ready <= clock : ready - clock < budget;
  });
  if (cands.length < 2) { status("Not enough reachable targets match the filters."); return; }
  status(`Trying ${cands.length} starts…`); progress(0);
  const m = cands.length, n = m + 1, val = (x) => (Number.isFinite(x) ? x : 1e6);
  const svc = cands.map((i) => serviceTime(boxes[i], mid, p));
  const extraIn = cands.map((i) => (overridden(i) ? dotV(overrideTarget(i).inC, w) : 0));
  const extraOut = cands.map((i) => (overridden(i) ? dotV(overrideTarget(i).outC, w) : 0));
  // travel-only times between candidates
  const T = new Float64Array(m * m);
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) if (a !== b) {
    const ledge = sameLedge(cands[a], cands[b]);
    T[a * m + b] = ledge ? dotV(ledge, w) : val(dot(M, (cands[a] * B + cands[b]) * NC, w) + extraOut[a] + extraIn[b]);
  }
  const souls = cands.map((i) => targetSouls(boxes[i], mid) + targetBuffs(boxes[i], S.params) * S.buffValue);
  const values = Float64Array.from({ length: n }, (_, j) => (j ? (boxes[cands[j - 1]].type === "tough" && S.prioritizeTough ? 2 : 1) * souls[j - 1] : 0));
  const ready = S.spawnMode === "ignore" && !P.brokenBefore.size ? null
    : Float64Array.from({ length: n }, (_, j) => (j ? Math.max(0, readyAt(cands[j - 1], P.brokenBefore) - clock) : 0));
  // node j (1..m) = candidate j-1; node 0 = standing at the start target, about to break it
  const D = new Float64Array(n * n).fill(1e6);
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) if (a !== b) D[(a + 1) * n + b + 1] = T[a * m + b] + svc[b];
  // seeds: one per spot (targets within 4 m start the same route)
  const seeds = [];
  for (let s = 0; s < m; s++) {
    const ps = boxes[cands[s]].pos;
    if (!seeds.some((t) => Math.hypot(...ps.map((v, k) => v - boxes[cands[t]].pos[k])) < 4)) seeds.push(s);
  }
  const quick = [];
  let last = performance.now();
  for (const [q, s] of seeds.entries()) {
    for (let b = 0; b < m; b++) D[b + 1] = b === s ? svc[s] : T[s * m + b] + svc[b];
    const back = loop ? Float64Array.from({ length: n }, (_, j) => (j ? (j - 1 === s ? 0 : T[(j - 1) * m + s]) : 0)) : null;
    const v = values.slice(); v[s + 1] = 1e7; // always break the start target first
    const order = solve(D, n, { mode: "budget", budget, values: v, back, ready });
    const got = order.reduce((a, j) => a + souls[j - 1], 0);
    quick.push({ s, got, time: simulate([0, ...order], D, n, back, ready).time });
    if (performance.now() - last > 60) { progress((q + 1) / seeds.length * 0.7); await new Promise((res) => setTimeout(res)); last = performance.now(); }
  }
  // the best few in different places, at least 25 m apart
  quick.sort((a, b) => b.got - a.got || a.time - b.time);
  const picks = [];
  for (const c of quick) {
    const ps = boxes[cands[c.s]].pos;
    if (picks.some((t) => Math.hypot(...ps.map((v, k) => v - boxes[cands[t.s]].pos[k])) < 25)) continue;
    picks.push(c);
    if (picks.length === 6) break;
  }
  // full optimizer on each pick, starting at that target with the route's own settings
  const saved = { start: r.start, end: r.end, endMode: r.endMode, mode: r.mode, budget: r.budget, stops: r.stops };
  const results = [];
  for (const [q, c] of picks.entries()) {
    const i = cands[c.s], t = boxTarget(i);
    Object.assign(r, { start: { tri: t.tri, point: t.point, label: `At ${targetName(boxes[i]).toLowerCase()}` }, endMode: loop ? "loop" : "open", mode: "budget", budget, stops: [] });
    await optimize();
    const st = routeStats(plan[k0]);
    results.push({ start: r.start, endMode: r.endMode, stops: [...r.stops], souls: st.souls, buffs: st.buffs, time: st.total, n: st.stops.length, box: i });
    progress(0.7 + ((q + 1) / picks.length) * 0.3);
  }
  Object.assign(r, saved);
  progress(null);
  results.sort((a, b) => b.souls - a.souls || a.time - b.time);
  bestStarts = results; bestStarts.route = k0;
  if (results.length) applyBestStart(0);
  status(`Tried ${seeds.length} starts with a ${fmtSec(budget)} limit. Best: ${Math.round(results[0]?.souls ?? 0)} souls in ${fmtSec(results[0]?.time ?? 0)}.`);
}
function applyBestStart(k) {
  const x = bestStarts[k], r = R();
  Object.assign(r, { start: x.start, endMode: x.endMode, mode: "budget", stops: [...x.stops] });
  bestStarts.forEach((y, j) => (y.on = j === k));
  syncRouteInputs(); computePlan(); renderBestStarts(); save();
  focusRoute(S.active);
}
function renderBestStarts() {
  const ul = $("bestList");
  ul.hidden = !bestStarts.length || bestStarts.route !== S.active;
  ul.innerHTML = "";
  for (const [k, x] of bestStarts.entries()) {
    const b = boxes[x.box], li = document.createElement("li");
    li.className = x.on ? "on" : "";
    li.innerHTML = `<span class="n">${k + 1}</span><div><div class="row1"><span class="nm" style="color:${BOX_TYPES[b.type].color}">Start at ${targetName(b)}</span></div>
      <div class="muted">${soulsHTML(x.souls)} in ${fmtSec(x.time)} · ${Math.round((x.souls / Math.max(x.time, 1)) * 60)}/min · ${x.n} stops${x.buffs ? ` · ${buffsText(x.buffs)}` : ""}</div></div>`;
    li.onclick = () => applyBestStart(k);
    ul.appendChild(li);
  }
}

// Cheapest place to insert node j into tour t ([0, ...stops]), measured as the change in total
// route time from the full simulation, so spawn waits it causes (or removes) are counted.
function bestInsertion(t, j, D, n, back, ready) {
  const base = simulate(t, D, n, back, ready).time;
  let best = Infinity, pos = t.length;
  for (let k = 1; k <= t.length; k++) {
    t.splice(k, 0, j);
    const c = simulate(t, D, n, back, ready).time - base;
    t.splice(k, 1);
    if (c < best) { best = c; pos = k; }
  }
  return { added: best, pos };
}
// Insert nodes not yet in the order, each where it adds the least time.
function insertCheapest(order, nodes, D, n, back, ready) {
  const t = [0, ...order], have = new Set(order);
  for (const j of nodes) {
    if (have.has(j)) continue;
    const { pos } = bestInsertion(t, j, D, n, back, ready);
    t.splice(pos, 0, j); have.add(j);
  }
  return t.slice(1);
}
// Insert any target that adds at most S.grabNearby seconds to the whole route (waits included),
// so a route never passes a box sitting right next to it. Repeats until nothing more qualifies.
function grabNearby(order, D, n, back, ready) {
  const t = [0, ...order], inRoute = new Set(order);
  for (let added = true; added;) {
    added = false;
    for (let j = 1; j < n; j++) {
      if (inRoute.has(j) || D[j] >= 1e6) continue;
      const { added: c, pos } = bestInsertion(t, j, D, n, back, ready);
      if (c <= S.grabNearby) { t.splice(pos, 0, j); inRoute.add(j); added = true; }
    }
  }
  return t.slice(1);
}
// Say why a time-limited route took no camps although camps are enabled.
function campNote(r, cands) {
  if (r.mode !== "budget" || !S.categories.camp || r.stops.some((i) => boxes[i].type === "camp")) return "";
  if (!cands.some((i) => boxes[i].type === "camp")) return " · no enabled camps are up and in range";
  const dps = Math.round(S.params.campDps + S.params.campDpsPerMin * (plan[S.active].startClock / 60));
  return ` · no camps taken: at ${dps} DPS nearby boxes pay more per second`;
}

// Time-limited routes are built greedily by value per extra second, which always prefers a box
// one second away over a camp that takes 10-15 s to clear, even when the camp is worth far more
// than the boxes it would displace. For each left-out target (most valuable first) insert it,
// trim back to the limit, and keep the result if the route's total value went up.
function swapForValue(order, D, n, back, ready, values, keep, budget) {
  const total = (o) => o.reduce((s, k) => s + values[k], 0);
  let best = order, bestValue = total(order);
  const inRoute = new Set(order);
  const outside = Array.from({ length: n - 1 }, (_, i) => i + 1).filter((j) => !inRoute.has(j) && values[j] > 0 && D[j] < 1e6)
    .sort((x, y) => values[y] - values[x]).slice(0, 80);
  for (const j of outside) {
    const t = [0, ...best];
    t.splice(bestInsertion(t, j, D, n, back, ready).pos, 0, j);
    const cand = trimToBudget(t.slice(1), D, n, back, ready, values, new Set([...keep, j]), budget);
    const v = total(cand);
    if (v > bestValue + 1e-6 && simulate([0, ...cand], D, n, back, ready).time <= budget) { best = cand; bestValue = v; }
  }
  return best;
}

// Time-limited routes: drop the least valuable stops per second they cost (never pinned ones)
// until the simulated route fits the limit again.
function trimToBudget(order, D, n, back, ready, values, keep, budget) {
  const t = [0, ...order];
  while (t.length > 1 && simulate(t, D, n, back, ready).time > budget) {
    const full = simulate(t, D, n, back, ready).time;
    let worst = -1, wr = Infinity;
    for (let k = 1; k < t.length; k++) {
      if (keep.has(t[k])) continue;
      const [x] = t.splice(k, 1);
      const saved = full - simulate(t, D, n, back, ready).time;
      t.splice(k, 0, x);
      const ratio = values[t[k]] / Math.max(saved, 1e-3);
      if (ratio < wr) { wr = ratio; worst = k; }
    }
    if (worst < 0) break; // only pinned stops left
    t.splice(worst, 1);
  }
  return t.slice(1);
}

// A statue is "on the way" when visiting it adds at most statueDetour seconds compared with
// going straight from the stop before it to the stop after it. Removes the worst offender
// first and repeats, since removing one changes its neighbours' detours.
function pruneStatues(order, D, n, back, cands, keep = new Set()) {
  const t = [0, ...order], removed = [];
  const cost = (a, b) => (b === -1 ? (back ? back[a] : 0) : D[a * n + b]);
  for (;;) {
    let worst = -1, wd = S.statueDetour;
    for (let k = 1; k < t.length; k++) {
      if (boxes[cands[t[k] - 1]].type !== "buff" || keep.has(t[k])) continue;
      const prev = t[k - 1], next = k + 1 < t.length ? t[k + 1] : -1;
      const detour = cost(prev, t[k]) + cost(t[k], next) - cost(prev, next);
      if (detour > wd) { wd = detour; worst = k; }
    }
    if (worst < 0) break;
    removed.push(t[worst]);
    t.splice(worst, 1);
  }
  return { order: t.slice(1), removed };
}

// ---------------------------------------------------------------- drawing
const routeGroup = new THREE.Group(), xrayRoute = new THREE.Group();
scene.add(routeGroup, xrayRoute);
function labelSprite(text, color, size = 0.032) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const x = c.getContext("2d");
  x.fillStyle = color; x.beginPath(); x.arc(32, 32, 28, 0, Math.PI * 2); x.fill();
  x.fillStyle = "#1a1405"; x.font = `bold ${text.length > 2 ? 22 : 30}px system-ui`; x.textAlign = "center"; x.textBaseline = "middle";
  x.fillText(text, 32, 34);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }));
  s.scale.set(size, size, 1); s.renderOrder = 10;
  return s;
}
const mats = {};
const tubeMat = (color, opacity, xray) => (mats[`${color}${opacity}${xray}`] ??= new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: !xray, depthWrite: !xray }));
const markers = new THREE.Group();
scene.add(markers);

function drawPlan() {
  routeGroup.clear(); xrayRoute.clear(); markers.clear();
  const lift = (p) => new THREE.Vector3(p[0], p[1] + 1.2, p[2]);
  plan.forEach((P, k) => {
    const active = k === S.active, rc = ROUTE_COLORS[k % ROUTE_COLORS.length];
    for (const leg of P.legs) {
      if (leg.unreachable) continue;
      let runStart = 0;
      for (let q = 1; q <= leg.kinds.length; q++) {
        if (q < leg.kinds.length && leg.kinds[q] === leg.kinds[runStart]) continue;
        const path = new THREE.CurvePath();
        for (let z = runStart; z < q; z++) path.add(new THREE.LineCurve3(lift(leg.points[z]), lift(leg.points[z + 1])));
        if (path.curves.length) {
          const geo = new THREE.TubeGeometry(path, Math.max(2, path.curves.length * 2), active ? 0.38 : 0.22, 5);
          const color = active ? MOVE_STYLE[leg.kinds[runStart]]?.[0] ?? rc : rc;
          routeGroup.add(new THREE.Mesh(geo, tubeMat(color, active ? 0.95 : 0.55, false)));
          if (active) xrayRoute.add(new THREE.Mesh(geo, tubeMat(color, 0.3, true)));
        }
        runStart = q;
      }
    }
    if (P.startPt) {
      const s = labelSprite(k ? `S${k + 1}` : "S", active ? "#ffffff" : rc, active ? 0.04 : 0.028);
      s.position.copy(lift(P.startPt.point)).add(new THREE.Vector3(0, 1.5, 0));
      markers.add(s);
    }
    if (S.routes[k].endMode === "point" && P.endPt) {
      const s = labelSprite("E", active ? "#ffffff" : rc, active ? 0.036 : 0.026);
      s.position.copy(lift(P.endPt.point)).add(new THREE.Vector3(0, 1.5, 0));
      markers.add(s);
    }
    if (active) {
      let n = 0;
      for (const leg of P.legs) {
        if (leg.box < 0 || leg.unreachable) continue;
        const s = labelSprite(String(++n), BOX_TYPES[boxes[leg.box].type].color);
        s.position.copy(lift(boxes[leg.box].pos)).add(new THREE.Vector3(0, 1.6, 0));
        markers.add(s);
      }
    }
  });
  xrayRoute.visible = S.view.xray;
  renderRouteUI();
  rebuildBoxes();
}

const boxGeo = new THREE.BoxGeometry(1.5, 1.5, 1.5);
let boxMesh = null, boxXray = null;
function rebuildBoxes() {
  for (const m of [boxMesh, boxXray]) if (m) { scene.remove(m); m.dispose(); }
  const P = plan[S.active];
  boxMesh = new THREE.InstancedMesh(boxGeo, new THREE.MeshBasicMaterial(), boxes.length);
  boxXray = new THREE.InstancedMesh(boxGeo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthTest: false, depthWrite: false }), boxes.length);
  boxXray.renderOrder = 5;
  const m = new THREE.Matrix4(), col = new THREE.Color(), inRoute = new Set(R().stops), cands = new Set(boxCandidates());
  boxes.forEach((b, i) => {
    m.makeTranslation(b.pos[0], b.pos[1] + (isBox(b) ? 0.75 : 1.4), b.pos[2]);
    if (!isBox(b)) { const s = markerScale(b); m.scale(new THREE.Vector3(s, s, s)); }
    if (i === selectedBox) m.scale(new THREE.Vector3(1.6, 1.6, 1.6));
    boxMesh.setMatrixAt(i, m); boxXray.setMatrixAt(i, m);
    col.set(BOX_TYPES[b.type].color);
    if (!boxReachable(i)) col.set("#7a2e2e");
    else if (!typeOn(b) || S.excluded[b.id]) col.multiplyScalar(0.18);
    else if (P && readyAt(i, P.brokenBefore) > P.startClock) col.multiplyScalar(0.42);
    else if (inRoute.size && !inRoute.has(i)) col.multiplyScalar(0.6);
    if (i === selectedBox) col.set("#ffffff");
    boxMesh.setColorAt(i, col); boxXray.setColorAt(i, col);
    // only routable boxes (and the selection) show through walls, to keep the x-ray readable
    if (!(cands.has(i) || i === selectedBox)) boxXray.setMatrixAt(i, m.clone().scale(new THREE.Vector3(0, 0, 0)));
  });
  boxXray.visible = S.view.xray;
  scene.add(boxMesh, boxXray);
  const reach = boxes.filter((_, i) => boxReachable(i)).length;
  $("boxCount").textContent = `${cands.size} targets selectable · ${boxes.length - reach} unreachable`;
  renderBoxMenu();
}

// ---------------------------------------------------------------- route UI
const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s.toFixed(1)}s`);
function movesText(l) {
  const c = l.comps, parts = [`run ${c[C.walk].toFixed(0)}m`];
  if (l.sim?.dashes) parts.push(`${l.sim.dashes} dash-slide${l.sim.dashes > 1 ? "s" : ""}`);
  if (c[C.zip] > 1) parts.push(`zip ${c[C.zip].toFixed(0)}m`);
  if (c[C.rope] > 0.5) parts.push(`rope ${c[C.rope].toFixed(0)}m`);
  if (c[C.jumps] > 0) parts.push(`${c[C.jumps]} jump${c[C.jumps] > 1 ? "s" : ""}`);
  if (c[C.drop] > 1) parts.push(`drop ${c[C.drop].toFixed(0)}m`);
  for (const [k, label] of [["pad", "jump pad"], ["teleport", "teleporter"], ["tunnel", "tunnel"]]) if (l.kinds.includes(k)) parts.push(label);
  if (l.sim?.staminaWait > 0.05) parts.push(`<span class="wait">waits ${l.sim.staminaWait.toFixed(1)}s for stamina</span>`);
  return `<span class="moves">${parts.join(" · ")}</span>`;
}
function routeStats(P) {
  const done = P.legs.filter((l) => !l.unreachable), stops = done.filter((l) => l.box >= 0);
  const souls = stops.reduce((a, l) => a + l.souls, 0), buffBoxes = stops.filter((l) => boxes[l.box].type === "buff");
  return {
    done, stops, souls, buffBoxes, buffs: stops.reduce((a, l) => a + targetBuffs(boxes[l.box], S.params), 0),
    total: P.endClock - P.startClock, travel: done.reduce((a, l) => a + l.travel, 0), waits: done.reduce((a, l) => a + l.wait, 0),
    dashes: done.reduce((a, l) => a + (l.sim?.dashes ?? 0), 0), downDashes: done.reduce((a, l) => a + (l.sim?.downDashes ?? 0), 0), staminaWait: done.reduce((a, l) => a + (l.sim?.staminaWait ?? 0), 0),
  };
}
// Route panel (top left of the map): one collapsible card per route. The header always shows
// time, stops, souls and buffs; the body lists the stops with their time and what they give,
// colored like their markers. The active route's settings are in the sidebar.
const soulsHTML = (n) => `<span class="souls"><img src="${SOUL_ICON}" alt="" referrerpolicy="no-referrer">${Math.round(n).toLocaleString()}</span>`;
const buffsText = (n) => `${+n.toFixed(1)} buff${n === 1 ? "" : "s"}`;
function statsLine(P, st) {
  return `${fmtSec(st.total)} · ${st.stops.length} stops · ${soulsHTML(st.souls)} · ${buffsText(st.buffs)}`;
}
function stopItem(r, P, l, idx) {
  const li = document.createElement("li");
  if (l.box < 0) {
    li.innerHTML = `<span class="n">${r.endMode === "loop" ? "↩" : "E"}</span><div><div class="row1"><span class="nm">${r.endMode === "loop" ? "Back to start" : "End point"}</span><span class="t">+${l.travel.toFixed(1)}s · ${fmtClock(l.done)}</span></div></div>`;
    return li;
  }
  const b = boxes[l.box], buffs = targetBuffs(b, S.params);
  const gives = [l.souls >= 0.5 ? soulsHTML(l.souls) : "", buffs ? (b.type === "buff" ? "50% buff" : buffsText(buffs)) : ""].filter(Boolean).join(" · ");
  li.draggable = true;
  li.className = "typed";
  li.style.setProperty("--type", BOX_TYPES[b.type].color);
  li.innerHTML = `<span class="n">${idx + 1}</span><div>
    <div class="row1"><span class="nm" title="${b.subclass}">${(r.pinned ?? []).includes(b.id) ? '<span class="pin" title="Added by you: kept when you re-optimize">📌</span>' : ""}${targetName(b)}</span><span class="t">+${(l.travel + l.svc + l.wait).toFixed(1)}s · ${fmtClock(l.done)}</span></div>
    <div class="gives">${gives}</div></div>`;
  li.onclick = () => { selectBox(l.box); focusOn(b.pos); };
  li.ondragstart = (e) => e.dataTransfer.setData("text/plain", idx);
  li.ondragover = (e) => { e.preventDefault(); li.classList.add("drag-over"); };
  li.ondragleave = () => li.classList.remove("drag-over");
  li.ondrop = (e) => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData("text/plain")), [moved] = r.stops.splice(from, 1);
    r.stops.splice(idx, 0, moved);
    computePlan(); save();
  };
  return li;
}
const escapeHtml = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
// Rename a route in place: Enter or clicking away saves, Esc cancels.
function renameInline(span, r) {
  const input = document.createElement("input");
  input.className = "rename"; input.value = r.name; input.maxLength = 40;
  span.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (keep && v) setRouteName(r, v); else renderRouteUI();
  };
  input.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
  input.onclick = (e) => e.stopPropagation();
}
function setRouteName(r, name) {
  r.name = name;
  syncRouteInputs(); drawPlan(); save();
}
function renderRouteUI() {
  const list = $("rpRoutes");
  $("routeTitle").textContent = `Route · ${R().name}`;
  list.innerHTML = "";
  S.routes.forEach((r, k) => {
    const P = plan[k], st = P?.legs.length ? routeStats(P) : null, active = k === S.active;
    const card = document.createElement("div");
    card.className = `rp-card${active ? " active" : ""}`;
    const h = document.createElement("div");
    h.className = "rp-card-head";
    h.innerHTML = `<span class="chev">${r.collapsed ? "▸" : "▾"}</span><span class="swatch" style="background:${ROUTE_COLORS[k % ROUTE_COLORS.length]}"></span>
      <div class="titles"><div class="nm"><span class="rname" title="Double-click to rename">${escapeHtml(r.name)}</span>${st ? ` <span class="muted">${fmtClock(P.startClock)}–${fmtClock(P.endClock)}</span>` : ""}</div>
      <div class="stats">${st ? statsLine(P, st) : P?.startPt ? "Not optimized yet" : "No start point"}</div></div>
      <button class="icon" data-act="rename" title="Rename this route">✎</button>
      <button class="icon" data-act="focus" title="Point the camera at this route">⌖</button>
      <button class="icon" data-act="fit" title="Zoom the minimap to this route">⤢</button>`;
    h.onclick = (e) => {
      const act = e.target.closest("button")?.dataset.act;
      if (act === "focus") { focusRoute(k); return; }
      if (act === "fit") { fitMinimapTo(k); return; }
      if (act === "rename") { renameInline(h.querySelector(".rname"), r); return; }
      if (active) r.collapsed = !r.collapsed;
      else { S.active = k; r.collapsed = false; }
      closeBoxMenu(); syncRouteInputs(); drawPlan(); save();
    };
    h.querySelector(".rname").ondblclick = (e) => { e.stopPropagation(); renameInline(e.target, r); };
    card.appendChild(h);
    if (!r.collapsed) {
      const body = document.createElement("div");
      body.className = "rp-body";
      if (!st) {
        const note = document.createElement("div");
        note.className = "sum";
        note.textContent = P?.startPt ? "No stops yet. Optimize it from the sidebar, or click targets on the map to add them." : k ? "Starts where the previous route ends. Optimize that one first, or pick a start." : "Pick a start in the sidebar, or click a box on the map and choose Start route here.";
        body.appendChild(note);
      } else {
        const ol = document.createElement("ol");
        st.done.forEach((l, idx) => ol.appendChild(stopItem(r, P, l, idx)));
        body.appendChild(ol);
        const warn = [];
        if (st.waits > 0.05) warn.push(`${fmtSec(st.waits)} waiting for spawns`);
        if (st.staminaWait > 0.05) warn.push(`${fmtSec(st.staminaWait)} waiting for stamina`);
        if (P.legs.some((l) => l.unreachable)) warn.push(`${P.legs.filter((l) => l.unreachable).length} stop(s) unreachable`);
        if (warn.length) { const w = document.createElement("div"); w.className = "sum wait"; w.textContent = warn.join(" · "); body.appendChild(w); }
      }
      card.appendChild(body);
    }
    list.appendChild(card);
  });
  const filled = plan.filter((p) => p.legs.length);
  if (S.routes.length > 1 && filled.length) {
    const all = filled.map(routeStats), souls = all.reduce((a, s) => a + s.souls, 0), buffs = all.reduce((a, s) => a + s.buffs, 0);
    const foot = document.createElement("div");
    foot.className = "rp-foot";
    foot.innerHTML = `<b>Whole plan</b> ${fmtClock(filled[0].startClock)} → ${fmtClock(filled[filled.length - 1].endClock)} · ${soulsHTML(souls)} · ${buffsText(buffs)}`;
    list.appendChild(foot);
  }
}
$("rpAdd").onclick = () => {
  for (const r of S.routes) r.collapsed = true;
  const r = newRoute(S.routes.length + 1, true);
  S.routes.push(r); S.active = S.routes.length - 1;
  syncRouteInputs(); computePlan(); save();
};

// Points of a route (start, stops, path) for camera and minimap framing.
function routePoints(k) {
  const P = plan[k], pts = [];
  if (P?.startPt) pts.push(P.startPt.point);
  for (const l of P?.legs ?? []) for (const q of l.points ?? []) pts.push(q);
  return pts;
}
function focusRoute(k) {
  const pts = routePoints(k);
  if (!pts.length) { status("That route has nothing to show yet."); return; }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const q of pts) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], q[j]); hi[j] = Math.max(hi[j], q[j]); }
  const c = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
  const span = Math.max(hi[0] - lo[0], hi[2] - lo[2], 20);
  const dist = span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.1;
  stopFollow();
  focusAnim = { from: controls.target.clone(), to: c, camFrom: camera.position.clone(), camTo: c.clone().add(new THREE.Vector3(-mm.flip * dist * 0.45, dist * 0.85, 0)), t: 0 };
}

// ---------------------------------------------------------------- box menu (click a box)
let menuBox = -1;
function selectBox(i) { selectedBox = i; rebuildBoxes(); }
function openBoxMenu(i, clientX, clientY) {
  menuBox = i; selectedBox = i;
  rebuildBoxes();
  const m = $("boxMenu"), vr = viewport.getBoundingClientRect();
  m.hidden = false;
  const x = Math.min(clientX - vr.left + 10, vr.width - m.offsetWidth - 8), y = Math.min(clientY - vr.top + 10, vr.height - m.offsetHeight - 8);
  m.style.left = `${Math.max(8, x)}px`; m.style.top = `${Math.max(8, y)}px`;
  fillMenuTimes(i);
}
function closeBoxMenu() {
  if (menuBox < 0 && !pointMenuOpen) return;
  pointMenuOpen = false;
  $("boxMenu").hidden = true;
  if (menuBox >= 0) { menuBox = -1; selectedBox = -1; rebuildBoxes(); }
}
// The walkable floor for a clicked surface: the spot itself, else the highest floor under it
// (a click on a wall or facade), else the nearest floor within 15 m.
function snapClick(p) {
  const at = snap(g, [p.x, p.y + 0.3, p.z], 3);
  if (at) return at;
  const below = trisAt(g, p.x, p.z).filter((h) => h.y <= p.y + 0.5).sort((a, b) => b.y - a.y)[0];
  if (below) return { tri: below.t, point: [p.x, below.y, p.z] };
  return snap(g, [p.x, p.y, p.z], 15);
}
// Right-click on open map: set the active route's start or end at that floor point.
let pointMenuOpen = false;
function openPointMenu(s, clientX, clientY) {
  closeBoxMenu();
  const m = $("boxMenu"), r = R();
  m.innerHTML = s
    ? `<div class="bm-title">Map point</div><div class="bm-info">Height ${s.point[1].toFixed(0)} m · ${S.routes.length > 1 ? r.name : "current route"}</div>
       <button data-act="start" class="primary"><span>Start ${r.name} here</span></button>
       <button data-act="end"><span>End ${r.name} here</span></button>
       <button data-act="fly"><span>Fly camera here</span></button>`
    : `<div class="bm-title">No walkable floor here</div><div class="bm-info">Right-click a street, roof or platform.</div>`;
  pointMenuOpen = true;
  m.hidden = false;
  const vr = viewport.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(clientX - vr.left + 10, vr.width - m.offsetWidth - 8))}px`;
  m.style.top = `${Math.max(8, Math.min(clientY - vr.top + 10, vr.height - m.offsetHeight - 8))}px`;
  m.querySelectorAll("button").forEach((btn) => (btn.onclick = () => {
    const act = btn.dataset.act, pt = { tri: s.tri, point: s.point, label: `Map point (${s.point[1].toFixed(0)} m up)` };
    closeBoxMenu();
    if (act === "fly") { focusOn(s.point); return; }
    if (act === "start") { r.start = pt; status(`${r.name} now starts here. Optimize to rebuild the route.`); }
    else { r.end = pt; r.endMode = "point"; status(`${r.name} now ends here.`); }
    syncRouteInputs(); computePlan(); save();
  }));
}
function renderBoxMenu() {
  if (menuBox < 0) return;
  const i = menuBox, b = boxes[i], t = BOX_TYPES[b.type], P = plan[S.active], r = R();
  const reach = boxReachable(i), k = r.stops.indexOf(i), broken = P?.brokenBefore.get(i);
  const why = reach ? "" : S.hero !== "tunnel" && b.reachableTunnel && !b.reachable ? "Tunnel heroes only." : b.minJump ? `Needs a ${b.minJump} m wall climb (max ${S.params.wallClimb} m).` : "No walkable route found to it.";
  const acts = [];
  if (reach || k >= 0) acts.push(["route", k >= 0 ? `Remove from ${r.name}` : `Add to ${r.name}`, true]);
  acts.push(["start", `Start ${r.name} here`], ["end", `End ${r.name} here`]);
  acts.push(["exclude", S.excluded[b.id] ? "Include in routes" : "Exclude from routes"]);
  if (!reach || overridden(i)) acts.push(["reach", overridden(i) ? "Mark as not reachable" : "I can reach this"]);
  acts.push(["fly", "Fly camera here"]);
  $("boxMenu").innerHTML = `<div class="bm-title" style="color:${t.color}">${targetName(b)}</div>
    <div class="bm-info">Spawns ${fmtClock(b.firstSpawn)}, respawns every ${(b.respawn / 60).toFixed(b.respawn % 60 ? 1 : 0)} min · ${valueText(b, P?.startClock ?? 180)}
    ${broken != null ? `<br>Broken earlier at ${fmtClock(broken)}, back at ${fmtClock(readyAt(i, P.brokenBefore))}` : ""}${k >= 0 ? `<br>Stop ${k + 1} of ${r.name}` : ""}${why ? `<br><span class="wait">${why}</span>` : ""}${overridden(i) ? "<br>Marked reachable" : ""}</div>`
    + acts.map(([a, label, primary]) => `<button data-act="${a}"${primary ? ' class="primary"' : ""}><span>${label}</span><span class="when"></span></button>`).join("");
  $("boxMenu").querySelectorAll("button").forEach((btn) => (btn.onclick = () => boxAction(btn.dataset.act, i)));
}
// Time the route gains (add) or loses (remove) with this target, shown next to the button.
async function fillMenuTimes(i) {
  const P = plan[S.active], btn = $("boxMenu").querySelector('button[data-act="route"] .when');
  if (!btn || !P?.startPt) return;
  btn.textContent = "…";
  const r = R(), k = r.stops.indexOf(i), svc = serviceTime(boxes[i], P.startClock, S.params);
  const { cost } = await routeCostFns();
  if (menuBox !== i) return;
  if (k >= 0) {
    const seq = [-1, ...r.stops, -2], prev = seq[k], next = seq[k + 2];
    const saved = cost(prev, i) + cost(i, next) - cost(prev, next) + svc;
    btn.textContent = `−${saved.toFixed(1)}s`;
  } else {
    const { added } = await cheapestInsert(i);
    btn.textContent = `+${(added + svc).toFixed(1)}s`;
  }
}
async function boxAction(act, i) {
  const b = boxes[i], r = R(), here = { ...boxTarget(i) ?? { tri: b.tri, point: b.navPoint }, label: `At ${targetName(b).toLowerCase()}` };
  if (act === "route") {
    const k = r.stops.indexOf(i);
    if (k >= 0) { r.stops.splice(k, 1); unpin(r, i); status(`Removed from ${r.name}.`); }
    else {
      if (!plan[S.active]?.startPt) { status("Set a start point for this route first."); return; }
      delete S.excluded[b.id];
      const { pos, added } = await cheapestInsert(i);
      r.stops.splice(pos, 0, i);
      r.pinned = [...new Set([...(r.pinned ?? []), b.id])];
      status(`Added to ${r.name} as stop ${pos + 1} (about +${added.toFixed(1)}s travel). It stays when you re-optimize.`);
    }
  } else if (act === "start") {
    if (!here.point) { status("No floor next to it to start from."); return; }
    r.start = here; r.stops = r.stops.filter((j) => j !== i); unpin(r, i);
    status(`${r.name} now starts here. Optimize to rebuild the route.`);
  } else if (act === "end") {
    if (!here.point) { status("No floor next to it to end on."); return; }
    r.end = here; r.endMode = "point";
    status(`${r.name} now ends here.`);
  } else if (act === "exclude") {
    if (S.excluded[b.id]) delete S.excluded[b.id]; else S.excluded[b.id] = true;
    for (const x of S.routes) { x.stops = x.stops.filter((j) => !S.excluded[boxes[j].id]); if (S.excluded[b.id]) unpin(x, i); }
  } else if (act === "reach") {
    S.reachOverride[b.id] = !overridden(i);
    status(S.reachOverride[b.id] ? "Marked reachable. Add it to a route or re-optimize." : "Marked not reachable.");
  } else if (act === "fly") { closeBoxMenu(); focusOn(b.pos); return; }
  closeBoxMenu();
  syncRouteInputs(); computePlan(); save();
}
// Steady-state travel cost between route positions (-1 = start, -2 = end), as the optimizer sees it.
async function routeCostFns() {
  const P = plan[S.active], p = eff(), w = planWeights(p), M = await getMatrix(), B = boxes.length;
  const fwd = pointRows(P.startPt, false), back = P.endPt ? pointRows(P.endPt, true) : null;
  const cost = (x, y) => {
    const v = x === -1 && y === -2 ? 0 : x === -1 ? dot(fwd, y * NC, w) : y === -2 ? (back ? dot(back, x * NC, w) : 0) : dot(M, (x * B + y) * NC, w);
    return Number.isFinite(v) ? v : 1e6;
  };
  return { cost };
}
// Insert a target where it adds the least travel.
async function cheapestInsert(i) {
  const { cost } = await routeCostFns(), seq = [-1, ...R().stops, -2];
  let best = 0, bestCost = Infinity;
  for (let k = 0; k < seq.length - 1; k++) {
    const added = cost(seq[k], i) + cost(i, seq[k + 1]) - cost(seq[k], seq[k + 1]);
    if (added < bestCost) { bestCost = added; best = k; }
  }
  return { pos: best, added: bestCost };
}

// ---------------------------------------------------------------- calibration
function routeFeatures() {
  const P = plan[S.active], done = P.legs.filter((l) => !l.unreachable);
  // spawn waits and stamina waits are not movement; they come off the measured time
  const notMoving = (l) => l.wait + l.sim.staminaWait + (l.box >= 0 && !isBox(boxes[l.box]) ? l.svc : 0);
  return { x: featuresOf(done, done.filter((l) => l.box >= 0 && isBox(boxes[l.box])).length), waits: done.reduce((a, l) => a + notMoving(l), 0) };
}
function renderSamples() {
  const t = $("samples"), w = weightsOf(S.params);
  if (!S.samples.length) { t.innerHTML = ""; return; }
  t.innerHTML = `<tr><th>Run</th><th>Measured</th><th>Model</th><th></th></tr>` + S.samples.map((s, i) => {
    const pred = s.x.reduce((a, x, k) => a + x * w[k], 0);
    return `<tr><td title="${s.label}">${s.label.slice(0, 26)}</td><td>${s.seconds.toFixed(1)}s</td><td>${pred.toFixed(1)}s</td><td><button class="link" data-i="${i}">remove</button></td></tr>`;
  }).join("");
  t.querySelectorAll("button").forEach((b) => (b.onclick = () => { S.samples.splice(Number(b.dataset.i), 1); renderSamples(); save(); }));
}
async function suggestTests() {
  const p = eff(), w = planWeights(p), M = await getMatrix(), B = boxes.length;
  const reach = boxes.map((_, i) => i).filter((i) => boxes[i].reachable && isBox(boxes[i]));
  const kinds = [
    ["Flat run", (c) => c[C.walk] > 60 && c[C.walk] < 160 && c[C.zip] + c[C.rope] + c[C.drop] + c[C.jumpUp] + c[C.fixed] < 0.5 ? c[C.walk] : -1],
    ["Zipline ride", (c) => c[C.zip] > 80 && c[C.fixed] === 0 && c[C.rope] === 0 ? c[C.zip] - c[C.walk] : -1],
    ["Rope climb", (c) => c[C.rope] > 8 && c[C.zip] === 0 && c[C.fixed] === 0 ? c[C.rope] * 4 - c[C.walk] : -1],
    ["Big drops", (c) => c[C.drop] > 12 && c[C.zip] === 0 && c[C.rope] === 0 && c[C.fixed] === 0 ? c[C.drop] * 3 - c[C.walk] : -1],
    ["Jump-ups", (c) => c[C.jumps] >= 3 && c[C.zip] === 0 && c[C.rope] === 0 && c[C.fixed] === 0 ? c[C.jumpUp] * 5 - c[C.walk] * 0.2 : -1],
    ["Jump pad", (c) => c[C.fixed] > 0.5 && c[C.fixed] < 3.9 && c[C.zip] === 0 ? 100 - c[C.walk] : -1],
  ];
  const tests = [];
  for (const [label, score] of kinds) {
    let best = null;
    for (const i of reach) for (const j of reach) {
      if (i === j) continue;
      const o = (i * B + j) * NC;
      if (Number.isNaN(M[o])) continue;
      const s = score(M.subarray(o, o + NC));
      if (s > 0 && (!best || s > best.s)) best = { s, i, j };
    }
    if (best) tests.push({ label, ...best, time: dot(M, (best.i * B + best.j) * NC, w) + p.breakTime });
  }
  const ol = $("testList");
  ol.innerHTML = tests.map((t, k) => `<li>${t.label}: ~${t.time.toFixed(1)}s <button data-k="${k}">Load</button></li>`).join("") || "<li>No suitable pairs found.</li>";
  ol.querySelectorAll("button").forEach((btn) => (btn.onclick = () => {
    const t = tests[Number(btn.dataset.k)], a = boxes[t.i];
    const r = newRoute(S.routes.length + 1);
    Object.assign(r, { name: `Test: ${t.label}`, startWhen: "fixed", clock: 600, start: { tri: a.tri, point: a.navPoint, label: `At the ${BOX_TYPES[a.type].label.toLowerCase()} (break it, start timer)` }, endMode: "open", stops: [t.j] });
    S.routes.push(r); S.active = S.routes.length - 1;
    syncRouteInputs(); computePlan(); focusOn(a.pos); save();
    status("Test loaded as its own route tab. Break the box at S, start the timer, follow the line, stop when box 1 breaks.");
  }));
}

// ---------------------------------------------------------------- camera: orbit + WASD
function resetView() {
  const bb = mapMesh?.geometry.boundingBox;
  if (!bb) return;
  const c = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
  controls.target.copy(c);
  // behind your own base, looking toward the enemy's
  const flip = mm.flip ?? 1;
  camera.position.set(c.x - flip * size.x * 0.55, c.y + Math.max(size.x, size.z) * 0.6, c.z + 0.01);
  controls.update();
}
function topView() {
  const t = controls.target, h = camera.position.distanceTo(t);
  camera.position.set(t.x - (mm.flip ?? 1) * 0.01, t.y + h, t.z);
  controls.update();
}
let focusAnim = null;
function focusOn(p) {
  const target = new THREE.Vector3(...p), offset = camera.position.clone().sub(controls.target).setLength(45);
  focusAnim = { from: controls.target.clone(), to: target, camFrom: camera.position.clone(), camTo: target.clone().add(offset), t: 0 };
}
const keys = new Set();
const typing = () => /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? "");
addEventListener("keydown", (e) => {
  if (e.key === "Escape") { stopPicking(); stopFollow(); closeBoxMenu(); }
  if (typing()) return;
  if (follow.on && e.key === " ") { setPlaying(!follow.playing); e.preventDefault(); return; }
  if (follow.on && e.key.startsWith("Arrow")) {
    stepFollow(e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
    e.preventDefault();
    return;
  }
  const k = e.key.toLowerCase();
  if ("wasdqe".includes(k) && k.length === 1) { keys.add(k); e.preventDefault(); }
  if (e.key === "Shift") keys.add("shift");
});
addEventListener("keyup", (e) => { keys.delete(e.key.toLowerCase()); if (e.key === "Shift") keys.delete("shift"); });
addEventListener("blur", () => keys.clear());
function flyStep(dt) {
  if (!keys.size || follow.on) return;
  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1).applyQuaternion(camera.quaternion).setY(0);
  fwd.normalize();
  const right = new THREE.Vector3().crossVectors(fwd, camera.up).normalize();
  const move = new THREE.Vector3();
  if (keys.has("w")) move.add(fwd);
  if (keys.has("s")) move.sub(fwd);
  if (keys.has("d")) move.add(right);
  if (keys.has("a")) move.sub(right);
  if (keys.has("e")) move.y += 1;
  if (keys.has("q")) move.y -= 1;
  if (!move.lengthSq()) return;
  // speed scales with zoom so it feels the same up close and zoomed out
  const dist = camera.position.distanceTo(controls.target);
  const speed = Math.min(Math.max(dist * 0.9, 12), 260) * (keys.has("shift") ? 3 : 1);
  move.normalize().multiplyScalar(speed * dt);
  camera.position.add(move); controls.target.add(move);
  focusAnim = null;
}

// ---------------------------------------------------------------- follow path (chase camera)
// Stop 0 is the route start; each later stop is reached by its leg. The route is laid out on a
// timeline using its estimated times: each leg's travel time is spread over its moves by how
// fast that kind of move is (ziplines quick, runs slower), then the camera holds at the box for
// its break/clear time and any spawn wait. Play runs that timeline in real time (or faster or
// slower) so it can be followed on a second monitor; arrows and Prev/Next jump between stops.
const follow = { on: false, idx: 0, stops: [], anim: null, playing: false, t: 0, speed: 1, timeline: null, dir: new THREE.Vector3(1, 0, 0), target: new THREE.Vector3(), hudAt: 0 };
const CHASE_BACK = 16, CHASE_UP = 12;
const liftV = (p) => new THREE.Vector3(p[0], p[1] + 1.2, p[2]);
function followStops() {
  const P = plan[S.active];
  if (!P?.startPt || !P.legs.length) return null;
  const stops = [{ pos: P.startPt.point, leg: null }];
  for (const l of P.legs) if (!l.unreachable) stops.push({ pos: l.points[l.points.length - 1], leg: l });
  return stops;
}
// Seconds per meter for each kind of move, used only to split a leg's estimated time.
function movePace(kind) {
  const p = S.params;
  return kind === "zip" || kind === "latch" ? 1 / p.zipSpeed : kind === "rope" ? 1 / p.ropeSpeed
    : kind === "drop" || kind === "gap" || kind === "dismount" ? 1 / p.dashSpeed : 1 / p.runSpeed;
}
function buildTimeline(stops) {
  const P = plan[S.active], legs = [];
  let t = 0;
  for (let k = 1; k < stops.length; k++) {
    const l = stops[k].leg, pts = l.points.map(liftV), segs = [];
    let raw = 0;
    for (let i = 1; i < pts.length; i++) {
      const kind = l.kinds[i - 1], len = pts[i].distanceTo(pts[i - 1]);
      const d = kind === "pad" || kind === "teleport" ? 1 : len * movePace(kind);
      segs.push({ a: pts[i - 1], b: pts[i], d }); raw += d;
    }
    const scale = raw > 0 ? l.travel / raw : 0;
    for (const s of segs) s.d *= scale;
    const start = t;
    t = l.done - P.startClock; // arrival plus wait plus break/clear, as the plan computed it
    legs.push({ start, travelEnd: start + l.travel, end: Math.max(t, start + l.travel), segs });
  }
  return { legs, total: t };
}
// Camera target and heading at route time t.
function timelineAt(t) {
  const tl = follow.timeline;
  let k = tl.legs.findIndex((L) => t < L.end);
  if (k < 0) k = tl.legs.length - 1;
  const L = tl.legs[k];
  let u = Math.max(0, Math.min(t, L.travelEnd) - L.start);
  for (const s of L.segs) {
    if (u <= s.d || s === L.segs[L.segs.length - 1]) {
      const f = s.d > 1e-6 ? Math.min(u / s.d, 1) : 1;
      return { k, pos: s.a.clone().lerp(s.b, f), dir: s.b.clone().sub(s.a).setY(0), moving: t < L.travelEnd };
    }
    u -= s.d;
  }
  return { k, pos: liftV(follow.stops[k + 1].pos), dir: null, moving: false };
}
function startFollow(play = false) {
  const st = followStops();
  if (!st) { status("Optimize a route first."); return; }
  Object.assign(follow, { on: true, idx: 0, stops: st, anim: null, playing: false, t: 0, timeline: buildTimeline(st) });
  controls.enabled = false; focusAnim = null;
  const first = st[1]?.leg?.points;
  follow.dir.set(1, 0, 0);
  if (first?.length > 1) follow.dir.subVectors(liftV(first[1]), liftV(first[0])).setY(0).normalize();
  follow.target.copy(liftV(st[0].pos));
  $("follow").classList.add("active");
  renderFollowHud();
  if (play) setPlaying(true);
}
function stopFollow() {
  if (!follow.on) return;
  follow.on = false; follow.anim = null; follow.playing = false; controls.enabled = true;
  $("followHud").hidden = true;
  $("follow").classList.remove("active");
}
function setPlaying(on) {
  if (on && follow.t >= follow.timeline.total - 1e-3) follow.t = 0; // replay from the start
  follow.playing = on; follow.anim = null;
  renderFollowHud();
}
// Time at which stop k is done (stop 0 = route start).
const stopTime = (k) => (k <= 0 ? 0 : follow.timeline.legs[k - 1].end);
function stepFollow(d) {
  const ni = follow.idx + d;
  if (ni < 0 || ni >= follow.stops.length) return;
  if (follow.playing) { follow.t = ni ? follow.timeline.legs[ni - 1].travelEnd : 0; follow.idx = ni; renderFollowHud(); return; }
  const leg = (d > 0 ? follow.stops[ni] : follow.stops[follow.idx]).leg;
  let pts = leg.points.map(liftV);
  if (d < 0) pts = pts.reverse();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const len = cum[cum.length - 1];
  follow.anim = { pts, cum, len, t: 0, dur: Math.min(Math.max(len / 35, 0.8), 4.5) };
  follow.idx = ni;
  follow.t = stopTime(ni);
  if (follow.stops[ni].leg?.box >= 0) selectedBox = follow.stops[ni].leg.box;
  renderFollowHud(); rebuildBoxes();
}
function followFrame(dt) {
  if (follow.playing) {
    follow.t = Math.min(follow.t + dt * follow.speed, follow.timeline.total);
    const at = timelineAt(follow.t);
    follow.target.copy(at.pos);
    if (at.dir && at.dir.lengthSq() > 1e-4) follow.dir.lerp(at.dir.normalize(), 1 - Math.exp(-dt * 4)).normalize();
    const idx = at.moving ? at.k : at.k + 1;
    if (idx !== follow.idx) {
      follow.idx = idx;
      const b = follow.stops[idx]?.leg?.box;
      if (b >= 0) { selectedBox = b; rebuildBoxes(); }
      renderFollowHud();
    }
    if (follow.t >= follow.timeline.total) setPlaying(false);
    else if (performance.now() - follow.hudAt > 200) updateFollowClock();
  } else if (follow.anim) {
    const a = follow.anim;
    a.t = Math.min(a.t + dt / a.dur, 1);
    const s = (a.t < 0.5 ? 2 * a.t * a.t : 1 - (-2 * a.t + 2) ** 2 / 2) * a.len;
    let i = 1;
    while (i < a.cum.length - 1 && a.cum[i] < s) i++;
    const seg = a.cum[i] - a.cum[i - 1], f = seg > 1e-6 ? (s - a.cum[i - 1]) / seg : 1;
    follow.target.lerpVectors(a.pts[i - 1], a.pts[i], f);
    const dir = a.pts[i].clone().sub(a.pts[i - 1]).setY(0);
    if (dir.lengthSq() > 1e-4) follow.dir.lerp(dir.normalize(), 1 - Math.exp(-dt * 6)).normalize();
    if (a.t >= 1) follow.anim = null;
  }
  const want = follow.target.clone().addScaledVector(follow.dir, -CHASE_BACK).add(new THREE.Vector3(0, CHASE_UP, 0));
  controls.target.lerp(follow.target, 1 - Math.exp(-dt * 12));
  camera.position.lerp(want, 1 - Math.exp(-dt * 5));
  camera.lookAt(controls.target);
}
function updateFollowClock() {
  follow.hudAt = performance.now();
  const el = $("followHud").querySelector(".fclock");
  if (!el) return;
  const P = plan[S.active], total = follow.timeline.total;
  el.textContent = `${fmtClock(follow.t)} / ${fmtClock(total)} · game ${fmtClock(P.startClock + follow.t)}`;
  $("followHud").querySelector(".fbar > div").style.width = `${(100 * follow.t) / Math.max(total, 1e-6)}%`;
}
function renderFollowHud() {
  const hud = $("followHud"), st = follow.stops[follow.idx], n = follow.stops.length - 1, P = plan[S.active];
  let text;
  if (follow.idx === 0) text = `<b>Start</b> · ${S.routes[S.active].name} · ${fmtClock(P.startClock)}`;
  else if (st.leg.box < 0) text = `<b>${R().endMode === "loop" ? "Back to start" : "End point"}</b> · ${fmtClock(st.leg.done)} · +${st.leg.travel.toFixed(1)}s`;
  else {
    const b = boxes[st.leg.box];
    text = `<b>Stop ${follow.idx} of ${n}</b> · <span style="color:${BOX_TYPES[b.type].color}">${targetName(b)}</span> · ${fmtClock(st.leg.done)} · +${(st.leg.travel + st.leg.svc).toFixed(1)}s<br>${movesText(st.leg)}`;
  }
  hud.innerHTML = `${text}
    <div class="fbar"><div></div></div><div class="fclock"></div>
    <div class="fbtns">
      <button data-f="prev" title="Previous stop (←)"${follow.idx === 0 ? " disabled" : ""}>◀</button>
      <button data-f="play" class="primary" title="Play the route in real time">${follow.playing ? "❚❚ Pause" : "▶ Play"}</button>
      <button data-f="stop" title="Stop following (Esc)">■ Stop</button>
      <button data-f="next" title="Next stop (→)"${follow.idx === n ? " disabled" : ""}>▶</button>
      <select data-f="speed" title="Playback speed">${[0.5, 1, 1.5, 2].map((v) => `<option value="${v}"${v === follow.speed ? " selected" : ""}>${v}×</option>`).join("")}</select>
    </div>`;
  hud.querySelector('[data-f="prev"]').onclick = () => stepFollow(-1);
  hud.querySelector('[data-f="next"]').onclick = () => stepFollow(1);
  hud.querySelector('[data-f="play"]').onclick = () => setPlaying(!follow.playing);
  hud.querySelector('[data-f="stop"]').onclick = () => stopFollow();
  hud.querySelector('[data-f="speed"]').onchange = (e) => { follow.speed = Number(e.target.value); e.target.blur(); };
  hud.hidden = false;
  updateFollowClock();
}

// ---------------------------------------------------------------- minimap
// Drawn from the navmesh (the game's minimap image isn't in the export): walkable floor shaded
// by height, Amber base at the bottom. Shows routes, selectable boxes and the camera's view.
const mm = { canvas: $("minimap"), bg: null, size: 0, cx: 0, cz: 0, flip: 1, px: 0, last: 0 };
function buildMinimap() {
  const tv = g.triVerts;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let t = 0; t < g.nTri; t++) {
    if (!g.mainland[t]) continue;
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      x0 = Math.min(x0, tv[o]); x1 = Math.max(x1, tv[o]); z0 = Math.min(z0, tv[o + 2]); z1 = Math.max(z1, tv[o + 2]);
      y0 = Math.min(y0, tv[o + 1]); y1 = Math.max(y1, tv[o + 1]);
    }
  }
  mm.full = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, size: Math.max(x1 - x0, z1 - z0) * 1.04 };
  mm.heights = [y0, y1];
  // the Amber (Hidden King) base sits on one end of the lane axis; your base goes at the bottom
  const amber = nav.presets.filter((p) => p.name.startsWith("Amber"));
  mm.amberFlip = amber.length && amber.reduce((a, p) => a + p.pos[0], 0) / amber.length > mm.full.cx ? -1 : 1;
  setMinimapView(mm.full);
}
function applyTeam() {
  mm.flip = S.team === "amber" ? mm.amberFlip : -mm.amberFlip;
  $("mmTeam").textContent = S.team === "amber" ? "Team: Hidden King (Amber) ⇅" : "Team: Archmother (Sapphire) ⇅";
}
function setMinimapView(view) {
  Object.assign(mm, { cx: view.cx, cz: view.cz, size: view.size });
  applyTeam();
  renderMinimapBg();
}
function fitMinimapTo(k) {
  const pts = routePoints(k);
  if (!pts.length) { status("That route has nothing to show yet."); return; }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const q of pts) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]); }
  setMinimapView({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, size: Math.max(x1 - x0, z1 - z0, 40) * 1.25 });
}
function renderMinimapBg() {
  const tv = g.triVerts, [y0, y1] = mm.heights;
  const dpr = Math.min(devicePixelRatio, 2);
  mm.px = Math.round(mm.canvas.clientWidth * dpr);
  mm.canvas.width = mm.canvas.height = mm.px;
  const bg = document.createElement("canvas");
  bg.width = bg.height = mm.px;
  const c = bg.getContext("2d");
  c.fillStyle = "#12151b"; c.fillRect(0, 0, mm.px, mm.px);
  // lower floors first so rooftops draw on top
  const order = Array.from({ length: g.nTri }, (_, t) => t).sort((a, b) => g.nodePos[a * 3 + 1] - g.nodePos[b * 3 + 1]);
  for (const t of order) {
    const h = (g.nodePos[t * 3 + 1] - y0) / (y1 - y0), l = Math.round(48 + h * 150) * (g.mainland[t] ? 1 : 0.55);
    c.fillStyle = `rgb(${l * 0.86 | 0},${l * 0.9 | 0},${l | 0})`;
    c.beginPath();
    for (let k = 0; k < 3; k++) { const [u, v] = mmPoint(tv[t * 9 + k * 3], tv[t * 9 + k * 3 + 2]); k ? c.lineTo(u, v) : c.moveTo(u, v); }
    c.closePath(); c.fill();
  }
  mm.bg = bg;
  mm.last = 0;
}
// Patron icons (deadlock.wiki) on each team's spawn, so it's clear which side is which. The wiki CDN
// refuses hotlinked requests that carry a referrer, so they load without one.
const PATRONS = {
  amber: { name: "Hidden King", color: "#e9a23b", src: "https://cdn.deadlock.wiki/thumb/Hidden_King.png/120px-Hidden_King.png" },
  sapphire: { name: "Archmother", color: "#4fb6c9", src: "https://cdn.deadlock.wiki/thumb/Archmother.png/120px-Archmother.png" },
};
for (const pt of Object.values(PATRONS)) {
  pt.img = new Image();
  pt.img.referrerPolicy = "no-referrer";
  pt.img.onload = () => (mm.last = 0);
  pt.img.src = pt.src;
}
function drawPatrons(c, s) {
  for (const [team, pt] of Object.entries(PATRONS)) {
    const spawns = nav.presets.filter((p) => p.name.toLowerCase().startsWith(team));
    if (!spawns.length) continue;
    const x = spawns.reduce((acc, p) => acc + p.pos[0], 0) / spawns.length, z = spawns.reduce((acc, p) => acc + p.pos[2], 0) / spawns.length;
    let [u, v] = mmPoint(x, z);
    const R = 13 * s, pad = R + 2 * s;
    // keep the badge on screen when the minimap is zoomed to a route, pinned to the nearest edge
    const off = u < pad || v < pad || u > mm.px - pad || v > mm.px - pad;
    u = Math.min(Math.max(u, pad), mm.px - pad); v = Math.min(Math.max(v, pad), mm.px - pad);
    c.globalAlpha = off ? 0.75 : 1;
    c.fillStyle = "rgba(15,17,21,.9)"; c.strokeStyle = pt.color; c.lineWidth = 2 * s;
    c.beginPath(); c.arc(u, v, R, 0, 7); c.fill(); c.stroke();
    if (pt.img.complete && pt.img.naturalWidth) c.drawImage(pt.img, u - R * 0.82, v - R * 0.82, R * 1.64, R * 1.64);
    c.globalAlpha = 1;
  }
}
function mmPoint(x, z) {
  return [(0.5 + (mm.flip * (z - mm.cz)) / mm.size) * mm.px, (0.5 - (mm.flip * (x - mm.cx)) / mm.size) * mm.px];
}
function mmWorld(u, v) {
  return { x: mm.cx + (mm.flip * (0.5 - v / mm.px)) * mm.size, z: mm.cz + (mm.flip * (u / mm.px - 0.5)) * mm.size };
}
function drawMinimap(now) {
  if (!mm.bg || now - mm.last < 80) return;
  mm.last = now;
  const c = mm.canvas.getContext("2d"), s = mm.px / 240;
  c.drawImage(mm.bg, 0, 0);
  c.lineCap = c.lineJoin = "round";
  c.strokeStyle = "rgba(94,200,229,.55)"; c.lineWidth = 1 * s;
  for (const pts of nav.ziplines) { c.beginPath(); pts.forEach((p, i) => { const [u, v] = mmPoint(p[0], p[2]); i ? c.lineTo(u, v) : c.moveTo(u, v); }); c.stroke(); }
  const cands = new Set(boxCandidates());
  for (const i of cands) {
    const [u, v] = mmPoint(boxes[i].pos[0], boxes[i].pos[2]);
    c.fillStyle = BOX_TYPES[boxes[i].type].color;
    c.fillRect(u - 0.8 * s, v - 0.8 * s, 1.6 * s, 1.6 * s);
  }
  plan.forEach((P, k) => {
    const active = k === S.active;
    c.strokeStyle = ROUTE_COLORS[k % ROUTE_COLORS.length]; c.globalAlpha = active ? 1 : 0.55; c.lineWidth = (active ? 2 : 1.2) * s;
    c.beginPath();
    let first = true;
    for (const l of P.legs) for (const p of l.points ?? []) { const [u, v] = mmPoint(p[0], p[2]); first ? c.moveTo(u, v) : c.lineTo(u, v); first = false; }
    c.stroke();
    if (P.startPt) { const [u, v] = mmPoint(P.startPt.point[0], P.startPt.point[2]); c.fillStyle = "#fff"; c.beginPath(); c.arc(u, v, 3 * s, 0, 7); c.fill(); }
  });
  c.globalAlpha = 1;
  drawPatrons(c, s);
  // camera: position, view wedge, focus point
  const [cu, cv] = mmPoint(camera.position.x, camera.position.z), [fu, fv] = mmPoint(controls.target.x, controls.target.z);
  const ang = Math.atan2(fv - cv, fu - cu), half = THREE.MathUtils.degToRad(camera.fov * camera.aspect) / 2, R2 = 26 * s;
  c.fillStyle = "rgba(242,181,68,.22)"; c.strokeStyle = "rgba(242,181,68,.8)"; c.lineWidth = 1 * s;
  c.beginPath(); c.moveTo(cu, cv); c.arc(cu, cv, R2, ang - Math.min(half, 1.2), ang + Math.min(half, 1.2)); c.closePath(); c.fill(); c.stroke();
  c.fillStyle = "#f2b544"; c.beginPath(); c.arc(cu, cv, 3.2 * s, 0, 7); c.fill();
  c.strokeStyle = "#fff"; c.beginPath(); c.arc(fu, fv, 2.6 * s, 0, 7); c.stroke();
}
mm.canvas.addEventListener("click", (e) => {
  if (!g) return;
  const r = mm.canvas.getBoundingClientRect(), dpr = mm.px / r.width;
  const { x, z } = mmWorld((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  const floors = trisAt(g, x, z).map((h) => h.y);
  stopFollow();
  focusOn([x, floors.length ? Math.max(...floors) : controls.target.y, z]);
});

// ---------------------------------------------------------------- picking
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;
const ndc = new THREE.Vector2();
let picking = null; // "start" | "end"
function pickAt(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const boxHit = boxMesh ? ray.intersectObject(boxMesh)[0] : null;
  let mapHit = null;
  // skip surfaces hidden by the height slice or dissolved by the cutaway
  if (mapMesh) {
    ray.firstHitOnly = false;
    for (const h of ray.intersectObject(mapMesh)) {
      if (h.point.y > mapUniforms.uSlice.value || cutAway(h.point)) continue;
      mapHit = h; break;
    }
    ray.firstHitOnly = true;
  }
  if (boxHit && (S.view.xray || !mapHit || boxHit.distance <= mapHit.distance + 0.5)) return { box: boxHit.instanceId, point: boxHit.point };
  return mapHit ? { point: mapHit.point } : null;
}
function cutAway(p) {
  if (!S.view.cutaway) return false;
  const cam = camera.position, f = controls.target, d = f.clone().sub(cam), L = d.length(), u = d.divideScalar(L);
  const t = p.clone().sub(cam).dot(u);
  if (t < 0 || t > L - S.view.cutRadius * 0.3) return p.distanceTo(cam) < S.view.cutRadius * 0.45;
  return p.clone().sub(cam.clone().addScaledVector(u, t)).length() < S.view.cutRadius * 0.75;
}
let downAt = null;
renderer.domElement.addEventListener("pointerdown", (e) => (downAt = [e.clientX, e.clientY]));
// right-click without dragging (dragging pans the camera) opens the point or box menu
renderer.domElement.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (!g || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pickAt(e);
  if (!hit) { closeBoxMenu(); return; }
  if (hit.box != null) { closeBoxMenu(); openBoxMenu(hit.box, e.clientX, e.clientY); return; }
  openPointMenu(snapClick(hit.point), e.clientX, e.clientY);
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (e.button !== 0) return; // right button: handled by the context menu
  if (!g || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const hit = pickAt(e);
  if (!hit) return;
  if (picking) {
    const s = snap(g, [hit.point.x, hit.point.y + 0.3, hit.point.z], 8);
    if (!s) { status("No walkable floor there. Pick a street, roof or platform."); return; }
    const pt = { tri: s.tri, point: s.point, label: `Map point ${s.point.map((v) => v.toFixed(0)).join(", ")}` };
    if (picking === "start") { R().start = pt; R().stops = []; } else R().end = pt;
    stopPicking(); syncRouteInputs(); computePlan(); save();
    return;
  }
  if (hit.box != null) openBoxMenu(hit.box, e.clientX, e.clientY);
  else closeBoxMenu();
});
const tooltip = $("tooltip");
renderer.domElement.addEventListener("pointermove", (e) => {
  if (e.buttons || !boxMesh) { tooltip.hidden = true; return; }
  const hit = pickAt(e);
  if (hit?.box == null) { tooltip.hidden = true; return; }
  const b = boxes[hit.box], k = R().stops.indexOf(hit.box), t = BOX_TYPES[b.type];
  tooltip.innerHTML = `<b>${t.label}</b> · ${b.groupName}<br><span class="muted">${valueText(b, plan[S.active]?.startClock ?? 180)}${k >= 0 ? ` · stop ${k + 1}` : ""}${boxReachable(hit.box) ? "" : " · unreachable"}<br>click for details</span>`;
  const r = viewport.getBoundingClientRect();
  tooltip.style.left = e.clientX - r.left + "px"; tooltip.style.top = e.clientY - r.top + "px";
  tooltip.hidden = false;
});
function startPicking(kind) {
  picking = kind;
  $("pickHint").textContent = `Click the map to set the ${kind} point · Esc to cancel`;
  $("pickHint").hidden = false;
  $(kind === "start" ? "pickStart" : "pickEnd").classList.add("active");
}
function stopPicking() { picking = null; $("pickHint").hidden = true; $("pickStart").classList.remove("active"); $("pickEnd").classList.remove("active"); }

// ---------------------------------------------------------------- inputs
const PARAM_INPUTS = ["runSpeed", "wallClimb", "maxJumpUp", "maxGap", "zipSpeed", "latchTime", "ropeSpeed", "jumpTime", "climbCost", "dropCost", "rampCost", "fixedScale", "breakTime", "campDps", "campDpsPerMin", "sinnerTime", "sinnerBuffs",
  "stamina", "staminaRegen", "dashSpeed", "dashDistance", "freeJumpUp", "freeGap", "downDashCost", "downDashMin", "zipCarry", "wallClimbTime"];
const PARAM_CHECKS = ["useZip", "useRope", "usePads", "useTeleport", "useDash", "useDownDash"];
function syncInputs() {
  for (const k of PARAM_INPUTS) $(k).value = +Number(S.params[k]).toFixed(3);
  for (const k of PARAM_CHECKS) $(k).checked = S.params[k];
  $("spawnMode").value = S.spawnMode; $("hero").value = S.hero;
  $("grabNearby").value = S.grabNearby;
  $("ignoreIsolated").checked = S.ignoreIsolated; $("statueDetour").value = S.statueDetour; $("detourRow").hidden = !S.ignoreIsolated;
  $("prioritizeTough").checked = S.prioritizeTough; $("buffValue").value = S.buffValue;
  $("cutaway").checked = S.view.cutaway; $("cutRadius").value = S.view.cutRadius; $("xray").checked = S.view.xray;
  mapUniforms.uCutOn.value = S.view.cutaway ? 1 : 0; mapUniforms.uCut.value = S.view.cutRadius;
  syncRouteInputs();
}
function syncRouteInputs() {
  if (!nav) return;
  const r = R();
  if (document.activeElement !== $("routeName")) $("routeName").value = r.name;
  $("startWhen").value = S.active === 0 ? "fixed" : r.startWhen;
  $("startWhen").disabled = S.active === 0;
  $("clockRow").hidden = S.active > 0 && r.startWhen === "after";
  $("gapRow").hidden = !(S.active > 0 && r.startWhen === "after");
  $("startClock").value = fmtClock(r.clock); $("gap").value = r.gap;
  $("startPrevRow").hidden = S.active === 0;
  $("startPrev").checked = S.active > 0 && !r.start;
  $("startLabel").textContent = r.start ? r.start.label : S.active ? "where the previous route ended" : "not set";
  renderBestStarts();
  $("endMode").value = r.endMode;
  $("endRow").hidden = r.endMode !== "point";
  $("endLabel").textContent = r.end?.label ?? "not set";
  $("mode").value = r.mode; $("budget").value = r.budget; $("radius").value = r.radius; $("radiusVal").textContent = r.radius ? `${r.radius} m` : "all";
  $("budgetRow").hidden = r.mode !== "budget";
  $("deleteRoute").hidden = S.routes.length < 2;
}
function onParamsChanged() { computePlan(); renderSamples(); save(); }
for (const k of PARAM_INPUTS) $(k).onchange = () => { const v = Number($(k).value); if (v > 0 || (k !== "runSpeed" && v >= 0)) S.params[k] = v; onParamsChanged(); };
for (const k of PARAM_CHECKS) $(k).onchange = () => { S.params[k] = $(k).checked; onParamsChanged(); };
$("resetParams").onclick = () => { S.params = { ...DEFAULT_PARAMS }; syncInputs(); onParamsChanged(); };
$("spawnMode").onchange = () => { S.spawnMode = $("spawnMode").value; computePlan(); save(); };
$("hero").onchange = () => { S.hero = $("hero").value; onParamsChanged(); };
$("ignoreIsolated").onchange = () => { S.ignoreIsolated = $("ignoreIsolated").checked; $("detourRow").hidden = !S.ignoreIsolated; save(); };
$("grabNearby").onchange = () => { S.grabNearby = Math.max(0, Number($("grabNearby").value) || 0); save(); };
$("mmFull").onclick = () => setMinimapView(mm.full);
$("mmTeam").onclick = () => { S.team = S.team === "amber" ? "sapphire" : "amber"; applyTeam(); renderMinimapBg(); save(); };
$("statueDetour").onchange = () => { S.statueDetour = Math.max(0, Number($("statueDetour").value) || 0); save(); };
$("prioritizeTough").onchange = () => { S.prioritizeTough = $("prioritizeTough").checked; save(); };
$("buffValue").onchange = () => { S.buffValue = Number($("buffValue").value) || 0; save(); };
$("routeName").onchange = () => { const v = $("routeName").value.trim(); if (v) setRouteName(R(), v); else $("routeName").value = R().name; };
$("startWhen").onchange = () => { R().startWhen = $("startWhen").value; syncRouteInputs(); computePlan(); save(); };
$("startClock").onchange = () => { const t = parseClock($("startClock").value); if (t != null) R().clock = t; syncRouteInputs(); computePlan(); save(); };
$("gap").onchange = () => { R().gap = Number($("gap").value) || 0; computePlan(); save(); };
$("startPrev").onchange = () => {
  if ($("startPrev").checked) { R().start = null; R().stops = []; syncRouteInputs(); computePlan(); save(); }
  else startPicking("start");
};
$("endMode").onchange = () => { R().endMode = $("endMode").value; syncRouteInputs(); computePlan(); save(); };
$("mode").onchange = () => { R().mode = $("mode").value; syncRouteInputs(); save(); };
$("budget").onchange = () => { R().budget = Number($("budget").value) || 60; save(); };
// Radius slider: a translucent sphere around the start shows the range while you drag (and a moment after).
const radiusSphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: "#f2b544", transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide }));
const radiusRing = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.SphereGeometry(1, 24, 12)), new THREE.LineBasicMaterial({ color: "#f2b544", transparent: true, opacity: 0.35 }));
radiusSphere.add(radiusRing);
radiusSphere.visible = false; radiusSphere.renderOrder = 4;
scene.add(radiusSphere);
let radiusHide = 0;
function showRadius() {
  const P = plan[S.active], rad = R().radius;
  clearTimeout(radiusHide);
  if (!P?.startPt || !rad) { radiusSphere.visible = false; return; }
  radiusSphere.position.set(...P.startPt.point);
  radiusSphere.scale.setScalar(rad);
  radiusSphere.visible = true;
  radiusHide = setTimeout(() => (radiusSphere.visible = false), 2500);
}
$("radius").oninput = () => {
  R().radius = Number($("radius").value) || 0;
  $("radiusVal").textContent = R().radius ? `${R().radius} m` : "all";
  showRadius(); rebuildBoxes();
};
$("radius").onchange = () => { save(); };
$("radius").onpointerenter = showRadius;
$("clearExcluded").onclick = () => { S.excluded = {}; rebuildBoxes(); save(); };
$("pickStart").onclick = () => (picking === "start" ? stopPicking() : startPicking("start"));
$("pickEnd").onclick = () => (picking === "end" ? stopPicking() : startPicking("end"));
$("solve").onclick = () => optimize().catch((e) => { console.error(e); status(`Optimize failed: ${e.message}`); });
$("follow").onclick = () => (follow.on ? stopFollow() : startFollow());
$("findBest").onclick = () => findBestStarts().catch((e) => { console.error(e); progress(null); status(`Search failed: ${e.message}`); });
$("clearRoute").onclick = () => { R().stops = []; R().pinned = []; computePlan(); save(); };
$("deleteRoute").onclick = () => {
  if (S.routes.length < 2) return;
  S.routes.splice(S.active, 1);
  S.active = Math.min(S.active, S.routes.length - 1);
  if (S.active === 0) R().startWhen = "fixed";
  syncRouteInputs(); computePlan(); save();
};
$("cutaway").onchange = () => { S.view.cutaway = $("cutaway").checked; mapUniforms.uCutOn.value = S.view.cutaway ? 1 : 0; save(); };
$("cutRadius").oninput = () => { S.view.cutRadius = Number($("cutRadius").value); mapUniforms.uCut.value = S.view.cutRadius; save(); };
$("xray").onchange = () => { S.view.xray = $("xray").checked; if (boxXray) boxXray.visible = S.view.xray; xrayRoute.visible = S.view.xray; save(); };
$("topView").onclick = topView;
$("resetView").onclick = resetView;
$("slice").oninput = (e) => {
  const v = Number(e.target.value);
  mapUniforms.uSlice.value = v >= 1 ? 1e9 : mapUniforms.uMinY.value + v * (mapUniforms.uMaxY.value - mapUniforms.uMinY.value);
};
const download = (name, data) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = name; a.click();
};
$("exportRoute").onclick = () => download("midtown-plan.json", {
  map: "dl_midtown", hero: S.hero, spawnMode: S.spawnMode, params: S.params, reachOverride: S.reachOverride,
  routes: S.routes.map((r, k) => ({
    ...r, stops: undefined,
    startClock: fmtClock(plan[k]?.startClock ?? r.clock), endClock: fmtClock(plan[k]?.endClock ?? r.clock),
    stops: (plan[k]?.legs ?? []).filter((l) => l.box >= 0 && !l.unreachable).map((l) => ({ id: boxes[l.box].id, type: boxes[l.box].type, pos: boxes[l.box].pos, at: fmtClock(l.done), souls: +l.souls.toFixed(1) })),
  })),
});
$("importRoute").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const d = JSON.parse(await f.text()), byId = new Map(boxes.map((b, i) => [b.id, i]));
  if (Array.isArray(d.routes)) {
    S.routes = d.routes.map((r, k) => ({ ...newRoute(k + 1, k > 0), ...r, clock: parseClock(r.startClock) ?? r.clock ?? 180, stops: (r.stops ?? []).map((s) => byId.get(s.id)).filter((i) => i != null) }));
    Object.assign(S.reachOverride, Array.isArray(d.reachOverride) ? Object.fromEntries(d.reachOverride.map((id) => [id, true])) : d.reachOverride ?? {});
  }
  S.active = 0; syncRouteInputs(); computePlan(); save();
};
$("suggestTests").onclick = () => suggestTests();
$("addSample").onclick = () => {
  const sec = Number($("measured").value), P = plan[S.active];
  if (!P?.legs.length || !(sec > 0)) { status("Load or optimize a route, run it in game, then enter the measured seconds."); return; }
  const { x, waits } = routeFeatures();
  S.samples.push({ label: `${R().name}: ${R().stops.length} box${R().stops.length > 1 ? "es" : ""}`, x: Array.from(x), seconds: sec - waits });
  $("measured").value = "";
  renderSamples(); save();
};
$("fitParams").onclick = () => {
  if (S.samples.length < 2) { $("fitResult").textContent = "Record at least 2 timed runs (6+ varied runs give a solid fit)."; return; }
  const w0 = weightsOf(S.params), r = fit(S.samples.map((s) => ({ x: s.x, seconds: s.seconds })), w0);
  const before = { ...S.params };
  S.params = paramsOf(r.w, S.params);
  syncInputs(); onParamsChanged();
  const changes = PARAM_INPUTS.filter((k) => Math.abs(S.params[k] - before[k]) > 1e-3).map((k) => `${k} ${(+before[k]).toFixed(2)}→${S.params[k].toFixed(2)}`);
  $("fitResult").innerHTML = `Fit error ${r.before.toFixed(2)}s → <b>${r.after.toFixed(2)}s</b> RMS over ${S.samples.length} runs. Adjusted: ${changes.join(", ") || "nothing"}. Your runs tested: ${r.fitted.join(", ") || "nothing yet"}; other settings wait for runs that use them.`;
};
$("exportSamples").onclick = () => download("midtown-calibration.json", { features: FEATURES, params: S.params, samples: S.samples });
$("importSamples").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const d = JSON.parse(await f.text());
  S.samples = [...S.samples, ...(d.samples ?? []).map(upgradeSample)];
  renderSamples(); save();
};
function buildTypeToggles() {
  const wrap = $("typeToggles");
  wrap.innerHTML = "";
  const count = (f) => boxes.filter(f).length;
  const row = (cls, checked, color, text, onChange) => {
    const lab = document.createElement("label");
    lab.className = cls;
    lab.innerHTML = `<input type="checkbox" ${checked ? "checked" : ""}>${color ? `<span class="swatch" style="background:${color}"></span>` : ""}${text}`;
    lab.querySelector("input").onchange = (e) => { onChange(e.target.checked); buildTypeToggles(); computePlan(); save(); };
    wrap.appendChild(lab);
  };
  row("cat", S.categories.box, null, `Boxes <span class="muted">${count(isBox)}</span>`, (v) => (S.categories.box = v));
  if (S.categories.box)
    for (const k of ["crate", "tough", "buff"]) {
      const t = BOX_TYPES[k];
      row("sub", S.types[k], t.color, `${t.label} <span class="muted">${count((b) => b.type === k)} · ${t.souls ? `${t.souls}+${t.perMin}/min${t.chance < 1 ? `, ${t.chance * 100}% drop` : ""}` : "50% buff"}</span>`, (v) => (S.types[k] = v));
    }
  row("cat", S.categories.camp, BOX_TYPES.camp.color, `Jungle camps <span class="muted">${count((b) => b.type === "camp")} · clear time from your DPS</span>`, (v) => (S.categories.camp = v));
  if (S.categories.camp) {
    S.campTiers ??= { small: true, medium: true, large: true };
    for (const [k, label, tier] of [["small", "Small camps", "T1"], ["medium", "Medium camps", "T2"], ["large", "Large camps", "T3"]])
      row("sub", S.campTiers[k] !== false, null, `${label} <span class="muted">${tier} · ${count((b) => b.type === "camp" && campTier(b) === k)}</span>`, (v) => (S.campTiers[k] = v));
  }
  row("cat", S.categories.sinner, BOX_TYPES.sinner.color, `Sinner's Sacrifices <span class="muted">${count((b) => b.type === "sinner")} camps · 310+3.35/min each, from 8:00</span>`, (v) => (S.categories.sinner = v));
  $("campSettings").hidden = !S.categories.camp && !S.categories.sinner;
}
function buildLegend() {
  const seen = new Set();
  $("legend").innerHTML = Object.values(MOVE_STYLE).filter(([, l]) => l && !seen.has(l) && seen.add(l))
    .map(([c, l]) => `<span><span class="swatch" style="background:${c}"></span>${l}</span>`).join("")
    + Object.values(BOX_TYPES).map((t) => `<span><span class="swatch" style="background:${t.color}"></span>${t.label}</span>`).join("")
    + `<span><span class="swatch" style="background:#7a2e2e"></span>Unreachable</span>`;
}

// ---------------------------------------------------------------- saved route presets
// A preset is a named copy of the whole plan (its routes plus the farming settings that shaped
// them), tagged with a team and a lane so the right one can be found mid-game. Stored in this
// browser; Export/Import moves them between browsers or backs them up.
const PRESET_STORE = "midtown-router-presets";
const PRESET_KEYS = ["hero", "spawnMode", "types", "categories", "campTiers", "ignoreIsolated", "statueDetour", "prioritizeTough", "grabNearby", "buffValue", "reachOverride", "excluded"];
const LANES = ["Left lane", "Mid lane", "Right lane", "Jungle"];
const TEAM_NAMES = { amber: "Hidden King", sapphire: "Archmother", any: "Any team" };
let presets = [];
const presetFilter = { team: "any", lane: "" };
function loadPresets() {
  try { presets = JSON.parse(localStorage.getItem(PRESET_STORE) ?? "[]"); } catch { presets = []; }
}
function savePresets() {
  try { localStorage.setItem(PRESET_STORE, JSON.stringify(presets)); } catch {}
}
function snapshotPlan() {
  const out = { routes: S.routes.map((r) => ({ ...r, stopIds: r.stops.map((i) => boxes[i]?.id).filter(Boolean), stops: [] })) };
  for (const k of PRESET_KEYS) out[k] = structuredClone(S[k]);
  return out;
}
function applyPreset(p) {
  const byId = new Map(boxes.map((b, i) => [b.id, i]));
  for (const k of PRESET_KEYS) if (p.plan[k] !== undefined) S[k] = structuredClone(p.plan[k]);
  S.routes = p.plan.routes.map((r, k) => ({ ...newRoute(k + 1, k > 0), ...structuredClone(r), stops: (r.stopIds ?? []).map((id) => byId.get(id)).filter((i) => i != null) }));
  S.active = 0;
  if (p.team !== "any" && p.team !== S.team) { S.team = p.team; applyTeam(); renderMinimapBg(); }
  closeBoxMenu(); stopFollow();
  syncInputs(); buildTypeToggles(); computePlan(); save();
  status(`Loaded "${p.name}".`);
}
function renderPresets() {
  const list = $("presetList");
  const lanes = [...new Set([...LANES, ...presets.map((p) => p.lane).filter(Boolean)])];
  $("presetLane").innerHTML = `<option value="">Any lane</option>` + lanes.map((l) => `<option${l === presetFilter.lane ? " selected" : ""}>${l}</option>`).join("");
  $("presetTeam").value = presetFilter.team;
  $("presetLaneList").innerHTML = lanes.map((l) => `<option value="${l}">`).join("");
  const shown = presets.filter((p) => (presetFilter.team === "any" || p.team === "any" || p.team === presetFilter.team) && (!presetFilter.lane || p.lane === presetFilter.lane));
  list.innerHTML = shown.length ? "" : `<li class="muted">${presets.length ? "No saved routes match." : "No saved routes yet. Build a route, then Save current."}</li>`;
  for (const p of shown) {
    const li = document.createElement("li");
    const stops = p.plan.routes.reduce((a, r) => a + (r.stopIds?.length ?? 0), 0);
    li.innerHTML = `<div class="pinfo"><b>${p.name}</b><span class="muted">${TEAM_NAMES[p.team]}${p.lane ? ` · ${p.lane}` : ""} · ${p.plan.routes.length} route${p.plan.routes.length > 1 ? "s" : ""}, ${stops} stops</span></div>
      <button data-a="play" class="primary" title="Load and play it">▶</button><button data-a="load">Load</button><button data-a="del" class="link" title="Delete">✕</button>`;
    li.querySelector('[data-a="load"]').onclick = () => applyPreset(p);
    li.querySelector('[data-a="play"]').onclick = () => { applyPreset(p); startFollow(true); };
    const del = li.querySelector('[data-a="del"]');
    del.onclick = () => {
      if (del.dataset.armed) { presets = presets.filter((x) => x !== p); savePresets(); renderPresets(); return; }
      del.dataset.armed = "1"; del.textContent = "Delete?";
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = "✕"; } }, 3000);
    };
    list.appendChild(li);
  }
}
$("presetTeam").onchange = () => { presetFilter.team = $("presetTeam").value; renderPresets(); };
$("presetLane").onchange = () => { presetFilter.lane = $("presetLane").value; renderPresets(); };
$("savePreset").onclick = () => {
  const f = $("presetForm");
  f.hidden = !f.hidden;
  if (!f.hidden) {
    $("presetName").value = `${R().name} · ${fmtClock(plan[0]?.startClock ?? R().clock)}`;
    $("presetSaveTeam").value = S.team;
    $("presetSaveLane").value = presetFilter.lane;
    $("presetName").select();
  }
};
$("presetCancel").onclick = () => ($("presetForm").hidden = true);
$("presetForm").onsubmit = (e) => {
  e.preventDefault();
  if (!S.routes.some((r) => r.stops.length)) { status("Build a route first, then save it."); return; }
  const name = $("presetName").value.trim() || "Untitled route";
  const existing = presets.find((p) => p.name === name);
  const p = { id: existing?.id ?? `p${Date.now().toString(36)}`, name, team: $("presetSaveTeam").value, lane: $("presetSaveLane").value.trim(), saved: new Date().toISOString(), plan: snapshotPlan() };
  presets = existing ? presets.map((x) => (x === existing ? p : x)) : [...presets, p];
  savePresets();
  $("presetForm").hidden = true;
  renderPresets();
  status(`${existing ? "Updated" : "Saved"} "${name}".`);
};
$("exportPresets").onclick = () => download("midtown-saved-routes.json", { map: "dl_midtown", presets });
$("importPresets").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const d = JSON.parse(await f.text());
  const incoming = (d.presets ?? []).filter((p) => p?.plan?.routes);
  const names = new Set(presets.map((p) => p.name));
  presets = [...presets.filter((p) => !incoming.some((q) => q.name === p.name)), ...incoming];
  savePresets(); renderPresets();
  status(`Imported ${incoming.length} saved route${incoming.length === 1 ? "" : "s"}${incoming.some((q) => names.has(q.name)) ? " (same names replaced)" : ""}.`);
  e.target.value = "";
};

// ---------------------------------------------------------------- persistence
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...S, paramsVersion: 7, routes: S.routes.map((r) => ({ ...r, stopIds: r.stops.map((i) => boxes[i]?.id), stops: [] })) }));
  } catch {}
}
function restore() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (!d) return;
    for (const k of Object.keys(S)) if (k in d && k !== "routes") S[k] = d[k];
    S.params = { ...DEFAULT_PARAMS, ...d.params };
    // settings saved before these were measured in game: take the new values
    if ((d.paramsVersion ?? 0) < 2) {
      if (S.params.sinnerTime === 4) S.params.sinnerTime = DEFAULT_PARAMS.sinnerTime;
      if (S.params.sinnerBuffs === 1) S.params.sinnerBuffs = DEFAULT_PARAMS.sinnerBuffs;
      if (S.params.ropeSpeed <= 11) S.params.ropeSpeed = DEFAULT_PARAMS.ropeSpeed;
    }
    // values still at an older default move to the newer measured one
    if ((d.paramsVersion ?? 0) < 6) {
      const OLD = { breakTime: 0.6, dashDistance: 9, jumpTime: 0.35, climbCost: 0.2, zipSpeed: 13, runSpeed: 8.4, dropCost: 0.1, downDashCost: 0.065, latchTime: 0.8 };
      for (const [k, v] of Object.entries(OLD)) if (S.params[k] === v) S.params[k] = DEFAULT_PARAMS[k];
    }
    if ((d.paramsVersion ?? 0) < 7) {
      const OLD = { runSpeed: 9, latchTime: 0.3 };
      for (const [k, v] of Object.entries(OLD)) if (S.params[k] === v) S.params[k] = DEFAULT_PARAMS[k];
    }
    if ((d.paramsVersion ?? 0) < 3 && S.params.campDps === 150) {
      S.params.campDps = DEFAULT_PARAMS.campDps; S.params.campDpsPerMin = DEFAULT_PARAMS.campDpsPerMin;
    }
    S.samples = (S.samples ?? []).map(upgradeSample);
    S.view = { cutaway: true, cutRadius: 14, xray: true, ...d.view };
    const byId = new Map(boxes.map((b, i) => [b.id, i]));
    if (Array.isArray(d.routes) && d.routes.length)
      S.routes = d.routes.map((r, k) => ({ ...newRoute(k + 1, k > 0), ...r, stops: (r.stopIds ?? []).map((id) => byId.get(id)).filter((i) => i != null) }));
    S.active = Math.min(S.active, S.routes.length - 1);
  } catch {}
}

// ---------------------------------------------------------------- loop
let last = performance.now();
function tick(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  flyStep(dt);
  if (follow.on) followFrame(dt);
  else if (focusAnim) {
    focusAnim.t = Math.min(focusAnim.t + 0.06, 1);
    const k = 1 - Math.pow(1 - focusAnim.t, 3);
    controls.target.lerpVectors(focusAnim.from, focusAnim.to, k);
    camera.position.lerpVectors(focusAnim.camFrom, focusAnim.camTo, k);
    if (focusAnim.t >= 1) focusAnim = null;
  }
  if (!follow.on) controls.update();
  mapUniforms.uCam.value.copy(camera.position);
  mapUniforms.uFocus.value.copy(controls.target);
  renderer.render(scene, camera);
  drawMinimap(now);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
buildLegend();
// console handle for troubleshooting: __boxRouter.state, .boxes(), .select(i)
window.__boxRouter = { state: S, boxes: () => boxes, select: selectBox, menu: openBoxMenu, pointMenu: openPointMenu, plan: () => plan, follow, followFrame };
loadAll().then(() => {
  restore();
  applyTeam(); renderMinimapBg(); resetView();
  loadPresets(); presetFilter.team = S.team; renderPresets();
  buildTypeToggles();
  syncInputs();
  computePlan();
  renderSamples();
}).catch((e) => { console.error(e); status(`Could not load data: ${e.message}. Run the tools/ build scripts first.`); });
