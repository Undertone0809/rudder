import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  NativeMigrationOperatorError,
  runNativeMigrationOperator,
  type MigrationOperatorRequest,
  type MigrationOperatorSpawn,
} from "./migration-operator.js";

const request: MigrationOperatorRequest = {
  databaseUrl: "postgres://rudder:secret@127.0.0.1:5432/rudder",
  migrationsDir: "/tmp/rudder-migrations",
  expectedFingerprint: "a".repeat(64),
  recoveryDirectory: "/tmp/rudder-backups",
  pgDumpBinary: "/usr/bin/pg_dump",
};

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => true);
}

function successResponse(status: "validated" | "applied" = "validated"): string {
  return JSON.stringify({
    schema: "rudder.migration-apply/v1",
    protocolVersion: 1,
    status,
    report: {
      manifestFingerprint: request.expectedFingerprint,
      alreadyCurrent: true,
      appliedMigrations: [],
      reconciledLegacyMigrations: [],
      normalizedLegacyColumns: [],
      recoveryPoint: null,
    },
  });
}

function fakeSpawn(stdout: string, exitCode = 0) {
  const child = new FakeChild();
  let input = "";
  child.stdin.on("data", (chunk) => { input += chunk.toString(); });
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const spawnProcess: MigrationOperatorSpawn = (command, args, options) => {
    calls.push({ command, args, options: options as Record<string, unknown> });
    child.stdin.once("finish", () => {
      setImmediate(() => {
        child.stdout.end(stdout);
        child.stderr.end();
        child.emit("close", exitCode, null);
      });
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnProcess, calls, child, readInput: () => input };
}

describe("Rust migration operator transport", () => {
  it("passes credentials only through the child environment and validates a current-state receipt", async () => {
    const fixture = fakeSpawn(successResponse());
    const result = await runNativeMigrationOperator({ ...request, validateOnly: true }, {
      binaryPath: "/tmp/migration-apply",
      env: { PATH: "/usr/bin", HOME: "/tmp" },
      spawnProcess: fixture.spawnProcess,
    });

    expect(result).toMatchObject({ alreadyCurrent: true, appliedMigrations: [] });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      command: "/tmp/migration-apply",
      args: [],
      options: { shell: false, stdio: ["pipe", "pipe", "pipe"] },
    });
    const childEnv = fixture.calls[0]?.options.env as NodeJS.ProcessEnv;
    expect(childEnv.RUDDER_MIGRATION_APPLY_DATABASE_URL).toBe(request.databaseUrl);
    expect(fixture.readInput()).toContain("rudder.migration-apply/v1");
    expect(fixture.readInput()).not.toContain("secret");
  });

  it("preserves the structured requires-apply result without trying another writer", async () => {
    const response = JSON.stringify({
      schema: "rudder.migration-apply/v1",
      protocolVersion: 1,
      status: "error",
      error: { code: "requires_apply" },
    });
    const fixture = fakeSpawn(response, 2);

    await expect(runNativeMigrationOperator({ ...request, validateOnly: true }, {
      binaryPath: "/tmp/migration-apply",
      spawnProcess: fixture.spawnProcess,
    })).rejects.toMatchObject({ code: "requires_apply" });
    expect(fixture.calls).toHaveLength(1);
  });

  it("fails closed when the native binary cannot be started", async () => {
    const spawnProcess = vi.fn<MigrationOperatorSpawn>(() => { throw new Error("missing binary"); });

    await expect(runNativeMigrationOperator(request, {
      binaryPath: "/tmp/migration-apply-missing",
      spawnProcess,
    })).rejects.toMatchObject({ code: "spawn_failed" });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(new NativeMigrationOperatorError("spawn_failed").message).toContain("no Node migration fallback");
  });
});
