import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ASSIGNMENT_DEPENDENCY_REPAIR_COMMAND,
  ASSIGNMENT_RUN_TOTAL_FAILURE_LIMIT,
  AssignmentDependencyPreflightError,
  createAssignmentRunFailureBudget,
  fingerprintToolFailure,
  inspectAssignmentRunWorkspace,
  repairAssignmentRunWorkspace,
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
  }, 15_000);

  it("uses the pnpm-supported read-only dependency graph command", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-preflight-command-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }), "utf8");
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf8");
    await fs.mkdir(path.join(cwd, "node_modules", ".pnpm"), { recursive: true });
    const runCommand = vi.fn(async (_command: string, _args: string[], _cwd: string) => ({
      ok: true,
      output: "[]",
    }));

    await expect(inspectAssignmentRunWorkspace({
      actualCwd: cwd,
      projectWorkingSetCwd: cwd,
      runCommand,
    })).resolves.toMatchObject({
      dependencyGraphAvailable: true,
      ready: true,
    });
    expect(runCommand).toHaveBeenCalledWith(
      "pnpm",
      ["list", "--depth", "-1", "--json"],
      cwd,
    );
  });

  it("coalesces one dependency repair and suppresses an unchanged failed readiness state", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-repair-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }), "utf8");
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf8");
    const preflight = await inspectAssignmentRunWorkspace({ actualCwd: cwd, projectWorkingSetCwd: cwd });
    const runCommand = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("registry unavailable");
    });
    const inspect = vi.fn(async () => preflight);

    const [first, second] = await Promise.all([
      repairAssignmentRunWorkspace({ preflight, inspect, runCommand }),
      repairAssignmentRunWorkspace({ preflight, inspect, runCommand }),
    ]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(
      "pnpm",
      ["install", "--frozen-lockfile"],
      cwd,
    );
    expect(first).toMatchObject({
      command: ASSIGNMENT_DEPENDENCY_REPAIR_COMMAND,
      attempted: true,
      coalesced: false,
      rechecked: true,
      succeeded: false,
      output: "registry unavailable",
    });
    expect(second).toMatchObject({
      attempted: true,
      coalesced: true,
      succeeded: false,
    });

    const suppressed = await repairAssignmentRunWorkspace({ preflight, inspect, runCommand });
    expect(suppressed).toMatchObject({
      attempted: false,
      coalesced: false,
      rechecked: false,
      succeeded: false,
      skippedReason: "unchanged_readiness",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("coalesces repairs by workspace identity when readiness snapshots differ", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-repair-race-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }), "utf8");
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf8");
    const preflight = await inspectAssignmentRunWorkspace({ actualCwd: cwd, projectWorkingSetCwd: cwd });
    const firstPreflight = { ...preflight, readinessFingerprint: `${preflight.readinessFingerprint}:first` };
    const secondPreflight = { ...preflight, readinessFingerprint: `${preflight.readinessFingerprint}:second` };
    const final = {
      ...preflight,
      ready: false,
      diagnosticOutput: "dependency graph is still unavailable",
      readinessFingerprint: `${preflight.readinessFingerprint}:final`,
    };
    const runCommand = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true, output: "" };
    });
    const inspect = vi.fn(async () => final);

    const [first, second] = await Promise.all([
      repairAssignmentRunWorkspace({ preflight: firstPreflight, inspect, runCommand }),
      repairAssignmentRunWorkspace({ preflight: secondPreflight, inspect, runCommand }),
    ]);

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ attempted: true, coalesced: false, succeeded: false });
    expect(second).toMatchObject({
      attempted: true,
      coalesced: true,
      succeeded: false,
      readinessFingerprint: secondPreflight.readinessFingerprint,
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("retains a failed dependency graph check after a successful repair command", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "assignment-repair-recheck-"));
    tempDirs.push(cwd);
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "pnpm@9.15.4" }), "utf8");
    await fs.writeFile(path.join(cwd, "pnpm-lock.yaml"), "lockfileVersion: '9.0'", "utf8");
    const preflight = await inspectAssignmentRunWorkspace({ actualCwd: cwd, projectWorkingSetCwd: cwd });
    const final = {
      ...preflight,
      ready: false,
      dependencyGraphAvailable: false,
      diagnosticOutput: "ERR_PNPM_OFFLINE_RECHECK",
      readinessFingerprint: `${preflight.readinessFingerprint}:recheck-failed`,
    };

    const outcome = await repairAssignmentRunWorkspace({
      preflight,
      inspect: vi.fn(async () => final),
      runCommand: vi.fn(async () => ({ ok: true, output: "" })),
    });

    expect(outcome).toMatchObject({
      attempted: true,
      rechecked: true,
      succeeded: false,
      output: "ERR_PNPM_OFFLINE_RECHECK",
    });
    expect(new AssignmentDependencyPreflightError(outcome.final, outcome).message).toContain(
      "ERR_PNPM_OFFLINE_RECHECK",
    );
  }, 15_000);

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
