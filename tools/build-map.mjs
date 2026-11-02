// Converts the Source 2 Viewer glTF export of dl_midtown into a compact,
// simplified collision-style mesh (map.bin) plus landmark volumes (map.json)
// for the browser viewer.
//
// Usage: node tools/build-map.mjs <export dir> <out dir> [cellSizeMeters]
import fs from "node:fs";
import path from "node:path";
import { SKIP_MAT, worldMatrices, openBuffers, readAccessor, inCrop } from "./gltf.mjs";

const [srcDir, outDir, cellArg] = process.argv.slice(2);
if (!srcDir || !outDir) {
  console.error("usage: node build-map.mjs <export dir> <out dir> [cell]");
  process.exit(1);
}
const CELL = Number(cellArg ?? 0.3);

// ---------- growable typed arrays ----------
class Grow {
  constructor(T) { this.T = T; this.a = new T(1 << 20); this.n = 0; }
  push(v) {
    if (this.n === this.a.length) { const b = new this.T(this.a.length * 2); b.set(this.a); this.a = b; }
    this.a[this.n++] = v;
  }
  get view() { return this.a.subarray(0, this.n); }
}

// ---------- 1. render mesh -> vertex-clustered world mesh ----------
const render = JSON.parse(fs.readFileSync(path.join(srcDir, "dl_midtown_d.gltf"), "utf8"));
const rfds = openBuffers(render, srcDir);
const rWorld = worldMatrices(render);

// Open-addressing hash: quantised cell key -> output vertex index. (JS Map caps at ~16.7M.)
let hCap = 1 << 24, hKeys = new Float64Array(hCap).fill(-1), hVals = new Int32Array(hCap), hSize = 0;
function hSlot(keys, cap, key) {
  let h = (Math.imul((key % 4294967296) | 0, 0x9e3779b1) ^ Math.floor(key / 4294967296)) & (cap - 1);
  while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & (cap - 1);
  return h;
}
function hGrow() {
  const nc = hCap * 2, nk = new Float64Array(nc).fill(-1), nv = new Int32Array(nc);
  for (let i = 0; i < hCap; i++) if (hKeys[i] !== -1) { const s = hSlot(nk, nc, hKeys[i]); nk[s] = hKeys[i]; nv[s] = hVals[i]; }
  hCap = nc; hKeys = nk; hVals = nv;
}
const sums = new Grow(Float64Array); // accumulated positions (x,y,z,count)
const tris = new Grow(Uint32Array);
const K = 1 << 17, OFF = K / 2;


function vert(x, y, z) {
  const ix = Math.floor(x / CELL) + OFF, iy = Math.floor(y / CELL) + OFF, iz = Math.floor(z / CELL) + OFF;
  const key = (ix * K + iy) * K + iz; // < 2^51, exact in a double
  let s0 = hSlot(hKeys, hCap, key), v;
  if (hKeys[s0] === key) v = hVals[s0];
  else {
    v = sums.n / 4;
    hKeys[s0] = key; hVals[s0] = v;
    if (++hSize * 2 > hCap) hGrow();
    sums.push(0); sums.push(0); sums.push(0); sums.push(0);
  }
  const s = sums.a;
  s[v * 4] += x; s[v * 4 + 1] += y; s[v * 4 + 2] += z; s[v * 4 + 3]++;
  return v;
}

let done = 0;
for (const [ni, M] of rWorld) {
  const n = render.nodes[ni];
  if (n.mesh === undefined || n.skin !== undefined) continue;
  const name = n.name ?? "";
  if (SKIP_MAT.test(name)) { skippedMat++; continue; }
  for (const pr of render.meshes[n.mesh].primitives) {
    if (pr.indices === undefined || (pr.mode ?? 4) !== 4) continue;
    const matName = render.materials[pr.material]?.name ?? "";
    if (SKIP_MAT.test(matName)) { skippedMat++; continue; }
    const I = readAccessor(render, rfds, pr.indices);
    let lo = Infinity, hi = -1;
    for (let t = 0; t < I.length; t++) { if (I[t] < lo) lo = I[t]; if (I[t] > hi) hi = I[t]; }
    if (hi < 0) continue;
    const P = readAccessor(render, rfds, pr.attributes.POSITION, lo, hi - lo + 1);
    for (let t = 0; t < I.length; t++) I[t] -= lo;
    // only vertices the indices reference
    const used = new Uint8Array(hi - lo + 1);
    for (let t = 0; t < I.length; t++) used[I[t]] = 1;
    const W = new Float32Array((hi - lo + 1) * 3);
    for (let i = 0; i < used.length; i++) {
      if (!used[i]) continue;
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      W[i * 3] = M[0] * x + M[4] * y + M[8] * z + M[12];
      W[i * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      W[i * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
    }
    const map = new Int32Array(hi - lo + 1).fill(-1);
    const vi = (i) => (map[i] >= 0 ? map[i] : (map[i] = vert(W[i * 3], W[i * 3 + 1], W[i * 3 + 2])));
    for (let t = 0; t < I.length; t += 3) {
      inTris++;
      const i0 = I[t] * 3, i1 = I[t + 1] * 3, i2 = I[t + 2] * 3;
      if (!inCrop((W[i0] + W[i1] + W[i2]) / 3, (W[i0 + 1] + W[i1 + 1] + W[i2 + 1]) / 3, (W[i0 + 2] + W[i1 + 2] + W[i2 + 2]) / 3)) continue;
      const a = vi(I[t]), b = vi(I[t + 1]), c = vi(I[t + 2]);
      if (a === b || b === c || a === c) continue;
      tris.push(a); tris.push(b); tris.push(c);
    }
  }
  if (++done % 2000 === 0) console.log(`  ${done} nodes, ${tris.n / 3} tris out`);
}

const vcount = sums.n / 4;
const pos = new Float32Array(vcount * 3);
for (let v = 0; v < vcount; v++) {
  const c = sums.a[v * 4 + 3];
  pos[v * 3] = sums.a[v * 4] / c; pos[v * 3 + 1] = sums.a[v * 4 + 1] / c; pos[v * 3 + 2] = sums.a[v * 4 + 2] / c;
}
const idx = tris.view;
const bmin = [Infinity, Infinity, Infinity], bmax = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i++) { const k = i % 3; bmin[k] = Math.min(bmin[k], pos[i]); bmax[k] = Math.max(bmax[k], pos[i]); }

// ---------- 2. physics export -> landmark volumes ----------
const LANDMARKS = {
  citadel_trigger_climb_rope: "rope",
  trigger_catapult: "jumppad",
  citadel_trigger_teleport: "teleport",
  trigger_item_shop: "shop",
  citadel_trigger_shop_tunnel: "shop_tunnel",
  trigger_team_base: "base",
  citadel_capture_point: "capture",
  citadel_trigger_idol_return: "idol_return",
  trigger_midboss_shield: "midboss",
  citadel_trigger_in_map_district: "district",
};
const phys = JSON.parse(fs.readFileSync(path.join(srcDir, "dl_midtown_d_physics.gltf"), "utf8"));
const pfds = openBuffers(phys, srcDir);
const pWorld = worldMatrices(phys);
const landmarks = [];
for (const [ni, M] of pWorld) {
  const n = phys.nodes[ni];
  const kind = LANDMARKS[n.name];
  if (!kind || n.mesh === undefined) continue;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const pr of phys.meshes[n.mesh].primitives) {
    const P = readAccessor(phys, pfds, pr.attributes.POSITION);
    for (let i = 0; i < P.length; i += 3) {
      const x = P[i], y = P[i + 1], z = P[i + 2];
      const w = [
        M[0] * x + M[4] * y + M[8] * z + M[12],
        M[1] * x + M[5] * y + M[9] * z + M[13],
        M[2] * x + M[6] * y + M[10] * z + M[14],
      ];
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
    }
  }
  landmarks.push({ kind, entity: n.name, min: lo.map((v) => +v.toFixed(2)), max: hi.map((v) => +v.toFixed(2)) });
}

// ---------- write ----------
fs.mkdirSync(outDir, { recursive: true });
const header = Buffer.alloc(12);
header.write("DLMP", 0); header.writeUInt32LE(vcount, 4); header.writeUInt32LE(idx.length / 3, 8);
fs.writeFileSync(path.join(outDir, "map.bin"), Buffer.concat([
  header, Buffer.from(pos.buffer), Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength),
]));
fs.writeFileSync(path.join(outDir, "map.json"), JSON.stringify({
  source: "dl_midtown_d", cell: CELL, units: "meters, Y-up (Source 2 Viewer glTF frame)",
  bounds: { min: bmin, max: bmax }, vertices: vcount, triangles: idx.length / 3, landmarks,
}, null, 1));
console.log(`in ${inTris} tris, skipped ${skippedMat} decorative meshes`);
console.log(`out ${vcount} verts, ${idx.length / 3} tris, ${landmarks.length} landmarks`);
console.log("bounds", bmin.map((v) => v.toFixed(1)), bmax.map((v) => v.toFixed(1)));
