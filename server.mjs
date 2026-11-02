// Minimal static file server for the site (no dependencies).
// Usage: node server.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "site");
const port = Number(process.argv[2] ?? 5178);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".bin": "application/octet-stream",
};

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  let file = path.join(root, url);
  if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  // folders serve their index.html; /router redirects to /router/ so relative links resolve
  if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) {
    if (!url.endsWith("/")) { res.writeHead(301, { Location: `${url}/` }).end(); return; }
    file = path.join(file, "index.html");
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream", "Content-Length": st.size });
    fs.createReadStream(file).pipe(res);
  });
}).listen(port, "127.0.0.1", () => console.log(`Deadlock Tools: http://localhost:${port}`));
