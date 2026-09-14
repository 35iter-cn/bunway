import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";

const base = Bun.env.GATEWAY_URL ?? "http://localhost:3101";
const token = Bun.env.ADMIN_TOKEN;
const dbPath = Bun.env.DB_PATH;
if (!token || !dbPath) throw new Error("ADMIN_TOKEN and DB_PATH are required");
const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function ready(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${base}/admin/providers`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) return;
    } catch {}
    await Bun.sleep(2000);
  }
  throw new Error("gateway did not become ready");
}

await ready();

const providersRes = await fetch(`${base}/admin/providers`, { headers: { Authorization: `Bearer ${token}` } });
const providers = (await providersRes.json()).data as Array<{ id: number; name: string }>;
let provider = providers.find((p) => p.name === "mock-upstream");
if (!provider) {
  const res = await fetch(`${base}/admin/providers`, {
    method: "POST", headers: auth,
    body: JSON.stringify({
      name: "mock-upstream", base_url: "http://mock-upstream:3102", api_key: "mock-key",
      routes: [
        { gateway_model: "fast-model", provider_model: "mock-model", priority: 10,
          pricing: { default: { price_input: 0.15, price_output: 0.5, price_cache_read: 0.03, price_cache_write: 0.03 } } },
        { gateway_model: "smart-model", provider_model: "mock-model", priority: 10,
          pricing: { default: { price_input: 1, price_output: 3, price_cache_read: 0.1, price_cache_write: 0.1 } } },
      ],
    }),
  });
  if (!res.ok) throw new Error(`provider create failed: ${res.status} ${await res.text()}`);
  const created = (await res.json()) as { id: number };
  provider = { id: created.id, name: "mock-upstream" };
}

const keysRes = await fetch(`${base}/admin/keys`, { headers: { Authorization: `Bearer ${token}` } });
const keys = (await keysRes.json()).data as Array<{ id: number; key: string }>;
let key = keys.find((k) => k.key === "sk-demo");
if (!key) {
  const res = await fetch(`${base}/admin/keys`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "demo", key: "sk-demo" }),
  });
  if (!res.ok) throw new Error(`key create failed: ${res.status} ${await res.text()}`);
  const created = (await res.json()) as { id: number };
  key = { id: created.id, key: "sk-demo" };
}

const db = new Database(dbPath);
const DAY = 86_400_000;
db.exec("DELETE FROM usage_log");
const ins = db.query(
  `INSERT INTO usage_log(ts, key_id, provider_id, gateway_model, provider_model,
     prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, cost, latency_ms, ttft_ms, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const price = {
  "fast-model": { input: 0.15, output: 0.5, cache_read: 0.03, cache_write: 0.03 },
  "smart-model": { input: 1, output: 3, cache_read: 0.1, cache_write: 0.1 },
};
const now = Date.now();
const tx = db.transaction(() => {
  for (let i = 0; i < 7 * 24; i++) {
    for (const model of ["fast-model", "smart-model"]) {
      const p = price[model as keyof typeof price];
      const inTok = 8000 + ((i * 137) % 42000);
      const outTok = 500 + ((i * 53) % 4000);
      const cacheRead = i % 3 === 0 ? Math.floor(inTok * 0.6) : 0;
      const hour = new Date(now - i * 3_600_000).getUTCHours();
      const peak = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
      const k = peak ? 1 : 0.5;
      const cost = (inTok * p.input + outTok * p.output + cacheRead * p.cache_read) / 1_000_000 * k;
      const rows = model === "fast-model" ? 3 : 1;
      for (let r = 0; r < rows; r++) {
        ins.run(now - i * 3_600_000 - r * 60_000, key.id, provider.id, model, "mock-model",
          inTok, outTok, cacheRead, 0, cost, 800 + ((i * 91) % 1500), 400 + ((i * 17) % 2200), "ok");
      }
    }
  }
});
tx();

const logsDir = Bun.env.LOG_DIR ?? "/data/logs";
mkdirSync(logsDir, { recursive: true });
const errTs = new Date(now - 3_600_000).toISOString();
appendFileSync(`${logsDir}/error-${errTs.slice(0, 10)}.log`, `${JSON.stringify({
  ts: errTs, level: "error", event: "upstream_error", provider: "mock-upstream",
  model: "fast-model", error: "sample error event planted by demo seed",
})}\n`);

console.log("seed done: provider, routes, client key, 7 days of usage, 1 sample error");