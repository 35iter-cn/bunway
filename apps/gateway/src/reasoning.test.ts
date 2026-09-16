import { describe, test, expect } from "bun:test";
import { normalizeRequestMessages, normalizeResponseChunk, normalizeResponseBody } from "./reasoning";

describe("normalizeRequestMessages", () => {
  test("renames reasoning to reasoning_content and drops the legacy key", () => {
    const body = { messages: [{ role: "assistant", reasoning: "think", content: "hi" }] };
    expect(normalizeRequestMessages(body, false)).toBe(true);
    expect(body.messages[0]).toEqual({ role: "assistant", content: "hi", reasoning_content: "think" });
  });

  test("keeps an existing reasoning_content when both keys are present", () => {
    const body = { messages: [{ role: "assistant", reasoning: "old", reasoning_content: "new" }] };
    expect(normalizeRequestMessages(body, false)).toBe(true);
    expect(body.messages[0]).toEqual({ role: "assistant", reasoning_content: "new" });
  });

  test("pads empty reasoning_content when the target provider requires the key", () => {
    const body = { messages: [{ role: "assistant", content: "", tool_calls: [] }, { role: "user", content: "x" }] };
    expect(normalizeRequestMessages(body, true)).toBe(true);
    expect(body.messages[0]).toEqual({ role: "assistant", content: "", tool_calls: [], reasoning_content: "" });
    expect(body.messages[1]).toEqual({ role: "user", content: "x" });
  });

  test("leaves assistant messages untouched when the provider does not require the key", () => {
    const body = { messages: [{ role: "assistant", content: "", tool_calls: [] }] };
    expect(normalizeRequestMessages(body, false)).toBe(false);
    expect(body.messages[0]).toEqual({ role: "assistant", content: "", tool_calls: [] });
  });

  test("is idempotent on an already canonical body", () => {
    const body = { messages: [{ role: "assistant", reasoning_content: "think" }] };
    expect(normalizeRequestMessages(body, true)).toBe(false);
    expect(body.messages[0]).toEqual({ role: "assistant", reasoning_content: "think" });
  });

  test("never touches non assistant roles and non array messages", () => {
    const body = { messages: [{ role: "user", reasoning: "x" }, { role: "tool", reasoning: "y" }] };
    expect(normalizeRequestMessages(body, true)).toBe(false);
    expect(normalizeRequestMessages({ messages: "nope" }, true)).toBe(false);
    expect(body.messages[0]).toEqual({ role: "user", reasoning: "x" });
  });
});

describe("normalizeResponseChunk", () => {
  test("renames streamed delta reasoning", () => {
    const chunk = { choices: [{ delta: { role: "assistant", reasoning: "think" } }] };
    expect(normalizeResponseChunk(chunk)).toBe(true);
    expect(chunk.choices[0].delta).toEqual({ role: "assistant", reasoning_content: "think" });
  });

  test("drops a stale reasoning when reasoning_content is present", () => {
    const chunk = { choices: [{ delta: { reasoning: "old", reasoning_content: "new" } }] };
    expect(normalizeResponseChunk(chunk)).toBe(true);
    expect(chunk.choices[0].delta).toEqual({ reasoning_content: "new" });
  });

  test("leaves canonical and unrelated chunks untouched", () => {
    const chunk = { choices: [{ delta: { reasoning_content: "think" } }, { delta: { content: "hi" } }] };
    expect(normalizeResponseChunk(chunk)).toBe(false);
    expect(normalizeResponseChunk({ choices: [] })).toBe(false);
    expect(normalizeResponseChunk({ usage: { total_tokens: 3 } })).toBe(false);
  });
});

describe("normalizeResponseBody", () => {
  test("renames the non streaming message field", () => {
    const text = JSON.stringify({ choices: [{ message: { role: "assistant", reasoning: "think" } }] });
    expect(JSON.parse(normalizeResponseBody(text)).choices[0].message).toEqual({
      role: "assistant",
      reasoning_content: "think",
    });
  });

  test("returns the original text when nothing changes or the payload is not JSON", () => {
    const canonical = JSON.stringify({ choices: [{ message: { reasoning_content: "think" } }] });
    expect(normalizeResponseBody(canonical)).toBe(canonical);
    expect(normalizeResponseBody("not json")).toBe("not json");
    expect(normalizeResponseBody(JSON.stringify({ error: { message: "boom" } }))).toBe(
      JSON.stringify({ error: { message: "boom" } })
    );
  });
});
