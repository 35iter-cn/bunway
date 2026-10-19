# bunway agent guide

Configuring or deploying this gateway? Start at `llms.txt` — it holds the four
tasks (deploy, upstream provider, routes, client) with exact calls and a
verification script. This file covers the repo itself.

## Layout

- `apps/gateway` — gateway core: plain TypeScript on Bun, zero npm runtime
  dependencies (`bun:sqlite`, `Bun.serve`), entry `src/index.ts`
- `apps/dashboard` — Svelte 5 + Vite + uPlot console, built to static files
  served by the gateway at `/console`
- `deploy/` — production compose; `demo/` — zero-key demo stack
- pnpm workspaces + turbo monorepo

## Commands

- Gateway tests: `cd apps/gateway && bun test`
- Smoke the running gateway: `bash demo/smoke.sh <base_url> <admin_token> <client_key> [model]`
- Console build: `pnpm --filter dashboard build`
- Full build: `pnpm turbo build`

## Conventions

- No comments anywhere in the code; write self-explanatory code instead
- Zero npm runtime dependencies in the gateway (Bun built-ins only)
- Model/provider/route management goes through the admin API (`/admin/*`).
  Never mutate the SQLite database directly; it is read-only for inspection
- Dashboard font sizes use the five-step rem scale defined in App.svelte
- Never commit private paths, hostnames, LAN addresses, or real API keys;
  `data/`, `logs/`, and `.env` are gitignored

## Security

Admin endpoints and `/console` are for trusted networks only — never expose
them directly to the public internet.