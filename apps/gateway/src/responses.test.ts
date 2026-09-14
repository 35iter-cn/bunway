import { describe, test, expect } from "bun:test";
import { convertRequest, convertResponse } from "./responses";

describe("convertRequest", () => {
  test("instructions → system, string input → user", () => {
    const out = JSON.parse(
      convertRequest(
        JSON.stringify({
          model: "m",
          instructions: "be brief",
          input: "hello",
        })
      )!
    );
    expect(out.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
    ]);
    expect(out.stream).toBeUndefined();
  });

  test("items → messages incl tool_calls", () => {
    const out = JSON.parse(
      convertRequest(
        JSON.stringify({
          model: "m",
          input: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "check weather" }] },
            {
              type: "function_call",
              call_id: "call_1",
              name: "get_weather",
              arguments: '{"city":"x"}',
            },
            { type: "function_call_output", call_id: "call_1", output: "sunny" },
            { type: "reasoning", summary: [] },
          ],
          tools: [{ type: "function", name: "get_weather", parameters: {} }],
          reasoning_effort: "high",
          stream: true,
        })
      )!
    );
    expect(out.messages).toEqual([
      { role: "user", content: "check weather" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"x"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
    ]);
    expect(out.tools).toHaveLength(1);
    expect(out.reasoning_effort).toBe("high");
    expect(out.stream).toBe(true);
    expect(out.stream_options.include_usage).toBe(true);
  });

  test("max_output_tokens → max_tokens; invalid json → null", () => {
    const out = JSON.parse(convertRequest(JSON.stringify({ model: "m", input: "x", max_output_tokens: 5 }))!);
    expect(out.max_tokens).toBe(5);
    expect(convertRequest("not json")).toBeNull();
  });
});

describe("convertResponse non-stream", () => {
  test("chat json → response object with output + usage", async () => {
    const chat = Response.json({
      choices: [
        { message: { role: "assistant", content: "hi there" } },
        {
          message: {
            tool_calls: [{ id: "call_9", function: { name: "f", arguments: '{"a":1}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const out = await convertResponse(chat, "glm");
    const json = await out.json();
    expect(json.status).toBe("completed");
    expect(json.output[0].type).toBe("message");
    expect(json.output[0].content[0].text).toBe("hi there");
    expect(json.output[1].type).toBe("function_call");
    expect(json.output[1].call_id).toBe("call_9");
    expect(json.usage.input_tokens).toBe(10);
  });
});

describe("convertResponse stream", () => {
  test("chat SSE → responses events with tool call chain and completed usage", async () => {
    const sse =
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"He"}}]}\n\n` +
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"y"}}]}\n\n` +
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{\\"a\\":"}}]}}]}\n\n` +
      `data: {"id":"1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n` +
      `data: {"id":"1","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}\n\n` +
      `data: [DONE]\n\n`;
    const chat = new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    const out = await convertResponse(chat, "glm");
    const text = await out.text();
    const events = text
      .split("\n\n")
      .filter(Boolean)
      .map((block) => {
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"))!;
        return JSON.parse(dataLine.slice(6));
      });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.output_text.delta");
    expect(types).toContain("response.function_call_arguments.delta");
    expect(types[types.length - 1]).toBe("response.completed");
    const completed = events[events.length - 1].response;
    expect(completed.usage.input_tokens).toBe(9);
    const deltas = events.filter((e) => e.type === "response.output_text.delta");
    expect(deltas.map((e) => e.delta).join("")).toBe("Hey");
    const argDeltas = events.filter((e) => e.type === "response.function_call_arguments.delta");
    expect(argDeltas.map((e) => e.delta).join("")).toBe('{"a":1}');
  });

  test("chat SSE error chunk → event: error, no response.completed", async () => {
    const sse =
      `data: {"id":"1","choices":[{"index":0,"delta":{"content":"He"}}]}\n\n` +
      `data: {"error":{"message":"upstream interrupted after 42 bytes: closed","type":"upstream_interrupted","code":"upstream_interrupted"}}\n\n`;
    const chat = new Response(sse, { headers: { "Content-Type": "text/event-stream" } });
    const out = await convertResponse(chat, "glm");
    const text = await out.text();
    expect(text).toContain("event: error");
    expect(text).toContain("upstream interrupted after 42 bytes");
    expect(text).not.toContain("response.completed");
  });
});