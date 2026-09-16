import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db";
import { createApp } from "./index";
import { resolvePrices, tierOf } from "./billing";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function seed(usage: Array<[number, number, string, number]>) {
  const db = openDb(":memory:");
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', 'http://up', 'k')").run();
  db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority) VALUES ('m', 1, 'm-up', 1)").run();
  db.query("INSERT INTO client_keys(id, name, key) VALUES (1, 'pi', 'sk-test')").run();
  const ins = db.query(
    "INSERT INTO usage_log(ts, provider_id, gateway_model, provider_model, prompt_tokens, completion_tokens, cost, ttft_ms, status) VALUES (?, 1, 'm', 'm-up', 10, 5, ?, ?, ?)"
  );
  for (const [ts, cost, status, lat] of usage) {
    ins.run(ts, cost, lat, status);
  }
  const logDir = join("/tmp", `gw-admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(logDir, { recursive: true });
  dirs.push(logDir);
  process.env.LOG_DIR = logDir;
  return { db, app: createApp(db, "admin-token") };
}

const AH = { Authorization: "Bearer admin-token" };
const HOUR = 3_600_000;
const now = Date.now();

describe("GET /admin/stats (ttft)", () => {
  test("returns ttft_avg and ttft_p95 per group", async () => {
    const { app } = seed([
      [now - HOUR, 0.1, "ok", 1000, 1, 1, 0, 0],
      [now - HOUR, 0.2, "ok", 2000, 1, 1, 0, 0],
      [now - HOUR, 0.3, "ok", 3000, 1, 1, 0, 0],
      [now - HOUR, 0.4, "ok", 9000, 1, 1, 0, 0],
    ]);
    const res = await app.fetch(new Request("http://x/admin/stats?range=7d", { headers: AH }));
    const { data } = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].ttft_avg).toBe(3750);
    expect(data[0].ttft_p95).toBe(9000);
  });

  test("p95 uses valid samples as denominator, not all requests", async () => {
    const rows: Array<[number, number, string, number]> = [];
    for (let i = 1; i <= 90; i++) rows.push([now - HOUR, 0.1, "ok", i * 100]);
    for (let i = 0; i < 10; i++) rows.push([now - HOUR, 0.1, "ok", 0]);
    const { app } = seed(rows);
    const { data } = await (await app.fetch(new Request("http://x/admin/stats?range=7d", { headers: AH }))).json();
    expect(data[0].requests).toBe(100);
    expect(data[0].ttft_avg).toBe(4550);
    expect(data[0].ttft_p95).toBe(8600);
  });

  test("p95 is null when the group has no valid sample", async () => {
    const { app } = seed([[now - HOUR, 0.1, "ok", 0], [now - HOUR, 0.1, "ok", 0]]);
    const { data } = await (await app.fetch(new Request("http://x/admin/stats?range=7d", { headers: AH }))).json();
    expect(data[0].ttft_p95).toBeNull();
  });
});

describe("GET /admin/ttft", () => {
  test("returns global and per-provider p95, ordered by p95 desc", async () => {
    const { db, app } = seed([
      [now - HOUR, 0.1, "ok", 1000],
      [now - HOUR, 0.1, "ok", 2000],
    ]);
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (2, 'p2', 'http://up2', 'k')").run();
    db.query(
      "INSERT INTO usage_log(ts, provider_id, gateway_model, provider_model, prompt_tokens, completion_tokens, cost, ttft_ms, status) VALUES (?, 2, 'm', 'm-up', 10, 5, 0.1, ?, 'ok')"
    ).run(now - HOUR, 9000);
    const { data } = await (await app.fetch(new Request("http://x/admin/ttft?range=7d", { headers: AH }))).json();
    expect(data.global).toEqual({ p95: 9000, avg: 4000, n: 3 });
    expect(data.by_provider.map((p: { name: string }) => p.name)).toEqual(["p2", "p1"]);
    expect(data.by_provider[0]).toEqual({ provider_id: 2, name: "p2", p95: 9000, avg: 9000, n: 1 });
    expect(data.by_provider[1]).toEqual({ provider_id: 1, name: "p1", p95: 2000, avg: 1500, n: 2 });
  });

  test("ignores zero ttft rows and returns null when nothing is valid", async () => {
    const { app } = seed([
      [now - HOUR, 0.1, "ok", 0],
      [now - HOUR, 0.1, "ok", 4000],
      [now - HOUR, 0.1, "ok", 8000],
    ]);
    const { data } = await (await app.fetch(new Request("http://x/admin/ttft?range=7d", { headers: AH }))).json();
    expect(data.global).toEqual({ p95: 8000, avg: 6000, n: 2 });

    const empty = seed([[now - HOUR, 0.1, "ok", 0]]);
    const res = await (await empty.app.fetch(new Request("http://x/admin/ttft?range=7d", { headers: AH }))).json();
    expect(res.data.global).toBeNull();
    expect(res.data.by_provider).toEqual([]);
  });
});

describe("GET /admin/pricing", () => {
  const PEAK = {
    default: { price_input: 0.15, price_output: 0.6, price_cache_read: 0.003, price_cache_write: 0 },
    rules: [
      { windows: ["01:00-04:00", "06:00-10:00"], days: [1, 2, 3, 4, 5], price_input: 0.3, price_output: 1.2, price_cache_read: 0.006 },
    ],
  };

  function seedPriced() {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', 'http://up', 'k')").run();
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing) VALUES ('m', 1, 'm-up', 1, ?)").run(
      JSON.stringify(PEAK)
    );
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority) VALUES ('n', 1, 'n-up', 2)").run();
    return createApp(db, "admin-token");
  }

  test("401 without token", async () => {
    const app = seedPriced();
    const res = await app.fetch(new Request("http://x/admin/pricing"));
    expect(res.status).toBe(401);
  });

  test("each route carries pricing, current tier/prices and the next switch", async () => {
    const app = seedPriced();
    const res = await app.fetch(new Request("http://x/admin/pricing", { headers: AH }));
    expect(res.status).toBe(200);
    const { ts, data } = await res.json();
    expect(typeof ts).toBe("number");
    expect(data.length).toBe(2);

    const priced = data.find((r: { gateway_model: string }) => r.gateway_model === "m");
    expect(priced.provider_model).toBe("m-up");
    expect(priced.pricing).toEqual(PEAK);
    expect(priced.now.rule).toBe(tierOf(PEAK as never, ts));
    expect(priced.now.prices).toEqual(resolvePrices(PEAK as never, ts));
    expect(priced.next_switch === null || typeof priced.next_switch.ts === "number").toBe(true);

    const plain = data.find((r: { gateway_model: string }) => r.gateway_model === "n");
    expect(plain.now.rule).toBe(-1);
    expect(plain.next_switch).toBeNull();
  });

  test("price_index and rank follow the order basis", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', 'http://up', 'k')").run();
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (2, 'p2', 'http://up2', 'k')").run();
    const ins = db.query(
      "INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing) VALUES (?,?,?,?,?)"
    );
    ins.run("m", 1, "m-up", 10, JSON.stringify({ default: { price_input: 0.3, price_output: 1.2, price_cache_read: 0.006, price_cache_write: 0 } }));
    ins.run("m", 2, "m-up", 5, JSON.stringify({ default: { price_input: 0.15, price_output: 0.6, price_cache_read: 0.003, price_cache_write: 0 } }));
    const app = createApp(db, "admin-token");
    const rankOf = (body: { data: Array<{ provider_id: number; rank: number; price_index: number }> }, provider_id: number) =>
      body.data.find((r) => r.provider_id === provider_id)!;

    const off = await (await app.fetch(new Request("http://x/admin/pricing", { headers: AH }))).json();
    expect(off.dynamic_priority).toBe(true);
    expect(typeof off.computed_at).toBe("number");
    expect(rankOf(off, 2).rank).toBe(1);
    expect(rankOf(off, 1).rank).toBe(2);
    expect(rankOf(off, 2).price_index).toBeCloseTo(0.15 + 0.6 + 0.003, 10);

    const offPut = await app.fetch(
      new Request("http://x/admin/settings", {
        method: "PUT",
        headers: { ...AH, "Content-Type": "application/json" },
        body: JSON.stringify({ dynamic_priority: "0" }),
      })
    );
    expect(offPut.status).toBe(200);
    const plain = await (await app.fetch(new Request("http://x/admin/pricing", { headers: AH }))).json();
    expect(plain.dynamic_priority).toBe(false);
    expect(rankOf(plain, 1).rank).toBe(1);
    expect(rankOf(plain, 2).rank).toBe(2);

    const put = await app.fetch(
      new Request("http://x/admin/settings", {
        method: "PUT",
        headers: { ...AH, "Content-Type": "application/json" },
        body: JSON.stringify({ dynamic_priority: "1" }),
      })
    );
    expect(put.status).toBe(200);

    const on = await (await app.fetch(new Request("http://x/admin/pricing", { headers: AH }))).json();
    expect(on.dynamic_priority).toBe(true);
    expect(rankOf(on, 2).rank).toBe(1);
    expect(rankOf(on, 1).rank).toBe(2);
    expect(rankOf(on, 1).price_index).toBeCloseTo(0.3 + 1.2 + 0.006, 10);
  });});

describe("GET /admin/stats/timeseries", () => {
  test("empty db → zero-filled continuous buckets", async () => {
    const { app } = seed([]);
    const res = await app.fetch(new Request(`http://x/admin/stats/timeseries?since=${now - 2 * HOUR}&until=${now}`, { headers: AH }));
    const { data } = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(4);
    expect(data.length).toBeLessThanOrEqual(5);
    for (const r of data) {
      expect(r.cost).toBe(0);
      expect(r.requests).toBe(0);
      expect(r.tokens).toBe(0);
      expect(r.ttft_avg).toBeNull();
    }
    for (let i = 1; i < data.length; i++) expect(data[i].bucket - data[i - 1].bucket).toBe(1_800_000);
  });

  test("legacy range: span>2d → daily buckets, today → hourly", async () => {
    const { app } = seed([
      [now - HOUR, 0.1, "ok", 100, 1, 1, 0, 0],
      [now - HOUR - HOUR * 2, 0.2, "error", 200, 1, 1, 0, 0],
      [now - 20 * 86_400_000, 0.5, "ok", 300, 1, 1, 0, 0],
    ]);
    const res = await app.fetch(new Request("http://x/admin/stats/timeseries?range=7d", { headers: AH }));
    const { data } = await res.json();
    const hit = data.filter((r: any) => r.requests > 0);
    expect(hit.length).toBe(1);
    expect(hit[0].errors).toBe(1);
    expect(hit[0].cost).toBeCloseTo(0.3, 5);
    expect(hit[0].tokens).toBe(2 * 15);
    expect(hit[0].bucket % 86_400_000).toBe(0);
    for (let i = 1; i < data.length; i++) expect(data[i].bucket - data[i - 1].bucket).toBe(86_400_000);

    const resToday = await app.fetch(new Request("http://x/admin/stats/timeseries?range=today", { headers: AH }));
    const { data: d1 } = await resToday.json();
    expect(d1.length).toBeGreaterThanOrEqual(1);
    expect(d1[0].bucket % HOUR).toBe(0);
    for (let i = 1; i < d1.length; i++) expect(d1[i].bucket - d1[i - 1].bucket).toBe(1_800_000);
  });

  test("client window since/until/tz: filtering and tz-aligned daily buckets", async () => {
    const { app } = seed([
      [now - HOUR, 0.1, "ok", 100, 1, 1, 0, 0],
      [now - 30 * HOUR, 0.2, "ok", 200, 1, 1, 0, 0],
    ]);
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0);
    const since3d = startOfDay.getTime() - 3 * 86_400_000;
    const wp = `since=${since3d}&until=${now}&tz=${-new Date().getTimezoneOffset()}`;
    const res = await app.fetch(new Request(`http://x/admin/stats/timeseries?${wp}`, { headers: AH }));
    const { data } = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(2);
    expect(data.reduce((a, x) => a + x.cost, 0)).toBeCloseTo(0.3, 5);
    expect((data[data.length - 1].bucket - data[0].bucket) % 86_400_000).toBe(0);

    const narrow = await app.fetch(new Request(`http://x/admin/stats?since=${now - 2 * HOUR}&until=${now}`, { headers: AH }));
    const nd = (await narrow.json()).data;
    expect(nd.length).toBe(1);
    expect(nd[0].cost).toBeCloseTo(0.1, 5);

    const shifted = await app.fetch(new Request(`http://x/admin/stats/timeseries?since=${since3d}&until=${now}&tz=480`, { headers: AH }));
    const sd = (await shifted.json()).data;
    const shiftedBucket = (sd[0].bucket + 480 * 60_000) % 86_400_000;
    expect(shiftedBucket).toBe(0);
  });

  test("invalid range → 400", async () => {
    const { app } = seed([]);
    const res = await app.fetch(new Request("http://x/admin/stats/timeseries?range=1h", { headers: AH }));
    expect(res.status).toBe(400);
  });
});

describe("GET /admin/errors", () => {
  test("aggregates event counts and recent stream from JSONL", async () => {
    const { app } = seed([]);
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dirs[0], `error-${day}.log`),
      [
        JSON.stringify({ ts: `${day}T07:10:37Z`, event: "upstream_error", provider: "p1" }),
        JSON.stringify({ ts: `${day}T07:11:00Z`, event: "client_aborted", provider: "p1", phase: "upstream_call" }),
        JSON.stringify({ ts: `${day}T07:12:00Z`, event: "upstream_error", provider: "p1" }),
        "not-json",
        "",
      ].join("\n")
    );
    const res = await app.fetch(new Request("http://x/admin/errors?range=today&limit=50", { headers: AH }));
    const { data } = await res.json();
    expect(data.counts).toEqual({ upstream_error: 2, client_aborted: 1 });
    expect(data.recent.length).toBe(3);
    expect(data.recent[0].event).toBe("upstream_error");
    expect(Object.keys(data.byEvent).sort()).toEqual(["client_aborted", "upstream_error"]);
    expect(data.byEvent.upstream_error.map((e: { ts: string }) => e.ts)).toEqual([`${day}T07:12:00Z`, `${day}T07:10:37Z`]);
    expect(data.byEvent.client_aborted).toEqual([{ ts: `${day}T07:11:00Z`, event: "client_aborted", provider: "p1", phase: "upstream_call" }]);
  });

  test("missing log dir → empty, no throw", async () => {
    const { app } = seed([]);
    process.env.LOG_DIR = join("/tmp", `gw-nonexistent-${Date.now()}`);
    const res = await app.fetch(new Request("http://x/admin/errors?range=today", { headers: AH }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ counts: {}, recent: [], byEvent: {} });
  });

  test("limit clamped", async () => {
    const { app } = seed([]);
    const day = new Date().toISOString().slice(0, 10);
    writeFileSync(
      join(dirs[0], `error-${day}.log`),
      Array.from({ length: 10 }, (_, i) => JSON.stringify({ ts: `${day}T00:00:${String(i).padStart(2, "0")}Z`, event: "e" })).join("\n")
    );
    const res = await app.fetch(new Request("http://x/admin/errors?range=today&limit=3", { headers: AH }));
    const { data } = await res.json();
    expect(data.recent.length).toBe(3);
    expect(data.byEvent.e.length).toBe(3);

    const res2 = await app.fetch(new Request("http://x/admin/errors?range=today&limit=99999", { headers: AH }));
    expect((await res2.json()).data.recent.length).toBe(10);
  });
});
describe("GET /admin/providers runtime state", () => {  test("upstream 500 puts provider in cooldown and is exposed", async () => {
    const { db, app } = seed([]);
    const upstream = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    db.query("UPDATE providers SET base_url=? WHERE id=1").run(`http://localhost:${upstream.port}`);
    const failure = await app.fetch(
      new Request("http://x/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer sk-test" },
        body: JSON.stringify({ model: "m", messages: [] }),
      })
    );
    expect(failure.status).toBe(502);
    upstream.stop(true);

    const res = await app.fetch(new Request("http://x/admin/providers", { headers: AH }));
    const { data } = await res.json();
    expect(data.length).toBe(1);
    expect(data[0].cooldown_until).toBeGreaterThan(Date.now());
    expect(data[0].unavailable).toBe(false);
  });

  test("untouched provider reports idle runtime", async () => {
    const { app } = seed([]);
    const res = await app.fetch(new Request("http://x/admin/providers", { headers: AH }));
    const { data } = await res.json();
    expect(data[0].unavailable).toBe(false);
    expect(data[0].cooldown_until).toBe(0);
  });
});

describe("route pricing API", () => {
  const URL_ROUTES = "http://x/admin/routes";
  const jsonH = { ...AH, "Content-Type": "application/json" };
  const post = (body: unknown) => new Request(URL_ROUTES, { method: "POST", headers: jsonH, body: JSON.stringify(body) });
  const put = (query: string, body: unknown) => new Request(`${URL_ROUTES}?${query}`, { method: "PUT", headers: jsonH, body: JSON.stringify(body) });
  const list = async (app: ReturnType<typeof seed>["app"]) =>
    ((await (await app.fetch(new Request(URL_ROUTES, { headers: AH }))).json()) as {
      data: { gateway_model: string; pricing: unknown }[];
    }).data;

  const pricing = {
    default: { price_input: 0.15, price_output: 0.6, price_cache_read: 0.003, price_cache_write: 0 },
    rules: [{ windows: ["01:00-04:00", "06:00-10:00"], days: [1, 2, 3, 4, 5], price_input: 0.3, price_output: 1.2 }],
  };

  test("accepts pricing with rules; both GETs return it parsed", async () => {
    const { app } = seed([]);
    const res = await app.fetch(post({ gateway_model: "m", provider_id: 1, provider_model: "m-up", priority: 1, pricing }));
    expect(res.status).toBe(200);
    expect((await list(app))[0].pricing).toEqual(pricing);
    const detail = (await (await app.fetch(new Request("http://x/admin/providers/1", { headers: AH }))).json()) as {
      data: { routes: { pricing: unknown }[] };
    };
    expect(detail.data.routes[0].pricing).toEqual(pricing);
  });

  test("omitted pricing writes four zeros", async () => {
    const { app } = seed([]);
    const res = await app.fetch(post({ gateway_model: "m2", provider_id: 1, provider_model: "m", priority: 1 }));
    expect(res.status).toBe(200);
    const row = (await list(app)).find((r) => r.gateway_model === "m2");
    expect(row?.pricing).toEqual({ default: { price_input: 0, price_output: 0, price_cache_read: 0, price_cache_write: 0 } });
  });

  test("flat price fields are rejected with a mapping hint", async () => {
    const { app } = seed([]);
    const res = await app.fetch(post({ gateway_model: "m3", provider_id: 1, provider_model: "m", price_input: 1 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("pricing.default.price_input");
    const viaPut = await app.fetch(put("gateway_model=m&provider_id=1&provider_model=m-up", { price_output: 1 }));
    expect(viaPut.status).toBe(400);
    const viaProvider = await app.fetch(
      new Request("http://x/admin/providers/1", {
        method: "PUT",
        headers: jsonH,
        body: JSON.stringify({ name: "p1", base_url: "http://up", api_key: "k", routes: [{ gateway_model: "m", provider_model: "m-up", priority: 1, price_output: 1 }] }),
      })
    );
    expect(viaProvider.status).toBe(400);
  });

  test("invalid pricing → 400 on POST and PUT", async () => {
    const { app } = seed([]);
    const bad = [
      { default: { price_input: -1, price_output: 1, price_cache_read: 0, price_cache_write: 0 } },
      { default: { price_input: 1, price_output: 1, price_cache_read: 0 } },
      { default: { price_input: 1, price_output: 1, price_cache_read: 0, price_cache_write: 0 }, rules: [{ windows: ["99:00-10:00"] }] },
      {
        default: { price_input: 1, price_output: 1, price_cache_read: 0, price_cache_write: 0 },
        rules: [{ windows: ["01:00-02:00"], days: [7] }],
      },
      { default: { price_input: 1, price_output: 1, price_cache_read: 0, price_cache_write: 0 }, rules: [{ windows: [] }] },
      "nope",
      null,
    ];
    for (const p of bad) {
      const res = await app.fetch(post({ gateway_model: "mb", provider_id: 1, provider_model: "m", pricing: p }));
      expect(res.status).toBe(400);
    }
    const viaPut = await app.fetch(put("gateway_model=m&provider_id=1&provider_model=m-up", { pricing: { default: {} } }));
    expect(viaPut.status).toBe(400);
    expect((await list(app))[0].pricing).toEqual({ default: { price_input: 0, price_output: 0, price_cache_read: 0, price_cache_write: 0 } });
  });

  test("unchanged route keeps its pricing when PUT touches only priority", async () => {
    const { app } = seed([]);
    await app.fetch(post({ gateway_model: "m", provider_id: 1, provider_model: "m-up", priority: 1, pricing }));
    const res = await app.fetch(put("gateway_model=m&provider_id=1&provider_model=m-up", { priority: 7 }));
    expect(res.status).toBe(200);
    expect((await list(app))[0].pricing).toEqual(pricing);
  });
});
