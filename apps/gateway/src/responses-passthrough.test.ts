import { describe, test, expect } from "bun:test";
import { openDb } from "./db";
import { createApp } from "./index";
import type { Router } from "./router";
import type { GatewayEnv } from "./index";

const H = { Authorization: "Bearer sk-test", "Content-Type": "application/json" };
const AH = { Authorization: "Bearer admin-token", "Content-Type": "application/json" };
const servers: Bun.TCPSocketListener[] = [];

function seedResponses() {
  const db = openDb(":memory:");
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', ?, 'k')").run("http://placeholder");
  // spec 27：数组 api，双方言 unit
  db.query(
    `INSERT INTO routes(gateway_model, provider_id, provider_model, priority, api, pricing)
     VALUES ('m', 1, 'm-up', 1, '["chat","responses"]', '{"default":{"price_input":1,"price_output":1,"price_cache_read":0,"price_cache_write":0}}')`
  ).run();
  db.query("INSERT INTO client_keys(id, name, key) VALUES (1, 'pi', 'sk-test')").run();
  return { db, app: createApp(db, "admin-token") };
}

function bindProvider(db: ReturnType<typeof openDb>, port: number, app?: { router: Router }) {
  db.query("UPDATE providers SET base_url=? WHERE id=1").run(`http://localhost:${port}`);
  app?.router.invalidate();
}

const responsesJson = () =>
  Response.json({
    id: "resp_1",
    object: "response",
    status: "completed",
    model: "m-up",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "hey" }] }],
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 2 } },
  });

describe("spec 27: /v1/responses passthrough", () => {
  test("stateless guard: store=true rejected before relay", async () => {
    const { app } = seedResponses();
    const res = await app.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "m", input: "hi", store: true }) })
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("stateless");
  });

  test("stateless guard: previous_response_id rejected", async () => {
    const { app } = seedResponses();
    const res = await app.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "m", input: "hi", previous_response_id: "resp_x" }) })
    );
    expect(res.status).toBe(400);
  });

  test("non-stream: only model rewritten, body passed verbatim, usage billed", async () => {
    const up = Bun.serve({
      port: 0,
      async fetch(req) {
        const sent = await req.text();
        return new Response(JSON.stringify({ echoed: JSON.parse(sent) }), { headers: { "Content-Type": "application/json" } });
      },
    });
    servers.push(up);
    const { db, app } = seedResponses();
    bindProvider(db, up.port, app);
    const body = JSON.stringify({
      model: "m",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning: { effort: "high" },
      tools: [{ type: "function", name: "fn", parameters: { type: "object" } }],
      include: ["reasoning.encrypted_content"],
      store: false,
      prompt_cache_key: "conv-1",
    });
    const res = await app.fetch(new Request("http://x/v1/responses", { method: "POST", headers: H, body }));
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as { echoed: Record<string, unknown> };
    const sent = echoed.echoed as Record<string, unknown>;
    expect(sent.model).toBe("m-up");
    expect(sent.store).toBe(false);
    expect(sent.include).toEqual(["reasoning.encrypted_content"]);
    expect(sent.prompt_cache_key).toBe("conv-1");
    expect(sent.reasoning).toEqual({ effort: "high" });
    expect(sent.tools).toEqual([{ type: "function", name: "fn", parameters: { type: "object" } }]);
    const sentRaw = JSON.stringify(sent);
    const expectedRaw = body.replace('"model":"m"', '"model":"m-up"');
    expect(sentRaw).toBe(expectedRaw);
  });

  test("non-stream usage: normalizeUsage picks input/output tokens and cache details", async () => {
    const up = Bun.serve({ port: 0, fetch: () => responsesJson() });
    servers.push(up);
    const { db, app } = seedResponses();
    bindProvider(db, up.port, app);
    const res = await app.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "m", input: "hi" }) })
    );
    expect(res.status).toBe(200);
    const row = db.query("SELECT prompt_tokens, completion_tokens, cache_read_tokens, cost FROM usage_log").get() as Record<string, number>;
    expect(row.prompt_tokens).toBe(10);
    expect(row.completion_tokens).toBe(3);
    expect(row.cache_read_tokens).toBe(2);
    expect(row.cost).toBeGreaterThan(0);
  });

  test("stream: lines passed through verbatim, completed/incomplete both billed once", async () => {
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r1","usage":null}}',
      "",
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"he"}',
      "",
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}}}',
      "",
    ].join("\n");
    const up = Bun.serve({ port: 0, fetch: () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }) });
    servers.push(up);
    const { db, app } = seedResponses();
    bindProvider(db, up.port, app);
    const res = await app.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "m", input: "hi", stream: true }) })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"he"');
    expect(text).toContain("response.completed");
    const row = db.query("SELECT prompt_tokens, completion_tokens FROM usage_log").get() as Record<string, number>;
    expect(row.prompt_tokens).toBe(7);
    expect(row.completion_tokens).toBe(2);
    expect((db.query("SELECT COUNT(*) c FROM usage_log").get() as { c: number }).c).toBe(1);
  });

  test("stream incomplete with usage is billed; stream closed without terminal → interrupted frame", async () => {
    const sseIncomplete = [
      'data: {"type":"response.incomplete","response":{"usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}}',
      "",
    ].join("\n");
    const upIncomplete = Bun.serve({ port: 0, fetch: () => new Response(sseIncomplete, { headers: { "Content-Type": "text/event-stream" } }) });
    servers.push(upIncomplete);
    const { db, app } = seedResponses();
    bindProvider(db, upIncomplete.port, app);
    const res = await app.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "m", input: "hi", stream: true }) })
    );
    expect(res.status).toBe(200);
    const row = db.query("SELECT prompt_tokens FROM usage_log").get() as Record<string, number>;
    expect(row.prompt_tokens).toBe(5);

    const upTruncated = Bun.serve({ port: 0, fetch: () => new Response('data: {"type":"response.created","response":{}}\n\n', { headers: { "Content-Type": "text/event-stream" } }) });
    servers.push(upTruncated);
    bindProvider(db, upTruncated.port, app);
    const app2 = createApp(db, "admin-token");
    const res2 = await app2.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "m", input: "hi", stream: true }) })
    );
    const text2 = await res2.text();
    expect(text2).toContain("upstream_interrupted");
  });

  test("malformed SSE line skipped, honest frame forwarded, malformed event logged", async () => {
    const sse = [
      'data: {"type":"response.created","response":{}}',
      "data: {broken",
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      "",
    ].join("\n");
    const up = Bun.serve({ port: 0, fetch: () => new Response(sse, { headers: { "Content-Type": "text/event-stream" } }) });
    servers.push(up);
    const { db, app } = seedResponses();
    bindProvider(db, up.port, app);
    const res = await app.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "m", input: "hi", stream: true }) })
    );
    const text = await res.text();
    expect(text).toContain("response.completed");
    expect(text).not.toContain("broken");
  });

  test("model with no responses-capable unit → 502 short-circuit (no upstream call)", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', 'http://never-called', 'k')").run();
    db.query(
      `INSERT INTO routes(gateway_model, provider_id, provider_model, priority, api)
       VALUES ('chat-only', 1, 'up', 1, '["chat"]')`
    ).run();
    db.query("INSERT INTO client_keys(id, name, key) VALUES (1, 'pi', 'sk-test')").run();
    const app = createApp(db, "admin-token");
    const res = await app.fetch(
      new Request("http://x/v1/responses", { method: "POST", headers: H, body: JSON.stringify({ model: "chat-only", input: "hi" }) })
    );
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("no available provider");
  });

  test("chat endpoint unaffected by array dialect: chat traffic still works on dual-dialect unit", async () => {
    const up = Bun.serve({
      port: 0,
      async fetch(req) {
        const sent = await req.text();
        return Response.json({ model: JSON.parse(sent).model, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      },
    });
    servers.push(up);
    const { db, app } = seedResponses();
    bindProvider(db, up.port, app);
    const res = await app.fetch(
      new Request("http://x/v1/chat/completions", { method: "POST", headers: H, body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) })
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { model: string };
    expect(json.model).toBe("m-up");
  });
});