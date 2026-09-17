import type { Database } from "bun:sqlite";
import { openDb } from "./db";
import { Router, classifyError } from "./router";
import { relay, relayAndBill, injectStreamUsage, bill, providerMeta } from "./relay";
import { toMessagesRequest } from "./anthropic";
import { normalizeRequestMessages } from "./reasoning";
import { runAdminRoutes } from "./admin";
import { consoleRoutes } from "./static";
import { startTester, logError } from "./tester";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

export type GatewayEnv = {
  DB_PATH?: string;
  ADMIN_TOKEN?: string;
  STATIC_DIR?: string;
  PORT?: string;
};

export function createApp(db: Database, adminToken: string, staticDir = "./static") {
  const router = new Router(db, () => {
    const row = db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key='cooldown_minutes_5xx'").get();
    return Number(row?.value ?? 5);
  });

  async function handleV1(req: Request, url: URL): Promise<Response> {
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!key) return jsonError(401, "missing api key");
    const keyRow = db
      .query<{ id: number }, [string]>("SELECT id FROM client_keys WHERE key=? AND enabled=1")
      .get(key);
    if (!keyRow) return jsonError(401, "invalid api key");

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const models = db
        .query<{ gateway_model: string }, []>("SELECT DISTINCT gateway_model FROM routes ORDER BY gateway_model")
        .all();
      return Response.json({
        object: "list",
        data: models.map((m) => ({ id: m.gateway_model, object: "model", owned_by: "bunway" })),
      });
    }

    if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/responses")) {
      return handleCompletion(req, keyRow.id, url.pathname === "/v1/responses");
    }

    return jsonError(404, "not found");
  }

  async function handleCompletion(req: Request, keyId: number, responsesApi: boolean): Promise<Response> {
    let body: string;
    try {
      body = await req.text();
    } catch {
      return jsonError(400, "invalid body");
    }
    if (responsesApi) {
      body = await convertResponsesToChat(body);
      if (body === null) return jsonError(400, "invalid responses payload");
    }

    const parsed = JSON.parse(body) as { model?: string; stream?: boolean };
    const gatewayModel = parsed.model;
    if (!gatewayModel) return jsonError(400, "model is required");

    const candidates = router.pick(gatewayModel);
    if (candidates.length === 0) {
      void logError({ level: "error", event: "no_available_provider", model: gatewayModel });
      return jsonError(502, `no available provider for ${gatewayModel}`);
    }

    const started = Date.now();
    for (const candidate of candidates) {
      const route = candidate.route;
      const api = (route.api ?? "chat") as "chat" | "messages" | "responses";
      const bodyJson = JSON.parse(body) as Record<string, unknown>;
      bodyJson.model = route.provider_model;
      normalizeRequestMessages(bodyJson, providerMeta(candidate.provider).requires_reasoning_content === true);
      const upstreamBody =
        api === "messages"
          ? JSON.stringify(toMessagesRequest(bodyJson))
          : injectStreamUsage(JSON.stringify(bodyJson)).body;
      try {
        const upstream = await relay({
          db,
          provider: candidate.provider,
          route,
          api,
          keyId,
          gatewayModel,
          body: upstreamBody,
          clientHeaders: req.headers,
          signal: req.signal,
          startedAt: started,
        });
        if (upstream.ok) {
          router.markResult(gatewayModel, candidate.provider.id, "ok");
          const out = await relayAndBill(
            { db, provider: candidate.provider, route, api, keyId, gatewayModel, body: upstreamBody, clientHeaders: req.headers, startedAt: started },
            upstream
          );
          if (responsesApi && out.body) return convertChatToResponseStreamOrJson(out, gatewayModel);
          return out;
        }
        const cls = classifyError(upstream.status);
        router.markResult(gatewayModel, candidate.provider.id, cls);
        if (cls === "nofailover") {
          const errorBody = await upstream.text();
          void logError({ level: "error", event: "upstream_rejected", provider: candidate.provider.name, status: upstream.status, model: gatewayModel, error_body: errorBody.slice(0, 500) });
          return jsonError(upstream.status, `upstream ${candidate.provider.name} rejected request`);
        }
        const errorBody = await upstream.text();
        void logError({ level: "error", event: "upstream_failed", provider: candidate.provider.name, status: upstream.status, model: gatewayModel, error_body: errorBody.slice(0, 500) });
      } catch (err) {
        if (req.signal.aborted) {
          void logError({ level: "warn", event: "client_aborted", provider: candidate.provider.name, model: gatewayModel, phase: "upstream_call" });
          break;
        }
        void logError({ level: "error", event: "upstream_error", provider: candidate.provider.name, model: gatewayModel, error: err instanceof Error ? err.message : String(err) });
        router.markResult(gatewayModel, candidate.provider.id, classifyError(null, err));
      }
    }
    return jsonError(502, "all providers failed");
  }

  const adminRoutes = runAdminRoutes(db, adminToken, router);
  const consoleRoutesFor = consoleRoutes(staticDir);

  return {
    router,
    fetch(req: Request): Response | Promise<Response> {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ ok: true });
      if (url.pathname.startsWith("/console")) return consoleRoutesFor(url.pathname);
      if (url.pathname.startsWith("/admin")) return adminRoutes(req, url);
      if (url.pathname.startsWith("/v1")) return handleV1(req, url);
      return jsonError(404, "not found");
    },
  };
}

async function convertResponsesToChat(body: string): Promise<string | null> {
  const { convertRequest } = await import("./responses");
  return convertRequest(body);
}

async function convertChatToResponseStreamOrJson(resp: Response, gatewayModel: string): Promise<Response> {
  const { convertResponse } = await import("./responses");
  return convertResponse(resp, gatewayModel);
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: { message, type: "gateway_error", code: status } }, { status });
}

function ensureWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = `${dir}/.write-probe`;
    writeFileSync(probe, "ok");
    rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function main(): void {
  const env = (Bun.env ?? process.env) as GatewayEnv;
  const dbPath = env.DB_PATH ?? "data/gateway.db";
  const adminToken = env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error("ADMIN_TOKEN is required");
    process.exit(1);
  }
  const dataDir = dirname(dbPath);
  if (!ensureWritable(dataDir)) {
    console.error(`[fatal] data dir ${dataDir} not writable (uid ${process.getuid?.() ?? "?"}), run on host:`);
    console.error(`  sudo chown -R 1000:1000 <host data dir>`);
    process.exit(1);
  }
  const staticDir = env.STATIC_DIR ?? "./static";
  const db = openDb(dbPath);
  const app = createApp(db, adminToken, staticDir);
  const port = Number(env.PORT ?? 3001);
  startTester(db, app.router);
  Bun.serve({ port, fetch: app.fetch, idleTimeout: 0 });
  void logError({
    level: "info",
    event: "gateway_started",
    providers: Object.keys(app.router.states()).length,
    routes: app.router.pricedRoutes().length,
  });
  console.log(`bunway listening on :${port}`);
}
if (import.meta.main) main();
