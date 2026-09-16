export const CANONICAL_REASONING_FIELD = "reasoning_content";
const LEGACY_REASONING_FIELD = "reasoning";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renameReasoning(target: Record<string, unknown>): boolean {
  if (typeof target[LEGACY_REASONING_FIELD] !== "string") return false;
  if (typeof target[CANONICAL_REASONING_FIELD] !== "string") {
    target[CANONICAL_REASONING_FIELD] = target[LEGACY_REASONING_FIELD];
  }
  delete target[LEGACY_REASONING_FIELD];
  return true;
}

export function normalizeRequestMessages(body: Record<string, unknown>, requiresReasoningContent: boolean): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (renameReasoning(message)) changed = true;
    if (requiresReasoningContent && typeof message[CANONICAL_REASONING_FIELD] !== "string") {
      message[CANONICAL_REASONING_FIELD] = "";
      changed = true;
    }
  }
  return changed;
}

export function normalizeResponseChunk(obj: Record<string, unknown>): boolean {
  if (!Array.isArray(obj.choices)) return false;
  let changed = false;
  for (const choice of obj.choices) {
    if (!isRecord(choice) || !isRecord(choice.delta)) continue;
    if (renameReasoning(choice.delta)) changed = true;
  }
  return changed;
}

export function normalizeResponseBody(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return text;
  let changed = false;
  for (const choice of parsed.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue;
    if (renameReasoning(choice.message)) changed = true;
  }
  return changed ? JSON.stringify(parsed) : text;
}
