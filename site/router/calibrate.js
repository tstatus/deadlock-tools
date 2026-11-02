// Fits movement-model weights to routes timed in game.
//
// Each sample is {x: feature vector, seconds}. Features come from the stamina simulation of the
// route: meters run, meters covered by dash-slides and down dashes, the other move components,
// and boxes broken. Predicted time = x · w. Stamina waits and spawn waits are subtracted from
// the measured time before fitting.
//
// A few timed runs can't separate every weight (every run breaks a box, most include some
// running), so a weight is only fitted when at least one run spends a real share of its time
// on that feature; the rest keep their current values until runs that test them come in.
import { C } from "./nav-core.js";

export const FEATURES = ["run m", "ramp up m", "jumps", "jump height m", "drop m", "zip m", "latches", "rope m", "fixed s", "dash m", "down-dash m", "boxes"];
export const NF = FEATURES.length;
const DASH = 9, DOWN = 10, BOXES = 11;
const MIN_SHARE = 0.25; // a run must spend this share of its time on a feature to fit it

// legStats: [{comps, sim: {runM, dashM, downDashM}}], boxes: number of boxes broken
export function featuresOf(legStats, boxes) {
  const x = new Float64Array(NF);
  for (const { comps, sim } of legStats) {
    for (let j = C.rampUp; j <= C.fixed; j++) x[j] += comps[j];
    // every horizontal meter not covered by a dash-slide, including the air time of gap jumps and drops
    // zipline exit momentum is covered at dash speed, like a dash-slide
    x[0] += comps[C.walk] - sim.dashM - (sim.carryM ?? 0); x[DASH] += sim.dashM + (sim.carryM ?? 0);
    x[C.drop] -= sim.downDashM ?? 0; x[DOWN] += sim.downDashM ?? 0;
  }
  x[BOXES] = boxes;
  return x;
}

// Samples recorded before down dashes were modeled had 11 features; their drops were taken
// with down dashes, so move them to the down-dash slot.
export function upgradeSample(s) {
  if (s.x.length === NF) return s;
  const x = [...s.x];
  x.splice(DOWN, 0, x[C.drop]);
  x[C.drop] = 0;
  return { ...s, x };
}

export function weightsOf(p) {
  return Float64Array.from([1 / p.runSpeed, p.rampCost, p.jumpTime, p.climbCost, p.dropCost, 1 / p.zipSpeed, p.latchTime, 1 / p.ropeSpeed, p.fixedScale, 1 / p.dashSpeed, p.downDashCost, p.breakTime]);
}

export function paramsOf(w, base) {
  return {
    ...base,
    runSpeed: 1 / w[0], rampCost: w[1], jumpTime: w[2], climbCost: w[3], dropCost: w[4],
    zipSpeed: 1 / w[5], latchTime: w[6], ropeSpeed: 1 / w[7], fixedScale: w[8], dashSpeed: 1 / w[DASH],
    downDashCost: w[DOWN], breakTime: w[BOXES],
  };
}

function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}

// samples: [{x, seconds}], w0: current weights.
// Returns {w, before, after, fitted: [feature names]} (before/after are RMS errors in seconds).
export function fit(samples, w0, strength = 0.1) {
  samples = samples.map(upgradeSample);
  const pred = (s, w) => s.x.reduce((t, x, k) => t + x * w[k], 0);
  // which weights the runs actually test
  const fixed = new Map();
  for (let k = 0; k < NF; k++) {
    const share = Math.max(0, ...samples.map((s) => (s.x[k] * w0[k]) / Math.max(pred(s, w0), 1e-6)));
    if (share < MIN_SHARE) fixed.set(k, w0[k]);
  }
  const fittedSet = [...Array(NF).keys()].filter((k) => !fixed.has(k));
  const lo = Array.from(w0, (v) => v * 0.25), hi = Array.from(w0, (v) => v * 4);
  let w = Array.from(w0);
  for (let iter = 0; iter < NF; iter++) {
    const free = [...Array(NF).keys()].filter((k) => !fixed.has(k));
    if (!free.length) break;
    const A = free.map(() => new Array(free.length).fill(0)), b = new Array(free.length).fill(0);
    for (const s of samples) {
      let rest = s.seconds;
      for (const [k, v] of fixed) rest -= s.x[k] * v;
      free.forEach((k, i) => { b[i] += s.x[k] * rest; free.forEach((l, j) => (A[i][j] += s.x[k] * s.x[l])); });
    }
    // light pull toward the current value keeps a barely-determined weight sensible
    free.forEach((k, i) => {
      const mean = samples.reduce((a, s) => a + s.x[k] * s.x[k], 0) / samples.length;
      const lam = strength * mean; A[i][i] += lam; b[i] += lam * w0[k];
    });
    const sol = solveLinear(A, b);
    w = Array.from(w0);
    for (const [k, v] of fixed) w[k] = v;
    free.forEach((k, i) => (w[k] = sol[i]));
    const bad = free.filter((k) => w[k] < lo[k] || w[k] > hi[k]);
    if (!bad.length) break;
    for (const k of bad) fixed.set(k, Math.min(hi[k], Math.max(lo[k], w[k])));
  }
  const rms = (ww) => Math.sqrt(samples.reduce((a, s) => a + (pred(s, ww) - s.seconds) ** 2, 0) / Math.max(samples.length, 1));
  return { w: Float64Array.from(w), before: rms(w0), after: rms(w), fitted: fittedSet.map((k) => FEATURES[k]) };
}
