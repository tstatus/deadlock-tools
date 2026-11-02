# Deadlock Tools

Browser-based planning tools for Deadlock.

| Tool | Page | Docs |
|---|---|---|
| Box Router: 3D farming route planner for `dl_midtown` | `site/router/` | [docs/router.md](docs/router.md) |
| Build Calculator | not started | |

## Run

Double-click **Start.bat**, or run `node server.mjs` in this folder, then open http://localhost:5178.
You need [Node.js](https://nodejs.org). There is no build step or install.

## Layout

- `site/`: everything that gets published. Each tool has its own folder and page.
- `site/shared/`: styles and code used by more than one tool.
- `tools/`: scripts that generate each tool's data from game exports. Not published.
- `docs/`: documentation and calibration samples.

Pages use relative links so the site also works from a subfolder, such as GitHub Pages.
