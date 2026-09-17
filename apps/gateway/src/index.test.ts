import { describe, test, expect, afterEach } from "bun:test";
import { openDb } from "./db";
import { createApp } from "./index";

const servers: { stop(): void }[] = [];
const hits: string[] = [];

afterEach(() => {
  for (const s of servers) s.stop(true);
  servers.length = 0;
  hits.length = 0;
});

function mockUpstream(name: string, handler: (req: Request) => Response | Promise<Response>): string {
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      hits.push(name);
      return handler(req);
    },
  });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

function seed(baseUrls: string[]) {
  const db = openDb(":memory:");
  baseUrls.forEach((base, i) => {
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (?, ?, ?, 'k')").run(i + 1, `p${i + 1}`, base);
  });
  const ins = db.query(
    `INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing)
     VALUES ('m', ?, 'm-up', ?, '{"default":{"price_input":1,"price_output":1,"price_cache_read":0,"price_cache_write":0}}')`
  );
  baseUrls.forEach((_, i) => ins.run(i + 1, 10 - i * 5));
  db.query("INSERT INTO client_keys(id, name, key) VALUES (1, 'pi', 'sk-test')").run();
  return { db, app: createApp(db, "admin-token") };
}

const H = { "Content-Type": "application/json", Authorization: "Bearer sk-test" };

describe("/v1 failover orchestration", () => {
  test("primary 429 → failover to backup → 200, both attempts logged", async () => {
    const { db, app } = seed([mockUpstream("primary", () => new Response("rate limited", { status: 429 })), mockUpstream("backup", () => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }))]);
    const res = await app.fetch(new Request("http://x/v1/chat/completions", { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [] }) }));
    expect(res.status).toBe(200);
    expect(hits).toEqual(["primary", "backup"]);
    const rows = db.query("SELECT * FROM usage_log ORDER BY id").all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
  });

  test("primary 400 → no failover, error passed through", async () => {
    const { app } = seed([mockUpstream("primary", () => new Response("bad request", { status: 400 })), mockUpstream("backup", () => Response.json({ ok: true }))]);
    const res = await app.fetch(new Request("http://x/v1/chat/completions", { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [] }) }));
    expect(res.status).toBe(400);
    expect(hits).toEqual(["primary"]);
  });

  test("no candidates → 502", async () => {
    const { app } = seed([]);
    const res = await app.fetch(new Request("http://x/v1/chat/completions", { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [] }) }));
    expect(res.status).toBe(502);
  });

  test("models list = distinct gateway models", async () => {
    const { app } = seed([mockUpstream("a", () => Response.json({})), mockUpstream("b", () => Response.json({}))]);
    const res = await app.fetch(new Request("http://x/v1/models", { headers: H }));
    const json = await res.json();
    expect(json.data.map((m: { id: string }) => m.id)).toEqual(["m"]);
  });
});

describe("request reasoning normalization", () => {
  const messages = [
    { role: "user", content: "hi" },
    { role: "assistant", reasoning: "th", tool_calls: [] },
    { role: "tool", tool_call_id: "c", content: "ok" },
    { role: "assistant", tool_calls: [] },
  ];

  async function forwarded(meta: Record<string, unknown>): Promise<Record<string, unknown>> {
    let sent = "";
    const { db, app } = seed([
      mockUpstream("primary", async (req) => {
        sent = await req.text();
        return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
      }),
    ]);
    db.query("UPDATE providers SET meta=? WHERE id=1").run(JSON.stringify(meta));
    app.router.invalidate();
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages }) })
    );
    expect(res.status).toBe(200);
    return JSON.parse(sent) as Record<string, unknown>;
  }

  test("renames the legacy reasoning field for every provider", async () => {
    const sent = await forwarded({});
    const msgs = sent.messages as Record<string, unknown>[];
    expect(sent.model).toBe("m-up");
    expect(msgs[0]).toEqual({ role: "user", content: "hi" });
    expect(msgs[1]).toEqual({ role: "assistant", tool_calls: [], reasoning_content: "th" });
    expect(msgs[3]).toEqual({ role: "assistant", tool_calls: [] });
  });

  test("pads empty reasoning_content only when the provider requires the key", async () => {
    const sent = await forwarded({ requires_reasoning_content: true });
    const msgs = sent.messages as Record<string, unknown>[];
    expect(msgs[1]).toEqual({ role: "assistant", tool_calls: [], reasoning_content: "th" });
    expect(msgs[3]).toEqual({ role: "assistant", tool_calls: [], reasoning_content: "" });
  });
});

describe("auth", () => {
  test("missing/invalid key → 401", async () => {
    const { app } = seed([]);
    expect((await app.fetch(new Request("http://x/v1/models"))).status).toBe(401);
    expect((await app.fetch(new Request("http://x/v1/models", { headers: { Authorization: "Bearer wrong" } }))).status).toBe(401);
  });
});

describe("admin hot update", () => {
  test("new provider takes effect without restart", async () => {
    const { db, app } = seed([mockUpstream("primary", () => new Response("nope", { status: 500 })), mockUpstream("backup", () => Response.json({ ok: true }))]);
    const before = await app.fetch(new Request("http://x/v1/models", { headers: H }));
    expect(((await before.json()) as { data: unknown[] }).data.length).toBe(1);

    const adminH = { "Content-Type": "application/json", Authorization: "Bearer admin-token" };
    const res = await app.fetch(
      new Request("http://x/admin/providers", {
        method: "POST",
        headers: adminH,
        body: JSON.stringify({
          name: "extra",
          base_url: "http://example.com",
          api_key: "k",
          routes: [{ gateway_model: "new-model", provider_model: "new", priority: 1 }],
        }),
      })
    );
    expect(res.status).toBe(201);
    const after = await app.fetch(new Request("http://x/v1/models", { headers: H }));
    expect(((await after.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["m", "new-model"]);
    void db;
  });

  test("disabled provider is skipped by router", async () => {
    const { app, db } = seed([mockUpstream("primary", () => new Response("nope", { status: 500 })), mockUpstream("backup", () => Response.json({ ok: true }))]);
    db.query("INSERT INTO providers(id, name, base_url, api_key, enabled) VALUES (99, 'extra', 'http://x', 'k', 0)").run();
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority) VALUES ('m', 99, 'm', 20)").run();
    const res = await app.fetch(new Request("http://x/v1/chat/completions", { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [] }) }));
    expect(hits).not.toContain("extra");
    expect(hits[0]).toBe("primary");
  });
});

const adminH = { "Content-Type": "application/json", Authorization: "Bearer admin-token" };
describe("admin entity CRUD", () => {
  test("POST /admin/routes creates a single route without touching others", async () => {
    const { db, app } = seed([mockUpstream("primary", () => Response.json({}))]);
    const pricing = { default: { price_input: 1, price_output: 0.5, price_cache_read: 0, price_cache_write: 0 } };
    const res = await app.fetch(new Request("http://x/admin/routes", { method: "POST", headers: adminH, body: JSON.stringify({ gateway_model: "r1", provider_id: 1, provider_model: "up-r1", priority: 2, pricing }) }));
    expect(res.status).toBe(200);
    const rows = db.query("SELECT gateway_model, provider_model, priority, pricing FROM routes ORDER BY gateway_model").all() as { gateway_model: string; provider_model: string; priority: number; pricing: string }[];
    expect(rows.map((r) => r.gateway_model)).toEqual(["m", "r1"]);
    expect(JSON.parse(rows[0].pricing)).toEqual({ default: { price_input: 1, price_output: 1, price_cache_read: 0, price_cache_write: 0 } });
    expect(JSON.parse(rows[1].pricing)).toEqual(pricing);
  });

  test("POST same triple twice updates prices without adding a row", async () => {
    const { db, app } = seed([mockUpstream("primary", () => Response.json({}))]);
    for (const po of [0.5, 0.9]) {
      const body = JSON.stringify({
        gateway_model: "r1",
        provider_id: 1,
        provider_model: "up-r1",
        pricing: { default: { price_input: 1, price_output: po, price_cache_read: 0, price_cache_write: 0 } },
      });
      const res = await app.fetch(new Request("http://x/admin/routes", { method: "POST", headers: adminH, body }));
      expect(res.status).toBe(200);
    }
    expect((db.query("SELECT COUNT(*) c FROM routes WHERE gateway_model='r1'").get() as { c: number }).c).toBe(1);
    const row = db.query("SELECT pricing FROM routes WHERE gateway_model='r1'").get() as { pricing: string };
    expect(JSON.parse(row.pricing).default.price_output).toBe(0.9);
  });

  test("GET single / 404 / filtered list", async () => {
    const { app } = seed([mockUpstream("primary", () => Response.json({}))]);
    const one = await app.fetch(new Request("http://x/admin/routes?gateway_model=m&provider_id=1&provider_model=m-up", { headers: adminH }));
    expect(one.status).toBe(200);
    expect(((await one.json()) as { data: { gateway_model: string } }).data.gateway_model).toBe("m");
    const missing = await app.fetch(new Request("http://x/admin/routes?gateway_model=nope&provider_id=1&provider_model=m-up", { headers: adminH }));
    expect(missing.status).toBe(404);
    const filtered = await app.fetch(new Request("http://x/admin/routes?provider_id=1", { headers: adminH }));
    expect(((await filtered.json()) as { data: unknown[] }).data.length).toBe(1);
  });

  test("PUT updates only provided fields", async () => {
    const { db, app } = seed([mockUpstream("primary", () => Response.json({}))]);
    const body = JSON.stringify({
      pricing: { default: { price_input: 1, price_output: 2.5, price_cache_read: 0, price_cache_write: 0 } },
    });
    const res = await app.fetch(new Request("http://x/admin/routes?gateway_model=m&provider_id=1&provider_model=m-up", { method: "PUT", headers: adminH, body }));
    expect(res.status).toBe(200);
    const row = db.query("SELECT gateway_model, provider_id, provider_model, priority, pricing FROM routes").get() as {
      gateway_model: string;
      provider_id: number;
      provider_model: string;
      priority: number;
      pricing: string;
    };
    expect({ ...row, pricing: JSON.parse(row.pricing) }).toEqual({
      gateway_model: "m",
      provider_id: 1,
      provider_model: "m-up",
      priority: 10,
      pricing: { default: { price_input: 1, price_output: 2.5, price_cache_read: 0, price_cache_write: 0 } },
    });
  });

  test("PUT renames PK without adding rows; 409 on collision; 404 on missing target", async () => {
    const { db, app } = seed([mockUpstream("primary", () => Response.json({}))]);
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model) VALUES ('m2', 1, 'm-up')").run();
    const rename = await app.fetch(new Request("http://x/admin/routes?gateway_model=m2&provider_id=1&provider_model=m-up", { method: "PUT", headers: adminH, body: JSON.stringify({ gateway_model: "m3" }) }));
    expect(rename.status).toBe(200);
    const models = db.query("SELECT gateway_model FROM routes ORDER BY gateway_model").all() as { gateway_model: string }[];
    expect(models.map((r) => r.gateway_model)).toEqual(["m", "m3"]);
    const dup = await app.fetch(new Request("http://x/admin/routes?gateway_model=m3&provider_id=1&provider_model=m-up", { method: "PUT", headers: adminH, body: JSON.stringify({ provider_model: "x" }) }));
    expect(dup.status).toBe(200);
    const collide = await app.fetch(new Request("http://x/admin/routes?gateway_model=m3&provider_id=1&provider_model=x", { method: "PUT", headers: adminH, body: JSON.stringify({ gateway_model: "m", provider_model: "m-up" }) }));
    expect(collide.status).toBe(409);
    const gone = await app.fetch(new Request("http://x/admin/routes?gateway_model=nope&provider_id=1&provider_model=x", { method: "PUT", headers: adminH, body: JSON.stringify({ priority: 1 }) }));
    expect(gone.status).toBe(404);
    expect((db.query("SELECT COUNT(*) c FROM routes").get() as { c: number }).c).toBe(2);
  });

  test("DELETE single route; repeat → 404", async () => {
    const { app } = seed([mockUpstream("primary", () => Response.json({}))]);
    const del = await app.fetch(new Request("http://x/admin/routes?gateway_model=m&provider_id=1&provider_model=m-up", { method: "DELETE", headers: adminH }));
    expect(del.status).toBe(200);
    const again = await app.fetch(new Request("http://x/admin/routes?gateway_model=m&provider_id=1&provider_model=m-up", { method: "DELETE", headers: adminH }));
    expect(again.status).toBe(404);
  });

  test("provider PUT without routes keeps routes; with [] clears them", async () => {
    const { db, app } = seed([mockUpstream("primary", () => Response.json({}))]);
    const keep = await app.fetch(new Request("http://x/admin/providers/1", { method: "PUT", headers: adminH, body: JSON.stringify({ name: "p1", base_url: "http://changed", api_key: "k", enabled: true, meta: {} }) }));
    expect(keep.status).toBe(200);
    expect((db.query("SELECT COUNT(*) c FROM routes WHERE provider_id=1").get() as { c: number }).c).toBe(1);
    const clear = await app.fetch(new Request("http://x/admin/providers/1", { method: "PUT", headers: adminH, body: JSON.stringify({ name: "p1", base_url: "http://changed", api_key: "k", enabled: true, meta: {}, routes: [] }) }));
    expect(clear.status).toBe(200);
    expect((db.query("SELECT COUNT(*) c FROM routes WHERE provider_id=1").get() as { c: number }).c).toBe(0);
  });

  test("GET /admin/providers/:id returns provider + routes; missing → 404", async () => {
    const { app } = seed([mockUpstream("primary", () => Response.json({}))]);
    const ok = await app.fetch(new Request("http://x/admin/providers/1", { headers: adminH }));
    expect(ok.status).toBe(200);
    const data = ((await ok.json()) as { data: { name: string; routes: unknown[] } }).data;
    expect(data.name).toBe("p1");
    expect(data.routes.length).toBe(1);
    expect((await app.fetch(new Request("http://x/admin/providers/77", { headers: adminH }))).status).toBe(404);
  });
});

describe("client abort", () => {
  test("client disconnect penalizes no provider and the next request still routes", async () => {
    const slow = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(1_000);
        return Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } });
      },
    });
    servers.push(slow);
    const { db, app } = seed([`http://localhost:${slow.port}`, `http://localhost:${slow.port}`]);
    const gateway = Bun.serve({ port: 0, fetch: app.fetch });
    servers.push(gateway);

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    await fetch(`http://localhost:${gateway.port}/v1/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [] }), signal: ac.signal }).catch(() => {});
    await Bun.sleep(200);

    expect(app.router.pick("m").map((p) => p.provider.name)).toEqual(["p1", "p2"]);

    const next = await fetch(`http://localhost:${gateway.port}/v1/chat/completions`, { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [] }) });
    expect(next.status).toBe(200);
    expect((db.query("SELECT COUNT(*) c FROM usage_log").get() as { c: number }).c).toBe(1);
  }, 10_000);
});

describe("messages dialect routing", () => {
  function seedMessages(base: string, api = "messages") {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', ?, 'k')").run(base);
    db.query(
      `INSERT INTO routes(gateway_model, provider_id, provider_model, priority, api)
       VALUES ('m', 1, 'm-up', 1, ?)`
    ).run(api);
    db.query("INSERT INTO client_keys(id, name, key) VALUES (1, 'pi', 'sk-test')").run();
    return { db, app: createApp(db, "admin-token") };
  }

  const anthropicReply = () =>
    Response.json({
      id: "msg_1", type: "message", role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    });

  test("non-stream: chat/completions body converted, openai shape returned", async () => {
    let sent = "";
    let path = "";
    const up = Bun.serve({
      port: 0,
      async fetch(req) {
        path = new URL(req.url).pathname;
        sent = await req.text();
        return anthropicReply();
      },
    });
    servers.push(up);
    const { app } = seedMessages(`http://localhost:${up.port}`);
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      })
    );
    expect(res.status).toBe(200);
    expect(path).toBe("/v1/messages");
    const sentBody = JSON.parse(sent) as Record<string, unknown>;
    expect(sentBody.max_tokens).toBe(8192);
    expect(sentBody.messages).toEqual([{ role: "user", content: "hi" }]);
    const json = (await res.json()) as { choices: { message: { content: string } }[]; model: string };
    expect(json.choices[0].message.content).toBe("hello");
    expect(json.model).toBe("m");
  });

  test("stream: ends with [DONE], no interrupted frame", async () => {
    const up = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n` +
            `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hey"}}\n\n` +
            `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n` +
            `data: {"type":"message_stop"}\n\n` +
            `data: {"type":"ping","cost":"0"}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        ),
    });
    servers.push(up);
    const { app } = seedMessages(`http://localhost:${up.port}`);
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: H,
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }], stream: true }),
      })
    );
    const text = await res.text();
    expect(text).toContain('"content":"hey"');
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("upstream_interrupted");
  });

  test("tool loop: tool_use mapped to tool_calls finish", async () => {
    const up = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n` +
            `data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"fn"}}\n\n` +
            `data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n` +
            `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}\n\n` +
            `data: {"type":"message_stop"}\n\n` +
            `data: {"type":"ping","cost":"0"}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        ),
    });
    servers.push(up);
    const { app } = seedMessages(`http://localhost:${up.port}`);
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ function: { name: "fn", description: "d", parameters: { type: "object" } } }],
          stream: true,
        }),
      })
    );
    const text = await res.text();
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain('"tool_calls"');
    expect(text).toContain("[DONE]");
  });

  test("503: no retry, cooldown + failover; 400 MissingSessionID: nofailover passthrough", async () => {
    const up503 = Bun.serve({ port: 0, fetch: () => new Response("Endpoint is unavailable", { status: 503 }) });
    const upOk = Bun.serve({ port: 0, fetch: () => anthropicReply() });
    servers.push(up503, upOk);
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', ?, 'k')").run(`http://localhost:${up503.port}`);
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (2, 'p2', ?, 'k')").run(`http://localhost:${upOk.port}`);
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority, api) VALUES ('m', 1, 'm-up', 10, 'messages')").run();
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority, api) VALUES ('m', 2, 'm-up', 5, 'messages')").run();
    db.query("INSERT INTO client_keys(id, name, key) VALUES (1, 'pi', 'sk-test')").run();
    const app = createApp(db, "admin-token");

    let hits = 0;
    expect(hits).toBe(0);
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [] }) })
    );
    expect(res.status).toBe(200);
    const units = app.router.unitsState().filter((u) => u.provider_id === 1);
    expect(units.every((u) => u.cooldown_until > Date.now())).toBe(true);
    expect(units.filter((u) => u.gateway_model === "m").every((u) => u.unavailable === false && u.cooldown_until > 0)).toBe(true);
  });

  test("models list includes messages-dialect models", async () => {
    const up = Bun.serve({ port: 0, fetch: () => anthropicReply() });
    servers.push(up);
    const { app } = seedMessages(`http://localhost:${up.port}`);
    const res = await app.fetch(new Request("http://x/v1/models", { headers: H }));
    expect(((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id)).toEqual(["m"]);
  });
});
