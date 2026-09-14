import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

export type Provider = {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  enabled: number;
  meta: string;
};

export type Route = {
  gateway_model: string;
  provider_id: number;
  provider_model: string;
  priority: number;
  pricing: string;
};

export type ClientKey = {
  id: number;
  name: string;
  key: string;
  enabled: number;
};

export type UsageRow = {
  id: number;
  ts: number;
  key_id: number | null;
  provider_id: number;
  gateway_model: string;
  provider_model: string;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost: number;
  latency_ms: number;
  status: string;
};

export const ZERO_PRICING =
  '{"default":{"price_input":0,"price_output":0,"price_cache_read":0,"price_cache_write":0}}';

export const DEFAULT_SETTINGS: Record<string, string> = {
  test_interval_minutes: "60",
  cooldown_minutes_5xx: "1",
};

export function openDb(path: string): Database {
  if (path !== ":memory:") {
    const dir = path.split("/").slice(0, -1).join("/");
    if (dir) mkdirSync(dir, { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS routes (
      gateway_model TEXT NOT NULL,
      provider_id INTEGER NOT NULL REFERENCES providers(id),
      provider_model TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      pricing TEXT NOT NULL DEFAULT '${ZERO_PRICING}',
      PRIMARY KEY (gateway_model, provider_id, provider_model)
    );
    CREATE TABLE IF NOT EXISTS client_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      key TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      key_id INTEGER REFERENCES client_keys(id),
      provider_id INTEGER NOT NULL REFERENCES providers(id),
      gateway_model TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      ttft_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
  `);
  try {
    db.exec("ALTER TABLE usage_log ADD COLUMN ttft_ms INTEGER NOT NULL DEFAULT 0");
  } catch {}
  const routeCols = (db.query("PRAGMA table_info(routes)").all() as { name: string }[]).map((c) => c.name);
  if (!routeCols.includes("pricing")) {
    db.exec(`ALTER TABLE routes ADD COLUMN pricing TEXT NOT NULL DEFAULT '${ZERO_PRICING}'`);
  }
  if (routeCols.includes("price_input")) {
    db.exec(`
      BEGIN;
      UPDATE routes SET pricing = json_object('default', json_object(
        'price_input', price_input, 'price_output', price_output,
        'price_cache_read', price_cache_read, 'price_cache_write', price_cache_write));
      ALTER TABLE routes DROP COLUMN price_input;
      ALTER TABLE routes DROP COLUMN price_output;
      ALTER TABLE routes DROP COLUMN price_cache_read;
      ALTER TABLE routes DROP COLUMN price_cache_write;
      COMMIT;`);
  }
  const put = db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) put.run(k, v);
  return db;
}