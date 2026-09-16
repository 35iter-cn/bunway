import { describe, test, expect } from "bun:test";
import { openDb } from "./db";
import {
  normalizeUsage,
  computeCost,
  recordUsage,
  parsePricing,
  inWindow,
  matchRule,
  resolvePrices,
  tierOf,
  nextSwitch,
  priceIndex,
} from "./billing";
import type { Pricing, PricedRoute } from "./billing";

const ZERO: Pricing = {
  default: { price_input: 0, price_output: 0, price_cache_read: 0, price_cache_write: 0 },
};

const pricing: Pricing = {
  default: { price_input: 1, price_output: 2, price_cache_read: 0.1, price_cache_write: 0 },
};

const route: PricedRoute = {
  gateway_model: "m",
  provider_id: 1,
  provider_model: "m",
  priority: 1,
  pricing,
};

const PEAK: Pricing = {
  default: { price_input: 0.15, price_output: 0.6, price_cache_read: 0.003, price_cache_write: 0 },
  rules: [
    {
      windows: ["01:00-04:00", "06:00-10:00"],
      days: [1, 2, 3, 4, 5],
      price_input: 0.3,
      price_output: 1.2,
      price_cache_read: 0.006,
    },
  ],
};

const at = (iso: string) => Date.parse(iso);

describe("normalizeUsage", () => {
  test("deepseek dialect → cache_read, cache_write=0 (miss stays at input price)", () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    });
    expect(u).toEqual({
      prompt_tokens: 1000,
      completion_tokens: 100,
      cache_read_tokens: 800,
      cache_write_tokens: 0,
    });
  });

  test("openai dialect cached_tokens", () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 600 },
    });
    expect(u?.cache_read_tokens).toBe(600);
    expect(u?.cache_write_tokens).toBe(0);
  });

  test("anthropic-style cache_creation → cache_write", () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 10,
      cache_creation_input_tokens: 500,
    });
    expect(u?.cache_write_tokens).toBe(500);
  });

  test("no usage tokens → null", () => {
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage({ foo: 1 })).toBeNull();
  });
});

describe("parsePricing", () => {
  test("accepts default + rules, including cross-midnight, 24:00 end and partial rules", () => {
    const raw = JSON.stringify({
      default: { price_input: 1, price_output: 2, price_cache_read: 3, price_cache_write: 4 },
      rules: [
        { windows: ["16:30-00:30"], price_input: 0.5 },
        { windows: ["00:00-24:00"], days: [0, 6], price_output: 0.25 },
      ],
    });
    const parsed = parsePricing(raw);
    expect(parsed?.rules?.length).toBe(2);
    expect(parsed?.rules?.[0].price_input).toBe(0.5);
    expect(parsed?.rules?.[0].price_output).toBeUndefined();
  });

  test("rejects malformed shapes", () => {
    const bad = [
      null,
      undefined,
      "",
      "{oops",
      "[]",
      "{}",
      JSON.stringify({ default: {} }),
      JSON.stringify({ default: { price_input: 1, price_output: 2, price_cache_read: 3 } }),
      JSON.stringify({ default: { price_input: -1, price_output: 2, price_cache_read: 3, price_cache_write: 4 } }),
      '{"default":{"price_input":1e999,"price_output":2,"price_cache_read":3,"price_cache_write":4}}',
      JSON.stringify({ default: pricing.default, rules: "nope" }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: [] }] }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: ["25:00-26:00"] }] }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: ["01:00-24:01"] }] }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: ["01:00-01:00"] }] }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: ["24:00"] }] }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: ["01:00-02:00"], days: [7] }] }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: ["01:00-02:00"], days: [-1] }] }),
      JSON.stringify({ default: pricing.default, rules: [{ windows: ["01:00-02:00"], price_input: -0.1 }] }),
    ];
    for (const raw of bad) expect(parsePricing(raw as string | null | undefined)).toBeNull();
  });
});

describe("inWindow", () => {
  test("half-open interval with both boundaries", () => {
    expect(inWindow("01:00-04:00", at("2026-09-14T01:00:00Z"))).toBe(true);
    expect(inWindow("01:00-04:00", at("2026-09-14T03:59:00Z"))).toBe(true);
    expect(inWindow("01:00-04:00", at("2026-09-14T04:00:00Z"))).toBe(false);
    expect(inWindow("01:00-04:00", at("2026-09-14T00:59:00Z"))).toBe(false);
  });

  test("cross-midnight matches both sides of midnight", () => {
    expect(inWindow("16:30-00:30", at("2026-09-14T16:30:00Z"))).toBe(true);
    expect(inWindow("16:30-00:30", at("2026-09-14T23:59:00Z"))).toBe(true);
    expect(inWindow("16:30-00:30", at("2026-09-14T00:10:00Z"))).toBe(true);
    expect(inWindow("16:30-00:30", at("2026-09-14T00:30:00Z"))).toBe(false);
    expect(inWindow("16:30-00:30", at("2026-09-14T12:00:00Z"))).toBe(false);
  });

  test("00:00-24:00 covers the whole day", () => {
    for (const h of ["00:00", "12:00", "23:59"]) {
      expect(inWindow("00:00-24:00", at(`2026-09-14T${h}:00Z`))).toBe(true);
    }
  });
});

describe("matchRule / resolvePrices", () => {
  test("days filter uses the ts weekday", () => {
    const monday = at("2026-09-14T02:00:00Z");
    const sunday = at("2026-09-13T02:00:00Z");
    expect(matchRule(PEAK.rules!, monday)?.price_input).toBe(0.3);
    expect(matchRule(PEAK.rules!, sunday)).toBeNull();
    expect(matchRule(PEAK.rules!, at("2026-09-14T05:00:00Z"))).toBeNull();
  });

  test("first match wins on overlapping rules", () => {
    const first = { windows: ["00:00-24:00"], price_input: 1 };
    const second = { windows: ["00:00-24:00"], price_input: 2 };
    expect(resolvePrices({ default: pricing.default, rules: [first, second] }, at("2026-09-14T10:00:00Z")).price_input).toBe(1);
  });

  test("no match returns exactly the default", () => {
    expect(resolvePrices(PEAK, at("2026-09-14T05:00:00Z"))).toEqual(PEAK.default);
    expect(resolvePrices(PEAK, at("2026-09-14T05:00:00Z"))).not.toBe(PEAK.default);
    expect(resolvePrices(ZERO, at("2026-09-14T02:00:00Z"))).toEqual(ZERO.default);
  });

  test("partial rule overrides only the fields it sets", () => {
    const p: Pricing = { default: { price_input: 1, price_output: 2, price_cache_read: 3, price_cache_write: 4 }, rules: [{ windows: ["00:00-24:00"], price_output: 9 }] };
    expect(resolvePrices(p, at("2026-09-14T12:00:00Z"))).toMatchObject({
      price_input: 1,
      price_output: 9,
      price_cache_read: 3,
      price_cache_write: 4,
    });
  });
});

describe("priceIndex", () => {
  test("input + output + cache read at the resolved tier", () => {
    const ts = at("2026-09-14T12:00:00Z");
    const peakRoute: PricedRoute = { ...route, pricing: PEAK };
    expect(priceIndex(route, ts)).toBeCloseTo(1 + 2 + 0.1, 10);
    expect(priceIndex(peakRoute, at("2026-09-14T02:00:00Z"))).toBeCloseTo(0.3 + 1.2 + 0.006, 10);
    expect(priceIndex(peakRoute, at("2026-09-14T05:00:00Z"))).toBeCloseTo(0.15 + 0.6 + 0.003, 10);
    expect(priceIndex(peakRoute, at("2026-09-13T02:00:00Z"))).toBeCloseTo(0.15 + 0.6 + 0.003, 10);
  });

  test("cache write is never counted", () => {
    const withWrite: PricedRoute = { ...route, pricing: { default: { ...pricing.default, price_cache_write: 9 } } };
    expect(priceIndex(withWrite, at("2026-09-14T12:00:00Z"))).toBeCloseTo(3.1, 10);
  });
});

describe("computeCost", () => {
  test("four-price billing", () => {
    const cost = computeCost(
      route,
      { prompt_tokens: 1_000_000, completion_tokens: 100_000, cache_read_tokens: 0, cache_write_tokens: 0 },
      at("2026-09-14T12:00:00Z")
    );
    expect(cost).toBeCloseTo(1 + 0.2, 10);
  });

  test("cache read billed at cache price, falls back to input price when unset", () => {
    const u = { prompt_tokens: 1_000_000, completion_tokens: 0, cache_read_tokens: 400_000, cache_write_tokens: 0 };
    const ts = at("2026-09-14T12:00:00Z");
    expect(computeCost(route, u, ts)).toBeCloseTo(0.6 * 1 + 0.4 * 0.1, 10);
    const noCachePrice: PricedRoute = {
      ...route,
      pricing: { default: { ...pricing.default, price_cache_read: 0 } },
    };
    expect(computeCost(noCachePrice, u, ts)).toBeCloseTo(1, 10);
  });

  test("deepseek: hit tokens at cache price, miss at input price", () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 0,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    })!;
    expect(computeCost(route, u, at("2026-09-14T12:00:00Z"))).toBeCloseTo((200 * 1 + 800 * 0.1) / 1_000_000, 15);
  });

  test("peak ts uses the rule, off-peak ts uses the default", () => {
    const peakRoute: PricedRoute = { ...route, pricing: PEAK };
    const u = { prompt_tokens: 1_000_000, completion_tokens: 1_000_000, cache_read_tokens: 0, cache_write_tokens: 0 };
    const inPeak = computeCost(peakRoute, u, at("2026-09-14T02:00:00Z"));
    const offPeak = computeCost(peakRoute, u, at("2026-09-14T05:00:00Z"));
    const weekend = computeCost(peakRoute, u, at("2026-09-13T02:00:00Z"));
    expect(inPeak).toBeCloseTo(0.3 + 1.2, 10);
    expect(offPeak).toBeCloseTo(0.15 + 0.6, 10);
    expect(weekend).toBeCloseTo(0.15 + 0.6, 10);
  });
});

describe("tierOf", () => {
  test("matched rule index, -1 when nothing matches", () => {
    expect(tierOf(PEAK, at("2026-09-14T02:00:00Z"))).toBe(0);
    expect(tierOf(PEAK, at("2026-09-14T05:00:00Z"))).toBe(-1);
    expect(tierOf(PEAK, at("2026-09-13T02:00:00Z"))).toBe(-1);
    expect(tierOf(ZERO, at("2026-09-14T02:00:00Z"))).toBe(-1);
  });

  test("agrees with matchRule on every 15-minute sample of a week", () => {
    const rules = PEAK.rules!;
    const sunday = Date.UTC(2024, 0, 7);
    for (let i = 0; i < 7 * 96; i++) {
      const ts = sunday + i * 900_000;
      const hit = matchRule(rules, ts);
      expect(tierOf(PEAK, ts)).toBe(hit ? rules.indexOf(hit) : -1);
    }
  });

  test("first match wins for identical rules", () => {
    const both = { windows: ["00:00-24:00"] };
    const p: Pricing = { default: pricing.default, rules: [both, { ...both, price_input: 9 }] };
    expect(tierOf(p, at("2026-09-14T10:00:00Z"))).toBe(0);
  });
});

describe("nextSwitch", () => {
  const overnight: Pricing = { default: pricing.default, rules: [{ windows: ["16:30-00:30"] }] };

  test("cross-midnight window reports the exact next minute, not an hour boundary", () => {
    expect(nextSwitch(overnight, at("2026-09-14T12:00:00Z"))).toEqual({ ts: at("2026-09-14T16:30:00Z"), rule: 0 });
    expect(nextSwitch(overnight, at("2026-09-14T17:00:00Z"))).toEqual({ ts: at("2026-09-15T00:30:00Z"), rule: -1 });
  });

  test("weekday-only rule rolls over the weekend", () => {
    expect(nextSwitch(PEAK, at("2026-09-18T10:30:00Z"))).toEqual({ ts: at("2026-09-21T01:00:00Z"), rule: 0 });
    expect(nextSwitch(PEAK, at("2026-09-19T12:00:00Z"))).toEqual({ ts: at("2026-09-21T01:00:00Z"), rule: 0 });
  });

  test("inside a window, reports the window end", () => {
    expect(nextSwitch(PEAK, at("2026-09-14T02:00:00Z"))).toEqual({ ts: at("2026-09-14T04:00:00Z"), rule: -1 });
  });

  test("missing rules or a week without change → null", () => {
    expect(nextSwitch({ default: pricing.default }, at("2026-09-14T10:00:00Z"))).toBeNull();
    expect(nextSwitch(ZERO, at("2026-09-14T10:00:00Z"))).toBeNull();
    expect(nextSwitch({ default: pricing.default, rules: [{ windows: ["00:00-24:00"] }] }, at("2026-09-14T10:00:00Z"))).toBeNull();
  });
});

describe("recordUsage", () => {
  test("persists row", () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO providers(id, name, base_url, api_key) VALUES (1,'p','http://x','k')").run();
    db.query("INSERT INTO client_keys(id, name, key) VALUES (1,'pi','sk')").run();
    const u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10 })!;
    recordUsage(db, {
      ts: 1,
      key_id: 1,
      provider_id: 1,
      gateway_model: "m",
      provider_model: "m",
      usage: u,
      cost: 0.5,
      latency_ms: 42,
      ttft_ms: 20,
      status: "ok",
    });
    const row = db.query("SELECT * FROM usage_log").get() as Record<string, unknown>;
    expect(row.prompt_tokens).toBe(100);
    expect(row.cost).toBe(0.5);
    expect(row.ttft_ms).toBe(20);
    expect(row.status).toBe("ok");
  });
});
