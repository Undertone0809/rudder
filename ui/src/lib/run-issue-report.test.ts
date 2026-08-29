import type { HeartbeatRun } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  buildRunDebugChatMessage,
  buildRunIssueDiagnostics,
  createRunIssueReportUrl,
} from "./run-issue-report";

function failedRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "810d0487-8dc8-490c-b741-4068e675499d",
    orgId: "org-private",
    agentId: "agent-private",
    invocationSource: "chat",
    triggerDetail: "chat_assistant_reply_stream",
    status: "failed",
    startedAt: new Date("2026-07-26T14:40:27.982Z"),
    finishedAt: new Date("2026-07-26T14:40:29.699Z"),
    error: "managedExternalMcpBindings[0] contains unsupported fields: accessMode",
    wakeupRequestId: null,
    exitCode: null,
    signal: null,
    usageJson: null,
    resultJson: null,
    sessionIdBefore: null,
    sessionIdAfter: null,
    sessionReuseScope: "none",
    logStore: null,
    logRef: "/Users/zeeland/private/run.log",
    logBytes: 120,
    logSha256: null,
    logCompressed: false,
    stdoutExcerpt: [
      "request https://user:password@private.example.test/run?token=secret-value",
      "conversation conversation-private for org-private and agent-private",
      '{"apiKey":"json-secret"}',
      'password="two words secret"',
    ].join("\n"),
    stderrExcerpt: [
      "Authorization: Bearer super-secret",
      "config at /Users/zeeland/projects/private/.env",
      "API_KEY=top-secret",
    ].join("\n"),
    errorCode: "chat_runtime_exception",
    externalRunId: null,
    chatConversationId: "conversation-private",
    goalId: null,
    processPid: null,
    processStartedAt: null,
    retryOfRunId: null,
    processLossRetryCount: 0,
    contextSnapshot: {
      scene: "chat",
      targetType: "chat_conversation",
      targetId: "conversation-private",
    },
    createdAt: new Date("2026-07-26T14:40:27.982Z"),
    updatedAt: new Date("2026-07-26T14:40:29.699Z"),
    ...overrides,
  };
}

describe("run issue report", () => {
  it("builds bounded diagnostics while removing secrets, private URLs, and home paths", () => {
    const diagnostics = buildRunIssueDiagnostics(failedRun({
      startedAt: "2026-07-26T14:40:27.982Z" as unknown as Date,
      finishedAt: "2026-07-26T14:40:29.699Z" as unknown as Date,
    }), {
      version: "0.6.2",
      environment: "dev / desktop",
    });

    expect(diagnostics).toContain("Run ID: 810d0487-8dc8-490c-b741-4068e675499d");
    expect(diagnostics).toContain("Error code: chat_runtime_exception");
    expect(diagnostics).toContain("Started at: 2026-07-26T14:40:27.982Z");
    expect(diagnostics).toContain("Finished at: 2026-07-26T14:40:29.699Z");
    expect(diagnostics).toContain("managedExternalMcpBindings[0]");
    expect(diagnostics).toContain("API_KEY=[REDACTED]");
    expect(diagnostics).toContain("Authorization: [REDACTED]");
    expect(diagnostics).toContain("~/projects/private/.env");
    expect(diagnostics).toContain("https://[REDACTED]@private.example.test/run?[REDACTED]");
    expect(diagnostics).not.toContain("super-secret");
    expect(diagnostics).not.toContain("top-secret");
    expect(diagnostics).not.toContain("token=secret-value");
    expect(diagnostics).not.toContain("conversation-private");
    expect(diagnostics).not.toContain("org-private");
    expect(diagnostics).not.toContain("agent-private");
    expect(diagnostics).not.toContain("json-secret");
    expect(diagnostics).not.toContain("two words secret");
    expect(diagnostics).not.toContain("user:password");
    expect(diagnostics.length).toBeLessThanOrEqual(6_000);
  });

  it("prefills the repository bug form with the reviewed diagnostics", () => {
    const diagnostics = [
      "Run ID: run-1",
      "Error code: chat_runtime_exception",
      "API_KEY=edited-secret",
      "org-private",
    ].join("\n");
    const url = new URL(createRunIssueReportUrl(failedRun(), {
      diagnostics,
      version: "0.6.2",
      platform: "macOS",
      environment: "dev / desktop",
    }));

    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe("/Undertone0809/rudder/issues/new");
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("title")).toContain("chat_runtime_exception");
    expect(url.searchParams.get("actual_behavior")).toContain("Run failed");
    expect(url.searchParams.get("expected_behavior")).toContain("complete");
    expect(url.searchParams.get("affected_area")).toBe("Agent runtime/heartbeat");
    expect(url.searchParams.get("rudder_version")).toBe("0.6.2");
    expect(url.searchParams.get("platform")).toBe("macOS");
    expect(url.searchParams.get("evidence")).toContain("API_KEY=[REDACTED]");
    expect(url.searchParams.get("evidence")).toContain("[REDACTED_ID]");
    expect(url.searchParams.get("evidence")).not.toContain("edited-secret");
    expect(url.searchParams.get("evidence")).not.toContain("org-private");
  });

  it("builds a Debug Chat request with bounded diagnostics in an untrusted evidence boundary", () => {
    const run = failedRun();
    const diagnostics = buildRunIssueDiagnostics(run, {
      version: "0.6.2",
      environment: "dev / desktop",
    });
    const message = buildRunDebugChatMessage(run, diagnostics);

    expect(message).toContain(`Run ID: ${run.id}`);
    expect(message).toContain("Explain the likely root cause");
    expect(message).toContain("cite the evidence");
    expect(message).toContain("validation and repair steps");
    expect(message).toContain("BEGIN UNTRUSTED DIAGNOSTIC EVIDENCE");
    expect(message).toContain("END UNTRUSTED DIAGNOSTIC EVIDENCE");
    expect(message).toContain("API_KEY=[REDACTED]");
    expect(message).not.toContain("top-secret");
  });
});
