export type StreamState = {
  stopReason: unknown;
  usage: unknown;
};

export function toMessagesRequest(chat: Record<string, unknown>): Record<string, unknown> | null {
  const messages = chat.messages;
  if (!Array.isArray(messages)) return null;

  const out: Record<string, unknown> = { model: chat.model, max_tokens: chat.max_tokens ?? 8192 };
  const system: string[] = [];
  const converted: Record<string, unknown>[] = [];
  for (const m of messages as Record<string, unknown>[]) {
    if (m.role === "system") {
      system.push(String(m.content ?? ""));
      continue;
    }
    if (m.role === "tool") {
      converted.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") }],
      });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
      if (typeof m.reasoning_content === "string" && m.reasoning_content) {
        blocks.push({ type: "text", text: m.reasoning_content });
      }
      for (const tc of (m.tool_calls ?? []) as Record<string, unknown>[]) {
        const fn = tc.function as Record<string, unknown>;
        blocks.push({ type: "tool_use", id: tc.id, name: fn.name, input: safeJson(fn.arguments) });
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }
    converted.push({ role: "user", content: m.content });
  }
  out.messages = mergeAdjacentToolResults(converted);
  if (system.length > 0) out.system = system.join("\n\n");

  if (Array.isArray(chat.tools) && (chat.tools as unknown[]).length > 0) {
    out.tools = (chat.tools as Record<string, unknown>[]).map((t) => {
      const fn = t.function as Record<string, unknown>;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters };
    });
    out.tool_choice = chat.tool_choice === "required" ? { type: "any" } : { type: "auto" };
  }
  if (chat.stream === true) out.stream = true;
  return out;
}

function safeJson(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return args as Record<string, unknown>;
  if (typeof args === "string" && args.trim()) {
    try {
      const parsed = JSON.parse(args);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function mergeAdjacentToolResults(msgs: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    const isToolResult = (x: Record<string, unknown>) =>
      Array.isArray(x.content) && (x.content as Record<string, unknown>[]).every((b) => b.type === "tool_result");
    if (prev && prev.role === "user" && m.role === "user" && isToolResult(prev) && isToolResult(m)) {
      prev.content = [...(prev.content as unknown[]), ...(m.content as unknown[])];
      continue;
    }
    out.push(m);
  }
  return out;
}

export function messagesToChat(msg: Record<string, unknown>, gatewayModel: string): Record<string, unknown> {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: Record<string, unknown>[] = [];
  for (const b of (msg.content ?? []) as Record<string, unknown>[]) {
    if (b.type === "text") text.push(String(b.text));
    else if (b.type === "thinking") thinking.push(String(b.thinking));
    else if (b.type === "tool_use") {
      toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    }
  }
  const choice: Record<string, unknown> = {
    index: 0,
    finish_reason:
      msg.stop_reason === "tool_use" ? "tool_calls" : msg.stop_reason === "max_tokens" ? "length" : "stop",
    message: {
      role: "assistant",
      content: text.join("") || null,
      ...(thinking.length ? { reasoning_content: thinking.join("") } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
  };
  return {
    id: msg.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: gatewayModel,
    choices: [choice],
    usage: usageToChat(msg.usage),
  };
}

function usageToChat(usage: unknown): Record<string, number> {
  const u = (usage ?? {}) as Record<string, unknown>;
  return {
    prompt_tokens: toNum(u.input_tokens),
    completion_tokens: toNum(u.output_tokens),
    prompt_cache_hit_tokens: toNum(u.cache_read_input_tokens),
    cache_creation_input_tokens: toNum(u.cache_creation_input_tokens),
  };
}

function toNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function messagesUsageOf(event: Record<string, unknown>): unknown | null {
  if (event.type === "message_start") return (event.message as Record<string, unknown> | undefined)?.usage ?? null;
  if (event.type === "message_delta") return event.usage ?? null;
  return null;
}

export function messagesEventChunks(
  event: Record<string, unknown>,
  state: StreamState,
  gatewayModel: string,
  id: string
): Record<string, unknown>[] {
  const type = event.type;
  if (type === "message_start") {
    state.stopReason = undefined;
    state.usage = undefined;
    return [{ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: gatewayModel, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }];
  }
  if (type === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    if (block?.type === "tool_use") {
      return [
        {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: gatewayModel,
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: event.index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] },
            },
          ],
        },
      ];
    }
    return [];
  }
  if (type === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta") {
      return [{ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: gatewayModel, choices: [{ index: 0, delta: { content: delta.text } }] }];
    }
    if (delta?.type === "thinking_delta") {
      return [{ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: gatewayModel, choices: [{ index: 0, delta: { reasoning_content: delta.thinking } }] }];
    }
    if (delta?.type === "input_json_delta") {
      return [
        {
          id,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: gatewayModel,
          choices: [{ index: 0, delta: { tool_calls: [{ index: event.index, function: { arguments: delta.partial_json } }] } }],
        },
      ];
    }
    return [];
  }
  if (type === "message_delta") {
    state.stopReason = event.delta ? (event.delta as Record<string, unknown>).stop_reason : undefined;
    state.usage = event.usage;
    return [];
  }
  if (type === "message_stop") {
    const finish =
      state.stopReason === "tool_use" ? "tool_calls" : state.stopReason === "max_tokens" ? "length" : "stop";
    const frames: Record<string, unknown>[] = [
      { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: gatewayModel, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ];
    if (state.usage) {
      frames.push({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: gatewayModel,
        choices: [],
        usage: usageToChat(state.usage),
      });
    }
    return frames;
  }
  if (type === "error") {
    return [{ error: (event.error as Record<string, unknown>) ?? { message: "upstream error" } }];
  }
  return [];
}