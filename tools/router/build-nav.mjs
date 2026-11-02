// Builds the routing graph from Valve's navmesh (Source 2 Viewer export of dl_midtown.nav)
// plus movement links the navmesh lacks: ledge drops, jump-ups, gap jumps, ropes, jump pads,
// teleporters and ziplines. Link clearance is checked against the simplified world mesh.
//
// Usage: node tools/build-nav.mjs <export dir> <data dir> [hull]
//   needs <data dir>/map.bin + map.json (from build-map.mjs) and <export dir>/dl_midtown.glb,
//   default_ents.vents. Writes <data dir>/nav.bin and nav.json.
import fs from "node:fs";
import path from "node:path";
import { toGL, S2M, worldMatrices, openBuffers, readAccessor } from "./gltf.mjs";
import { C, EC, EDGE, DEFAULT_PARAMS, moveAllowed } from "../../site/router/nav-core.js";

const [srcDir, dataDir, hullArg] = process.argv.slice(2);
if (!srcDir || !dataDir) { console.error("usage: node build-nav.mjs <export dir> <data dir> [hull]"); process.exit(1); }
const HULL = Number(hullArg ?? 1);

// Link generation limits (meters).
const PROBE = [0.9, 1.5, 2.3, 3.2]; // outward distances tested from each navmesh border
const SAMPLE = 1.5;                  // spacing of probes along a border edge
const MAX_UP = 12;                   // tallest jump-up link generated; the app caps it with its wall-climb setting
const JUMP_STEPS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // wall-climb heights tested for each box's minimum
const MAX_DROP = 60;
const LEVEL = 0.6;                   // height difference still treated as "same level"
const LONG_GAP = 28;                 // longest rooftop jump generated; the app caps it with its max-gap setting
const ROOF_DROP = 30;                // a long jump may land up to this far below the takeoff
const ZIP_STEP = 3;                  // zipline sample spacing
const LATCH_RANGE = 22;              // max height of a cable above the floor you latch from (the latch pulls you up)
const LATCH_OFFSETS = [[0, 0], ...[2.5, 5].flatMap((r) => Array.from({ length: 8 }, (_, k) => [r * Math.cos((k * Math.PI) / 4), r * Math.sin((k * Math.PI) / 4)]))]; // latch from up to 5 m off the cable line

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------------------------------------------------------------- navmesh
const glb = fs.readFileSync(path.join(srcDir, "dl_midtown.glb"));
const jsonLen = glb.readUInt32LE(12);
const gj = JSON.parse(glb.toString("utf8", 20, 20 + jsonLen));
const binOff = 20 + jsonLen + 8;
const view = (acc, T) => {
  const a = gj.accessors[acc], bv = gj.bufferViews[a.bufferView];
  const start = binOff + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const n = a.count * ({ VEC3: 3, SCALAR: 1 }[a.type]);
  return new T(glb.buffer.slice(glb.byteOffset + start, glb.byteOffset + start + n * T.BYTES_PER_ELEMENT));
};
const prim = gj.meshes[HULL].primitives[0];
const RP = view(prim.attributes.POSITION, Float32Array), RI = view(prim.indices, Uint32Array);

// weld vertices (navmesh export is a triangle soup) and convert to the export frame
const vIndex = new Map(), V = [];
const weld = (i) => {
  const x = RP[i * 3], y = RP[i * 3 + 1], z = RP[i * 3 + 2];
  const k = `${Math.round(x * 4)},${Math.round(y * 4)},${Math.round(z * 4)}`; // 1/4 inch
  let v = vIndex.get(k);
  if (v === undefined) { v = V.length; vIndex.set(k, v); V.push([y * S2M, z * S2M, x * S2M]); }
  return v;
};
const tris = [];
for (let t = 0; t < RI.length; t += 3) {
  const a = weld(RI[t]), b = weld(RI[t + 1]), c = weld(RI[t + 2]);
  if (a === b || b === c || a === c) continue;
  const A = V[a], B = V[b], Cc = V[c];
  if (Math.abs((B[0] - A[0]) * (Cc[2] - A[2]) - (B[2] - A[2]) * (Cc[0] - A[0])) < 1e-6) continue;
  tris.push([a, b, c]);
}
const nTri = tris.length;
const cent = tris.map(([a, b, c]) => [0, 1, 2].map((k) => (V[a][k] + V[b][k] + V[c][k]) / 3));
log(`navmesh hull ${HULL}: ${nTri} triangles, ${V.length} welded vertices`);

// ---------------------------------------------------------------- graph edges
const edges = []; // {from,to,type,a,b,comps}
const comps0 = () => new Float64Array(EC);
const xzDist = (p, q) => Math.hypot(q[0] - p[0], q[2] - p[2]);
function meshEdge(t1, t2, a, b) {
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const c = comps0();
  c[C.walk] = xzDist(cent[t1], mid) + xzDist(mid, cent[t2]);
  c[C.rampUp] = Math.max(0, cent[t2][1] - cent[t1][1]);
  edges.push({ from: t1, to: t2, type: EDGE.mesh, a, b, comps: c });
}

// shared edges
const edgeOwners = new Map();
tris.forEach((tr, t) => {
  for (let k = 0; k < 3; k++) {
    const u = tr[k], v = tr[(k + 1) % 3], key = u < v ? `${u},${v}` : `${v},${u}`;
    let o = edgeOwners.get(key); if (!o) edgeOwners.set(key, (o = [])); o.push(t);
  }
});
const boundary = []; // {t, a, b}
for (const [key, owners] of edgeOwners) {
  const [u, v] = key.split(",").map(Number);
  if (owners.length === 1) { boundary.push({ t: owners[0], a: V[u], b: V[v] }); continue; }
  for (let i = 0; i < owners.length; i++) for (let j = 0; j < owners.length; j++) if (i !== j) meshEdge(owners[i], owners[j], V[u], V[v]);
}
log(`${edges.length} shared-edge links, ${boundary.length} border edges`);

// stitch T-junctions: border edges that lie on top of each other (navmesh tile seams)
{
  const G = 2, grid = new Map();
  boundary.forEach((e, i) => {
    const x0 = Math.floor(Math.min(e.a[0], e.b[0]) / G), x1 = Math.floor(Math.max(e.a[0], e.b[0]) / G);
    const z0 = Math.floor(Math.min(e.a[2], e.b[2]) / G), z1 = Math.floor(Math.max(e.a[2], e.b[2]) / G);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x * 65536 + z; let a = grid.get(k); if (!a) grid.set(k, (a = [])); a.push(i); }
  });
  let stitched = 0;
  const seen = new Set();
  for (let i = 0; i < boundary.length; i++) {
    const e1 = boundary[i];
    const d = [e1.b[0] - e1.a[0], e1.b[1] - e1.a[1], e1.b[2] - e1.a[2]], L = Math.hypot(...d);
    if (L < 0.05) continue;
    const u = d.map((x) => x / L);
    const cand = new Set();
    for (const p of [e1.a, e1.b]) for (const j of grid.get(Math.floor(p[0] / G) * 65536 + Math.floor(p[2] / G)) ?? []) cand.add(j);
    for (const j of cand) {
      if (j === i || boundary[j].t === e1.t) continue;
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      if (seen.has(key)) continue;
      const e2 = boundary[j];
      // both endpoints of e2 close to e1's line
      const off = (p) => { const w = [p[0] - e1.a[0], p[1] - e1.a[1], p[2] - e1.a[2]]; const s = w[0] * u[0] + w[1] * u[1] + w[2] * u[2]; return { s, d: Math.hypot(w[0] - s * u[0], (w[1] - s * u[1]) * 0.5, w[2] - s * u[2]) }; };
      const p = off(e2.a), q = off(e2.b);
      if (p.d > 0.06 || q.d > 0.06) continue;
      const lo = Math.max(0, Math.min(p.s, q.s)), hi = Math.min(L, Math.max(p.s, q.s));
      if (hi - lo < 0.15) continue;
      seen.add(key);
      const A = e1.a.map((x, k) => x + u[k] * lo), B = e1.a.map((x, k) => x + u[k] * hi);
      meshEdge(e1.t, e2.t, A, B); meshEdge(e2.t, e1.t, A, B);
      e1.stitched = e2.stitched = true;
      stitched++;
    }
  }
  log(`stitched ${stitched} tile seams`);
}

// ---------------------------------------------------------------- triangle point queries
const TG = 4, triGrid = new Map();
tris.forEach(([a, b, c], t) => {
  const P = [V[a], V[b], V[c]];
  const x0 = Math.floor(Math.min(...P.map((p) => p[0])) / TG), x1 = Math.floor(Math.max(...P.map((p) => p[0])) / TG);
  const z0 = Math.floor(Math.min(...P.map((p) => p[2])) / TG), z1 = Math.floor(Math.max(...P.map((p) => p[2])) / TG);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x * 65536 + z; let l = triGrid.get(k); if (!l) triGrid.set(k, (l = [])); l.push(t); }
});
function heightOn(t, x, z) {
  const [A, B, Cc] = tris[t].map((i) => V[i]);
  const d = (B[2] - Cc[2]) * (A[0] - Cc[0]) + (Cc[0] - B[0]) * (A[2] - Cc[2]);
  if (Math.abs(d) < 1e-12) return NaN;
  const l1 = ((B[2] - Cc[2]) * (x - Cc[0]) + (Cc[0] - B[0]) * (z - Cc[2])) / d;
  const l2 = ((Cc[2] - A[2]) * (x - Cc[0]) + (A[0] - Cc[0]) * (z - Cc[2])) / d, l3 = 1 - l1 - l2;
  if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) return NaN;
  return l1 * A[1] + l2 * B[1] + l3 * Cc[1];
}
function trisAt(x, z) {
  const out = [];
  for (const t of triGrid.get(Math.floor(x / TG) * 65536 + Math.floor(z / TG)) ?? []) {
    const y = heightOn(t, x, z);
    if (!Number.isNaN(y)) out.push({ t, y });
  }
  return out;
}
// nearest triangle to a world point (for entities): searches the column, then a small ring
function snapPoint(p, maxDist = 6) {
  let best = null;
  const consider = (x, z) => {
    for (const { t, y } of trisAt(x, z)) {
      const dy = p[1] - y, d = Math.hypot(x - p[0], z - p[2]) + (dy >= -0.5 ? dy : -dy * 3);
      if (d < maxDist && (!best || d < best.dist)) best = { tri: t, point: [x, y, z], dist: d };
    }
  };
  consider(p[0], p[2]);
  if (best && best.dist < 1.5) return best;
  for (let r = 0.5; r <= maxDist; r += 0.5)
    for (let a = 0; a < 16; a++) consider(p[0] + Math.cos((a / 16) * Math.PI * 2) * r, p[2] + Math.sin((a / 16) * Math.PI * 2) * r);
  return best;
}

// ---------------------------------------------------------------- world-mesh clearance tests
const mb = fs.readFileSync(path.join(dataDir, "map.bin"));
const mvc = mb.readUInt32LE(4), mtc = mb.readUInt32LE(8);
const mab = mb.buffer.slice(mb.byteOffset + 12, mb.byteOffset + 12 + mvc * 12 + mtc * 12);
const MP = new Float32Array(mab, 0, mvc * 3), MI = new Uint32Array(mab, mvc * 12, mtc * 3);
const MG = 2, mgrid = new Map();
for (let t = 0; t < mtc; t++) {
  const a = MI[t * 3] * 3, b = MI[t * 3 + 1] * 3, c = MI[t * 3 + 2] * 3;
  const x0 = Math.floor(Math.min(MP[a], MP[b], MP[c]) / MG), x1 = Math.floor(Math.max(MP[a], MP[b], MP[c]) / MG);
  const z0 = Math.floor(Math.min(MP[a + 2], MP[b + 2], MP[c + 2]) / MG), z1 = Math.floor(Math.max(MP[a + 2], MP[b + 2], MP[c + 2]) / MG);
  if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue; // giant backdrop planes
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = x * 65536 + z; let l = mgrid.get(k); if (!l) mgrid.set(k, (l = [])); l.push(t); }
}
log(`world mesh: ${mtc} triangles indexed for clearance tests`);
const stamp = new Uint32Array(mtc);
let stampId = 0;
let blockedCalls = 0, blockedHits = 0;
function blocked(p, q) { blockedCalls++; const r = blocked_(p, q); if (r) blockedHits++; return r; }
function blocked_(p, q) {
  stampId++;
  const dir = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const x0 = Math.floor(Math.min(p[0], q[0]) / MG), x1 = Math.floor(Math.max(p[0], q[0]) / MG);
  const z0 = Math.floor(Math.min(p[2], q[2]) / MG), z1 = Math.floor(Math.max(p[2], q[2]) / MG);
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
    for (const t of mgrid.get(x * 65536 + z) ?? []) {
      if (stamp[t] === stampId) continue;
      stamp[t] = stampId;
      // Möller–Trumbore, segment parameter in (0,1)
      const a = MI[t * 3] * 3, b = MI[t * 3 + 1] * 3, c = MI[t * 3 + 2] * 3;
      const e1 = [MP[b] - MP[a], MP[b + 1] - MP[a + 1], MP[b + 2] - MP[a + 2]], e2 = [MP[c] - MP[a], MP[c + 1] - MP[a + 1], MP[c + 2] - MP[a + 2]];
      const h = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-9) continue;
      const f = 1 / det, s = [p[0] - MP[a], p[1] - MP[a + 1], p[2] - MP[a + 2]];
      const u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
      if (u < 0 || u > 1) continue;
      const qq = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = f * (dir[0] * qq[0] + dir[1] * qq[1] + dir[2] * qq[2]);
      if (v < 0 || u + v > 1) continue;
      const tt = f * (e2[0] * qq[0] + e2[1] * qq[1] + e2[2] * qq[2]);
      if (tt > 1e-4 && tt < 1 - 1e-4) return true;
    }
  }
  return false;
}
const up = (p, h) => [p[0], h, p[2]];

// ---------------------------------------------------------------- ledge / jump / gap links
const linkBest = new Map(); // "from,to" -> edge
function addLink(from, to, type, a, b, c) {
  const key = `${from},${to}`, prev = linkBest.get(key);
  const cost = c[C.walk] / 8 + c[C.jumps] * 0.4 + c[C.jumpUp] * 0.2 + c[C.drop] * 0.1;
  if (prev && prev.cost <= cost) return;
  linkBest.set(key, { from, to, type, a, b, comps: c, cost });
}
let probes = 0, longJumps = 0;
for (const e of boundary) {
  if (e.stitched) continue;
  const d = [e.b[0] - e.a[0], e.b[2] - e.a[2]], L = Math.hypot(d[0], d[1]);
  if (L < 0.3) continue;
  let n = [d[1] / L, -d[0] / L];
  const mid = [(e.a[0] + e.b[0]) / 2, (e.a[2] + e.b[2]) / 2];
  if ((cent[e.t][0] - mid[0]) * n[0] + (cent[e.t][2] - mid[1]) * n[1] > 0) n = [-n[0], -n[1]]; // point outward
  const steps = Math.max(1, Math.round(L / SAMPLE));
  for (let s = 0; s < steps; s++) {
    const f = (s + 0.5) / steps;
    const p = [e.a[0] + (e.b[0] - e.a[0]) * f, e.a[1] + (e.b[1] - e.a[1]) * f, e.a[2] + (e.b[2] - e.a[2]) * f];
    for (const dist of PROBE) {
      probes++;
      const q = [p[0] + n[0] * dist, p[1], p[2] + n[1] * dist];
      const hits = trisAt(q[0], q[2]).filter((h) => h.t !== e.t);
      if (!hits.length) continue;
      let made = false;
      // drop: highest floor below
      const below = hits.filter((h) => h.y < p[1] - LEVEL && h.y > p[1] - MAX_DROP).sort((a, b) => b.y - a.y)[0];
      if (below && !blocked(up(p, p[1] + 1.4), up(q, p[1] + 1.4)) && !blocked(up(q, p[1] + 1.4), up(q, below.y + 0.3))) {
        const c = comps0(); c[C.walk] = dist; c[C.drop] = p[1] - below.y;
        addLink(e.t, below.t, EDGE.drop, p, [q[0], below.y, q[2]], c);
        made = true;
      }
      // jump up: lowest floor above, within reach
      const above = hits.filter((h) => h.y > p[1] + LEVEL && h.y <= p[1] + MAX_UP).sort((a, b) => a.y - b.y)[0];
      if (above && !blocked(up(p, p[1] + 0.3), up(p, above.y + 1.8)) && !blocked(up(p, above.y + 0.7), up(q, above.y + 0.7))) {
        const c = comps0(); c[C.walk] = dist; c[C.jumps] = 1; c[C.jumpUp] = above.y - p[1];
        addLink(e.t, above.t, EDGE.jump, p, [q[0], above.y, q[2]], c);
        made = true;
      }
      // gap jump across to the same level
      const level = dist >= 1.5 && hits.find((h) => Math.abs(h.y - p[1]) <= LEVEL);
      if (level) {
        const top = Math.max(p[1], level.y);
        if (!blocked(up(p, top + 0.8), up(q, top + 0.8)) && !blocked(up(p, top + 1.6), up(q, top + 1.6))) {
          const c = comps0(); c[C.walk] = dist; c[C.jumps] = 1; c[C.jumpUp] = Math.max(0, level.y - p[1]);
          addLink(e.t, level.t, EDGE.gap, p, [q[0], level.y, q[2]], c);
          made = true;
        }
      }
      if (made || hits.some((h) => Math.abs(h.y - p[1]) <= LEVEL)) break;
    }
    // long jumps between rooftops: march out across the gap (straight out and ±25°). The street
    // below is flown over; a lower roof is linked where the ground under the arc rises out of
    // it; the march ends at the first floor level with or above the takeoff. The app decides at
    // runtime which of these jumps a hero can actually make.
    const tryJump = (q, land, dist) => {
      // start and end high enough to clear rooftop parapets; the jump itself clears them in game
      const top = Math.max(p[1], land.y) + 1.8 + Math.min(dist * 0.1, 1.5);
      const apex = [(p[0] + q[0]) / 2, top, (p[2] + q[2]) / 2];
      if (blocked(up(p, p[1] + 0.3), up(p, p[1] + 1.6)) || blocked(up(p, p[1] + 1.6), apex) || blocked(apex, up(q, land.y + 1.6)) || blocked(up(q, land.y + 1.6), up(q, land.y + 0.3))) return;
      const c = comps0(); c[C.walk] = dist; c[C.jumps] = 1;
      c[C.jumpUp] = Math.max(0, land.y - p[1]); c[C.drop] = Math.max(0, p[1] - land.y);
      addLink(e.t, land.t, EDGE.gap, p, [q[0], land.y, q[2]], c);
      longJumps++;
    };
    for (const ang of [0, 0.44, -0.44]) {
      const dir = [n[0] * Math.cos(ang) - n[1] * Math.sin(ang), n[0] * Math.sin(ang) + n[1] * Math.cos(ang)];
      let lowest = -Infinity; // highest lower floor seen so far under the arc
      for (let dist = 2; dist <= LONG_GAP; dist += 0.75) {
        probes++;
        const q = [p[0] + dir[0] * dist, p[1], p[2] + dir[1] * dist];
        const hits = trisAt(q[0], q[2]).filter((h) => h.t !== e.t && h.y > p[1] - ROOF_DROP && h.y <= p[1] + MAX_UP);
        if (!hits.length) continue;
        const level = hits.filter((h) => h.y >= p[1] - LEVEL).sort((a, b) => a.y - b.y)[0];
        if (level) {
          if (!(dist < 3.3 && level.y - p[1] <= LEVEL)) tryJump(q, level, dist); // short ones are covered above
          break;
        }
        const lower = hits.sort((a, b) => b.y - a.y)[0];
        if (lower.y > lowest + 2) { if (lowest > -Infinity) tryJump(q, lower, dist); lowest = lower.y; }
        else lowest = Math.max(lowest, lower.y);
      }
    }
  }
}
const ledgeLinks = linkBest.size;
log(`long rooftop jumps found: ${longJumps}`);
log(`clearance tests: ${blockedHits} of ${blockedCalls} blocked`);
log(`${probes} border probes -> ${ledgeLinks} drop/jump/gap links`);

// ---------------------------------------------------------------- entities
const vents = fs.readFileSync(path.join(srcDir, "default_ents.vents"), "utf8").split(/====\d+====\r?\n/);
const ents = vents.map((b) => {
  const o = {};
  for (const l of b.split(/\r?\n/)) { const m = l.match(/^([\w.]+)\s+(.*)$/); if (m && !(m[1] in o)) o[m[1]] = m[2].replace(/^"|"$/g, ""); }
  if (o.origin) o.gl = toGL(o.origin.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number));
  return o;
}).filter((o) => o.classname);
const byTarget = (name) => {
  const k = (name ?? "").replace(/^\[PR#\]/, "");
  return k ? ents.find((o) => o.targetname && (o.targetname === name || o.targetname.endsWith(k))) : null;
};
const mapMeta = JSON.parse(fs.readFileSync(path.join(dataDir, "map.json"), "utf8"));
const volumes = (kind) => mapMeta.landmarks.filter((l) => l.kind === kind).map((l) => ({ ...l, c: l.min.map((v, i) => (v + l.max[i]) / 2) }));
const nearestVol = (vols, p) => vols.reduce((b, v) => (!b || Math.hypot(v.c[0] - p[0], v.c[2] - p[2]) < Math.hypot(b.c[0] - p[0], b.c[2] - p[2]) ? v : b), null);
let special = { rope: 0, pad: 0, teleport: 0 };

// ropes: climb between the floor at the bottom and the floor at the top
for (const r of volumes("rope")) {
  const bot = snapPoint([r.c[0], r.min[1] + 0.5, r.c[2]], 4);
  let top = null;
  // the landing at the top sits a few meters below the trigger's top and slightly off to the side
  for (let rad = 0.5; rad <= 7 && !top; rad += 0.5)
    for (let a = 0; a < 16 && !top; a++) {
      const x = r.c[0] + Math.cos(a * Math.PI / 8) * rad, z = r.c[2] + Math.sin(a * Math.PI / 8) * rad;
      const h = trisAt(x, z).filter((h) => h.y < r.max[1] + 4 && h.y > r.max[1] - 8).sort((a, b) => b.y - a.y)[0];
      if (h && h.y > r.min[1] + 4) top = { tri: h.t, point: [x, h.y, z] };
    }
  if (process.env.DEBUG_ROPES) console.log("rope", r.min.map((v) => v.toFixed(1)).join(","), "->", r.max.map((v) => v.toFixed(1)).join(","), "bot", bot && bot.point.map((v) => v.toFixed(1)).join(","), "top", top && top.point.map((v) => v.toFixed(1)).join(","));
  if (!bot || !top || bot.tri === top.tri) continue;
  const len = top.point[1] - bot.point[1];
  const c1 = comps0(); c1[C.rope] = len; c1[C.walk] = xzDist(bot.point, top.point);
  const c2 = comps0(); c2[C.drop] = len; c2[C.walk] = xzDist(bot.point, top.point);
  addLink(bot.tri, top.tri, EDGE.rope, bot.point, top.point, c1);
  addLink(top.tri, bot.tri, EDGE.rope, top.point, bot.point, c2);
  special.rope++;
}

// jump pads: launch from the pad to its info_target, flight time from launch speed
const padVols = volumes("jumppad");
for (const o of ents.filter((o) => o.classname === "trigger_catapult")) {
  const tgt = byTarget(o.target);
  const vol = nearestVol(padVols, o.gl);
  if (!tgt?.gl || !vol) continue;
  const from = snapPoint([vol.c[0], vol.min[1] + 0.5, vol.c[2]], 5), to = snapPoint(tgt.gl, 8);
  if (!from || !to) continue;
  const speed = Number(o.launch_speed) * S2M, d = Math.hypot(to.point[0] - from.point[0], to.point[2] - from.point[2]);
  // flight time from launch speed, scaled to an in-game timing (2026-10-29): a pad 33 m out at
  // 1000 u/s lands in about 0.4 s of extra time over the run there
  const c = comps0(); c[C.fixed] = (d / speed) * 0.24 + 0.1;
  addLink(from.tri, to.tri, EDGE.pad, from.point, to.point, c);
  special.pad++;
}

// teleporters: walk in, wait `delay`, appear at the exit
const telVols = volumes("teleport");
for (const o of ents.filter((o) => o.classname === "citadel_trigger_teleport")) {
  const exit = byTarget(o.exitpoint), vol = nearestVol(telVols, o.gl);
  if (!exit?.gl || !vol) continue;
  const from = snapPoint([vol.c[0], vol.min[1] + 0.5, vol.c[2]], 5), to = snapPoint(exit.gl, 6);
  if (!from || !to) continue;
  const c = comps0(); c[C.fixed] = Number(o.delay) || 4;
  addLink(from.tri, to.tri, EDGE.teleport, from.point, to.point, c);
  special.teleport++;
}

// ziplines: sample each cable into nodes, link floors below for latching and dismounting
const zipPaths = new Map();
for (const o of ents.filter((o) => o.classname === "citadel_zipline_path_node" && o.gl && o.path_uniqueid)) {
  if (!zipPaths.has(o.path_uniqueid)) zipPaths.set(o.path_uniqueid, []);
  zipPaths.get(o.path_uniqueid).push(o);
}
const zipNodes = []; // positions
const ziplines = [];
const catmull = (p0, p1, p2, p3, t) => p1.map((_, k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t * t * t));
for (const nodes of zipPaths.values()) {
  const P = nodes.sort((a, b) => Number(a.path_index) - Number(b.path_index)).map((o) => o.gl);
  if (P.length < 2) continue;
  const pts = [];
  for (let i = 0; i < P.length - 1; i++) {
    const seg = Math.max(1, Math.ceil(Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1], P[i + 1][2] - P[i][2]) / ZIP_STEP));
    for (let s = 0; s < seg; s++) pts.push(catmull(P[Math.max(0, i - 1)], P[i], P[i + 1], P[Math.min(P.length - 1, i + 2)], s / seg));
  }
  pts.push(P[P.length - 1]);
  ziplines.push(pts.map((p) => p.map((v) => +v.toFixed(2))));
  const base = nTri + zipNodes.length;
  pts.forEach((p) => zipNodes.push(p));
  for (let i = 0; i < pts.length; i++) {
    const node = base + i;
    if (i > 0) {
      const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
      for (const [a, b] of [[i - 1, i], [i, i - 1]]) {
        const c = comps0(); c[C.zip] = len;
        edges.push({ from: base + a, to: base + b, type: EDGE.zip, a: pts[a], b: pts[b], comps: c });
      }
    }
    // floors under the cable: latch up from them, drop down onto them
    const seenTri = new Set();
    for (const [ox, oz] of LATCH_OFFSETS) {
      const x = pts[i][0] + ox, z = pts[i][2] + oz;
      for (const h of trisAt(x, z)) {
        if (seenTri.has(h.t) || h.y > pts[i][1] - 1) continue;
        seenTri.add(h.t);
        const dy = pts[i][1] - h.y, floorPt = [x, h.y, z];
        if (dy <= LATCH_RANGE && !blocked(up(floorPt, h.y + 0.5), [pts[i][0], pts[i][1] - 0.5, pts[i][2]])) {
          const c = comps0(); c[C.latch] = 1; c[C.zip] = dy;
          edges.push({ from: h.t, to: node, type: EDGE.latch, a: floorPt, b: pts[i], comps: c });
        }
        if (dy <= MAX_DROP && !blocked([pts[i][0], pts[i][1] - 0.5, pts[i][2]], up(floorPt, h.y + 0.5))) {
          const c = comps0(); c[C.drop] = dy; c[C.walk] = Math.hypot(ox, oz);
          edges.push({ from: node, to: h.t, type: EDGE.dismount, a: pts[i], b: floorPt, comps: c });
        }
      }
    }
  }
}
log(`ropes ${special.rope}, pads ${special.pad}, teleporters ${special.teleport}, ziplines ${ziplines.length} (${zipNodes.length} cable nodes)`);

// tunnels: only small heroes (Rem, Rat King, Mo & Krill, Calico) fit, so these links form their own
// edge type the app can switch on. citadel_tunnel_node gives the network; is_exit nodes open to the street.
{
  const tnodes = ents.filter((o) => o.classname === "citadel_tunnel_node" && o.gl);
  const at = new Map();
  for (const o of tnodes) {
    const inside = snapPoint(o.gl, 5);
    let street = null;
    if (o.is_exit === "true") {
      for (let rad = 0; rad <= 5 && !street; rad += 0.5)
        for (let a = 0; a < (rad ? 16 : 1) && !street; a++) {
          const x = o.gl[0] + Math.cos(a * Math.PI / 8) * rad, z = o.gl[2] + Math.sin(a * Math.PI / 8) * rad;
          const h = trisAt(x, z).filter((h) => h.y > o.gl[1] + 1 && h.y < o.gl[1] + 10).sort((a, b) => a.y - b.y)[0];
          if (h) street = { tri: h.t, point: [x, h.y, z] };
        }
    }
    at.set(o.targetname, { o, inside, street });
  }
  let n = 0;
  const link = (a, b) => {
    const c = comps0(); c[C.walk] = Math.hypot(b.point[0] - a.point[0], b.point[2] - a.point[2]); c[C.rampUp] = Math.max(0, b.point[1] - a.point[1]);
    edges.push({ from: a.tri, to: b.tri, type: EDGE.tunnel, a: a.point, b: b.point, comps: c });
    n++;
  };
  for (const { o, inside, street } of at.values()) {
    if (inside && street && inside.tri !== street.tri) { link(street, inside); link(inside, street); }
    for (const k of ["connecting_node_01", "connecting_node_02", "connecting_node_03"]) {
      const other = o[k] && at.get(o[k]);
      if (!other?.inside || !inside || other.inside.tri === inside.tri) continue;
      link(inside, other.inside); link(other.inside, inside);
    }
  }
  log(`tunnels: ${tnodes.length} nodes, ${[...at.values()].filter((x) => x.street).length} street exits, ${n} links`);
}
for (const l of linkBest.values()) edges.push(l);

// ---------------------------------------------------------------- reachability
const nNodes = nTri + zipNodes.length;
let off;
function buildCSR() {
  edges.sort((a, b) => a.from - b.from);
  off = new Uint32Array(nNodes + 1);
  for (const e of edges) off[e.from + 1]++;
  for (let i = 0; i < nNodes; i++) off[i + 1] += off[i];
}
buildCSR();

// largest strongly connected region around the team spawns: reachable from them and back to them
const spawns = ents.filter((o) => o.classname === "info_team_spawn" && o.gl).map((o) => ({ o, s: snapPoint(o.gl, 6) })).filter((x) => x.s);
// Tunnel areas: navmesh triangles inside citadel_tunnel_trigger volumes. Only small heroes fit, so
// normal heroes may never path through them (the app reads this as tunnelTri).
const tunnelTri = new Uint8Array(nNodes);
{
  const phys = JSON.parse(fs.readFileSync(path.join(srcDir, "dl_midtown_d_physics.gltf"), "utf8"));
  const fds = openBuffers(phys, srcDir), vols = [];
  for (const [ni, M] of worldMatrices(phys)) {
    const n = phys.nodes[ni];
    if (n.name !== "citadel_tunnel_trigger" || n.mesh === undefined) continue;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const pr of phys.meshes[n.mesh].primitives) {
      const P = readAccessor(phys, fds, pr.attributes.POSITION);
      for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) {
        const v = M[k] * P[i] + M[4 + k] * P[i + 1] + M[8 + k] * P[i + 2] + M[12 + k];
        lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v);
      }
    }
    vols.push({ lo, hi });
  }
  for (let t = 0; t < nTri; t++) {
    const c = cent[t];
    if (vols.some(({ lo, hi }) => c[0] >= lo[0] && c[0] <= hi[0] && c[1] >= lo[1] - 0.5 && c[1] <= hi[1] && c[2] >= lo[2] && c[2] <= hi[2])) tunnelTri[t] = 1;
  }
  log(`tunnel volumes: ${vols.length}, ${tunnelTri.reduce((a, v) => a + v, 0)} navmesh triangles inside them`);
}
function reach(reverse, tunnels, climb = DEFAULT_PARAMS.wallClimb) {
  const params = { ...DEFAULT_PARAMS, wallClimb: climb, useTunnels: tunnels };
  const ok = (e) => moveAllowed(e.type, e.comps, 0, params) && (tunnels || !tunnelTri[e.to]);
  const seen = new Uint8Array(nNodes), stack = spawns.map((x) => x.s.tri);
  const radj = reverse ? (() => { const r = Array.from({ length: nNodes }, () => []); for (const e of edges) if (ok(e)) r[e.to].push(e.from); return r; })() : null;
  for (const s of stack) seen[s] = 1;
  while (stack.length) {
    const u = stack.pop();
    const next = reverse ? radj[u] : edges.slice(off[u], off[u + 1]).filter(ok).map((e) => e.to);
    for (const v of next) if (!seen[v]) { seen[v] = 1; stack.push(v); }
  }
  return seen;
}
const fwd = reach(false, false), bwd = reach(true, false);

// Tunnel pockets: the navmesh patch around each tunnel box that normal heroes can't round-trip.
// Small heroes enter through holes right above them, so link each pocket to the closest
// reachable floor (tunnel edges, both ways).
{
  const rt = (t) => fwd[t] && bwd[t];
  const und = Array.from({ length: nNodes }, () => []);
  for (const e of edges) if (e.type !== EDGE.tunnel) { und[e.from].push(e.to); und[e.to].push(e.from); }
  const pocketOf = new Int32Array(nNodes).fill(-1);
  let pockets = 0, links = 0;
  for (const o of ents.filter((o) => o.classname === "citadel_breakable_prop" && o.gl && o.breakable_spawn_group === "1")) {
    const s = snapPoint(o.gl, 6);
    if (!s || rt(s.tri) || pocketOf[s.tri] >= 0) continue;
    const id = pockets++, members = [s.tri], stack = [s.tri];
    pocketOf[s.tri] = id;
    while (stack.length) for (const v of und[stack.pop()]) if (v < nTri && !rt(v) && pocketOf[v] < 0) { pocketOf[v] = id; members.push(v); stack.push(v); }
    // closest reachable triangles (centroid distance, height weighted lightly), up to 3 entrances
    const near = [];
    for (const t of members) for (let u = 0; u < nTri; u++) {
      if (!rt(u)) continue;
      const dx = cent[u][0] - cent[t][0], dz = cent[u][2] - cent[t][2];
      if (Math.abs(dx) > 15 || Math.abs(dz) > 15) continue;
      const d = Math.hypot(dx, dz) + Math.abs(cent[u][1] - cent[t][1]) * 0.3;
      if (d < 15) near.push({ t, u, d });
    }
    near.sort((a, b) => a.d - b.d);
    const used = [];
    for (const n of near) {
      if (used.length >= 3) break;
      if (used.some((m) => Math.hypot(cent[m.u][0] - cent[n.u][0], cent[m.u][2] - cent[n.u][2]) < 12)) continue;
      used.push(n);
      for (const [a, b] of [[n.u, n.t], [n.t, n.u]]) {
        const c = comps0(); c[C.walk] = Math.hypot(cent[b][0] - cent[a][0], cent[b][2] - cent[a][2]) + Math.abs(cent[b][1] - cent[a][1]);
        edges.push({ from: a, to: b, type: EDGE.tunnel, a: cent[a], b: cent[b], comps: c });
        links++;
      }
    }
  }
  log(`tunnel pockets: ${pockets}, ${links} entrance links`);
  buildCSR();
}
const fwdT = reach(false, true), bwdT = reach(true, true);
// smallest wall-climb height that makes each node a round trip (normal heroes)
const minJump = new Float32Array(nNodes).fill(Infinity);
for (const h of [...JUMP_STEPS].reverse()) { const f = reach(false, false, h), b = reach(true, false, h); for (let t = 0; t < nNodes; t++) if (f[t] && b[t]) minJump[t] = h; }
const mainland = new Uint8Array(nNodes);
let mainCount = 0, mainArea = 0, totalArea = 0;
for (let t = 0; t < nNodes; t++) {
  mainland[t] = fwd[t] && bwd[t];
  if (t < nTri) {
    const [A, B, Cc] = tris[t].map((i) => V[i]);
    const ar = Math.abs((B[0] - A[0]) * (Cc[2] - A[2]) - (B[2] - A[2]) * (Cc[0] - A[0])) / 2;
    totalArea += ar; if (mainland[t]) { mainArea += ar; mainCount++; }
  }
}
log(`round-trip reachable from spawns: ${mainCount}/${nTri} triangles, ${(mainArea / 1000).toFixed(1)}k of ${(totalArea / 1000).toFixed(1)}k m²`);

// ---------------------------------------------------------------- entities to route between
const SPAWN = { 0: [180, 180], 1: [300, 300], 2: [600, 180], 3: [300, 180] }; // deadlock.wiki/Crate, /Buff_Container
const GROUP_NAME = { 0: "Standard", 1: "Tunnels", 2: "Midboss room", 3: "Bell Tower / Sunken Plaza" };
const TYPE = { citadel_breakable_prop_wooden_crate: "crate", citadel_breakable_prop_tough_crate: "tough", citadel_breakable_item_container: "buff" };
let unsnapped = 0, offMain = 0;
const boxes = ents.filter((o) => o.classname === "citadel_breakable_prop" && o.gl).map((o) => {
  const g = Number(o.breakable_spawn_group ?? 0), s = snapPoint(o.gl, 6);
  if (!s) unsnapped++; else if (!mainland[s.tri]) offMain++;
  return {
    id: o.hammeruniqueid, type: TYPE[o.subclass_name] ?? "crate", subclass: o.subclass_name, group: g, groupName: GROUP_NAME[g] ?? `Group ${g}`,
    firstSpawn: (SPAWN[g] ?? SPAWN[0])[0], respawn: (SPAWN[g] ?? SPAWN[0])[1],
    pos: o.gl.map((v) => +v.toFixed(2)), src: o.origin.match(/-?[\d.]+/g).map(Number),
    tri: s ? s.tri : -1, navPoint: s ? s.point.map((v) => +v.toFixed(2)) : null, snapDist: s ? +s.dist.toFixed(2) : null, reachable: !!(s && mainland[s.tri]),
    canReach: !!(s && fwd[s.tri]), canReturn: !!(s && bwd[s.tri]),
    reachableTunnel: !!(s && fwdT[s.tri] && bwdT[s.tri]),
    minJump: s && Number.isFinite(minJump[s.tri]) ? minJump[s.tri] : null,
  };
});
log(`${boxes.length} boxes: ${unsnapped} off the navmesh, ${offMain} on unreachable patches`);

// Jungle camps and Sinner's Sacrifices, as routable targets alongside the boxes. A camp's haunts are
// the info_neutral_trooper_spawn entities that name it (or, if unnamed, sit within 15 m of it);
// spawn subclasses ending _weak/_normal/_strong are small/medium/large haunts.
// Timers: deadlock.wiki/Denizens and /Sinner's_Sacrifice (checked 2026-10-29).
const CAMP_TIMES = { weak: [120, 85], medium: [300, 290], strong: [480, 335], vaults: [480, 300] };
const CAMP_NAME = { weak: "Small camp", medium: "Medium camp", strong: "Large camp", vaults: "Sinner's camp" };
{
  const camps = ents.filter((o) => o.classname === "info_neutral_trooper_camp" && o.gl && !/midboss/.test(o.subclass_name));
  const spawnsN = ents.filter((o) => o.classname === "info_neutral_trooper_spawn" && o.gl);
  const owner = new Map();
  for (const s of spawnsN) {
    let c = camps.find((c) => c.targetname && c.targetname === s.campname);
    if (!c) {
      const near = camps.map((c) => ({ c, d: Math.hypot(c.gl[0] - s.gl[0], c.gl[1] - s.gl[1], c.gl[2] - s.gl[2]) })).sort((a, b) => a.d - b.d)[0];
      if (near && near.d <= 15) c = near.c;
    }
    if (c) { if (!owner.has(c)) owner.set(c, []); owner.get(c).push(s); }
  }
  let added = 0;
  for (const c of camps) {
    const members = owner.get(c) ?? [];
    const haunts = { small: 0, medium: 0, large: 0 };
    let sinners = 0;
    for (const s of members) {
      const sub = s.neutralsubclass ?? "";
      if (/sinners/.test(sub)) sinners++;
      else if (/_strong$/.test(sub)) haunts.large++;
      else if (/_normal$/.test(sub)) haunts.medium++;
      else if (/_weak$/.test(sub)) haunts.small++;
    }
    const tier = c.subclass_name.replace("neutral_camp_", "");
    // a medium camp with no linked spawns still holds haunts in game; assume three medium ones
    if (!sinners && haunts.small + haunts.medium + haunts.large === 0) haunts.medium = 3;
    const s = snapPoint(c.gl, 8), [first, respawn] = CAMP_TIMES[tier] ?? CAMP_TIMES.medium;
    boxes.push({
      id: c.hammeruniqueid, type: sinners ? "sinner" : "camp", subclass: c.subclass_name, group: 0, groupName: CAMP_NAME[tier] ?? "Camp",
      haunts, sinners, firstSpawn: first, respawn,
      pos: c.gl.map((v) => +v.toFixed(2)), src: c.origin.match(/-?[\d.]+/g).map(Number),
      tri: s ? s.tri : -1, navPoint: s ? s.point.map((v) => +v.toFixed(2)) : null, snapDist: s ? +s.dist.toFixed(2) : null, reachable: !!(s && mainland[s.tri]),
      canReach: !!(s && fwd[s.tri]), canReturn: !!(s && bwd[s.tri]), reachableTunnel: !!(s && fwdT[s.tri] && bwdT[s.tri]),
      minJump: s && Number.isFinite(minJump[s.tri]) ? minJump[s.tri] : null,
    });
    added++;
  }
  log(`${added} jungle camps (${boxes.filter((b) => b.type === "sinner").length} with Sinner's Sacrifices)`);
}

const TEAM = { 2: "Amber", 3: "Sapphire" };
const presets = [];
spawns.forEach(({ o, s }, i) => presets.push({ name: `${TEAM[o.teamnumber] ?? "Team " + o.teamnumber} spawn ${i + 1}`, pos: s.point, tri: s.tri }));
volumes("shop").forEach((v, i) => { const s = snapPoint([v.c[0], v.min[1] + 0.5, v.c[2]], 8); if (s) presets.push({ name: `Shop ${i + 1}`, pos: s.point, tri: s.tri }); });

// ---------------------------------------------------------------- write
const E = edges.length;
const arrays = {
  nodePos: new Float32Array(nNodes * 3), triVerts: new Float32Array(nTri * 9), off,
  to: new Uint32Array(E), etype: new Uint8Array(E), epts: new Float32Array(E * 6), comps: new Float32Array(E * EC), mainland, tunnelTri,
};
cent.forEach((c, t) => arrays.nodePos.set(c, t * 3));
zipNodes.forEach((p, i) => arrays.nodePos.set(p, (nTri + i) * 3));
tris.forEach(([a, b, c], t) => arrays.triVerts.set([...V[a], ...V[b], ...V[c]], t * 9));
edges.forEach((e, i) => { arrays.to[i] = e.to; arrays.etype[i] = e.type; arrays.epts.set([...e.a, ...e.b], i * 6); arrays.comps.set(e.comps, i * EC); });
const typeName = (T) => ({ Float32Array: "f32", Uint32Array: "u32", Uint8Array: "u8" })[T.constructor.name];
const meta = { nTri, nNodes, hull: HULL, arrays: Object.entries(arrays).map(([k, v]) => [k, typeName(v), v.length]) };
const metaBuf = Buffer.from(JSON.stringify(meta));
const parts = [Buffer.from("DLNV"), Buffer.alloc(4), metaBuf];
parts[1].writeUInt32LE(metaBuf.length);
let size = 8 + metaBuf.length;
for (const v of Object.values(arrays)) {
  const pad = ((size + 3) & ~3) - size;
  if (pad) { parts.push(Buffer.alloc(pad)); size += pad; }
  parts.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength)); size += v.byteLength;
}
fs.writeFileSync(path.join(dataDir, "nav.bin"), Buffer.concat(parts));
const counts = {};
for (const e of edges) counts[e.type] = (counts[e.type] ?? 0) + 1;
fs.writeFileSync(path.join(dataDir, "nav.json"), JSON.stringify({
  hull: HULL, triangles: nTri, nodes: nNodes, edges: E, edgeCounts: Object.fromEntries(Object.entries(counts).map(([k, v]) => [Object.keys(EDGE)[k], v])),
  mainland: { triangles: mainCount, area: Math.round(mainArea) }, spawnTimes: SPAWN, groupNames: GROUP_NAME, boxes, presets, ziplines,
}));
log(`wrote nav.bin (${(size / 1e6).toFixed(1)} MB): ${nNodes} nodes, ${E} edges`, JSON.stringify(counts));
