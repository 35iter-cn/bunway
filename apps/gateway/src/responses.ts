export type ChatMessage = Record<string, unknown>;

export function convertRequest(body: string): string | null {
  let req: Record<string, unknown>;
  try {
    req = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }

  const messages: ChatMessage[] = [];
  const instructions = req.instructions;
  if (typeof instructions === "string" && instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const input = req.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const msg = convertInputItem(item);
      if (msg) messages.push(msg);
    }
  }

  const out: Record<string, unknown> = {
    model: req.model,
    messages,
  };
  if (req.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (req.reasoning_effort !== undefined) out.reasoning_effort = req.reasoning_effort;
  if (Array.isArray(req.tools) && req.tools.length > 0) {
    out.tools = req.tools;
    out.tool_choice = req.tool_choice ?? "auto";
  }
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.max_output_tokens === "number") out.max_tokens = req.max_output_tokens;
  return JSON.stringify(out);
}

function convertInputItem(item: unknown): ChatMessage | null {
  if (!item || typeof item !== "object") return null;
  const it = item as Record<string, unknown>;
  const type = it.type;
  if (type === undefined || type === "message") {
    const role = typeof it.role === "string" ? it.role : "user";
    const content = extractText(it.content);
    return { role, content };
  }
  if (type === "function_call") {
    return {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: it.call_id ?? it.id,
          type: "function",
          function: { name: it.name, arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}) },
        },
      ],
    };
  }
  if (type === "function_call_output") {
    return { role: "tool", tool_call_id: it.call_id ?? it.id, content: extractText(it.output) };
  }
  if (type === "reasoning") {
    return null;
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const p = part as Record<string, unknown>;
        if (p.type === "input_text" || p.type === "output_text") return typeof p.text === "string" ? p.text : "";
        return "";
      })
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

let responseCounter = 0;

export async function convertResponse(resp: Response, gatewayModel: string): Promise<Response> {
  const isStream = (resp.headers.get("content-type") ?? "").includes("text/event-stream");
  const responseId = `resp_${Date.now()}_${++responseCounter}`;

  if (!isStream) {
    const text = await resp.text();
    const chat = JSON.parse(text) as Record<string, unknown>;
    return Response.json(nonStreamResponse(chat, gatewayModel, responseId));
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const state = {
    outputIndex: -1,
    textEmitted: false,
    calls: new Map<number, { id: string; name: string; args: string; callId: string }>(),
  };
  let capturedUsage: Record<string, number> | undefined;
  let errored = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = resp.body!.getReader();
      let pending = "";
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

      send("response.created", {
        type: "response.created",
        response: emptyResponse(gatewayModel, responseId, "in_progress"),
      });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = pending + decoder.decode(value, { stream: true });
          const lines = text.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) {
            const chunk = parseSse(line);
            if (chunk === null) continue;
            if (chunk.error != null) {
              errored = true;
              const err = chunk.error as Record<string, unknown>;
              send("error", {
                type: "error",
                code: err.code ?? "upstream_interrupted",
                message: err.message ?? "upstream interrupted",
              });
              continue;
            }
            if (chunk.usage != null) capturedUsage = normalizeUsageForResponses(chunk.usage);
            emitChatChunk(send, state, chunk, gatewayModel, responseId);
          }
        }
      } finally {
        if (!errored) {
          const finalResp = emptyResponse(gatewayModel, responseId, "completed");
          finalResp.usage = capturedUsage;
          send("response.completed", {
            type: "response.completed",
            response: finalResp,
          });
        }
        controller.close();
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    status: resp.status,
    headers: new Headers({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" }),
  });
}

function emitChatChunk(
  send: (event: string, data: unknown) => void,
  state: {
    outputIndex: number;
    textEmitted: boolean;
    calls: Map<number, { id: string; name: string; args: string; callId: string }>;
  },
  chunk: Record<string, unknown>,
  gatewayModel: string,
  responseId: string
): void {
  const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>> | undefined;

    if (typeof delta.content === "string" && delta.content) {
      if (!state.textEmitted) {
        state.outputIndex++;
        state.textEmitted = true;
        send("response.output_item.added", {
          type: "response.output_item.added",
          output_index: state.outputIndex,
          item: { type: "message", role: "assistant", status: "in_progress", content: [] },
        });
        send("response.content_part.added", {
          type: "response.content_part.added",
          output_index: state.outputIndex,
          part: { type: "output_text", text: "" },
        });
      }
      send("response.output_text.delta", {
        type: "response.output_text.delta",
        output_index: state.outputIndex,
        delta: delta.content,
      });
    }

    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const index = typeof tc.index === "number" ? tc.index : 0;
        let call = state.calls.get(index);
        if (!call) {
          const fn = (tc.function ?? {}) as Record<string, unknown>;
          call = {
            id: typeof tc.id === "string" ? tc.id : `call_${index}`,
            name: typeof fn.name === "string" ? fn.name : "",
            args: "",
            callId: typeof tc.id === "string" ? tc.id : `call_${index}`,
          };
          state.calls.set(index, call);
          state.outputIndex++;
          send("response.output_item.added", {
            type: "response.output_item.added",
            output_index: state.outputIndex,
            item: { type: "function_call", id: call.id, call_id: call.callId, name: call.name, arguments: "", status: "in_progress" },
          });
        }
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        if (typeof fn.name === "string" && fn.name && !call.name) {
          call.name = fn.name;
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          call.args += fn.arguments;
          send("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            output_index: state.outputIndex,
            delta: fn.arguments,
          });
        }
      }
    }

    void gatewayModel;
    void responseId;
  }
}

function nonStreamResponse(chat: Record<string, unknown>, gatewayModel: string, responseId: string): Record<string, unknown> {
  const choices = (chat.choices ?? []) as Array<Record<string, unknown>>;
  const output: Array<Record<string, unknown>> = [];
  let outputIndex = 0;
  for (const choice of choices) {
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const content = typeof message.content === "string" ? message.content : "";
    if (content) {
      output.push({
        type: "message",
        id: `msg_${responseId}_${outputIndex++}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: content, annotations: [] }],
      });
    }
    const toolCalls = (message.tool_calls ?? []) as Array<Record<string, unknown>>;
    for (const tc of toolCalls) {
      const fn = (tc.function ?? {}) as Record<string, unknown>;
      output.push({
        type: "function_call",
        id: typeof tc.id === "string" ? tc.id : `fc_${outputIndex}`,
        call_id: typeof tc.id === "string" ? tc.id : `fc_${outputIndex}`,
        name: fn.name ?? "",
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        status: "completed",
      });
      outputIndex++;
    }
  }
  const resp = emptyResponse(gatewayModel, responseId, "completed");
  resp.output = output;
  resp.usage = normalizeUsageForResponses(chat.usage);
  return resp;
}

function normalizeUsageForResponses(usage: unknown): Record<string, number> | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  return {
    input_tokens: typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0,
    output_tokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
    total_tokens: typeof u.total_tokens === "number" ? u.total_tokens : 0,
  };
}

function emptyResponse(gatewayModel: string, responseId: string, status: string): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: gatewayModel,
    output: [],
    usage: undefined,
  };
}

function parseSse(line: string): Record<string, unknown> | null {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}