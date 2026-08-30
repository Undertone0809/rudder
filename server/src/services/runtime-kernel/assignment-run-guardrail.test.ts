import { describe, expect, it } from "vitest";
import {
  ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT,
  ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT,
  createAssignmentRunFailureBudget,
  fingerprintToolFailure,
  formatAssignmentRunGuardrailError,
} from "./assignment-run-guardrail.js";

function failure(content: string, toolUseId = "tool-1", toolName = "exec_command") {
  return {
    kind: "tool_result" as const,
    ts: new Date().toISOString(),
    toolUseId,
    toolName,
    content,
    isError: true,
  };
}

function call(command: string, toolUseId = "tool-1") {
  return {
    kind: "tool_call" as const,
    ts: new Date().toISOString(),
    name: "exec_command",
    toolUseId,
    input: { cmd: command },
  };
}

describe("assignment run guardrail", () => {
  it("normalizes dynamic paths, timestamps, ids, and numbers in failure fingerprints", () => {
    const first = failure("2026-08-13T01:02:03Z /tmp/run-123 failed with code 1");
    const second = failure("2026-08-13T02:03:04Z /private/run-456 failed with code 2");
    expect(fingerprintToolFailure(first, call("pnpm test", "tool-1"))).toBe(
      fingerprintToolFailure(second, call("pnpm test", "tool-2")),
    );
  });

  it("checkpoints after the same failure fingerprint occurs three times", () => {
    const budget = createAssignmentRunFailureBudget();
    expect(budget.observe([call("pnpm test", "tool-1"), failure("Cannot find module /tmp/a", "tool-1")])).toBeNull();
    expect(budget.observe([
      call("pnpm test", "tool-1"),
      failure("Cannot find module /tmp/a", "tool-1"),
      call("pnpm test", "tool-2"),
      failure("Cannot find module /tmp/b", "tool-2"),
    ])).toBeNull();
    expect(budget.observe([
      call("pnpm test", "tool-1"),
      failure("Cannot find module /tmp/a", "tool-1"),
      call("pnpm test", "tool-2"),
      failure("Cannot find module /tmp/b", "tool-2"),
      call("pnpm test", "tool-3"),
      failure("Cannot find module /tmp/c", "tool-3"),
    ])).toMatchObject({
      reason: "repeated_failure",
      failureCount: 3,
      consecutiveFailureCount: 3,
      nextRecoveryCommand: "pnpm install --frozen-lockfile",
    });
  });

  it("resets repeated failure streaks after a successful tool result", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = [
      call("pnpm test", "tool-1"), failure("same error", "tool-1"),
      call("pnpm test", "tool-ok"), { ...failure("ok", "tool-ok"), isError: false },
      call("pnpm test", "tool-2"), failure("same error", "tool-2"),
      call("pnpm test", "tool-3"), failure("same error", "tool-3"),
    ];
    expect(budget.observe(entries)).toBeNull();
    expect(budget.snapshot()).toMatchObject({ consecutiveFailureCount: 2 });
  });

  it("does not combine identical errors from different commands", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = [
      call("pnpm test", "tool-1"), failure("same error", "tool-1"),
      call("pnpm typecheck", "tool-2"), failure("same error", "tool-2"),
      call("pnpm test", "tool-3"), failure("same error", "tool-3"),
    ];
    expect(budget.observe(entries)).toBeNull();
    expect(budget.snapshot()).toMatchObject({ consecutiveFailureCount: 1 });
  });

  it("checkpoints when too many distinct operations remain unresolved", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = Array.from({ length: ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT }, (_, index) => [
      call(`tool-${index}`, `tool-${index}`),
      failure(`distinct failure marker-${String.fromCharCode(65 + index)} value`, `tool-${index}`, `tool-${index}`),
    ]).flat();
    expect(budget.observe(entries)).toMatchObject({
      reason: "unresolved_failure_budget",
      failureCount: ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT,
      unresolvedFailureCount: ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT,
    });
  });

  it("clears only the same operation after a later successful result", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = Array.from({ length: ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT }, (_, index) => [
      call(`pnpm test --filter case-${index}`, `failure-${index}`),
      failure(`test case ${index} failed`, `failure-${index}`),
      call(`pnpm test --filter case-${index}`, `success-${index}`),
      { ...failure("read succeeded", `success-${index}`), isError: false },
    ]).flat();

    expect(budget.observe(entries)).toBeNull();
    expect(budget.snapshot()).toMatchObject({
      failureCount: ASSIGNMENT_RUN_UNRESOLVED_FAILURE_LIMIT,
      unresolvedFailureCount: 0,
      consecutiveFailureCount: 0,
    });
  });

  it("does not let recovered operations bypass the lifetime failure cap", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = Array.from({ length: ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT }, (_, index) => [
      call("pnpm test", `failure-${index}`),
      failure(`distinct marker ${String.fromCharCode(0x100 + index)}`, `failure-${index}`),
      call("pnpm test", `success-${index}`),
      { ...failure("ok", `success-${index}`), isError: false },
    ]).flat();

    expect(budget.observe(entries)).toMatchObject({
      reason: "total_failure_budget",
      failureCount: ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT,
      unresolvedFailureCount: 1,
    });
  });

  it("classifies patch drift and emits an actionable bounded-recovery error", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = [1, 2, 3].flatMap((index) => [
      { ...call("apply patch", `patch-${index}`), name: "apply_patch" },
      failure("Invalid Context 42", `patch-${index}`, "apply_patch"),
    ]);
    const checkpoint = budget.observe(entries);

    expect(checkpoint).toMatchObject({
      reason: "repeated_failure",
      failureClass: "context_drift",
      automaticContinuationAllowed: true,
    });
    expect(formatAssignmentRunGuardrailError(checkpoint!, true)).toContain("eligible for recovery attempt 1 of 1");
  });

  it("does not mistake a timed-out patch mutation for context drift", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = [1, 2, 3].flatMap((index) => [
      { ...call("apply patch", `patch-${index}`), name: "apply_patch" },
      failure("Request timed out", `patch-${index}`, "apply_patch"),
    ]);

    expect(budget.observe(entries)).toMatchObject({
      failureClass: "transient_transport",
      automaticContinuationAllowed: false,
      continuationBlockReason: expect.stringContaining("no canonical read-only contract"),
    });
  });

  it("fails closed for deterministic and unclassified failures", () => {
    const invalidBudget = createAssignmentRunFailureBudget();
    const invalidEntries = [1, 2, 3].flatMap((index) => [
      { ...call("comment", `invalid-${index}`), name: "mcp__rudder_tools__rudder_issue_comment" },
      failure("Invalid argument", `invalid-${index}`, "mcp__rudder_tools__rudder_issue_comment"),
    ]);
    expect(invalidBudget.observe(invalidEntries)).toMatchObject({
      failureClass: "invalid_request",
      automaticContinuationAllowed: false,
    });

    const unknownBudget = createAssignmentRunFailureBudget();
    const unknownEntries = [1, 2, 3].flatMap((index) => [
      { ...call("unknown", `unknown-${index}`), name: "external_unknown_tool" },
      failure("unclassified failure", `unknown-${index}`, "external_unknown_tool"),
    ]);
    expect(unknownBudget.observe(unknownEntries)).toMatchObject({
      failureClass: "unknown",
      automaticContinuationAllowed: false,
    });
  });

  it("withholds automatic continuation for indeterminate mutation failures", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = [1, 2, 3].flatMap((index) => [
      { ...call("comment", `comment-${index}`), name: "mcp__rudder_tools__rudder_issue_comment" },
      failure("Internal server error status: 500", `comment-${index}`, "mcp__rudder_tools__rudder_issue_comment"),
    ]);

    expect(budget.observe(entries)).toMatchObject({
      failureClass: "transient_transport",
      automaticContinuationAllowed: false,
      continuationBlockReason: expect.stringContaining("side effect"),
    });
  });

  it("uses the paired call name when mutation results omit their tool name", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = [1, 2, 3].flatMap((index) => [
      { ...call("comment", `comment-${index}`), name: "mcp__rudder_tools__rudder_issue_comment" },
      { ...failure("Internal server error status: 500", `comment-${index}`), toolName: undefined },
    ]);

    expect(budget.observe(entries)).toMatchObject({
      toolName: "mcp__rudder_tools__rudder_issue_comment",
      automaticContinuationAllowed: false,
    });
  });

  it("allows transient continuation only for canonically read-only tools", () => {
    const readBudget = createAssignmentRunFailureBudget();
    const readEntries = [1, 2, 3].flatMap((index) => [
      { ...call("get", `get-${index}`), name: "mcp__rudder_tools__rudder_runs_get" },
      failure("Internal server error status: 500", `get-${index}`, "mcp__rudder_tools__rudder_runs_get"),
    ]);
    expect(readBudget.observe(readEntries)).toMatchObject({ automaticContinuationAllowed: true });

    const unknownBudget = createAssignmentRunFailureBudget();
    const unknownEntries = [1, 2, 3].flatMap((index) => [
      { ...call("unknown", `unknown-${index}`), name: "external_unknown_tool" },
      failure("Internal server error status: 500", `unknown-${index}`, "external_unknown_tool"),
    ]);
    expect(unknownBudget.observe(unknownEntries)).toMatchObject({
      automaticContinuationAllowed: false,
      continuationBlockReason: expect.stringContaining("no canonical read-only contract"),
    });
  });
});
