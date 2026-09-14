import type { Database } from "bun:sqlite";
import type { Router } from "./router";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";

const logDir = (): string => process.env.LOG_DIR ?? "/data/logs";
const LOG_RETENTION_DAYS = 7;

export function getSetting(db: Database, key: string, fallback: number): number {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key=?").get(key);
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function runTestOnce(db: Database, router: Router): Promise<void> {
  for (const pr of router.unavailableProviders()) {
    const route = pr.routes[0];
    if (!route) continue;
    let ok = false;
    try {
      const res = await fetch(`${pr.provider.base_url.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${pr.provider.api_key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: route.provider_model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      ok = res.ok;
      if (!ok) await drainSafe(res);
    } catch (err) {
      ok = false;
      await logError({ level: "error", event: "probe_failed", provider: pr.provider.name, error: err instanceof Error ? err.message : String(err) });
    }
    if (ok) {
      router.markAvailable(pr);
      await logError({ level: "info", event: "probe_recovered", provider: pr.provider.name });
    } else {
      await logError({ level: "error", event: "probe_still_failing", provider: pr.provider.name });
    }
  }
}

export function startTester(db: Database, router: Router): void {
  cleanupOldLogs();
  const tick = async () => {
    const minutes = getSetting(db, "test_interval_minutes", 60);
    await Bun.sleep(minutes * 60_000);
    await runTestOnce(db, router);
  };
  void (async () => {
    while (true) await tick();
  })();
}

export async function logError(entry: Record<string, unknown>): Promise<void> {
  try {
    const ts = new Date().toISOString();
    const dir = logDir();
    mkdirSync(dir, { recursive: true });
    await appendFile(`${dir}/error-${ts.slice(0, 10)}.log`, `${JSON.stringify({ ts, ...entry })}\n`);
    cleanupOldLogs();
  } catch {}
}

export function cleanupOldLogs(dir: string = logDir(), now: Date = new Date()): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const m = name.match(/^error-(\d{4}-\d{2}-\d{2})\.log$/);
    if (!m) continue;
    const fileDate = new Date(`${m[1]}T00:00:00Z`);
    if (now.getTime() - fileDate.getTime() > LOG_RETENTION_DAYS * 86_400_000) {
      try {
        unlinkSync(`${dir}/${name}`);
      } catch {}
    }
  }
}

async function drainSafe(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {}
}