// Route ordering on a precomputed travel-time matrix D (row-major n×n, node 0 = start,
// D[i*n+j] = seconds from i to j including breaking j). Asymmetric: climbing costs more
// than dropping. Optional time windows: ready[j] = seconds after the route starts when box j
// has spawned; arriving earlier means waiting.

const END = -1;
const edge = (D, n, back) => (a, b) => (b === END ? (back ? back[a] : 0) : D[a * n + b]);

function tourCost(t, D, n, back) {
  let c = 0;
  for (let i = 1; i < t.length; i++) c += D[t[i - 1] * n + t[i]];
  if (back) c += back[t[t.length - 1]];
  return c;
}

// Time including waits for boxes that have not spawned yet.
export function simulate(t, D, n, back, ready) {
  let time = 0, wait = 0;
  for (let i = 1; i < t.length; i++) {
    time += D[t[i - 1] * n + t[i]];
    const r = ready ? ready[t[i]] : 0;
    if (time < r) { wait += r - time; time = r; }
  }
  if (back) time += back[t[t.length - 1]];
  return { time, wait };
}

function nearestNeighbor(D, n, nodes) {
  const left = new Set(nodes), t = [0];
  while (left.size) {
    const last = t[t.length - 1];
    let best = -1, bc = Infinity;
    for (const j of left) if (D[last * n + j] < bc) { bc = D[last * n + j]; best = j; }
    if (best < 0) break;
    t.push(best); left.delete(best);
  }
  return t;
}

// 2-opt (segment reversal) and Or-opt (move a run of 1-3 stops) with O(1) deltas. The tour
// carries an END sentinel whose incoming edge is 0 (open path) or the trip back (loop).
function improve(t0, D, n, back, deadline) {
  const d = edge(D, n, back);
  const t = [...t0, END], m = t.length;
  const fwd = new Float64Array(m), bwd = new Float64Array(m);
  const prefix = () => {
    for (let i = 1; i < m - 1; i++) {
      fwd[i] = fwd[i - 1] + D[t[i - 1] * n + t[i]];
      bwd[i] = bwd[i - 1] + D[t[i] * n + t[i - 1]];
    }
  };
  let improved = true;
  while (improved && performance.now() < deadline) {
    improved = false;
    prefix();
    for (let i = 1; i < m - 2; i++) {
      for (let k = i + 1; k < m - 1; k++) {
        const before = d(t[i - 1], t[i]) + d(t[k], t[k + 1]) + (fwd[k] - fwd[i]);
        const after = d(t[i - 1], t[k]) + d(t[i], t[k + 1]) + (bwd[k] - bwd[i]);
        if (after < before - 1e-9) {
          for (let a = i, b = k; a < b; a++, b--) [t[a], t[b]] = [t[b], t[a]];
          prefix();
          improved = true;
        }
      }
      if (performance.now() > deadline) break;
    }
    for (let len = 1; len <= 3; len++) {
      for (let i = 1; i + len < m; i++) {
        const a = t[i - 1], s0 = t[i], s1 = t[i + len - 1], b = t[i + len];
        const gain = d(a, s0) + d(s1, b) - d(a, b);
        let bestJ = -1, bestAdd = gain - 1e-9;
        for (let j = 0; j < m - 1; j++) {
          if (j >= i - 1 && j <= i + len - 1) continue;
          const add = d(t[j], s0) + d(s1, t[j + 1]) - d(t[j], t[j + 1]);
          if (add < bestAdd) { bestAdd = add; bestJ = j; }
        }
        if (bestJ < 0) continue;
        const seg = t.splice(i, len);
        t.splice(bestJ < i ? bestJ + 1 : bestJ + 1 - len, 0, ...seg);
        improved = true;
      }
    }
  }
  return t.slice(0, -1);
}

// With spawn timers, re-place single stops using the full simulation (waits included).
function improveWindows(t, D, n, back, ready, deadline) {
  if (t.length > 220) return t;
  let best = simulate(t, D, n, back, ready).time, improved = true;
  while (improved && performance.now() < deadline) {
    improved = false;
    for (let i = 1; i < t.length; i++) {
      const s = t[i], rest = t.slice(0, i).concat(t.slice(i + 1));
      for (let j = 1; j <= rest.length; j++) {
        if (j === i) continue;
        const cand = rest.slice(0, j).concat(s, rest.slice(j));
        const c = simulate(cand, D, n, back, ready).time;
        if (c < best - 1e-6) { t = cand; best = c; improved = true; break; }
      }
      if (performance.now() > deadline) break;
    }
  }
  return t;
}

// Time-limited: greedy cheapest insertion by value per added second, tightened as it grows.
function orienteer(D, n, values, budget, back, ready, deadline) {
  const d = edge(D, n, back);
  let t = [0];
  const left = new Set(Array.from({ length: n - 1 }, (_, i) => i + 1));
  for (;;) {
    const base = tourCost(t, D, n, back), tt = [...t, END];
    let pick = null;
    for (const j of left) {
      if (!(values[j] > 0)) continue;
      for (let pos = 1; pos < tt.length; pos++) {
        const add = d(tt[pos - 1], j) + d(j, tt[pos]) - d(tt[pos - 1], tt[pos]);
        if (!Number.isFinite(add) || base + add > budget) continue;
        const ratio = values[j] / Math.max(add, 1e-3);
        if (!pick || ratio > pick.ratio) pick = { ratio, pos, j };
      }
    }
    if (!pick) break;
    t.splice(pick.pos, 0, pick.j);
    left.delete(pick.j);
    if (t.length % 8 === 0) t = improve(t, D, n, back, deadline);
  }
  t = improve(t, D, n, back, deadline);
  if (ready) {
    t = improveWindows(t, D, n, back, ready, deadline);
    // waiting may push it over the limit: drop the stop worth least per second it costs
    while (t.length > 1 && simulate(t, D, n, back, ready).time > budget) {
      let worst = -1, wr = Infinity;
      for (let i = 1; i < t.length; i++) {
        const without = t.slice(0, i).concat(t.slice(i + 1));
        const saved = simulate(t, D, n, back, ready).time - simulate(without, D, n, back, ready).time;
        const r = values[t[i]] / Math.max(saved, 1e-3);
        if (r < wr) { wr = r; worst = i; }
      }
      t.splice(worst, 1);
    }
  }
  return t;
}

// Returns indices (1..n-1) in visiting order.
// opts: {mode: "all"|"budget", budget, values[], back (Float64Array n: time from node to start, for loops), ready}
export function solve(D, n, opts) {
  if (n <= 1) return [];
  const deadline = performance.now() + 5000;
  let t;
  if (opts.mode === "budget") t = orienteer(D, n, opts.values, opts.budget, opts.back, opts.ready, deadline);
  else {
    t = improve(nearestNeighbor(D, n, Array.from({ length: n - 1 }, (_, i) => i + 1)), D, n, opts.back, deadline);
    if (opts.ready) t = improveWindows(t, D, n, opts.back, opts.ready, deadline);
  }
  return t.slice(1);
}
