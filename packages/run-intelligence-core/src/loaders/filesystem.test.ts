import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildObservedRunTrace } from "../trace.js";
import { loadFilesystemRunDetail } from "./filesystem.js";

const codexFixturePath = fileURLToPath(new URL("./fixtures/codex-run-log.ndjson", import.meta.url));

function match(logPath: string) {
  return {
    runId: "run-fixture",
    logPath,
    logRef: "org-fixture/agent-fixture/run-fixture.ndjson",
    orgId: "org-fixture",
    agentId: "agent-fixture",
  };
}

describe("filesystem run loader", () => {
  it("recognizes Codex event-format logs and parses turns and tool calls", () => {
    const detail = loadFilesystemRunDetail({ match: match(codexFixturePath) });

    expect(detail.run.contextSnapshot).toMatchObject({ agentRuntimeType: "codex_local" });
    expect(detail.bundle.agentRuntimeType).toBe("codex_local");
    expect(detail.transcript.some((entry) => entry.kind === "assistant" && entry.text === "Fixture response.")).toBe(true);
    expect(detail.transcript.some((entry) => entry.kind === "tool_call")).toBe(true);
    const trace = buildObservedRunTrace(detail);
    expect(trace.turnCount).toBe(1);
    expect(trace.turns[0]?.toolCallCount).toBe(1);
  });

  it("prefers durable runtime metadata over event-format inference", () => {
    const detail = loadFilesystemRunDetail({
      match: match(codexFixturePath),
      agentRuntimeType: "claude_local",
    });

    expect(detail.run.contextSnapshot).toMatchObject({ agentRuntimeType: "claude_local" });
    expect(detail.bundle.agentRuntimeType).toBe("claude_local");
  });

  it("does not infer Codex from transcript text alone", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-run-intelligence-"));
    const logPath = path.join(temporaryDirectory, "plain-text-run.ndjson");
    const logContent = `${JSON.stringify({
      ts: "2026-10-06T01:00:00.000Z",
      stream: "stdout",
      chunk: "A note mentions thread.started, turn.started, and item.completed.\n",
    })}\n`;
    fs.writeFileSync(logPath, logContent, "utf8");
    try {
      const detail = loadFilesystemRunDetail({ match: match(logPath) });
      expect(detail.run.contextSnapshot).toMatchObject({ agentRuntimeType: "process" });
      expect(detail.bundle.agentRuntimeType).toBe("process");
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("does not infer Codex from turn and generic item events without a thread signature", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-run-intelligence-"));
    const logPath = path.join(temporaryDirectory, "colliding-events-run.ndjson");
    const logContent = [
      { type: "turn.started" },
      { type: "item.completed", item: { id: "notice-1", type: "notification", message: "Job finished." } },
      { type: "turn.completed", result: "done" },
    ]
      .map((event) => JSON.stringify({
        ts: "2026-10-06T01:00:00.000Z",
        stream: "stdout",
        chunk: `${JSON.stringify(event)}\n`,
      }))
      .join("\n");
    fs.writeFileSync(logPath, logContent, "utf8");
    try {
      const detail = loadFilesystemRunDetail({ match: match(logPath) });
      expect(detail.run.contextSnapshot).toMatchObject({ agentRuntimeType: "process" });
      expect(detail.bundle.agentRuntimeType).toBe("process");
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
