import { describe, test, expect } from "bun:test";
import { toMessagesRequest, messagesToChat, messagesEventChunks, messagesUsageOf } from "./anthropic";
import type { StreamState } from "./anthropic";

const state = (): StreamState => ({ stopReason: undefined, usage: undefined });

describe("toMessagesRequest", () => {
  test("maps system/tool/assistant messages and merges adjacent tool_results", () => {
    const chat = {
      model: "union-alpha",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "chain of thought",
          tool_calls: [
            { id: "t1", type: "function", function: { name: "get_weather", arguments: '{"city":"sf"}' } },
            { id: "t2", type: "function", function: { name: "get_time", arguments: {} } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "sunny" },
        { role: "tool", tool_call_id: "t2", content: "noon" },
        { role: "user", content: "thanks" },
      ],
      tools: [{ function: { name: "get_weather", description: "w", parameters: { type: "object" } } }],
      tool_choice: "required",
      stream: true,
      max_tokens: 100,
    };
    const out = toMessagesRequest(chat as unknown as Record<string, unknown>)!;
    expect(out.system).toBe("be brief");
    expect(out.max_tokens).toBe(100);
    expect(out.stream).toBe(true);
    expect(out.tool_choice).toEqual({ type: "any" });
    expect(out.tools).toEqual([{ name: "get_weather", description: "w", input_schema: { type: "object" } }]);

    const msgs = out.messages as Record<string, unknown>[];
    expect(msgs[0]).toEqual({ role: "user", content: "weather?" });
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "chain of thought" },
        { type: "tool_use", id: "t1", name: "get_weather", input: { city: "sf" } },
        { type: "tool_use", id: "t2", name: "get_time", input: {} },
      ],
    });
    expect(msgs[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "sunny" },
        { type: "tool_result", tool_use_id: "t2", content: "noon" },
      ],
    });
    expect(msgs[3]).toEqual({ role: "user", content: "thanks" });
  });

  test("defaults max_tokens to 8192 and drops thinking parameter", () => {
    const out = toMessagesRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled", budget_tokens: 4096 },
      temperature: 0.5,
    })!;
    expect(out.max_tokens).toBe(8192);
    expect(out.thinking).toBeUndefined();
 expect(out.temperature).toBeUndefined();
  });

  test("returns null without messages array", () => {
    expect(toMessagesRequest({ model: "m" })).toBeNull();
  });
});

describe("messagesToChat", () => {
  test("maps content blocks, stop_reason and anthropic usage to openai wire shape", () => {
    const chat = messagesToChat(
      {
        id: "msg_1",
        content: [
          { type: "text", text: "hello" },
          { type: "thinking", thinking: "hmm" },
          { type: "tool_use", id: "t1", name: "fn", input: { a: 1 } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 },
      } as unknown as Record<string, unknown>,
      "union-alpha"
    );
    expect(chat.object).toBe("chat.completion");
    expect(chat.model).toBe("union-alpha");
    const choice = (chat.choices as Record<string, unknown>[])[0];
    expect(choice.finish_reason).toBe("tool_calls");
    expect((choice.message as Record<string, unknown>).tool_calls).toEqual([
      { id: "t1", type: "function", function: { name: "fn", arguments: '{"a":1}' } },
    ]);
    expect((chat.usage as Record<string, number>)).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_cache_hit_tokens: 8,
      cache_creation_input_tokens: 2,
    });
  });

  test("stop_reason max_tokens maps to length, others to stop", () => {
    const mk = (stop: string) =>
      messagesToChat({ id: "x", content: [{ type: "text", text: "t" }], stop_reason: stop } as unknown as Record<string, unknown>, "m");
    expect((mk("max_tokens").choices as Record<string, unknown>[])[0].finish_reason).toBe("length");
    expect((mk("end_turn").choices as Record<string, unknown>[])[0].finish_reason).toBe("stop");
  });
});

describe("messagesEventChunks (streaming)", () => {
  const st = state();
  const id = "chunk-1";
  const chunksFor = (event: Record<string, unknown>) => messagesEventChunks(event, st, "union-alpha", id);

  test("message_start emits first frame with empty assistant delta", () => {
    const frames = chunksFor({ type: "message_start", message: { usage: { input_tokens: 20 } } });
    expect(frames[0].choices).toEqual([{ index: 0, delta: { role: "assistant", content: "" } }]);
    expect(messagesUsageOf({ type: "message_start", message: { usage: { input_tokens: 20 } } })).toEqual({ input_tokens: 20 });
  });

  test("content_block_start text/thinking emit nothing; tool_use emits the call scaffold", () => {
    expect(chunksFor({ type: "content_block_start", index: 0, content_block: { type: "text" } })).toEqual([]);
    const frames = chunksFor({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "fn" } });
    expect(frames[0].choices[0].delta).toEqual({ tool_calls: [{ index: 1, id: "t1", type: "function", function: { name: "fn", arguments: "" } }] });
  });

  test("deltas map text/thinking/input_json", () => {
    expect(chunksFor({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })[0].choices[0].delta).toEqual({ content: "hi" });
    expect(chunksFor({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "h" } })[0].choices[0].delta).toEqual({ reasoning_content: "h" });
    expect(chunksFor({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"a"' } })[0].choices[0].delta).toEqual({ tool_calls: [{ index: 2, function: { arguments: '{"a"' } }] });
  });

  test("message_delta only caches; message_stop emits finish frame + usage frame", () => {
    expect(chunksFor({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9, input_tokens: 1 } })).toEqual([]);
    expect(st.stopReason).toBe("max_tokens");
    const frames = chunksFor({ type: "message_stop" });
    expect(frames[0].choices).toEqual([{ index: 0, delta: {}, finish_reason: "length" }]);
    expect(frames[1].usage).toEqual({ prompt_tokens: 1, completion_tokens: 9, prompt_cache_hit_tokens: 0, cache_creation_input_tokens: 0 });
  });

  test("ping and content_block_stop produce no output and are not terminal", () => {
    expect(chunksFor({ type: "ping", cost: "0" })).toEqual([]);
    expect(chunksFor({ type: "content_block_stop", index: 0 })).toEqual([]);
    expect(st.stopReason).toBe("max_tokens");
  });

  test("error event maps to error frame", () => {
    expect(chunksFor({ type: "error", error: { message: "boom" } })).toEqual([{ error: { message: "boom" } }]);
  });
});