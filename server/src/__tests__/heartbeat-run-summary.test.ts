import { describe, expect, it } from "vitest";
import { summarizeHeartbeatRunResultJson } from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });

  it("extracts a final result response from codex stdout when top-level summary fields are absent", () => {
    const summary = summarizeHeartbeatRunResultJson({
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Final answer from Codex." } }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } }),
      ].join("\n"),
      stderr: "",
    });

    expect(summary).toEqual({
      result: "Final answer from Codex.",
    });
  });

  it("prefers an explicit result event from stdout when available", () => {
    const summary = summarizeHeartbeatRunResultJson({
      stdout: [
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "output_text", text: "Interim assistant text." }] },
        }),
        JSON.stringify({
          type: "result",
          result: "Final result response.",
        }),
      ].join("\n"),
    });

    expect(summary).toEqual({
      result: "Final result response.",
    });
  });
});
