import type { Database } from "bun:sqlite";
import type { Router, UnitRuntime } from "./router";
import { upstreamUrl, applyAuth } from "./dialect";
import type { ApiDialect } from "./dialect";
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
  for (const unit of router.unavailableUnits()) {
    const ok = await probeUnit(unit);
    if (ok) {
      router.markAvailable(unit.provider.id, unit.gatewayModel);
      await logError({ level: "info", event: "probe_recovered", provider: unit.provider.name, model: unit.gatewayModel });
    } else {
      await logError({ level: "error", event: "probe_still_failing", provider: unit.provider.name, model: unit.gatewayModel });
    }
  }
}

export async function probeUnit(unit: UnitRuntime): Promise<boolean> {
  const { provider, route, gatewayModel } = unit;
  try {
    const res = await fetch(upstreamUrl(provider, route.api as ApiDialect), {
      method: "POST",
      headers: buildProbeHeaders(provider, route.api as ApiDialect),
      body: JSON.stringify({
        model: route.provider_model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) await drainSafe(res);
    return res.ok;
  } catch (err) {
    await logError({ level: "error", event: "probe_failed", provider: provider.name, model: gatewayModel, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function buildProbeHeaders(provider: UnitRuntime["provider"], api: ApiDialect): Headers {
  const h = new Headers();
  applyAuth(h, provider, api);
  h.set("Content-Type", "application/json");
  return h;
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