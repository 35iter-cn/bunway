import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb, DEFAULT_SETTINGS, ZERO_PRICING } from "./db";
import { unlinkSync, existsSync } from "node:fs";

const tmp = "/tmp/llmgw-db-test.db";
const legacy = "/tmp/llmgw-db-legacy.db";
if (existsSync(tmp)) unlinkSync(tmp);
if (existsSync(legacy)) unlinkSync(legacy);

const colsOf = (db: Database) =>
  (db.query("PRAGMA table_info(routes)").all() as { name: string }[]).map((c) => c.name);

describe("db", () => {
  test("creates tables and default settings", () => {
    const db = openDb(tmp);
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => r.name);
    for (const t of ["providers", "routes", "client_keys", "settings", "usage_log"]) {
      expect(tables).toContain(t);
    }
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get(k);
      expect(row?.value).toBe(v);
    }
  });

  test("default settings are INSERT OR IGNORE — re-open keeps overrides", () => {
    const db = openDb(tmp);
    db.query("UPDATE settings SET value='30' WHERE key='test_interval_minutes'").run();
    const again = openDb(tmp);
    const row = again.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get("test_interval_minutes");
    expect(row?.value).toBe("30");
  });

  test("FK constraint enforced on usage_log", () => {
    const db = openDb(tmp);
    db.query("INSERT INTO providers(name, base_url, api_key) VALUES ('p','http://x','k')").run();
    const pid = db.query<{ id: number }, []>("SELECT id FROM providers").get()!.id;
    expect(() =>
      db
        .query(
          "INSERT INTO usage_log(ts, key_id, provider_id, gateway_model, provider_model, status) VALUES (1, 999, ?, 'm', 'm', 'ok')"
        )
        .run(pid)
    ).toThrow();
  });

  test("fresh db has a single pricing column defaulting to four zeros", () => {
    const db = openDb(tmp);
    const cols = colsOf(db);
    expect(cols).toContain("pricing");
    for (const gone of ["price_input", "price_output", "price_cache_read", "price_cache_write"]) {
      expect(cols).not.toContain(gone);
    }
    db.query("INSERT OR IGNORE INTO providers(id, name, base_url, api_key) VALUES (1, 'p1', 'http://x', 'k')").run();
    db.query("INSERT INTO routes(gateway_model, provider_id, provider_model) VALUES ('fresh', 1, 'up')").run();
    const row = db.query<{ pricing: string }, []>("SELECT pricing FROM routes WHERE gateway_model='fresh'").get()!;
    expect(row.pricing).toBe(ZERO_PRICING);
  });

  test("migrates a legacy four-price routes table into one pricing column", () => {
    const old = new Database(legacy, { create: true });
    old.exec(`CREATE TABLE routes (
      gateway_model TEXT NOT NULL,
      provider_id INTEGER NOT NULL,
      provider_model TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 1,
      price_input REAL NOT NULL DEFAULT 0,
      price_output REAL NOT NULL DEFAULT 0,
      price_cache_read REAL NOT NULL DEFAULT 0,
      price_cache_write REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (gateway_model, provider_id, provider_model)
    )`);
    old
      .query(
        `INSERT INTO routes(gateway_model, provider_id, provider_model, priority,
           price_input, price_output, price_cache_read, price_cache_write)
         VALUES ('deepseek-flash', 2, 'deepseek-flash', 9, 0.3, 1.2, 0.006, 0)`
      )
      .run();
    old.close();

    const db = openDb(legacy);
    const cols = colsOf(db);
    expect(cols).toContain("pricing");
    for (const gone of ["price_input", "price_output", "price_cache_read", "price_cache_write"]) {
      expect(cols).not.toContain(gone);
    }
    const migrated = db.query<{ pricing: string; priority: number }, []>("SELECT priority, pricing FROM routes").get()!;
    expect(migrated.priority).toBe(9);
    expect(JSON.parse(migrated.pricing)).toEqual({
      default: { price_input: 0.3, price_output: 1.2, price_cache_read: 0.006, price_cache_write: 0 },
    });

    const again = openDb(legacy);
    expect(colsOf(again)).toEqual(cols);
    expect(again.query<{ pricing: string }, []>("SELECT pricing FROM routes").get()!.pricing).toBe(migrated.pricing);
  });
});