# Deploy and verify

Production deploy: one container, real upstreams. Verification is the same
script everywhere — `demo/smoke.sh`.

No API key yet? Start the same stack with the bundled demo provider
(`--profile demo`) and register it as an upstream — the exact compose command
and provider JSON are in [llms.txt](../llms.txt) task 2. Same deployment, no
second environment.

## Production

```bash
git clone https://github.com/35iter-cn/bunway && cd bunway
mkdir -p gateway-data
printf 'GATEWAY_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" > deploy/.env
docker compose -f deploy/docker-compose.service.yml up -d --build
```

expect: image builds (pnpm dashboard build + bun gateway build), then
`Container <project>-gateway-1 Started`.

Compose reads `.env` from `deploy/`, not the repo root. Everything the container
keeps lives in `/data`, bound to `gateway-data/` next to the repo root:
`gateway.db` (providers, routes, keys, usage) and
`logs/error-YYYY-MM-DD.log` (7-day retention). Create that directory first —
the container runs as uid 1000, and Docker would otherwise create the bind
mount as root, so the gateway exits with `data dir /data not writable`. If the
host user is not uid 1000: `sudo chown -R 1000:1000 gateway-data`.

Env vars and their defaults: `ADMIN_TOKEN` (required), `PORT` (`3001`),
`DB_PATH` (`data/gateway.db`; `/data/gateway.db` in the image), `STATIC_DIR`
(`./static`; `/app/static` in the image), `LOG_DIR` (`/data/logs`). Source of
truth: `apps/gateway/src/index.ts` and `apps/gateway/src/tester.ts`.

## Configure it

Four tasks, each with the exact call and a done-signal: see
[llms.txt](../llms.txt) — deploy, upstream provider, gateway routes, client.
Field-by-field semantics: [gateway.md](gateway.md).

## Verify

```bash
bash demo/smoke.sh http://localhost:3001 <admin-token> <client-key>
```

expect: `smoke passed`. It checks `/health`, `/console`, a rejected admin token,
the real admin token, `/v1/models` with the client key, and one real chat
request (`max_tokens: 4`) through the configured model. Any failure exits
non-zero and prints which check broke.

## Security notes

- The admin port (everything under `/admin/*` plus `/console`) is meant for a
  trusted network. The gateway listens on every interface by design so LAN
  clients can reach `/v1`; put an authenticating reverse proxy or tunnel in
  front before any public exposure.
- `/console` serves its HTML without authentication on purpose — the admin
  token is entered in-page and used for data calls. Not a vulnerability.
- Provider keys and client keys are write-only on the admin API.
- Disclosure contact: [SECURITY.md](../SECURITY.md).
