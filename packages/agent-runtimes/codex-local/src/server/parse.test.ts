import { describe, expect, it } from "vitest";
import { isCodexProviderAuthFailure, isCodexTransportDisconnectError, parseCodexJsonl } from "./parse.js";

describe("parseCodexJsonl", () => {
  it("does not promote incomplete assistant progress to a final summary", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Partial progress before stop." } }),
    ].join("\n"));

    expect(parsed.sessionId).toBe("thread-123");
    expect(parsed.summary).toBe("");
  });

  it("does not promote incomplete reasoning to a final summary", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Internal reasoning before stop." } }),
    ].join("\n"));

    expect(parsed.summary).toBe("");
  });

  it("uses completed assistant messages as the final summary", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final visible answer." } }),
      JSON.stringify({
        type: "turn.completed",
        result: "Final visible answer.",
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 4 },
      }),
    ].join("\n"));

    expect(parsed.summary).toBe("Final visible answer.");
  });

  it("recognizes only the Codex responses transport disconnect", () => {
    expect(isCodexTransportDisconnectError(
      "",
      "stream disconnected before completion: error sending request for url (https://sub.zeeland.studio/v1/responses)",
    )).toBe(true);
    expect(isCodexTransportDisconnectError("", "authentication failed")).toBe(false);
    expect(isCodexTransportDisconnectError(
      "",
      "stream disconnected before completion: error sending request for url (https://sub.zeeland.studio/v1/models)",
    )).toBe(false);
  });

  it("recognizes structured provider authentication failures without matching retryable failures", () => {
    expect(isCodexProviderAuthFailure(
      'unexpected status 401 Unauthorized: {"code":"API_KEY_REQUIRED","message":"API key is required"}',
    )).toBe(true);
    expect(isCodexProviderAuthFailure("unexpected status 401 Unauthorized")).toBe(true);
    expect(isCodexProviderAuthFailure("unexpected status 429 Too Many Requests: API key rate limit exceeded")).toBe(false);
    expect(isCodexProviderAuthFailure("unexpected status 503: authentication service unavailable")).toBe(false);
  });

  it("treats explicit error and failed-turn events as terminal", () => {
    const parsed = parseCodexJsonl([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "error", message: "provider rejected the turn" }),
      JSON.stringify({ type: "turn.failed", error: { message: "provider rejected the turn" } }),
    ].join("\n"));

    expect(parsed.terminalEventObserved).toBe(true);
    expect(parsed.terminalCompleted).toBe(false);
  });
});
