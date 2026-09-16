import type { Database } from "bun:sqlite";
import type { Router } from "./router";
import { existsSync, readFileSync } from "node:fs";
import { PRICE_KEYS, parsePricing, resolvePrices, tierOf, nextSwitch, priceIndex } from "./billing";
import { ZERO_PRICING } from "./db";

export type ProviderInput = {
  name: string;
  base_url: string;
  api_key: string;
  enabled?: boolean;
  meta?: string;
  routes?: Array<{
    gateway_model: string;
    provider_model: string;
    priority: number;
    pricing?: unknown;
  }>;
};

export function runAdminRoutes(db: Database, adminToken: string, router: Router) {
  const STATS_RANGES: Record<string, number> = {
    today: 0,
    "7d": 7,
    "30d": 30,
  };

  function auth(req: Request): boolean {
    return (req.headers.get("authorization") ?? "") === `Bearer ${adminToken}`;
  }

  function invalidate(): void {
    router.invalidate();
  }

  type Priced = { ok: true; value: string } | { ok: false; error: string };

  // 写路径唯一闸门：拒绝旧扁平价、验证 pricing 结构，省略时回落四个 0
  function pricingColumn(input: Record<string, unknown>): Priced {
    for (const k of PRICE_KEYS) {
      if (input[k] !== undefined) return { ok: false, error: `${k} is no longer accepted, use pricing.default.${k}` };
    }
    if (input.pricing === undefined) return { ok: true, value: ZERO_PRICING };
    if (!input.pricing || typeof input.pricing !== "object" || Array.isArray(input.pricing)) {
      return { ok: false, error: "pricing must be an object: {default:{price_input,price_output,price_cache_read,price_cache_write},rules?:[...]}" };
    }
    const raw = JSON.stringify(input.pricing);
    if (!parsePricing(raw)) {
      return {
        ok: false,
        error:
          "invalid pricing: default needs four non-negative numbers; rules need windows " +
          "HH:MM-HH:MM (UTC, end may be 24:00) and optional days 0-6 and non-negative prices",
      };
    }
    return { ok: true, value: raw };
  }

  const withPricing = <T extends { pricing: string }>(row: T) => ({ ...row, pricing: parsePricing(row.pricing) });

  const insRoute = db.query(
    `INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(gateway_model, provider_id, provider_model) DO UPDATE SET
       priority=excluded.priority, pricing=excluded.pricing`
  );

  function providerExists(id: number): boolean {
    return !!db.query("SELECT 1 FROM providers WHERE id=?").get(id);
  }

  return function adminRoutes(req: Request, url: URL): Response | Promise<Response> {
    const path = url.pathname.replace(/\/$/, "");
    const method = req.method;

    if (!auth(req)) return jsonError(401, "invalid admin token");

    if (path === "/admin/providers") {
      if (method === "GET") {
        const states = router.states();
        const rows = db.query("SELECT * FROM providers").all() as Array<{ id: number }>;
        return Response.json({
          data: rows.map((p) => ({
            ...p,
            unavailable: states[p.id]?.unavailable ?? false,
            cooldown_until: states[p.id]?.cooldown_until ?? 0,
          })),
        });
      }
      if (method === "POST") return upsertProvider(req);
    }

    const providerMatch = path.match(/^\/admin\/providers\/(\d+)$/);
    if (providerMatch) {
      const id = Number(providerMatch[1]);
      if (method === "GET") {
        const provider = db.query("SELECT * FROM providers WHERE id=?").get(id) as Record<string, unknown> | undefined;
        if (!provider) return jsonError(404, "provider not found");
        const routes = db.query("SELECT * FROM routes WHERE provider_id=?").all(id).map(withPricing);
        return Response.json({ data: { ...provider, routes } });
      }
      if (method === "PUT") return upsertProvider(req, id);
      if (method === "DELETE") {
        db.query("DELETE FROM routes WHERE provider_id=?").run(id);
        db.query("DELETE FROM providers WHERE id=?").run(id);
        invalidate();
        return Response.json({ ok: true });
      }
    }

    if (path === "/admin/routes") {
      const gw = url.searchParams.get("gateway_model");
      const pidRaw = url.searchParams.get("provider_id");
      const pm = url.searchParams.get("provider_model");
      if (method === "GET") {
        const conds: string[] = [];
        const vals: (string | number)[] = [];
        if (gw) {
          conds.push("r.gateway_model=?");
          vals.push(gw);
        }
        if (pm) {
          conds.push("r.provider_model=?");
          vals.push(pm);
        }
        if (pidRaw !== null) {
          const pid = Number(pidRaw);
          if (!Number.isInteger(pid)) return jsonError(400, "provider_id must be an integer");
          conds.push("r.provider_id=?");
          vals.push(pid);
        }
        const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
        const rows = db
          .query(
            `SELECT r.*, p.name AS provider_name FROM routes r JOIN providers p ON p.id=r.provider_id${where} ORDER BY r.gateway_model, r.provider_id, r.provider_model`
          )
          .all(...vals)
          .map(withPricing);
        if (gw && pidRaw !== null && pm) {
          if (!rows.length) return jsonError(404, "route not found");
          return Response.json({ data: rows[0] });
        }
        return Response.json({ data: rows });
      }
      if (method === "DELETE") {
        if (!gw || !pm || pidRaw === null) return jsonError(400, "gateway_model, provider_id, provider_model query params required");
        const pid = Number(pidRaw);
        if (!Number.isInteger(pid)) return jsonError(400, "provider_id must be an integer");
        const res = db.query("DELETE FROM routes WHERE gateway_model=? AND provider_id=? AND provider_model=?").run(gw, pid, pm);
        if (res.changes === 0) return jsonError(404, "route not found");
        invalidate();
        return Response.json({ ok: true });
      }
      if (method === "POST") return createOrReplaceRoute(req);
      if (method === "PUT") return updateRoute(req, gw, pidRaw, pm);
    }

    if (path === "/admin/keys") {
      if (method === "GET") return Response.json({ data: db.query("SELECT * FROM client_keys").all() });
      if (method === "POST") return createKey(req);
    }

    const keyMatch = path.match(/^\/admin\/keys\/(\d+)$/);
    if (keyMatch) {
      const id = Number(keyMatch[1]);
      if (method === "DELETE") {
        db.query("DELETE FROM client_keys WHERE id=?").run(id);
        invalidate();
        return Response.json({ ok: true });
      }
      if (method === "PUT") return updateKey(req, id);
    }

    if (path === "/admin/settings") {
      if (method === "GET") return Response.json({ data: db.query("SELECT * FROM settings").all() });
      if (method === "PUT") return updateSettings(req);
    }

    if (path === "/admin/stats" && method === "GET") {
      const range = url.searchParams.get("range") ?? "7d";
      if (!(range in STATS_RANGES) && !url.searchParams.has("since")) return jsonError(400, `range must be one of ${Object.keys(STATS_RANGES).join("|")}`);
      return Response.json({ data: stats(resolveWindow(url)) });
    }

    if (path === "/admin/pricing" && method === "GET") {
      const ts = Date.now();
      const basis = router.orderBasis();
      const data = router.pricedRoutes().map((r) => ({
        gateway_model: r.gateway_model,
        provider_id: r.provider_id,
        provider_model: r.provider_model,
        priority: r.priority,
        pricing: r.pricing,
        now: { rule: tierOf(r.pricing, ts), prices: resolvePrices(r.pricing, ts) },
        next_switch: nextSwitch(r.pricing, ts),
        price_index: priceIndex(r, basis.ts),
        rank: basis.rankOf(r.gateway_model, r.provider_id),
      }));
      return Response.json({ ts, dynamic_priority: basis.dynamic, computed_at: basis.ts, data });
    }

    if (path === "/admin/ttft" && method === "GET") {
      const range = url.searchParams.get("range") ?? "today";
      if (!(range in STATS_RANGES) && !url.searchParams.has("since")) return jsonError(400, `range must be one of ${Object.keys(STATS_RANGES).join("|")}`);
      return Response.json({ data: ttft(resolveWindow(url)) });
    }

    if (path === "/admin/stats/timeseries" && method === "GET") {
      const range = url.searchParams.get("range") ?? "7d";
      if (!(range in STATS_RANGES) && !url.searchParams.has("since")) return jsonError(400, `range must be one of ${Object.keys(STATS_RANGES).join("|")}`);
      return Response.json({ data: timeseries(resolveWindow(url)) });
    }

    if (path === "/admin/errors" && method === "GET") {
      const range = url.searchParams.get("range") ?? "today";
      if (!(range in STATS_RANGES)) return jsonError(400, `range must be one of ${Object.keys(STATS_RANGES).join("|")}`);
      const limitRaw = Number(url.searchParams.get("limit") ?? 50);
      const limit = Math.min(500, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));
      const win = resolveWindow(url);
      return Response.json({ data: errorEvents(win, limit) });
    }

    return jsonError(404, "not found");
  };

  type Window = { since: number; until: number; tzMs: number; spanDays: number };

  // 客户端窗口:since/until(ms epoch) + tz(分钟,客户端 UTC 偏移);缺省回落 range 旧语义
  function resolveWindow(url: URL): Window {
    const sinceRaw = Number(url.searchParams.get("since"));
    const tzMin = Number(url.searchParams.get("tz") ?? 0);
    if (Number.isFinite(sinceRaw) && url.searchParams.has("since")) {
      const untilRaw = Number(url.searchParams.get("until"));
      const until = Number.isFinite(untilRaw) && url.searchParams.has("until") ? untilRaw : Date.now();
      const tzMs = Number.isFinite(tzMin) ? tzMin * 60_000 : 0;
      return { since: sinceRaw, until, tzMs, spanDays: (until - sinceRaw) / 86_400_000 };
    }
    const range = url.searchParams.get("range") ?? "7d";
    const days = STATS_RANGES[range] ?? 7;
    if (days === 0) {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return { since: d.getTime(), until: Date.now(), tzMs: 0, spanDays: 1 };
    }
    return { since: Date.now() - days * 86_400_000, until: Date.now(), tzMs: 0, spanDays: days };
  }

  function stats(win: Window) {
    const rows = db
      .query(
        `SELECT p.id AS provider_id, p.name AS provider, u.gateway_model, u.provider_model,
                SUM(u.prompt_tokens) AS prompt_tokens,
                SUM(u.completion_tokens) AS completion_tokens,
                SUM(u.cache_read_tokens) AS cache_read_tokens,
                SUM(u.cache_write_tokens) AS cache_write_tokens,
                SUM(u.cost) AS cost,
                COUNT(*) AS requests,
                SUM(CASE WHEN u.status != 'ok' THEN 1 ELSE 0 END) AS errors,
                AVG(CASE WHEN u.ttft_ms > 0 THEN u.ttft_ms END) AS ttft_avg
         FROM usage_log u JOIN providers p ON p.id = u.provider_id
         WHERE u.ts >= ? AND u.ts <= ?
         GROUP BY p.id, u.gateway_model, u.provider_model
         ORDER BY cost DESC`
      )
      .all(win.since, win.until) as Array<Record<string, number | string>>;
    const p95Stmt = db.query(
      `WITH s AS (
         SELECT provider_id, gateway_model, provider_model, ttft_ms,
           ROW_NUMBER() OVER (PARTITION BY provider_id, gateway_model, provider_model ORDER BY ttft_ms) rn,
           COUNT(*)     OVER (PARTITION BY provider_id, gateway_model, provider_model) cnt
         FROM usage_log WHERE ts >= ? AND ts <= ? AND ttft_ms > 0
       )
       SELECT provider_id, gateway_model, provider_model, ttft_ms AS ttft_p95 FROM s WHERE rn = (95 * cnt + 99) / 100`
    );
    const p95By: Record<string, number> = {};
    for (const p of p95Stmt.all(win.since, win.until) as Array<{
      provider_id: number;
      gateway_model: string;
      provider_model: string;
      ttft_p95: number;
    }>) {
      p95By[`${p.provider_id}|${p.gateway_model}|${p.provider_model}`] = p.ttft_p95;
    }
    for (const row of rows) {
      row.ttft_p95 = p95By[`${row.provider_id}|${row.gateway_model}|${row.provider_model}`] ?? null;
    }
    return rows;
  }

  function ttft(win: Window) {
    type Row = { scope: string; provider_id: number | null; p95: number; n: number; avg: number };
    const rows = db
      .query(
        `WITH s AS (
           SELECT provider_id, ttft_ms,
             ROW_NUMBER() OVER (PARTITION BY provider_id ORDER BY ttft_ms) rn_p,
             COUNT(*)     OVER (PARTITION BY provider_id) cnt_p,
             AVG(ttft_ms) OVER (PARTITION BY provider_id) avg_p,
             ROW_NUMBER() OVER (ORDER BY ttft_ms) rn_all,
             COUNT(*)     OVER () cnt_all,
             AVG(ttft_ms) OVER () avg_all
           FROM usage_log WHERE ts >= ? AND ts <= ? AND ttft_ms > 0
         )
         SELECT 'provider' AS scope, provider_id, ttft_ms AS p95, cnt_p AS n, avg_p AS avg FROM s WHERE rn_p = (95 * cnt_p + 99) / 100
         UNION ALL
         SELECT 'global', NULL, ttft_ms, cnt_all, avg_all FROM s WHERE rn_all = (95 * cnt_all + 99) / 100`
      )
      .all(win.since, win.until) as Row[];
    const names = new Map(
      (db.query("SELECT id, name FROM providers").all() as Array<{ id: number; name: string }>).map((p) => [p.id, p.name])
    );
    const global = rows.find((r) => r.scope === "global");
    return {
      global: global ? { p95: global.p95, avg: global.avg, n: global.n } : null,
      by_provider: rows
        .filter((r) => r.scope === "provider")
        .sort((a, b) => b.p95 - a.p95)
        .map((r) => ({
          provider_id: r.provider_id,
          name: names.get(r.provider_id as number) ?? String(r.provider_id),
          p95: r.p95,
          avg: r.avg,
          n: r.n,
        })),
    };
  }

  function timeseries(win: Window) {
    const bucketMs = win.spanDays > 2 ? 86_400_000 : win.spanDays <= 1 ? 1_800_000 : 3_600_000;
    const rows = db
      .query(
        `SELECT ((ts + ${win.tzMs}) / ${bucketMs}) * ${bucketMs} - ${win.tzMs} AS bucket,
                SUM(cost) AS cost,
                COUNT(*) AS requests,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END) AS errors,
                AVG(CASE WHEN ttft_ms > 0 THEN ttft_ms END) AS ttft_avg,
                SUM(prompt_tokens + completion_tokens) AS tokens
         FROM usage_log WHERE ts >= ? AND ts <= ?
         GROUP BY bucket ORDER BY bucket`
      )
      .all(win.since, win.until) as Array<Record<string, number | null>>;
    const byBucket = new Map(rows.map((r) => [Number(r.bucket), r]));
    const start = Math.floor((win.since + win.tzMs) / bucketMs) * bucketMs - win.tzMs;
    const out: Array<Record<string, number | null>> = [];
    for (let b = start; b <= win.until; b += bucketMs) {
      out.push(byBucket.get(b) ?? { bucket: b, cost: 0, requests: 0, errors: 0, ttft_avg: null, tokens: 0 });
    }
    return out;
  }

  function errorEvents(win: Window, limit: number) {
    const dir = process.env.LOG_DIR ?? "/data/logs";
    const counts: Record<string, number> = {};
    const recent: Array<Record<string, unknown>> = [];
    const firstDay = new Date(win.since).toISOString().slice(0, 10);
    const lastDay = new Date(win.until).toISOString().slice(0, 10);
    for (let day = firstDay; day <= lastDay; day = nextDay(day)) {
      const file = `${dir}/error-${day}.log`;
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const t = Date.parse(String(entry.ts));
          if (t < win.since || t > win.until) continue;
          const event = String(entry.event ?? "unknown");
          counts[event] = (counts[event] ?? 0) + 1;
          recent.push(entry);
        } catch {}
      }
    }
    recent.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
    return { counts, recent: recent.slice(0, limit) };
  }

  function nextDay(day: string): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  async function upsertProvider(req: Request, id?: number): Promise<Response> {
    let input: ProviderInput;
    try {
      input = (await req.json()) as ProviderInput;
    } catch {
      return jsonError(400, "invalid json");
    }
    if (!input.name || !input.base_url || !input.api_key) return jsonError(400, "name, base_url, api_key are required");
    const meta = JSON.stringify(input.meta ?? {});

    let providerId: number;
    if (id) {
      db.query("UPDATE providers SET name=?, base_url=?, api_key=?, enabled=?, meta=? WHERE id=?").run(
        input.name,
        input.base_url,
        input.api_key,
        input.enabled === false ? 0 : 1,
        meta,
        id
      );
      providerId = id;
      if (input.routes !== undefined) {
        db.query("DELETE FROM routes WHERE provider_id=?").run(id);
      }
    } else {
      const res = db
        .query("INSERT INTO providers(name, base_url, api_key, enabled, meta) VALUES (?, ?, ?, ?, ?)")
        .run(input.name, input.base_url, input.api_key, input.enabled === false ? 0 : 1, meta);
      providerId = Number(res.lastInsertRowid);
    }

    const insRoute = db.query(
      `INSERT INTO routes(gateway_model, provider_id, provider_model, priority, pricing)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(gateway_model, provider_id, provider_model) DO UPDATE SET
         priority=excluded.priority, pricing=excluded.pricing`
    );
    for (const r of input.routes ?? []) {
      if (!r.gateway_model || !r.provider_model) return jsonError(400, "route needs gateway_model and provider_model");
      const priced = pricingColumn(r as unknown as Record<string, unknown>);
      if (!priced.ok) return jsonError(400, `route ${r.gateway_model}@${r.provider_model}: ${priced.error}`);
      insRoute.run(r.gateway_model, providerId, r.provider_model, r.priority ?? 1, priced.value);
    }
    invalidate();
    return Response.json({ ok: true, id: providerId }, { status: id ? 200 : 201 });
  }

  async function createOrReplaceRoute(req: Request): Promise<Response> {
    const input = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof input.gateway_model !== "string" || !input.gateway_model) return jsonError(400, "gateway_model string required");
    if (!Number.isInteger(input.provider_id)) return jsonError(400, "provider_id integer required");
    if (typeof input.provider_model !== "string" || !input.provider_model) return jsonError(400, "provider_model string required");
    if (!providerExists(input.provider_id as number)) return jsonError(404, "provider not found");
    if (input.priority !== undefined && typeof input.priority !== "number") return jsonError(400, "priority must be a number");
    const priced = pricingColumn(input);
    if (!priced.ok) return jsonError(400, priced.error);
    insRoute.run(
      input.gateway_model,
      input.provider_id as number,
      input.provider_model,
      (input.priority as number) ?? 1,
      priced.value
    );
    invalidate();
    return Response.json({ ok: true });
  }

  async function updateRoute(req: Request, gw: string | null, pidRaw: string | null, pm: string | null): Promise<Response> {
    if (!gw || !pm || pidRaw === null) return jsonError(400, "gateway_model, provider_id, provider_model query params required");
    const oldPid = Number(pidRaw);
    if (!Number.isInteger(oldPid)) return jsonError(400, "provider_id must be an integer");
    const input = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const sets: string[] = [];
    const vals: (string | number)[] = [];
    if (input.gateway_model !== undefined) {
      if (typeof input.gateway_model !== "string" || !input.gateway_model) return jsonError(400, "gateway_model must be a non-empty string");
      sets.push("gateway_model=?");
      vals.push(input.gateway_model);
    }
    if (input.provider_model !== undefined) {
      if (typeof input.provider_model !== "string" || !input.provider_model) return jsonError(400, "provider_model must be a non-empty string");
      sets.push("provider_model=?");
      vals.push(input.provider_model);
    }
    if (input.provider_id !== undefined) {
      if (!Number.isInteger(input.provider_id)) return jsonError(400, "provider_id must be an integer");
      if (!providerExists(input.provider_id as number)) return jsonError(404, "provider not found");
      sets.push("provider_id=?");
      vals.push(input.provider_id as number);
    }
    const priced = pricingColumn(input);
    if (!priced.ok) return jsonError(400, priced.error);
    if (input.pricing !== undefined) {
      sets.push("pricing=?");
      vals.push(priced.value);
    }
    if (input.priority !== undefined) {
      if (typeof input.priority !== "number") return jsonError(400, "priority must be a number");
      sets.push("priority=?");
      vals.push(input.priority);
    }
    if (!sets.length) return jsonError(400, "no updatable fields in body");
    if (!db.query("SELECT 1 FROM routes WHERE gateway_model=? AND provider_id=? AND provider_model=?").get(gw, oldPid, pm))
      return jsonError(404, "route not found");
    vals.push(gw, oldPid, pm);
    try {
      db.query(`UPDATE routes SET ${sets.join(", ")} WHERE gateway_model=? AND provider_id=? AND provider_model=?`).run(...vals);
    } catch (e) {
      if (String(e).includes("UNIQUE")) return jsonError(409, "duplicate route");
      throw e;
    }
    invalidate();
    return Response.json({ ok: true });
  }

  async function createKey(req: Request): Promise<Response> {
    let input: { name?: string; key?: string };
    try {
      input = (await req.json()) as { name?: string; key?: string };
    } catch {
      return jsonError(400, "invalid json");
    }
    if (!input.name || !input.key) return jsonError(400, "name and key are required");
    try {
      db.query("INSERT INTO client_keys(name, key) VALUES (?, ?)").run(input.name, input.key);
    } catch {
      return jsonError(409, "duplicate name or key");
    }
    invalidate();
    return Response.json({ ok: true }, { status: 201 });
  }

  async function updateKey(req: Request, id: number): Promise<Response> {
    const input = (await req.json().catch(() => ({}))) as { enabled?: boolean };
    if (typeof input.enabled !== "boolean") return jsonError(400, "enabled boolean required");
    db.query("UPDATE client_keys SET enabled=? WHERE id=?").run(input.enabled ? 1 : 0, id);
    invalidate();
    return Response.json({ ok: true });
  }

  async function updateSettings(req: Request): Promise<Response> {
    let input: Record<string, unknown>;
    try {
      input = (await req.json()) as Record<string, unknown>;
    } catch {
      return jsonError(400, "invalid json");
    }
    const up = db.query("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    for (const [k, v] of Object.entries(input)) {
      if (typeof v !== "string" && typeof v !== "number") return jsonError(400, `setting ${k} must be string|number`);
      up.run(k, String(v));
    }
    invalidate();
    return Response.json({ ok: true });
  }

  return adminRoutes;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}