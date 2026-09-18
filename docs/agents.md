# Connecting agents and clients

Ready-to-use configurations for pointing coding agents and OpenAI SDK clients
at a running bunway gateway. This page is written for both humans and coding
agents: every snippet is complete and copy-pasteable, with the exact file to
edit and the expected outcome.

Prerequisites (from [deploy.md](deploy.md)): a running gateway, an **admin
token**, and a **client key** (create one via `POST /admin/keys`). If your
upstream requires specific headers, also configure the provider's `meta` per
[gateway.md](gateway.md#headers-the-upstream-requires).

Every snippet below uses these placeholders:

| Placeholder | Meaning |
|---|---|
| `http://GATEWAY_HOST:3001` | Where your gateway runs (e.g. `http://localhost:3001`) |
| `sk-your-client-key` | A client key created via the admin API |
| `your-model` | A `gateway_model` you configured on a route |

## Generic OpenAI SDK

The gateway is OpenAI-compatible: change base URL and key, nothing else.

**Python**

```python
from openai import OpenAI

client = OpenAI(base_url="http://GATEWAY_HOST:3001/v1", api_key="sk-your-client-key")
stream = client.chat.completions.create(
    model="your-model",
    messages=[{"role": "user", "content": "hi"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

**JavaScript / TypeScript**

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://GATEWAY_HOST:3001/v1", apiKey: "sk-your-client-key" });
const stream = await client.chat.completions.create({
  model: "your-model",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

**curl**

```bash
curl -sN http://GATEWAY_HOST:3001/v1/chat/completions \
  -H "Authorization: Bearer sk-your-client-key" \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model","messages":[{"role":"user","content":"hi"}]}'
```

Expected: a streaming SSE of `chat.completion.chunk` frames ending with
`data: [DONE]`.

## Pi coding agent

Edit `~/.pi/agent/models.json` — add a provider entry and list the gateway
models you want selectable:

```json
{
  "providers": {
    "bunway": {
      "name": "bunway gateway",
      "baseUrl": "http://GATEWAY_HOST:3001/v1",
      "apiKey": "sk-your-client-key",
      "api": "openai-completions",
      "compat": { "supportsDeveloperRole": false },
      "models": [
        {
          "id": "your-model",
          "name": "Your Model",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 128000,
          "maxTokens": 65536,
          "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.006, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

Field notes for agents editing this file:

- `api` must be `openai-completions` (the gateway speaks chat completions)
- `compat.supportsDeveloperRole: false` — the gateway's upstreams reject the
  OpenAI `developer` role; this makes pi use `system` instead
- `models[].id` must match a `gateway_model` on one of your routes; `cost`
  is USD per million tokens and is display-only (the gateway bills its own
  SQLite numbers)
- restart pi after editing; the model appears in the session model list

If your provider was configured with `forward_headers` (see
[gateway.md](gateway.md#headers-the-upstream-requires)), the client must send
those headers. For pi, an extension is the reliable way — create
`~/.pi/agent/extensions/session-header.ts`:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_headers", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    if (sessionId) event.headers["x-opencode-session"] = sessionId;
  });
}
```

This sends the pi session id as `x-opencode-session` on every request —
stable within a session, unique across sessions, which upstreams that use the
header as a cache key expect.

## Hermes Agent

Edit `~/.hermes/config.yaml`:

```yaml
model:
  default: your-model
  provider: custom:bunway

providers:
  bunway:
    api: http://GATEWAY_HOST:3001/v1
    context_length: 128000
    default_model: your-model
    key_env: BUNWAY_API_KEY
```

And put the client key in `~/.hermes/.env`:

```bash
BUNWAY_API_KEY=sk-your-client-key
```

Field notes for agents editing these files:

- `model.provider` must be `custom:<providers key>` — without the `custom:`
  prefix Hermes skips named-provider resolution
- `api` points at the gateway root including `/v1`; `api_mode` may be omitted
  (Hermes derives `chat_completions` from the URL)
- `key_env` is required: Hermes does not derive a key for loopback URLs, and
  a missing key resolves to `no-key-required` → HTTP 401
- auxiliary calls (title generation, compression) go through the same
  provider; if the upstream rejects structured output (`json_schema`), point
  auxiliary tasks at a model that supports it or disable title generation

If the upstream needs a fixed session header for auxiliary calls that bypass
request middleware, add a static fallback:

```yaml
model:
  default_headers:
    x-opencode-session: hermes-static
```

For per-session ids in tool loops, use a Hermes plugin with an `llm_request`
middleware that sets `extra_headers` (or the gateway-side `extra_headers`
static value from [gateway.md](gateway.md#headers-the-upstream-requires) when
one fixed value per provider is acceptable).

## Verifying any client

After configuring, confirm the full chain from outside:

```bash
curl -s http://GATEWAY_HOST:3001/v1/models -H "Authorization: Bearer sk-your-client-key"
```

Expected: `{"object":"list","data":[{"id":"your-model",...,"owned_by":"bunway"}]}`,
then send a chat request from the client itself and check
`GET /admin/stats` (admin token) shows the request counted and billed.