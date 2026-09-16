import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "./db";
import { Router, classifyError } from "./router";
import type { ProviderRuntime } from "./router";
import type { Database } from "bun:sqlite";

function setup(): { db: Database; router: Router } {  const db = openDb(":memory:");
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1,'primary','http://p','k')").run();
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (2,'backup','http://b','k')").run();
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (3,'last','http://l','k')").run();
  const insRoute = db.query(
    "INSERT INTO routes(gateway_model, provider_id, provider_model, priority) VALUES (?,?,?,?)"
  );
  insRoute.run("glm", 1, "glm", 10);
  insRoute.run("glm", 2, "glm", 5);
  insRoute.run("glm", 3, "glm", 1);
  let cooldown = 5;
  const router = new Router(db, () => cooldown);
  return { db, router };
}

const pricingJson = (input: number, output: number, cacheRead: number): string =>
  JSON.stringify({
    default: { price_input: input, price_output: output, price_cache_read: cacheRead, price_cache_write: 0 },
  });

function priceSetup(dynamic: boolean): { db: Database; router: Router } {
  const db = openDb(":memory:");
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1,'primary','http://p','k')").run();
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (2,'backup','http://b','k')").run();
  db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (3,'last','http://l','k')").run();
  const insRoute = db.query(
    "INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing) VALUES (?,?,?,?,?)"
  );
  insRoute.run("m", 1, "m", 10, pricingJson(0.3, 1.2, 0.006));
  insRoute.run("m", 2, "m", 5, pricingJson(0.15, 0.6, 0.003));
  insRoute.run("m", 3, "m", 1, pricingJson(0.15, 0.6, 0.003));
  if (dynamic) db.query("UPDATE settings SET value='1' WHERE key='dynamic_priority'").run();
  return { db, router: new Router(db, () => 5) };
}

const names = (list: ProviderRuntime[]): string[] => list.map((p) => p.provider.name);

async function waitLines(lines: () => string[], n: number): Promise<string[]> {
  for (let i = 0; i < 60; i++) {
    if (lines().length >= n) return lines();
    await Bun.sleep(25);
  }
  return lines();
}

describe("classifyError", () => {
  test("4xx matrix per spec", () => {
    expect(classifyError(401)).toBe("unavailable");
    expect(classifyError(402)).toBe("unavailable");
    expect(classifyError(403)).toBe("unavailable");
    expect(classifyError(429)).toBe("unavailable");
    expect(classifyError(400)).toBe("nofailover");
    expect(classifyError(404)).toBe("nofailover");
    expect(classifyError(422)).toBe("nofailover");
  });
  test("5xx / network / timeout → cooldown", () => {
    expect(classifyError(500)).toBe("cooldown");
    expect(classifyError(502)).toBe("cooldown");
    expect(classifyError(null, new Error("timeout"))).toBe("cooldown");
    expect(classifyError(null)).toBe("cooldown");
  });
  test("2xx → ok", () => {
    expect(classifyError(200)).toBe("ok");
  });
});

describe("Router.pick", () => {
  test("priority descending", () => {
    const { router } = setup();
    const picked = router.pick("glm");
    expect(picked.map((p) => p.provider.name)).toEqual(["primary", "backup", "last"]);
  });

  test("unavailable and cooldown skipped", () => {
    const { router } = setup();
    const picked = router.pick("glm");
    router.markResult(picked[0], "unavailable");
    router.markResult(picked[1], "cooldown");
    const after = router.pick("glm");
    expect(after.map((p) => p.provider.name)).toEqual(["last"]);
  });

  test("cooldown expires → back in pool", () => {
    const { router } = setup();
    const [primary] = router.pick("glm");
    router.markResult(primary, "cooldown");
    expect(router.pick("glm").map((p) => p.provider.name)).toEqual(["backup", "last"]);
    const later = Date.now() + 6 * 60_000;
    expect(router.pick("glm", later).map((p) => p.provider.name)).toEqual(["primary", "backup", "last"]);
  });

  test("invalidate picks up new config", () => {
    const { db, router } = setup();
    db.query("UPDATE providers SET enabled=0 WHERE name='primary'").run();
    router.invalidate();
    expect(router.pick("glm").map((p) => p.provider.name)).toEqual(["backup", "last"]);
  });

  test("disabled provider excluded entirely", () => {
    const { router } = setup();
    const [primary] = router.pick("glm");
    router.markResult(primary, "unavailable");
    expect(router.pick("glm").map((p) => p.provider.name)).toEqual(["backup", "last"]);
  });

  test("unknown model → empty", () => {
    const { router } = setup();
    expect(router.pick("nope")).toEqual([]);
  });

  test("cooldown not extended by repeated failures", () => {
    const { router } = setup();
    const [primary] = router.pick("glm");
    const t0 = Date.now();
    router.markResult(primary, "cooldown", t0);
    router.markResult(primary, "cooldown", t0 + 30_000);
    router.markResult(primary, "cooldown", t0 + 59_000);
    expect(router.pick("glm", t0 + 6 * 60_000).map((p) => p.provider.name)).toEqual(["primary", "backup", "last"]);
  });

  test("cooldown uses injectable minutes", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1,'p','http://x','k')").run();
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model, priority) VALUES ('m',1,'m',1)").run();
    let minutes = 5;
    const router = new Router(db, () => minutes);
    const [p] = router.pick("m");
    router.markResult(p, "cooldown");
    expect(router.pick("m", Date.now() + 4 * 60_000)).toEqual([]);
    expect(router.pick("m", Date.now() + 6 * 60_000).length).toBe(1);
    minutes = 30;
    router.markAvailable(p);
    router.markResult(p, "cooldown");
    expect(router.pick("m", Date.now() + 6 * 60_000)).toEqual([]);
    expect(router.pick("m", Date.now() + 31 * 60_000).length).toBe(1);
  });
});
describe("Router.states", () => {
  test("reflects cooldown and unavailable for API exposure", () => {
    const { router } = setup();
    const [primary] = router.pick("glm");
    expect(router.states()[1]).toEqual({ unavailable: false, cooldown_until: 0 });
    router.markResult(primary, "cooldown");
    expect(router.states()[1].cooldown_until).toBeGreaterThan(Date.now());
    router.markResult(primary, "unavailable");
    expect(router.states()[1]).toEqual({ unavailable: true, cooldown_until: 0 });
  });
});

describe("Router dynamic price order", () => {
  test("off: priority descending even when a cheaper provider exists", () => {
    const { router } = priceSetup(false);
    expect(names(router.pick("m"))).toEqual(["primary", "backup", "last"]);
    expect(router.orderBasis().dynamic).toBe(false);
    expect(router.orderBasis().rankOf("m", 2)).toBe(2);
  });

  test("on: ascending price index, equal index falls back to priority", () => {
    const { router } = priceSetup(true);
    expect(names(router.pick("m"))).toEqual(["backup", "last", "primary"]);
    const basis = router.orderBasis();
    expect(basis.dynamic).toBe(true);
    expect(basis.ts).toBeGreaterThan(0);
    expect(basis.rankOf("m", 2)).toBe(1);
    expect(basis.rankOf("m", 1)).toBe(3);
  });

  test("on: unavailable and cooldown filtered before ranking", () => {
    const { router } = priceSetup(true);
    const [backup] = router.pick("m");
    router.markResult(backup, "unavailable");
    expect(names(router.pick("m"))).toEqual(["last", "primary"]);
  });

  test("on: routeFor keeps the provider's highest-priority route", () => {
    const { db, router } = priceSetup(true);
    db.query(
      "INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing) VALUES ('m',1,'m-flagship',20,?)"
    ).run(pricingJson(0.01, 0.02, 0.001));
    router.invalidate();
    const [first] = router.pick("m");
    expect(first.provider.name).toBe("primary");
    expect(router.routeFor(first, "m").provider_model).toBe("m-flagship");
  });

  test("tick: reorder only after 10 minutes", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1,'primary','http://p','k')").run();
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (2,'backup','http://b','k')").run();
    const ins = db.query(
      "INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing) VALUES (?,?,?,?,?)"
    );
    ins.run(
      "m",
      1,
      "m",
      10,
      JSON.stringify({
        default: { price_input: 0.3, price_output: 1.2, price_cache_read: 0.006, price_cache_write: 0 },
        rules: [
          { windows: ["00:05-04:00"], price_input: 0.05, price_output: 0.2, price_cache_read: 0.001 },
        ],
      })
    );
    ins.run("m", 2, "m", 5, pricingJson(0.15, 0.6, 0.003));
    db.query("UPDATE settings SET value='1' WHERE key='dynamic_priority'").run();
    const router = new Router(db, () => 5);
    const t0 = Date.parse("2026-09-14T00:00:00Z");
    expect(names(router.pick("m", t0))).toEqual(["backup", "primary"]);
    expect(names(router.pick("m", t0 + 9 * 60_000))).toEqual(["backup", "primary"]);
    expect(names(router.pick("m", t0 + 11 * 60_000))).toEqual(["primary", "backup"]);
  });
});

describe("Router dynamic order log", () => {
  test("logs routing_order_changed only when the order changes", async () => {
    const dir = mkdtempSync(`${tmpdir()}/bunway-order-log-`);
    const prevDir = process.env.LOG_DIR;
    process.env.LOG_DIR = dir;
    try {
      const { db, router } = priceSetup(true);
      const file = `${dir}/error-${new Date().toISOString().slice(0, 10)}.log`;
      const lines = () =>
        existsSync(file)
          ? readFileSync(file, "utf-8")
              .split("\n")
              .filter((l) => l.includes("routing_order_changed"))
          : [];

      router.pick("m");
      expect((await waitLines(lines, 1)).length).toBe(1);

      db.query("UPDATE routes SET pricing=? WHERE provider_id=1").run(pricingJson(0.15, 0.6, 0.003));
      db.query("UPDATE settings SET value='0' WHERE key='dynamic_priority'").run();
      router.invalidate();
      router.pick("m");
      await Bun.sleep(120);
      expect(lines().length).toBe(1);

      db.query("UPDATE settings SET value='1' WHERE key='dynamic_priority'").run();
      router.invalidate();
      router.pick("m");
      const after = await waitLines(lines, 2);
      expect(after.length).toBe(2);
      const entry = JSON.parse(after[1]) as Record<string, unknown>;
      expect(entry.level).toBe("info");
      expect(entry.event).toBe("routing_order_changed");
      expect(entry.from).toEqual([2, 3, 1]);
      expect(entry.to).toEqual([1, 2, 3]);

      router.invalidate();
      router.pick("m");
      await Bun.sleep(120);
      expect(lines().length).toBe(2);

      const first = JSON.parse(after[0]) as Record<string, unknown>;
      expect(first.from).toBeNull();
    } finally {
      process.env.LOG_DIR = prevDir;
    }
  });
});

describe("Router.reload pricing gate", () => {
  test("route with unparseable pricing is dropped, valid siblings survive", () => {
    const { db, router } = setup();
    expect(router.routeFor(router.pick("glm")[0], "glm").pricing.default.price_input).toBe(0);
    db.query("UPDATE routes SET pricing='{oops' WHERE provider_id=1").run();
    db.query(
      `UPDATE routes SET pricing='{"default":{"price_input":0.3,"price_output":1.2,"price_cache_read":0.006,"price_cache_write":0}}' WHERE provider_id=2`
    ).run();
    router.invalidate();
    expect(router.pick("glm").map((p) => p.provider.name)).toEqual(["backup", "last"]);
    expect(router.routeFor(router.pick("glm")[0], "glm").pricing.default.price_output).toBe(1.2);
  });

  test("provider whose only route is invalid disappears from candidates", () => {
    const { db, router } = setup();
    db.query("UPDATE routes SET pricing='nope' WHERE provider_id=3").run();
    router.invalidate();
    expect(router.pick("glm").map((p) => p.provider.name)).toEqual(["primary", "backup"]);
  });
});
