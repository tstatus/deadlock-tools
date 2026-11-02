// Precomputes box-to-box travel components for the default movement settings, for normal
// heroes and for tunnel heroes, so the app opens with routes ready. The app recomputes in a
// worker when a setting that changes which moves exist is different from these.
//
// Usage: node tools/build-matrix.mjs <data dir>
import fs from "node:fs";
import path from "node:path";
import { loadNav, buildMatrix, DEFAULT_PARAMS, structuralKey, NC } from "../public/nav-core.js";

const dataDir = process.argv[2];
if (!dataDir) { console.error("usage: node build-matrix.mjs <data dir>"); process.exit(1); }
const b = fs.readFileSync(path.join(dataDir, "nav.bin"));
const g = loadNav(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
const nav = JSON.parse(fs.readFileSync(path.join(dataDir, "nav.json"), "utf8"));
const pts = nav.boxes.map((x) => (x.tri >= 0 ? { tri: x.tri, point: x.navPoint } : null));

const out = {};
for (const [name, extra] of [["normal", { useTunnels: false }], ["tunnel", { useTunnels: true }]]) {
  const params = { ...DEFAULT_PARAMS, ...extra };
  const t0 = Date.now();
  const M = buildMatrix(g, pts.map((p) => p ?? { tri: -1 }), params, (i, B) => {
    if (i % 100 === 0) console.log(`  ${name}: ${i}/${B}`);
  });
  fs.writeFileSync(path.join(dataDir, `matrix-${name}.bin`), Buffer.from(M.buffer));
  let reach = 0;
  for (let i = 0; i < M.length; i += NC) if (!Number.isNaN(M[i])) reach++;
  out[name] = { key: structuralKey(params), file: `matrix-${name}.bin`, reachablePairs: reach };
  console.log(`${name}: ${pts.length}² pairs, ${reach} reachable, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
fs.writeFileSync(path.join(dataDir, "matrix.json"), JSON.stringify({ boxes: pts.length, nc: NC, matrices: out }, null, 1));
