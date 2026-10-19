# Connecting agents and clients

Every snippet is complete and copy-pasteable. Configure providers and routes
first — see [llms.txt](../llms.txt) tasks 2 and 3.

Placeholders: `http://GATEWAY_HOST:3001` (where the gateway runs),
`sk-your-client-key` (created via `POST /admin/keys`), `your-model` (a
`gateway_model` with at least one route).

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

Expect a streaming SSE of `chat.completion.chunk` frames ending with
`data: [DONE]`.

## Pi coding agent

Verified against pi 1.3.0. Edit `~/.pi/agent/models.json`:

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

- `api` must be `openai-completions` (the gateway speaks chat completions).
- `compat.supportsDeveloperRole: false` — send `system` instead of the OpenAI
  `developer` role, which upstreams reject.
- `models[].id` must match a `gateway_model`; `cost` is USD per million tokens
  and only feeds pi's own display (the gateway bills from SQLite).
- Restart pi; the model appears in the session model list.

If the provider was configured with `forward_headers`, the client must send
those headers. In pi, an extension is the reliable way — for example
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

## Hermes Agent

Hermes works through the same OpenAI-compatible surface: a `custom:<name>`
provider entry with `api: http://GATEWAY_HOST:3001/v1` (including `/v1`), a
`key_env` pointing at the client key, and `model.provider: custom:bunway`.
Unlike pi, Hermes does not derive a key for loopback URLs, so `key_env` is
mandatory. Auxiliary calls (title generation, compression) use the same provider.

## Verifying any client

```bash
curl -s http://GATEWAY_HOST:3001/v1/models -H "Authorization: Bearer sk-your-client-key"
```

Expect every configured `gateway_model`. Then send one request from the client
itself and confirm `GET /admin/stats` counts it, or run
`bash demo/smoke.sh http://GATEWAY_HOST:3001 <admin-token> <client-key>`.
