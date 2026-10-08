import { describe, test, expect, afterEach } from "bun:test";
import { openDb } from "./db";
import { Router } from "./router";
import { runTestOnce, cleanupOldLogs, getSetting } from "./tester";
import { mkdirSync, writeFileSync, readdirSync, rmSync, existsSync, readFileSync } from "node:fs";

process.env.LOG_DIR = "logs";

let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync("logs", { recursive: true, force: true });
});

function setup(base: string): { db: ReturnType<typeof openDb>; router: Router } {
  const db = openDb(":memory:");
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1,'p1',?,'k')").run(base);
  db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority) VALUES ('m',1,'m',1)").run();
  const router = new Router(db, () => 5);
  return { db, router };
}

describe("runTestOnce", () => {
  test("failing test keeps unavailable + logs", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    const { db, router } = setup(`http://localhost:${server.port}`);
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    await runTestOnce(db, router);
    expect(router.pick("m")).toEqual([]);
    const log = readFileSync(`logs/error-${new Date().toISOString().slice(0, 10)}.log`, "utf8");
    expect(log).toContain('"event":"probe_still_failing"');
    expect(log).toContain('"provider":"p1"');
  });

  test("passing test recovers provider", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    });
    const { db, router } = setup(`http://localhost:${server.port}`);
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    await runTestOnce(db, router);
    expect(router.pick("m").length).toBe(1);
  });

  test("test request is max_tokens minimal ping", async () => {
    let body = "";
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        body = await req.text();
        return Response.json({ choices: [], usage: {} });
      },
    });
    const { db, router } = setup(`http://localhost:${server.port}`);
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    await runTestOnce(db, router);
    const parsed = JSON.parse(body);
    expect(parsed.max_tokens).toBe(1);
    expect(parsed.model).toBe("m");
  });
});

describe("probe headers and error observability", () => {
  const baseSetup = (base: string, meta: string) => {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key, meta) VALUES (2,'p2',?,'k',?)").run(base, meta);
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority) VALUES ('m',2,'m',1)").run();
    return new Router(db, () => 5);
  };

  test("probe carries extra_headers and default UA", async () => {
    const seen = new Headers();
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        for (const [k, v] of req.headers.entries()) seen.set(k, v);
        return Response.json({ choices: [], usage: {} });
      },
    });
    const router = baseSetup(`http://localhost:${server.port}`, JSON.stringify({ extra_headers: { "x-opencode-session": "probe-sess" } }));
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    const db = openDb(":memory:");
    await runTestOnce(db, router);
    expect(seen.get("x-opencode-session")).toBe("probe-sess");
    expect(seen.get("user-agent")).toBe("bunway-probe/1.0");
    expect(seen.get("authorization")).toBe("Bearer k");
  });

  test("client-style forward header from empty client headers stays unset while extra header wins", async () => {
    const seen = new Headers();
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        for (const [k, v] of req.headers.entries()) seen.set(k, v);
        return Response.json({ choices: [], usage: {} });
      },
    });
    const router = baseSetup(`http://localhost:${server.port}`, JSON.stringify({ forward_headers: ["x-opencode-session"], extra_headers: { "x-opencode-session": "static-sess" } }));
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    const db = openDb(":memory:");
    await runTestOnce(db, router);
    expect(seen.get("x-opencode-session")).toBe("static-sess");
  });

  test("probe 400 logs still_failing with status and body sample", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response('{"type":"error","message":"MissingSessionID"}', { status: 400 }) });
    const router = baseSetup(`http://localhost:${server.port}`, "{}");
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    const db = openDb(":memory:");
    await runTestOnce(db, router);
    expect(router.pick("m")).toEqual([]);
    const log = readFileSync(`logs/error-${new Date().toISOString().slice(0, 10)}.log`, "utf8");
    const line = log.split("\n").find((l) => l.includes("probe_still_failing"))!;
    const entry = JSON.parse(line);
    expect(entry.status).toBe(400);
    expect(entry.error).toContain("MissingSessionID");
  });

  test("probe 500 logs still_failing with status", async () => {
    server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    const router = baseSetup(`http://localhost:${server.port}`, "{}");
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    const db = openDb(":memory:");
    await runTestOnce(db, router);
    const log = readFileSync(`logs/error-${new Date().toISOString().slice(0, 10)}.log`, "utf8");
    const entry = JSON.parse(log.split("\n").find((l) => l.includes("probe_still_failing"))!);
    expect(entry.status).toBe(500);
    expect(entry.error).toBe("boom");
  });

  test("probe 2xx logs recovered and clears unit", async () => {
    server = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [], usage: {} }) });
    const router = baseSetup(`http://localhost:${server.port}`, "{}");
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    const db = openDb(":memory:");
    await runTestOnce(db, router);
    expect(router.pick("m").length).toBe(1);
    const log = readFileSync(`logs/error-${new Date().toISOString().slice(0, 10)}.log`, "utf8");
    expect(log).toContain("probe_recovered");
    expect(log.includes("probe_still_failing")).toBe(false);
  });

  test("probe network error logs probe_failed then still_failing with message", async () => {
    const router = baseSetup("http://localhost:1", "{}");
    const [p] = router.pick("m");
    router.markResult("m", p.provider.id, "unavailable");
    const db = openDb(":memory:");
    await runTestOnce(db, router);
    const log = readFileSync(`logs/error-${new Date().toISOString().slice(0, 10)}.log`, "utf8");
    expect(log).toContain("probe_failed");
    const entry = JSON.parse(log.split("\n").find((l) => l.includes("probe_still_failing"))!);
    expect(entry.status).toBeUndefined();
    expect(typeof entry.error).toBe("string");
    expect(entry.error.length).toBeGreaterThan(0);
  });
});

describe("getSetting", () => {
  test("reads db value with fallback", () => {
    const db = openDb(":memory:");
    expect(getSetting(db, "test_interval_minutes", 60)).toBe(60);
    db.query("UPDATE settings SET value='15' WHERE key='test_interval_minutes'").run();
    expect(getSetting(db, "test_interval_minutes", 60)).toBe(15);
    expect(getSetting(db, "missing", 9)).toBe(9);
  });
});

describe("cleanupOldLogs", () => {
  test("deletes logs older than 7 days", () => {
    mkdirSync("logs", { recursive: true });
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString().slice(0, 10);
    writeFileSync(`logs/error-${old}.log`, "x");
    writeFileSync(`logs/error-${new Date().toISOString().slice(0, 10)}.log`, "x");
    cleanupOldLogs("logs");
    const files = readdirSync("logs");
    expect(files.length).toBe(1);
    expect(files[0]).toBe(`error-${new Date().toISOString().slice(0, 10)}.log`);
  });
  test("missing dir is noop", () => {
    rmSync("logs", { recursive: true, force: true });
    expect(() => cleanupOldLogs("logs")).not.toThrow();
    expect(existsSync("logs")).toBe(false);
  });
});
describe("per-unit probe with dialect", () => {
  test("messages unit probes /v1/messages with x-api-key and recovers only itself", async () => {
    const hits: { path: string; auth: string | null; body: string }[] = [];
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        hits.push({
          path: new URL(req.url).pathname,
          auth: req.headers.get("x-api-key"),
          body: await req.text(),
        });
        return Response.json({ ok: true });
      },
    });
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1,'pm',?,'mk')").run(`http://localhost:${server.port}`);
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority, api) VALUES ('alpha',1,'alpha-up',1,'messages')").run();
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority, api) VALUES ('beta',1,'beta-up',1,'chat')").run();
    const router = new Router(db, () => 5);
    router.markResult("alpha", 1, "unavailable");
    router.markResult("beta", 1, "unavailable");
    await runTestOnce(db, router);
    const alphaHit = hits.find((h) => h.path === "/v1/messages");
    expect(alphaHit).toBeDefined();
    expect(alphaHit!.auth).toBe("mk");
    const parsed = JSON.parse(alphaHit!.body);
    expect(parsed.model).toBe("alpha-up");
    expect(parsed.max_tokens).toBe(1);
    expect(hits.some((h) => h.path === "/v1/chat/completions")).toBe(true);
    expect(router.pick("alpha").length).toBe(1);
    expect(router.pick("beta").length).toBe(1);
    expect(hits.length).toBe(2);
  });
});
