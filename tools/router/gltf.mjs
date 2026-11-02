// Shared glTF reading helpers for the Source 2 Viewer export of dl_midtown.
import fs from "node:fs";
import path from "node:path";

// Decorative / non-blocking materials that only add noise to a routing view.
export const SKIP_MAT = /candle|flame|leaves|ivy|shrub|cloud|smoke|fog|sky|cosmic_veil|grass|fern|weed|drip|decal|overlay|graffiti|god_?ray|lightshaft|dust|cobweb|web_|puddle|leaking|smoke_card|ghost|pigeon|curtain_sway|banner|flag_cloth|joe_pye/i;

// ---------- matrix helpers (column-major 4x4, like glTF) ----------
export const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
export function trs(n) {
  if (n.matrix) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
export function worldMatrices(g) {
  const out = new Map();
  const walk = (i, parent) => {
    const n = g.nodes[i];
    const m = mul(parent, trs(n));
    out.set(i, m);
    for (const c of n.children ?? []) walk(c, m);
  };
  for (const r of g.scenes[g.scene ?? 0].nodes) walk(r, identity());
  return out;
}

// ---------- buffer access ----------
export function openBuffers(g, dir) {
  return g.buffers.map((b) => fs.openSync(path.join(dir, decodeURIComponent(b.uri)), "r"));
}
// Reads elements [first, first+count) of an accessor. Meshes in this export share large
// vertex buffers, so callers read only the range their indices touch.
export function readAccessor(g, fds, idx, first = 0, count = g.accessors[idx].count) {
  const a = g.accessors[idx];
  const bv = g.bufferViews[a.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const csize = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType];
  const stride = bv.byteStride || comps * csize;
  const len = stride * (count - 1) + comps * csize;
  const buf = Buffer.alloc(len);
  fs.readSync(fds[bv.buffer], buf, 0, len, (bv.byteOffset ?? 0) + (a.byteOffset ?? 0) + first * stride);
  if (stride === comps * csize && (a.componentType === 5126 || a.componentType === 5125)) {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + len);
    return a.componentType === 5126 ? new Float32Array(ab) : new Uint32Array(ab);
  }
  const out = a.componentType === 5126 ? new Float32Array(count * comps) : new Uint32Array(count * comps);
  for (let i = 0; i < count; i++)
    for (let c = 0; c < comps; c++) {
      const o = i * stride + c * csize;
      out[i * comps + c] =
        a.componentType === 5126 ? buf.readFloatLE(o)
        : a.componentType === 5125 ? buf.readUInt32LE(o)
        : a.componentType === 5123 ? buf.readUInt16LE(o)
        : buf.readUInt8(o);
    }
  return out;
}

// Playable area: district trigger volumes span roughly x ±280, z ±244, y -23..85 (meters).
// Keep a margin so edge buildings stay visible, and drop the skyline backdrop beyond it.
export const CROP = { x: 300, z: 265, yMin: -60, yMax: 140 };
export const inCrop = (x, y, z) => Math.abs(x) <= CROP.x && Math.abs(z) <= CROP.z && y >= CROP.yMin && y <= CROP.yMax;

// Source units (inches, Z-up) -> export frame (meters, Y-up), matching the physics glTF transforms.
export const S2M = 0.0254;
export const toGL = (o) => [o[1] * S2M, o[2] * S2M, o[0] * S2M];
