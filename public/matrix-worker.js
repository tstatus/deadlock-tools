// Recomputes the box-to-box component matrix off the main thread when a movement setting
// changes which moves exist (max jump height, hero type, zipline/rope/pad/teleporter use).
import { loadNav, buildMatrix } from "./nav-core.js";

let g = null;
self.onmessage = (e) => {
  const { navBuffer, pts, params, id } = e.data;
  if (navBuffer) g = loadNav(navBuffer);
  const M = buildMatrix(g, pts, params, (i, B) => { if (i % 20 === 0) self.postMessage({ id, progress: i / B }); });
  self.postMessage({ id, matrix: M }, [M.buffer]);
};
