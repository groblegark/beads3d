# beads3d

Interactive 3D visualization of beads issues using `3d-force-graph`.

## Setup

```bash
npm install
npm run dev   # starts vite on http://localhost:3333
```

## Environment

Connection to the beads daemon is configured via `.env` (untracked, contains secrets):

```
VITE_BD_API_URL=https://gastown-next.app.e2e.dev.fics.ai
VITE_BD_TOKEN=<bearer token>
```

The daemon env vars are available in the shell as `BD_DAEMON_HOST` and `BD_DAEMON_TOKEN`.
Copy them to `.env` with the `VITE_` prefix for Vite to pick them up.

You can also override via URL params: `?api=http://localhost:9080&token=xyz`

## Tech Stack

- `3d-force-graph` v1.79+ — Three.js-based 3D force-directed graph
- `three` — WebGL rendering, bloom post-processing
- `vite` — dev server + build

## API

Connects to beads daemon HTTP API (Connect-RPC JSON):
- `POST /bd.v1.BeadsService/List` — fetch all issues
- `POST /bd.v1.BeadsService/Stats` — project statistics
- `GET /events` — SSE live updates

## Design Vision

Biological cell metaphor:
- Beads = vacuoles floating in cytoplasm
- Agents = ribosomes attaching and processing
- Dependencies = structural connections
- Completed work = chromatin flowing toward nucleus (codebase)
- Cell membrane = fleet boundary
