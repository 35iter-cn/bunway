import type { Database } from "bun:sqlite";
import type { Route } from "./db";

export type NormalizedUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

export type Prices = {
  price_input: number;
  price_output: number;
  price_cache_read: number;
  price_cache_write: number;
};

export type PricingRule = Partial<Prices> & { windows: string[]; days?: number[] };

export type Pricing = { default: Prices; rules?: PricingRule[] };

export type PricedRoute = Omit<Route, "pricing"> & { pricing: Pricing };

export const PRICE_KEYS = ["price_input", "price_output", "price_cache_read", "price_cache_write"] as const;

const WINDOW = /^([01]\d|2[0-3]):[0-5]\d-(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;

const isPrice = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function parsePricing(raw: string | null | undefined): Pricing | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const def = p.default as Record<string, unknown> | undefined;
  if (!def || typeof def !== "object" || Array.isArray(def)) return null;
  if (!PRICE_KEYS.every((k) => isPrice(def[k]))) return null;
  if (p.rules !== undefined) {
    if (!Array.isArray(p.rules)) return null;
    for (const r of p.rules) {
      if (!r || typeof r !== "object" || Array.isArray(r)) return null;
      const rule = r as Record<string, unknown>;
      if (!Array.isArray(rule.windows) || rule.windows.length === 0) return null;
      for (const w of rule.windows) {
        if (typeof w !== "string" || !WINDOW.test(w) || w.slice(0, 5) === w.slice(6)) return null;
      }
      if (rule.days !== undefined) {
        if (!Array.isArray(rule.days)) return null;
        if (!rule.days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) return null;
      }
      for (const k of PRICE_KEYS) {
        if (rule[k] !== undefined && !isPrice(rule[k])) return null;
      }
    }
  }
  return parsed as Pricing;
}

const toMins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function inWindow(w: string, ts: number): boolean {
  const start = toMins(w);
  const end = w.slice(6) === "24:00" ? 1440 : toMins(w.slice(6));
  const d = new Date(ts);
  const cur = d.getUTCHours() * 60 + d.getUTCMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export function matchRule(rules: PricingRule[], ts: number): PricingRule | null {
  const day = new Date(ts).getUTCDay();
  return rules.find((r) => (r.days ? r.days.includes(day) : true) && r.windows.some((w) => inWindow(w, ts))) ?? null;
}

export function resolvePrices(pricing: Pricing, ts: number): Prices {
  return { ...pricing.default, ...(matchRule(pricing.rules ?? [], ts) ?? {}) };
}

export function tierOf(pricing: Pricing, ts: number): number {
  const rules = pricing.rules ?? [];
  const hit = matchRule(rules, ts);
  return hit ? rules.indexOf(hit) : -1;
}

export function nextSwitch(pricing: Pricing, ts: number): { ts: number; rule: number } | null {
  if (!pricing.rules?.length) return null;
  const cur = tierOf(pricing, ts);
  const first = ts + 60_000 - (ts % 60_000);
  for (let t = first; t <= ts + 7 * 86_400_000; t += 60_000) {
    const rule = tierOf(pricing, t);
    if (rule !== cur) return { ts: t, rule };
  }
  return null;
}

export function normalizeUsage(usage: unknown): NormalizedUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const prompt = toNum(u.prompt_tokens);
  const completion = toNum(u.completion_tokens);
  if (prompt === null && completion === null) return null;

  let cacheRead = 0;
  let cacheWrite = 0;

  const dsHit = toNum(u.prompt_cache_hit_tokens);
  const cacheCreation = toNum(u.cache_creation_input_tokens);
  const details = u.prompt_tokens_details as Record<string, unknown> | undefined;
  if (dsHit !== null) {
    cacheRead = dsHit;
  } else if (details && typeof details === "object") {
    cacheRead = toNum(details.cached_tokens) ?? 0;
  }
  cacheWrite = cacheCreation ?? 0;

  return {
    prompt_tokens: prompt ?? 0,
    completion_tokens: completion ?? 0,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

function toNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

export function computeCost(route: PricedRoute, u: NormalizedUsage, ts: number): number {
  const p = resolvePrices(route.pricing, ts);
  const perM = (tokens: number, price: number) => (tokens / 1_000_000) * price;
  const inputBilled = Math.max(0, u.prompt_tokens - u.cache_read_tokens - u.cache_write_tokens);
  return (
    perM(inputBilled, p.price_input) +
    perM(u.completion_tokens, p.price_output) +
    perM(u.cache_read_tokens, p.price_cache_read || p.price_input) +
    perM(u.cache_write_tokens, p.price_cache_write || p.price_input)
  );
}

export function recordUsage(
  db: Database,
  row: {
    ts: number;
    key_id: number | null;
    provider_id: number;
    gateway_model: string;
    provider_model: string;
    usage: NormalizedUsage;
    cost: number;
    latency_ms: number;
    ttft_ms: number;
    status: string;
  }
): void {
  db.query(
    `INSERT INTO usage_log(ts, key_id, provider_id, gateway_model, provider_model,
       prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens,
       cost, latency_ms, ttft_ms, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.ts,
    row.key_id,
    row.provider_id,
    row.gateway_model,
    row.provider_model,
    row.usage.prompt_tokens,
    row.usage.completion_tokens,
    row.usage.cache_read_tokens,
    row.usage.cache_write_tokens,
    row.cost,
    row.latency_ms,
    row.ttft_ms,
    row.status
  );
}
