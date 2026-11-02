// Navigation core shared by the browser app and the Node build scripts.
//
// Graph: one node per navmesh triangle plus one per zipline sample point. Edges are either
// mesh edges (two triangles sharing a portal) or links (drop, jump, gap jump, rope, jump pad,
// teleporter, zipline latch / ride / dismount, tunnel). Every edge carries a cost-component
// vector, and travel time = components · weights, so the movement model can change without
// rebuilding. Stamina (dash-slides, air jumps, dash jumps) is simulated along each route.

// Component slots. Edges in nav.bin store the first EC; stamina is derived from the move.
export const C = { walk: 0, rampUp: 1, jumps: 2, jumpUp: 3, drop: 4, zip: 5, latch: 6, rope: 7, fixed: 8, stamina: 9 };
export const EC = 9;
export const NC = 10;
export const EDGE = { mesh: 0, drop: 1, jump: 2, gap: 3, rope: 4, pad: 5, teleport: 6, latch: 7, zip: 8, dismount: 9, tunnel: 10 };
export const EDGE_NAMES = Object.keys(EDGE);

export const DEFAULT_PARAMS = {
  runSpeed: 10.5,    // m/s: 6.8 base + 1.6 sprint (deadlock.wiki/Move_Speed), plus slide-hop momentum (4 route timings)
  rampCost: 0.08,    // s per meter climbed while walking (stairs, ramps)
  jumpTime: 0.05,    // s per jump on top of the run (jumps are taken at speed; 2026-10-29 route timing)
  climbCost: 0.08,   // s per meter gained by a jump/mantle (2026-10-29 route timing)
  dropCost: 0.03,    // s per meter of plain fall (you keep moving forward while falling; route timings)
  wallClimb: 10,     // m: tallest ledge climbed from right against its wall (wall jump + double jump)
  wallClimbTime: 0.7,// s extra for each wall climb (route timings, 2026-10-29)
  maxJumpUp: 4.0,    // m: most height gained in an open-air jump across a gap
  maxGap: 20,        // m: longest level gap cleared between rooftops (dash jump)
  zipSpeed: 27,      // m/s on a zipline (in-game timing, 2026-10-29)
  latchTime: 0.1,    // s to attach to a zipline; the pull toward it counts as zipline travel
  zipCarry: 15,      // m covered at dash speed after crouching off a zipline (exit momentum)
  ropeSpeed: 14,     // m/s climbing a rope (in-game velocity 551 u/s)
  fixedScale: 1,     // multiplier on fixed times (jump pad flight, teleporter delay)
  breakTime: 0.15,   // s per box: broken and collected on the move (2026-10-29 route timing)
  campDps: 120,      // your damage per second against jungle haunts at 0:00 ...
  campDpsPerMin: 25, // ... growing this much per game minute (about 245 at 5:00, 420 at 12:00)
  sinnerTime: 10,    // s to break one Sinner's Sacrifice, jackpot included (in-game, 2026-10-29)
  sinnerBuffs: 4,    // buffs per Sinner's Sacrifice: always played as a heavy-melee jackpot
  // stamina
  useDash: true,     // dash-slide on runs whenever a charge is available
  stamina: 3,        // charges (most heroes)
  staminaRegen: 4.5, // s to recharge one charge
  dashSpeed: 14.7,   // m/s while dashing; a slide carries the momentum
  dashDistance: 12,  // m covered at dash speed per charge, slide momentum included (2026-10-29)
  freeJumpUp: 2.5,   // m climbable without an air jump (higher costs 1 stamina)
  freeGap: 6,        // m of gap cleared without a dash jump (farther costs 2 stamina)
  useDownDash: true, // down dash on drops: half a charge for a much quicker descent
  downDashCost: 0.045, // s per meter descended with a down dash (in-game timings, 2026-10-29)
  downDashMin: 4,    // m: shortest drop worth a down dash
  useZip: true, useRope: true, usePads: true, useTeleport: true,
  useTunnels: false, // only Rem, Rat King, Mo & Krill and Calico fit through tunnels
};
export const TUNNEL_HEROES = ["Rem", "Rat King", "Mo & Krill", "Calico"];

// Plain per-component costs (no dashing): how long each piece takes at run speed.
export function weights(p) {
  const w = new Float64Array(NC);
  w[C.walk] = 1 / p.runSpeed; w[C.rampUp] = p.rampCost; w[C.jumps] = p.jumpTime; w[C.jumpUp] = p.climbCost;
  w[C.drop] = p.dropCost; w[C.zip] = 1 / p.zipSpeed; w[C.latch] = p.latchTime; w[C.rope] = 1 / p.ropeSpeed;
  w[C.fixed] = p.fixedScale;
  return w;
}

// Seconds one dash-slide saves over running the same distance.
export const dashSave = (p) => (p.useDash ? Math.max(0, p.dashDistance * (1 / p.runSpeed - 1 / p.dashSpeed)) : 0);

// Steady-state weights for planning: every recharged stamina goes into a dash on the run, so
// running is effectively faster, and a stamina spent on a jump costs the dash it replaces.
export function planWeights(p) {
  const w = weights(p), save = dashSave(p);
  w[C.walk] = 1 / p.runSpeed / (1 + save / p.staminaRegen);
  w[C.stamina] = save;
  // every latch ends in a dismount whose momentum saves time on the run after it
  w[C.latch] = Math.max(0.05, p.latchTime - p.zipCarry * (1 / p.runSpeed - 1 / p.dashSpeed));
  if (p.useDownDash) w[C.drop] = Math.min(p.dropCost, p.downDashCost);
  return w;
}

// Stamina a move needs: an air jump for tall climbs, a dash jump for long gaps.
export function staminaOf(t, comps, off, p) {
  if (t === EDGE.jump) return comps[off + C.jumpUp] > p.freeJumpUp ? 1 : 0;
  if (t === EDGE.gap) return comps[off + C.walk] > p.freeGap ? 2 : comps[off + C.jumpUp] > p.freeJumpUp ? 1 : 0;
  return 0;
}

// Which moves a given movement setting allows. comps[off..] is the move's component vector.
// Jump-ups are taken from right against the ledge's wall, so they use the wall-climb height.
// Gap jumps follow a simple jump envelope: the full maxGap on the level, less distance the
// higher the landing (none at maxJumpUp), more distance when landing lower (longer airtime).
export function moveAllowed(t, comps, off, p) {
  if (t === EDGE.jump && comps[off + C.jumpUp] > p.wallClimb) return false;
  if (t === EDGE.gap) {
    const d = comps[off + C.walk], rise = comps[off + C.jumpUp], fall = comps[off + C.drop];
    if (d > p.maxGap * (1 + 0.15 * Math.sqrt(fall))) return false;
    if (rise > p.maxJumpUp * Math.max(0, 1 - (d / p.maxGap) ** 2)) return false;
  }
  if (!p.useZip && (t === EDGE.latch || t === EDGE.zip || t === EDGE.dismount)) return false;
  if (!p.useRope && t === EDGE.rope) return false;
  if (!p.usePads && t === EDGE.pad) return false;
  if (!p.useTeleport && t === EDGE.teleport) return false;
  if (!p.useTunnels && t === EDGE.tunnel) return false;
  return true;
}
const edgeAllowed = (g, e, p) => moveAllowed(g.etype[e], g.comps, e * EC, p);

// ---------------------------------------------------------------- loading
// nav.bin layout: "DLNV", u32 jsonLen, json, then the arrays named in json.arrays, each 4-byte aligned.
export function loadNav(buffer) {
  const dv = new DataView(buffer);
  const jsonLen = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, jsonLen)));
  let off = 8 + jsonLen;
  const T = { f32: Float32Array, u32: Uint32Array, u8: Uint8Array, i32: Int32Array };
  const g = { meta };
  for (const [name, type, len] of meta.arrays) {
    off = (off + 3) & ~3;
    g[name] = new T[type](buffer, off, len);
    off += len * T[type].BYTES_PER_ELEMENT;
  }
  g.nTri = meta.nTri; g.n = meta.nNodes;
  // reverse adjacency for "time from every node back to X" searches
  const E = g.to.length, rcount = new Uint32Array(g.n + 1);
  for (let e = 0; e < E; e++) rcount[g.to[e] + 1]++;
  for (let i = 0; i < g.n; i++) rcount[i + 1] += rcount[i];
  const fill = rcount.slice(0, g.n), rfrom = new Uint32Array(E), redge = new Uint32Array(E);
  for (let u = 0; u < g.n; u++)
    for (let e = g.off[u]; e < g.off[u + 1]; e++) { const k = fill[g.to[e]]++; rfrom[k] = u; redge[k] = e; }
  Object.assign(g, { roff: rcount, rfrom, redge });
  buildTriGrid(g);
  return g;
}

// ---------------------------------------------------------------- point queries
const GRID = 4;
function buildTriGrid(g) {
  const cells = new Map();
  for (let t = 0; t < g.nTri; t++) {
    const v = g.triVerts.subarray(t * 9, t * 9 + 9);
    const x0 = Math.floor(Math.min(v[0], v[3], v[6]) / GRID), x1 = Math.floor(Math.max(v[0], v[3], v[6]) / GRID);
    const z0 = Math.floor(Math.min(v[2], v[5], v[8]) / GRID), z1 = Math.floor(Math.max(v[2], v[5], v[8]) / GRID);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) {
      const k = x * 65536 + z;
      let a = cells.get(k); if (!a) cells.set(k, (a = [])); a.push(t);
    }
  }
  g.triGrid = cells;
}

// Height of triangle t at (x,z), or NaN if (x,z) is outside it.
export function triHeightAt(g, t, x, z) {
  const v = g.triVerts, o = t * 9;
  const ax = v[o], az = v[o + 2], bx = v[o + 3], bz = v[o + 5], cx = v[o + 6], cz = v[o + 8];
  const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
  if (Math.abs(d) < 1e-12) return NaN;
  const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, l3 = 1 - l1 - l2;
  const eps = -1e-4;
  if (l1 < eps || l2 < eps || l3 < eps) return NaN;
  return l1 * v[o + 1] + l2 * v[o + 4] + l3 * v[o + 7];
}

// Triangles under (x,z) as [{t, y}], any height.
export function trisAt(g, x, z) {
  const out = [];
  for (const t of g.triGrid.get(Math.floor(x / GRID) * 65536 + Math.floor(z / GRID)) ?? []) {
    const y = triHeightAt(g, t, x, z);
    if (!Number.isNaN(y)) out.push({ t, y });
  }
  return out;
}

function closestOnTri(g, t, p) {
  const v = g.triVerts, o = t * 9;
  const y = triHeightAt(g, t, p[0], p[2]);
  if (!Number.isNaN(y)) return [p[0], y, p[2]];
  let best = null, bd = Infinity;
  for (let k = 0; k < 3; k++) {
    const a = [v[o + k * 3], v[o + k * 3 + 1], v[o + k * 3 + 2]], b = [v[o + ((k + 1) % 3) * 3], v[o + ((k + 1) % 3) * 3 + 1], v[o + ((k + 1) % 3) * 3 + 2]];
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
    const s = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / L)) : 0;
    const q = [a[0] + ab[0] * s, a[1] + ab[1] * s, a[2] + ab[2] * s];
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 * 4 + (q[2] - p[2]) ** 2;
    if (d < bd) { bd = d; best = q; }
  }
  return best;
}

// Nearest navmesh triangle to a world point, preferring the floor at or just below it.
// Returns {tri, point, dist} or null.
export function snap(g, p, maxDist = 6) {
  let best = null;
  for (const { t, y } of trisAt(g, p[0], p[2])) {
    const dy = p[1] - y, score = dy >= -0.5 ? dy : -dy * 3;
    if (score < maxDist && (!best || score < best.dist)) best = { tri: t, point: [p[0], y, p[2]], dist: score };
  }
  if (best) return best;
  const r = Math.ceil(maxDist / GRID), cx = Math.floor(p[0] / GRID), cz = Math.floor(p[2] / GRID);
  for (let x = cx - r; x <= cx + r; x++) for (let z = cz - r; z <= cz + r; z++)
    for (const t of g.triGrid.get(x * 65536 + z) ?? []) {
      const q = closestOnTri(g, t, p);
      const d = Math.hypot(q[0] - p[0], (q[1] - p[1]) * 2, q[2] - p[2]);
      if (d < maxDist && (!best || d < best.dist)) best = { tri: t, point: q, dist: d };
    }
  return best;
}

// ---------------------------------------------------------------- search
class Heap {
  constructor(n) { this.k = new Float64Array(n); this.v = new Int32Array(n); this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) { const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k; const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v; }
    let i = this.n++;
    while (i > 0) { const p = (i - 1) >> 1; if (this.k[p] <= key) break; this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p; }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0], lk = this.k[--this.n], lv = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= lk) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = lk; this.v[i] = lv;
    return top;
  }
}

// Dijkstra from sources [{node, cost}] using the planning weights. reverse=true computes time
// from every node TO the sources. Returns {dist, via} where via[node] is the edge used (or -1).
export function dijkstra(g, sources, params, { reverse = false, maxCost = Infinity, targets = null } = {}) {
  const w = planWeights(params), blockTunnels = !params.useTunnels && !!g.tunnelTri;
  const dist = new Float64Array(g.n).fill(Infinity), via = new Int32Array(g.n).fill(-1), done = new Uint8Array(g.n);
  const heap = new Heap(1024);
  for (const s of sources) if (s.cost < dist[s.node]) { dist[s.node] = s.cost; heap.push(s.cost, s.node); }
  let remaining = targets ? new Set(targets) : null;
  while (heap.n) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (remaining) { remaining.delete(u); if (!remaining.size) break; }
    if (dist[u] > maxCost) break;
    const lo = reverse ? g.roff[u] : g.off[u], hi = reverse ? g.roff[u + 1] : g.off[u + 1];
    for (let k = lo; k < hi; k++) {
      const e = reverse ? g.redge[k] : k, v = reverse ? g.rfrom[k] : g.to[k];
      if (done[v] || !edgeAllowed(g, e, params)) continue;
      if (blockTunnels && g.tunnelTri[v]) continue; // only small heroes fit in the tunnels
      const o = e * EC;
      let c = staminaOf(g.etype[e], g.comps, o, params) * w[C.stamina];
      if (g.etype[e] === EDGE.jump) c += params.wallClimbTime * w[C.fixed];
      for (let j = 0; j < EC; j++) c += g.comps[o + j] * w[j];
      const nd = dist[u] + c;
      if (nd < dist[v]) { dist[v] = nd; via[v] = e; heap.push(nd, v); }
    }
  }
  return { dist, via };
}

const edgeFrom = (g, e) => { let lo = 0, hi = g.n; while (lo < hi) { const m = (lo + hi) >> 1; if (g.off[m + 1] <= e) lo = m + 1; else hi = m; } return lo; };

// Edge list from a search's source to `node` (forward search), or from `node` to the source (reverse).
export function edgeChain(g, via, node, reverse = false) {
  const chain = [];
  let v = node;
  for (let guard = 0; via[v] >= 0 && guard < 1e6; guard++) {
    const e = via[v];
    chain.push(e);
    v = reverse ? g.to[e] : edgeFrom(g, e);
  }
  return reverse ? chain : chain.reverse();
}

// ---------------------------------------------------------------- path geometry
const area2 = (a, b, c) => (c[0] - a[0]) * (b[2] - a[2]) - (b[0] - a[0]) * (c[2] - a[2]);
const same = (a, b) => (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2 < 1e-8;

// Simple stupid funnel algorithm (Mononen) in the xz plane. portals: [[left,right], ...] with the
// start as the first (degenerate) portal and the end as the last.
function funnel(portals) {
  const pts = [portals[0][0]];
  let apex = portals[0][0], left = portals[0][0], right = portals[0][1], ai = 0, li = 0, ri = 0;
  for (let i = 1; i < portals.length; i++) {
    const [l, r] = portals[i];
    if (area2(apex, right, r) <= 0) {
      if (same(apex, right) || area2(apex, left, r) > 0) { right = r; ri = i; }
      else { pts.push(left); apex = left; ai = li; left = right = apex; li = ri = ai; i = ai; continue; }
    }
    if (area2(apex, left, l) >= 0) {
      if (same(apex, left) || area2(apex, right, l) < 0) { left = l; li = i; }
      else { pts.push(right); apex = right; ai = ri; left = right = apex; li = ri = ai; i = ai; continue; }
    }
  }
  const end = portals[portals.length - 1][0];
  if (!same(pts[pts.length - 1], end)) pts.push(end);
  return pts;
}

// Portal endpoints of mesh edge e, ordered [left, right] for travel from `fromTri`.
function portal(g, e, fromTri) {
  const a = g.epts.subarray(e * 6, e * 6 + 3), b = g.epts.subarray(e * 6 + 3, e * 6 + 6);
  const c = [g.nodePos[fromTri * 3], g.nodePos[fromTri * 3 + 1], g.nodePos[fromTri * 3 + 2]];
  return area2(c, a, b) > 0 ? [Array.from(a), Array.from(b)] : [Array.from(b), Array.from(a)];
}

// Walk an edge chain from point `start` to point `end`, string-pulling each run of mesh edges.
// Returns {points, comps, kinds, pieces}: kinds[i] names the move that ends at points[i+1];
// pieces is the ordered list of runs ({kind:"walk", len, up}) and moves ({kind, comps, stamina})
// that the stamina simulation steps through.
export function tracePath(g, chain, start, end, params) {
  const comps = new Float64Array(NC), points = [start], kinds = [], pieces = [];
  let run = [[start, start]], cur = start;
  const flush = (to) => {
    run.push([to, to]);
    const pts = run.length > 2 ? funnel(run) : [cur, to];
    let len = 0, up = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      len += Math.hypot(b[0] - a[0], b[2] - a[2]);
      up += Math.max(0, b[1] - a[1]);
      points.push(b); kinds.push("walk");
    }
    comps[C.walk] += len; comps[C.rampUp] += up;
    if (len > 1e-3) pieces.push({ kind: "walk", len, up });
    run = []; cur = to;
  };
  for (const e of chain) {
    if (g.etype[e] === EDGE.mesh) {
      run.push(portal(g, e, edgeFrom(g, e)));
      continue;
    }
    const from = Array.from(g.epts.subarray(e * 6, e * 6 + 3)), to = Array.from(g.epts.subarray(e * 6 + 3, e * 6 + 6));
    flush(from);
    const ec = Float64Array.from(g.comps.subarray(e * EC, e * EC + EC)), st = staminaOf(g.etype[e], ec, 0, params);
    if (g.etype[e] === EDGE.jump) ec[C.fixed] += params.wallClimbTime;
    for (let j = 0; j < EC; j++) comps[j] += ec[j];
    comps[C.stamina] += st;
    pieces.push({ kind: EDGE_NAMES[g.etype[e]], comps: ec, stamina: st });
    points.push(to); kinds.push(EDGE_NAMES[g.etype[e]]);
    cur = to; run = [[to, to]];
  }
  flush(end);
  // drop zero-length steps
  for (let i = points.length - 1; i > 0; i--) if (Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1], points[i][2] - points[i - 1][2]) < 1e-3) { points.splice(i, 1); kinds.splice(i - 1, 1); }
  return { points, comps, kinds, pieces };
}

// ---------------------------------------------------------------- stamina simulation
// state = {s: charges}. Charges refill continuously at 1 per staminaRegen seconds up to the cap.
// Runs dash-slide whenever a charge is ready and enough run is left; a move needing stamina
// waits for it if short. Returns the time taken and what was used.
export function newStamina(p) { return { s: p.stamina }; }
export function regen(state, dt, p) { state.s = Math.min(p.stamina, state.s + dt / p.staminaRegen); }

// Decide whether to spend a charge on a dash-slide right now.
//   charges          stamina available now (fractional while recharging), at least 1 here
//   needSoon         stamina the next stamina move in this leg needs (0 if none: air jump 1, dash jump 2)
//   secondsUntilNeed running time from now until that move if we keep running
//   p                movement settings (p.staminaRegen = seconds per charge, p.stamina = cap)
// A dash saves about dashSave(p) seconds (~0.46 s); arriving at a dash jump short of stamina
// means waiting for the recharge (up to p.staminaRegen seconds per missing charge).
export function shouldDash({ charges, needSoon, secondsUntilNeed }, p) {
  if (!needSoon) return true;
  // after this dash, will recharging cover the next jump by the time we reach it?
  return charges - 1 + secondsUntilNeed / p.staminaRegen >= needSoon;
}

// Decide whether to down dash a drop (half a charge for a much quicker descent).
//   fall             meters this move drops
//   charges          stamina available now (fractional while recharging)
//   needSoon         stamina the next stamina move in this leg needs (0 if none)
//   secondsUntilNeed running time from this drop until that move
// Down dashing saves fall * (p.dropCost - p.downDashCost) seconds (~0.7 s on a 20 m drop).
export function shouldDownDash({ fall, charges, needSoon, secondsUntilNeed }, p) {
  if (fall < p.downDashMin) return false;
  // keep enough for the next air jump / dash jump once recharging is counted
  return !needSoon || charges - 0.5 + secondsUntilNeed / p.staminaRegen >= needSoon;
}

// Upcoming stamina need seen from the start of a piece list: {need, run} = what the first
// stamina move needs and how far you run before reaching it. Passing the result for the legs
// after this one (tail) lets a leg save charges for a dash jump in the next leg.
export function lookAhead(pieces, tail = { need: 0, run: 0 }) {
  let { need, run } = tail;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const pc = pieces[i];
    if (pc.kind === "walk") run += pc.len; else if (pc.stamina > 0) { need = pc.stamina; run = 0; }
  }
  return { need, run };
}

export function simulatePieces(pieces, state, p, tail = { need: 0, run: 0 }) {
  const w = weights(p), out = { time: 0, dashes: 0, dashM: 0, runM: 0, staminaWait: 0, staminaUsed: 0, downDashes: 0, downDashM: 0, carryM: 0 };
  let carry = 0; // momentum left from crouching off a zipline, in meters
  // look-ahead: for each piece, the next stamina move after it (this leg or later) and the run before it
  const nextNeed = new Array(pieces.length), runBefore = new Array(pieces.length);
  for (let i = pieces.length - 1, need = tail.need, run = tail.run; i >= 0; i--) {
    nextNeed[i] = need; runBefore[i] = run;
    const pc = pieces[i];
    if (pc.kind === "walk") run += pc.len; else if (pc.stamina > 0) { need = pc.stamina; run = 0; }
  }
  for (let pi = 0; pi < pieces.length; pi++) {
    const pc = pieces[pi];
    if (pc.kind === "walk") {
      let L = pc.len;
      if (carry > 0) { // ride the zipline exit momentum before running or dashing
        const d = Math.min(carry, L), dt = d / p.dashSpeed;
        out.time += dt; regen(state, dt, p); L -= d; out.carryM += d; carry = 0;
      }
      const rampT = pc.up * p.rampCost;
      out.time += rampT; regen(state, rampT, p);
      while (L > 1e-6) {
        const ctx = { charges: state.s, needSoon: nextNeed[pi], secondsUntilNeed: (L + runBefore[pi]) / p.runSpeed };
        if (p.useDash && state.s >= 1 && L >= p.dashDistance * 0.6 && shouldDash(ctx, p)) {
          const d = Math.min(p.dashDistance, L), dt = d / p.dashSpeed;
          state.s -= 1; out.time += dt; regen(state, dt, p);
          L -= d; out.dashes++; out.dashM += d; out.staminaUsed++;
          continue;
        }
        // run until the next charge is ready (or to the end); when holding a charge back, run one
        // dash length and ask again
        const untilCharge = !p.useDash ? Infinity : state.s < 1 ? (1 - state.s) * p.staminaRegen : p.dashDistance / p.runSpeed;
        const d = Math.min(L, untilCharge * p.runSpeed), dt = d / p.runSpeed;
        out.time += dt; regen(state, dt, p);
        L -= d; out.runM += d;
      }
      continue;
    }
    if (pc.stamina > 0) {
      if (state.s < pc.stamina) { const wt = (pc.stamina - state.s) * p.staminaRegen; out.staminaWait += wt; out.time += wt; state.s = pc.stamina; }
      state.s -= pc.stamina; out.staminaUsed += pc.stamina;
    }
    let t = 0;
    for (let j = 0; j < EC; j++) t += pc.comps[j] * w[j];
    // a dash jump crosses its gap at dash speed, not run speed
    if (pc.kind === "gap" && pc.stamina >= 2) t -= pc.comps[C.walk] * (1 / p.runSpeed - 1 / p.dashSpeed);
    // big drops: down dash if half a charge is spare after this move
    const fall = pc.comps[C.drop];
    const ddCtx = { fall, charges: state.s, needSoon: nextNeed[pi], secondsUntilNeed: runBefore[pi] / p.runSpeed };
    if (p.useDownDash && fall > 0 && state.s >= 0.5 && shouldDownDash(ddCtx, p)) {
      t += fall * (p.downDashCost - p.dropCost);
      state.s -= 0.5; out.staminaUsed += 0.5; out.downDashes++; out.downDashM += fall;
    }
    out.time += t; regen(state, t, p);
    if (pc.kind === "dismount") carry = p.zipCarry;
    else if (pc.kind !== "drop") carry = 0;
  }
  return out;
}

// ---------------------------------------------------------------- travel matrix
// Settings that change which edges exist or what they cost in stamina.
export const structuralKey = (p) => [p.wallClimb, p.maxJumpUp, p.maxGap, p.freeJumpUp, p.freeGap, p.useZip, p.useRope, p.usePads, p.useTeleport, p.useTunnels].join("|");

// Exact (string-pulled) components from one point to many: Float32Array(T*NC), NaN when unreachable.
// reverse=true gives the components from each target back to the source instead.
export function rowComps(g, src, targets, params, reverse = false) {
  const out = new Float32Array(targets.length * NC).fill(NaN);
  if (!src || src.tri < 0) return out;
  const { dist, via } = dijkstra(g, [{ node: src.tri, cost: 0 }], params, { reverse });
  targets.forEach((t, j) => {
    if (!t || t.tri < 0 || !Number.isFinite(dist[t.tri])) return;
    const chain = edgeChain(g, via, t.tri, reverse);
    const leg = reverse ? tracePath(g, chain, t.point, src.point, params) : tracePath(g, chain, src.point, t.point, params);
    out.set(leg.comps, j * NC);
  });
  return out;
}

// Components between every pair of points [{tri, point}]: Float32Array(B*B*NC), NaN when unreachable.
// onProgress(i, B) is called after each source row.
export function buildMatrix(g, pts, params, onProgress) {
  const B = pts.length, M = new Float32Array(B * B * NC).fill(NaN);
  for (let i = 0; i < B; i++) {
    M.set(rowComps(g, pts[i], pts, params), i * B * NC);
    onProgress?.(i, B);
  }
  return M;
}

// Exact leg: search from one triangle to another and string-pull the result.
export function exactLeg(g, from, to, params) {
  const { via, dist } = dijkstra(g, [{ node: from.tri, cost: 0 }], params, { targets: [to.tri] });
  if (!Number.isFinite(dist[to.tri])) return null;
  return tracePath(g, edgeChain(g, via, to.tri), from.point, to.point, params);
}

// Steady-state estimate of a component vector's time (what the optimizer uses).
export const timeOf = (comps, params) => {
  const w = planWeights(params);
  let t = 0;
  for (let j = 0; j < NC; j++) t += comps[j] * w[j];
  return t;
};
