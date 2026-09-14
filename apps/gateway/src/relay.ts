import type { Provider } from "./db";
import { normalizeUsage, computeCost, recordUsage } from "./billing";
import type { NormalizedUsage } from "./billing";
import { logError } from "./tester";
import type { Database } from "bun:sqlite";

export type RelayRequest = {
  db: Database;
  provider: Provider;
  route: Parameters<typeof computeCost>[0];
  keyId: number | null;
  gatewayModel: string;
  body: string;
  clientHeaders: Headers;
  signal?: AbortSignal;
  startedAt?: number;
  firstByteAt?: number;
  idleTimeoutMs?: number;
};

const UPSTREAM_IDLE_TIMEOUT_MS = 60_000;

function buildHeaders(provider: Provider, clientHeaders: Headers): Headers {
  const h = new Headers();
  h.set("Authorization", `Bearer ${provider.api_key}`);
  h.set("Content-Type", "application/json");
  const meta = JSON.parse(provider.meta || "{}") as { forward_headers?: string[] };
  for (const name of meta.forward_headers ?? []) {
    const v = clientHeaders.get(name);
    if (v !== null) h.set(name, v);
  }
  return h;
}

export async function relay(req: RelayRequest): Promise<Response> {
  const url = `${req.provider.base_url.replace(/\/$/, "")}/v1/chat/completions`;
  const idleMs = req.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  const abort = new AbortController();
  const signal = req.signal ? AbortSignal.any([req.signal, abort.signal]) : abort.signal;
  const timer = setTimeout(() => abort.abort(new Error(`upstream idle ${idleMs}ms before response`)), idleMs);
  try {
    return await fetch(url, {
      method: "POST",
      headers: buildHeaders(req.provider, req.clientHeaders),
      body: req.body,
      signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  onStall: (err: Error) => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timer = setTimeout(() => {
    const err = new Error(`upstream idle ${idleMs}ms`);
    onStall(err);
    void reader.cancel(err).catch(() => {});
  }, idleMs);
  try {
    return await reader.read();
  } finally {
    clearTimeout(timer);
  }
}

export async function relayAndBill(req: RelayRequest, upstream: Response): Promise<Response> {
  const idleMs = req.idleTimeoutMs ?? UPSTREAM_IDLE_TIMEOUT_MS;
  const isStream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  if (!isStream) {
    const text = await readBodyText(req, upstream.body!.getReader(), idleMs);
    billFromJson(req, text);
    return new Response(text, {
      status: upstream.status,
      headers: new Headers({ "Content-Type": upstream.headers.get("content-type") ?? "application/json" }),
    });
  }
  return relayStream(req, upstream, idleMs);
}

async function readBodyText(req: RelayRequest, reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let interrupted: Error | null = null;
  while (true) {
    const { done, value } = await readChunk(reader, idleMs, (err) => {
      interrupted ??= err;
    });
    if (done) break;
    req.firstByteAt ??= Date.now();
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  if (interrupted) {
    void logInterrupted(req, interrupted, text.length);
    reader.releaseLock();
    throw interrupted;
  }
  return text;
}

function logInterrupted(req: RelayRequest, err: Error, bytesRead: number): void {
  void logError({
    level: "error",
    event: "upstream_interrupted",
    provider: req.provider.name,
    model: req.gatewayModel,
    bytes_read: bytesRead,
    error: err.message,
  });
}

function billFromJson(req: RelayRequest, text: string): void {
  try {
    const json = JSON.parse(text) as { usage?: unknown };
    bill(req, json.usage);
  } catch {
    bill(req, null);
  }
}

export function bill(req: RelayRequest, usage: unknown): NormalizedUsage | null {
  const normalized = normalizeUsage(usage);
  if (!normalized) return null;
  const ts = req.startedAt ?? Date.now();
  const cost = computeCost(req.route, normalized, ts);
  recordUsage(req.db, {
    ts,
    key_id: req.keyId,
    provider_id: req.provider.id,
    gateway_model: req.gatewayModel,
    provider_model: req.route.provider_model,
    usage: normalized,
    cost,
    latency_ms: req.startedAt ? Date.now() - req.startedAt : 0,
    ttft_ms: req.startedAt && req.firstByteAt ? req.firstByteAt - req.startedAt : 0,
    status: "ok",
  });
  return normalized;
}

async function relayStream(req: RelayRequest, upstream: Response, idleMs: number): Promise<Response> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let captured = false;
  let bytesRead = 0;
  let interrupted: string | null = null;
  let sawDone = false;
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let pending = "";
      try {
        while (!aborted) {
          let done: boolean;
          let value: Uint8Array | undefined;
          try {
            ({ done, value } = await readChunk(reader, idleMs, (err) => {
              interrupted ??= err.message;
              void logInterrupted(req, err, bytesRead);
            }));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            interrupted ??= message;
            void logInterrupted(req, err instanceof Error ? err : new Error(message), bytesRead);
            break;
          }
          if (done) break;
          req.firstByteAt ??= Date.now();
          bytesRead += value.byteLength;
          const text = pending + decoder.decode(value, { stream: true });
          const lines = text.split("\n");
          pending = lines.pop() ?? "";
          const outLines: string[] = [];
          for (const line of lines) {
            if (line.trim() === "data: [DONE]") sawDone = true;
            const parsed = parseSseData(line);
            if (parsed === null) {
              outLines.push(line);
              continue;
            }
            const obj = parsed as Record<string, unknown>;
            if (obj.usage != null) {
              bill(req, obj.usage);
              captured = true;
            }
            outLines.push(line);
          }
          if (outLines.length > 0) controller.enqueue(encoder.encode(outLines.join("\n") + "\n"));
        }
        if (pending) {
          if (pending.trim() === "data: [DONE]") sawDone = true;
          controller.enqueue(encoder.encode(pending));
        }
      } finally {
        if (aborted) {
          void logError({ level: "warn", event: "client_aborted", provider: req.provider.name, model: req.gatewayModel, bytes_read: bytesRead });
          void reader.cancel().catch(() => {});
        } else {
          if (interrupted === null && !sawDone) {
            interrupted = "upstream closed without [DONE]";
            void logInterrupted(req, new Error(interrupted), bytesRead);
          }
          if (interrupted !== null) {
            const chunk = {
              error: {
                message: `upstream interrupted after ${bytesRead} bytes: ${interrupted}`,
                type: "upstream_interrupted",
                code: "upstream_interrupted",
              },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (!captured) {
            void logError({ level: "warn", event: "usage_missing", provider: req.provider.name, model: req.gatewayModel });
          }
        }
        if (!aborted) controller.close();
        reader.releaseLock();
      }
    },
    cancel() {
      aborted = true;
    },
  });

  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  });
  return new Response(stream, { status: upstream.status, headers });
}

function parseSseData(line: string): unknown | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export function injectStreamUsage(body: string): { body: string; injected: boolean } {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    if (json.stream !== true) return { body, injected: false };
    const opts = json.stream_options as Record<string, unknown> | undefined;
    if (opts && opts.include_usage === true) return { body, injected: false };
    json.stream_options = { ...(opts ?? {}), include_usage: true };
    return { body: JSON.stringify(json), injected: true };
  } catch {
    return { body, injected: false };
  }
}

export function isFinalUsageChunk(json: Record<string, unknown>): boolean {
  return (
    Object.prototype.hasOwnProperty.call(json, "usage") &&
    json.usage != null &&
    Array.isArray(json.choices) &&
    json.choices.length === 0
  );
}