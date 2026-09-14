# Deploy and verify

Every step below has the command and the expected output. Nothing here needs a
real upstream API key.

## Prerequisites

- Docker (engine + compose plugin)
- A machine with port 3101/3102 free for the demo, or 3001 for production

## Demo (zero key, ~2 minutes)

### 1. Start the demo stack

```bash
docker compose -f demo/docker-compose.yml up -d
```

Expected output: lines ending in `Started`/`Started` for the `seed`, `gateway`,
and `mock-upstream` containers (first run also builds the gateway image, which
takes a minute or two). Exit code 0. If you see
`Cannot connect to the Docker daemon`, start Docker first.

The seed container exits after finishing (`docker compose ps` shows it as
`Exited (0)`) — that is normal: it pre-configures the provider, routes, and a
client key, then fills the database with 7 days of sample usage.

### 2. Check the console

Open http://127.0.0.1:3101/console and enter token `demo-admin-token`.

Expected output: KPI cards with non-zero requests/cost, a 7-day trend chart,
a per-provider routing table, and at least one error event (the seed plants a
sample one). If the page is empty, confirm the token and check
`docker compose -f demo/docker-compose.yml logs seed`.

### 3. Send a request through the gateway

```bash
curl -sN http://127.0.0.1:3101/v1/chat/completions \
  -H "Authorization: Bearer sk-demo" \
  -H "Content-Type: application/json" \
  -d '{"model":"fast-model","messages":[{"role":"user","content":"hi"}]}'
```

Expected output: a streaming `text/event-stream` of
`chat.completion.chunk` frames ending with `data: [DONE]`, containing the
phrase `Hello from the mock upstream.` and a final frame carrying
`usage: {prompt_tokens: 12, completion_tokens: 6, total_tokens: 18}`.
The console KPI count increases after this request.

### 4. Idempotency check (optional)

```bash
docker compose -f demo/docker-compose.yml run --rm seed
```

Expected output: seed completes without errors and the console data volume
does not double (the seed clears and re-inserts the same fixed dataset).

### 5. Stop and clean up

```bash
docker compose -f demo/docker-compose.yml down -v
```

Expected output: the `bunway-demo` containers and the `data` volume are
removed. The demo binds ports to `127.0.0.1` only; nothing listens on your
LAN.

## Production deploy

### 1. Get the code

```bash
git clone https://github.com/35iter-cn/bunway
cd bunway
```

Expected output: a checkout containing `Dockerfile`,
`deploy/docker-compose.service.yml`, `apps/`.

### 2. Configure the admin token

```bash
printf 'GATEWAY_ADMIN_TOKEN=change-me-to-a-long-random-string\n' > .env
```

Expected output: no output, exit code 0.

### 3. Start the gateway

```bash
docker compose -f deploy/docker-compose.service.yml up -d --build
```

Expected output: the image builds (pnpm dashboard build, bun gateway build),
then `Container <project>-gateway-1  Started`. Exit code 0. On first start the
compose file creates a `gateway-data` directory next to the repo root and the
container runs as uid 1000; if you see permission errors on `/data`, run
`sudo chown -R 1000:1000 gateway-data` and start again.

### 4. Create a client key

```bash
curl -s http://localhost:3001/admin/keys \
  -H "Authorization: Bearer change-me-to-a-long-random-string" \
  -H "Content-Type: application/json" \
  -d '{"name":"first-key","key":"sk-my-key"}'
```

Expected output: `{"ok":true,...}`. Client keys are what callers authenticate
with (`Authorization: Bearer sk-my-key`); the admin token is only for
`/admin/*` and the console.

### 5. Add an upstream provider and route

```bash
curl -s http://localhost:3001/admin/providers \
  -H "Authorization: Bearer change-me-to-a-long-random-string" \
  -H "Content-Type: application/json" \
  -d '{
    "name":"my-upstream",
    "base_url":"https://api.openai.com",
    "api_key":"sk-...",
    "routes":[{"gateway_model":"gpt-4o-mini","provider_model":"gpt-4o-mini","priority":10,
      "pricing":{"default":{"price_input":0.15,"price_output":0.6,"price_cache_read":0.075,"price_cache_write":0}}}]
  }'
```

Expected output: `{"ok":true,"id":1}`. Pricing is USD per million tokens.

### 6. Verify end to end

```bash
curl -s http://localhost:3001/v1/models -H "Authorization: Bearer sk-my-key"
curl -sN http://localhost:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-my-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}'
```

Expected output: the first call returns
`{"object":"list","data":[{"id":"gpt-4o-mini","object":"model","owned_by":"bunway"}]}`;
the second streams chat completions. The console
(http://localhost:3001/console) now shows real usage and cost for this route.

## Security notes

- The admin port (everything under `/admin/*` plus `/console`) is intended for
  a trusted network. Do not expose it directly to the public internet; use an
  SSH tunnel or an authenticating reverse proxy if you must reach it remotely.
- `/console` serves the dashboard HTML without authentication by design (the
  admin token is entered in-page and used for data calls). This is intentional,
  not a vulnerability.
- See [SECURITY.md](../SECURITY.md) for disclosure contact.