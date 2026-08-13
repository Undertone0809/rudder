import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT,
  createAssignmentRunFailureBudget,
  fingerprintToolFailure,
  inspectAssignmentRunWorkspace,
  resolveProjectWorkingSetCwd,
} from "./assignment-run-guardrail.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

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

  it("checkpoints at the total failure budget when fingerprints vary", () => {
    const budget = createAssignmentRunFailureBudget();
    const entries = Array.from({ length: ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT }, (_, index) => [
      call(`tool-${index}`, `tool-${index}`),
      failure(`distinct failure marker-${String.fromCharCode(65 + index)} value`, `tool-${index}`, `tool-${index}`),
    ]).flat();
    expect(budget.observe(entries)).toMatchObject({
      reason: "total_failure_budget",
      failureCount: ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT,
    });
  });

  it("reports workspace and package-manager readiness without mutating the repo", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-preflight-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "package.json"), "{}", "utf8");
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf8");

    await expect(inspectAssignmentRunWorkspace({ actualCwd: cwd, projectWorkingSetCwd: cwd })).resolves.toMatchObject({
      cwdMatchesProjectWorkingSet: true,
      packageManager: "pnpm",
      packageJsonPresent: true,
      nodeModulesPresent: false,
      recoveryCommand: "pnpm install --frozen-lockfile",
    });
  });

  it("resolves only an external directory working set as the project repo root", () => {
    expect(resolveProjectWorkingSetCwd([
      { role: "reference", resource: { kind: "directory", sourceType: "external", locator: "/tmp/reference" } },
      { role: "working_set", resource: { kind: "file", sourceType: "external", locator: "/tmp/readme.md" } },
      { role: "working_set", resource: { kind: "directory", sourceType: "external", locator: "/tmp/repo" } },
    ])).toBe("/tmp/repo");
    expect(resolveProjectWorkingSetCwd([
      { role: "working_set", resource: { kind: "directory", sourceType: "library", locator: "projects/rudder" } },
    ])).toBeNull();
  });
});
