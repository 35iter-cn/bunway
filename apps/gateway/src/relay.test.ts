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
