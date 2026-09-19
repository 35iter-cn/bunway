import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { relay, relayAndBill, injectStreamUsage, isFinalUsageChunk } from "./relay";
import { parsePricing } from "./billing";
import type { PricedRoute } from "./billing";
import type { Provider, Route } from "./db";
import type { Database } from "bun:sqlite";

let server: ReturnType<typeof Bun.serve> | null = null;
const received: { headers: Headers; body: string }[] = [];

afterEach(() => {
  server?.stop(true);
  server = null;
  received.length = 0;
  delete process.env.LOG_DIR;
});

function mockUpstream(handler: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text();
      received.push({ headers: req.headers, body });
      return await handler(req);
    },
  });
  return `http://localhost:${server.port}`;
}

function setup(base: string): { db: Database; req: Parameters<typeof relay>[0] } {
  const db = openDb(":memory:");
  db.query("INSERT INTO providers(id, name, base_url, api_key, meta) VALUES (1,'p',?, 'k', ?)").run(
    base,
    JSON.stringify({ forward_headers: ["x-opencode-session"] })
  );
  db.query(
    `INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing)
     VALUES ('m', 1, 'm-up', 1, '{"default":{"price_input":1,"price_output":2,"price_cache_read":0,"price_cache_write":0}}')`
  ).run();
  const provider = db.query<Provider, []>("SELECT * FROM providers").get()!;
  const row = db.query<Route, []>("SELECT * FROM routes").get()!;
  const route: PricedRoute = { ...row, pricing: parsePricing(row.pricing)! };
  return {
    db,
    req: {
      db,
      provider,
      route,
      keyId: null,
      gatewayModel: "m",
      body: JSON.stringify({ model: "m-up", messages: [{ role: "user", content: "hi" }] }),
      clientHeaders: new Headers({ "x-opencode-session": "sess-123", "authorization": "Bearer client" }),
    },
  };
}

describe("relay", () => {
  test("non-stream: body passthrough + billing", async () => {
    const base = mockUpstream(() =>
      Response.json({
        id: "1",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      })
    );
    const { db, req } = setup(base);
    req.db = db;
    const upstream = await relay(req);
    const out = await relayAndBill(req, upstream);
    const text = await out.text();

    expect(JSON.parse(text).choices[0].message.content).toBe("ok");
    expect(received[0].headers.get("x-opencode-session")).toBe("sess-123");
    expect(received[0].headers.get("authorization")).toBe("Bearer k");
    const row = db.query("SELECT * FROM usage_log").get() as Record<string, unknown>;
    expect(row.prompt_tokens).toBe(100);
    expect(row.provider_model).toBe("m-up");
  });

  test("stream: passthrough byte-faithful, usage-only chunk forwarded and billed", async () => {
    const base = mockUpstream(
      () =>
        new Response(
          `data: {"id":"1","choices":[{"delta":{"content":"he"},"index":0}]}\n\n` +
            `data: {"id":"1","choices":[{"delta":{"content":"llo"},"index":0}]}\n\n` +
            `data: {"id":"1","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":2}}\n\n` +
            `data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { db, req } = setup(base);
    const upstream = await relay(req);
    const out = await relayAndBill(req, upstream);
    const text = await out.text();

    expect(text).toContain('"content":"he"');
    expect(text).toContain('"content":"llo"');
    expect(text).toContain('"usage"');
    expect(text).toContain("[DONE]");
    const row = db.query("SELECT * FROM usage_log").get() as Record<string, unknown>;
    expect(row.prompt_tokens).toBe(50);
  });

  test("stream: reasoning delta normalized to reasoning_content, other chunks untouched", async () => {
    const base = mockUpstream(
      () =>
        new Response(
          `data: {"id":"1","choices":[{"delta":{"reasoning":"th"},"index":0}]}\n\n` +
            `data: {"id":"1","choices":[{"delta":{"reasoning_content":"th2"},"index":0}]}\n\n` +
            `data: {"id":"1","choices":[{"delta":{"content":"hi"},"index":0}]}\n\n` +
            `data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { req } = setup(base);
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();

    expect(text).toContain('"reasoning_content":"th"');
    expect(text).toContain('"reasoning_content":"th2"');
    expect(text).not.toContain('"reasoning":');
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("[DONE]");
  });

  test("non-stream: message reasoning normalized to reasoning_content", async () => {
    const base = mockUpstream(() =>
      Response.json({
        id: "1",
        choices: [{ message: { role: "assistant", reasoning: "th", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      })
    );
    const { db, req } = setup(base);
    const out = await relayAndBill(req, await relay(req));
    const json = JSON.parse(await out.text()) as { choices: { message: Record<string, unknown> }[] };

    expect(json.choices[0].message).toEqual({ role: "assistant", content: "ok", reasoning_content: "th" });
    const row = db.query("SELECT * FROM usage_log").get() as Record<string, unknown>;
    expect(row.prompt_tokens).toBe(5);
  });

  test("stream with usage-bearing choice chunk: billed once, chunk forwarded", async () => {
    const base = mockUpstream(
      () =>
        new Response(
          `data: {"id":"1","choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n` +
            `data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { db, req } = setup(base);
    const upstream = await relay(req);
    const out = await relayAndBill(req, upstream);
    const text = await out.text();
    expect(text).toContain('"usage"');
    const rows = db.query("SELECT * FROM usage_log").all();
    expect(rows.length).toBe(1);
  });

  test("forward_headers absent → header not sent", async () => {
    const base = mockUpstream(() => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { db, req } = setup(base);
    req.clientHeaders = new Headers({ "authorization": "Bearer client" });
    await relayAndBill(req, await relay(req));
    expect(received[0].headers.get("x-opencode-session")).toBeNull();
  });

  test("extra_headers: static value injected when client sends none", async () => {
    const base = mockUpstream(() => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { db, req } = setup(base);
    db.query("UPDATE providers SET meta=? WHERE id=1").run(
      JSON.stringify({ extra_headers: { "x-opencode-session": "static-sess" } })
    );
    req.provider = db.query<Provider, []>("SELECT * FROM providers").get()!;
    req.clientHeaders = new Headers({ "authorization": "Bearer client" });
    await relayAndBill(req, await relay(req));
    expect(received[0].headers.get("x-opencode-session")).toBe("static-sess");
  });

  test("client header overrides extra_headers static value", async () => {
    const base = mockUpstream(() => Response.json({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const { db, req } = setup(base);
    db.query("UPDATE providers SET meta=? WHERE id=1").run(
      JSON.stringify({ extra_headers: { "x-opencode-session": "static-sess" }, forward_headers: ["x-opencode-session"] })
    );
    req.provider = db.query<Provider, []>("SELECT * FROM providers").get()!;
    await relayAndBill(req, await relay(req));
    expect(received[0].headers.get("x-opencode-session")).toBe("sess-123");
  });

  test("idle timeout: unresponsive upstream rejects before response", async () => {
    const base = mockUpstream(() => new Promise<Response>(() => {}));
    const { req } = setup(base);
    req.idleTimeoutMs = 50;
    await expect(relay(req)).rejects.toThrow();
  });

  test("idle timeout: mid-stream stall truncates stream and logs upstream_interrupted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    process.env.LOG_DIR = dir;
    const base = mockUpstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(`data: {"id":"1","choices":[{"delta":{"content":"he"},"index":0}]}\n\n`)
              );
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { req } = setup(base);
    req.idleTimeoutMs = 50;
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();
    expect(text).toContain('"content":"he"');
    expect(text).not.toContain("[DONE]");
    expect(text).toContain("upstream_interrupted");
    await Bun.sleep(100);
    const log = readFileSync(join(dir, `error-${new Date().toISOString().slice(0, 10)}.log`), "utf8");
    expect(log).toContain("upstream_interrupted");
  });

  test("upstream closes without [DONE]: error chunk sent, upstream_interrupted logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    process.env.LOG_DIR = dir;
    const base = mockUpstream(
      () =>
        new Response(
          `data: {"id":"1","choices":[{"delta":{"content":"he"},"index":0}]}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { req } = setup(base);
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();
    expect(text).toContain("upstream closed without [DONE]");
    expect(text).toContain("(stream terminated)");
    expect(text).not.toContain("data: [DONE]");
    await Bun.sleep(100);
    const log = readFileSync(join(dir, `error-${new Date().toISOString().slice(0, 10)}.log`), "utf8");
    expect(log).toContain("upstream_interrupted");
  });

  test("upstream socket error mid-stream: error chunk sent, upstream_interrupted logged", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    process.env.LOG_DIR = dir;
    const { req } = setup("http://localhost:1");
    const upstream = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: {"id":"1","choices":[{"delta":{"content":"he"},"index":0}]}\n\n`)
          );
          controller.error(new Error("socket connection was closed unexpectedly"));
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } }
    );
    const out = await relayAndBill(req, upstream);
    const text = await out.text();
    expect(text).toContain("socket connection was closed unexpectedly");
    expect(text).toContain("upstream_interrupted");
    await Bun.sleep(100);
    const log = readFileSync(join(dir, `error-${new Date().toISOString().slice(0, 10)}.log`), "utf8");
    expect(log).toContain("upstream_interrupted");
  });

  test("normal end with [DONE] but no usage: usage_missing only, no error chunk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-log-"));
    process.env.LOG_DIR = dir;
    const base = mockUpstream(
      () =>
        new Response(
          `data: {"id":"1","choices":[{"delta":{"content":"he"},"index":0}]}\n\n` + `data: [DONE]\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { req } = setup(base);
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("upstream_interrupted");
    await Bun.sleep(100);
    const log = readFileSync(join(dir, `error-${new Date().toISOString().slice(0, 10)}.log`), "utf8");
    expect(log).toContain("usage_missing");
    expect(log).not.toContain("upstream_interrupted");
  });

  test("healthy long stream: total duration exceeds idle window, short gaps survive", async () => {
    const base = mockUpstream(
      () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              for (let i = 0; i < 8; i++) {
                await Bun.sleep(20);
                controller.enqueue(
                  new TextEncoder().encode(`data: {"id":"1","choices":[{"delta":{"content":"${i}"},"index":0}]}\n\n`)
                );
              }
              controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { req } = setup(base);
    req.idleTimeoutMs = 100;
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();
    for (let i = 0; i < 8; i++) expect(text).toContain(`"content":"${i}"`);
    expect(text).toContain("[DONE]");
  });
});


describe("messages dialect", () => {
  function messagesSetup(base: string): { db: Database; req: Parameters<typeof relay>[0] } {
    const s = setup(base);
    s.req.api = "messages";
    s.req.body = JSON.stringify({ model: "m-up", messages: [{ role: "user", content: "hi" }], max_tokens: 8192 });
    return s;
  }

  test("sends to /v1/messages with x-api-key + anthropic-version", async () => {
    const base = mockUpstream(() =>
      Response.json({
        id: "msg_1", type: "message", role: "assistant",
        content: [{ type: "text", text: "hello" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      })
    );
    const { db, req } = messagesSetup(base);
    const out = await relayAndBill(req, await relay(req));
    expect(received[0].headers.get("x-api-key")).toBe("k");
    expect(received[0].headers.get("anthropic-version")).toBe("2023-06-01");
    expect(received[0].headers.get("authorization")).toBeNull();
    const json = JSON.parse(await out.text()) as Record<string, unknown>;
    expect((json.choices as Record<string, unknown>[])[0].message.content).toBe("hello");
    const row = db.query("SELECT * FROM usage_log").get() as Record<string, unknown>;
    expect(row.prompt_tokens).toBe(10);
    expect(row.completion_tokens).toBe(3);
  });

  test("stream: message_stop terminates (no interrupted), ping ignored, [DONE] appended", async () => {
    const base = mockUpstream(
      () =>
        new Response(
          `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":7}}}\n\n` +
            `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
            `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hey"}}\n\n` +
            `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
            `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n` +
            `event: message_stop\ndata: {"type":"message_stop"}\n\n` +
            `event: ping\ndata: {"type":"ping","cost":"0"}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { req } = messagesSetup(base);
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();
    expect(text).toContain('"content":"hey"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("upstream_interrupted");
    expect(text).not.toContain('"type":"ping"');
    expect(text).not.toContain("event: ");
  });

  test("stream with tool_use: full tool loop mapping", async () => {
    const base = mockUpstream(
      () =>
        new Response(
          `data: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n` +
            `data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n` +
            `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"let me check"}}\n\n` +
            `data: {"type":"content_block_stop","index":0}\n\n` +
            `data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu1","name":"get_weather"}}\n\n` +
            `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}\n\n` +
            `data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"sf\"}"}}\n\n` +
            `data: {"type":"content_block_stop","index":1}\n\n` +
            `data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}\n\n` +
            `data: {"type":"message_stop"}\n\n` +
            `data: {"type":"ping","cost":"0"}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { db, req } = messagesSetup(base);
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();
    expect(text).toContain('"tool_calls"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    expect(text).toContain("[DONE]");
    expect(text).not.toContain("upstream_interrupted");
    const rows = db.query("SELECT * FROM usage_log").all() as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0].prompt_tokens).toBe(9);
    expect(rows[0].completion_tokens).toBe(4);
  });

  test("stream closed without message_stop: interrupted error frame", async () => {
    const base = mockUpstream(
      () =>
        new Response(
          `data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        )
    );
    const { req } = messagesSetup(base);
    const out = await relayAndBill(req, await relay(req));
    const text = await out.text();
    expect(text).toContain("upstream closed without message_stop");
    expect(text).toContain("upstream_interrupted");
  });
});

describe("injectStreamUsage", () => {
  test("injects when missing", () => {
    const { body, injected } = injectStreamUsage(JSON.stringify({ stream: true, messages: [] }));
    expect(injected).toBe(true);
    expect(JSON.parse(body).stream_options.include_usage).toBe(true);
  });
  test("keeps existing include_usage", () => {
    const orig = JSON.stringify({ stream: true, stream_options: { include_usage: true } });
    const { body, injected } = injectStreamUsage(orig);
    expect(injected).toBe(false);
    expect(body).toBe(orig);
  });
  test("non-stream untouched", () => {
    const { injected } = injectStreamUsage(JSON.stringify({ stream: false }));
    expect(injected).toBe(false);
  });
  test("isFinalUsageChunk", () => {
    expect(isFinalUsageChunk({ usage: {}, choices: [] })).toBe(true);
    expect(isFinalUsageChunk({ usage: {}, choices: [{ delta: {} }] })).toBe(false);
    expect(isFinalUsageChunk({ choices: [] })).toBe(false);
  });
});
describe("latency recording", () => {
  test("bill with startedAt records real latency_ms and ttft_ms, and bills at that instant", async () => {
    const base = mockUpstream(() =>
      Response.json({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      })
    );
    const { db, req } = setup(base);
    const startedAt = Date.now() - 5000;
    req.startedAt = startedAt;
    const upstream = await relay(req);
    await relayAndBill(req, upstream);
    const row = db.query("SELECT ts, latency_ms, ttft_ms FROM usage_log").get() as {
      ts: number;
      latency_ms: number;
      ttft_ms: number;
    };
    expect(row.latency_ms).toBeGreaterThanOrEqual(5000);
    expect(row.ttft_ms).toBeGreaterThanOrEqual(5000);
    expect(row.ts).toBe(startedAt);
  });
});
