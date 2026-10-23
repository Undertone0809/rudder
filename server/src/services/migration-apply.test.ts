import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runNativeMigrationApply, runNativeMigrationStartup } from "./migration-apply.js";

const roots: string[] = [];
const fingerprint = "a".repeat(64);
const report = { manifestFingerprint: fingerprint, alreadyCurrent: true, appliedMigrations: [], reconciledLegacyMigrations: [], normalizedLegacyColumns: [], recoveryPoint: null };
const response = { schema: "rudder.migration-apply/v1", protocolVersion: 1, status: "applied", report };
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function invoke(source: string, options: {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  validateOnly?: boolean;
  signal?: AbortSignal;
  startupGate?: {
    policy?: "automatic" | "never" | "prompt";
    facts?: {
      autoApplyRequested: boolean;
      promptNever: boolean;
      interactive: boolean;
      embeddedClusterInitializedBeforeStartup?: boolean;
      applicationDatabaseCreated?: boolean;
    };
    approval?: { stateToken: string; approved: boolean };
  };
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-operator-transport-"));
  roots.push(root);
  const fixture = path.join(root, "operator.mjs");
  await writeFile(fixture, `#!/usr/bin/env node\nlet input = ''; for await (const chunk of process.stdin) input += chunk; const request = JSON.parse(input);\n${source}\n`);
  await chmod(fixture, 0o755);
  const request = {
    databaseUrl: "postgresql://test:private-fixture@127.0.0.1:1/postgres",
    migrationsDir: path.join(root, "migrations"), expectedFingerprint: fingerprint,
    recoveryDirectory: path.join(root, "backups"), pgDumpBinary: path.join(root, "pg_dump"),
    validateOnly: options.validateOnly,
    startupGate: options.startupGate,
  };
  const runOptions = { binaryPath: fixture, timeoutMs: options.timeoutMs, env: options.env, signal: options.signal };
  return options.startupGate
    ? runNativeMigrationStartup({ ...request, startupGate: options.startupGate }, runOptions)
    : runNativeMigrationApply(request, runOptions);
}

describe("Rust migration operator transport", () => {
  it("sends pinned input and credentials only through the dedicated environment", async () => {
    const result = await invoke(`
      if (request.schema !== 'rudder.migration-apply/v1' || !request.allowApply || request.expectedFingerprint !== '${fingerprint}') process.exit(9);
      if (input.includes('private-fixture') || process.argv.some(v => v.includes('private-fixture'))) process.exit(10);
      if (!process.env.RUDDER_MIGRATION_APPLY_DATABASE_URL.includes('private-fixture') || process.env.RUDDER_APP_SECRET || process.env.PGPASSWORD) process.exit(11);
      if (process.env.RUDDER_MIGRATION_APPLY_SUPERVISOR_PID !== String(process.ppid)) process.exit(12);
      console.log(JSON.stringify(${JSON.stringify(response)}));
    `, { env: { ...process.env, RUDDER_APP_SECRET: "must-not-inherit", PGPASSWORD: "must-not-inherit" } });
    expect(result).toEqual(report);
  });
  it("rejects a mismatched source receipt", async () => {
    await expect(invoke(`console.log(JSON.stringify(${JSON.stringify({ ...response, report: { ...report, manifestFingerprint: "b".repeat(64) } })}));`)).rejects.toMatchObject({ code: "source_identity_mismatch" });
  });
  it("accepts a validated receipt only for the read-only operation", async () => {
    const source = `console.log(JSON.stringify(${JSON.stringify({ ...response, status: "validated" })}));`;
    await expect(invoke(source, { validateOnly: true })).resolves.toEqual(report);
    await expect(invoke(source)).rejects.toMatchObject({ code: "invalid_response" });
    await expect(invoke(`console.log(JSON.stringify(${JSON.stringify(response)}));`, { validateOnly: true })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects a mutation receipt from locked validation", async () => {
    await expect(invoke(`console.log(JSON.stringify(${JSON.stringify({ ...response, status: "validated", report: { ...report, alreadyCurrent: false, appliedMigrations: ["0001.sql"] } })}));`, { validateOnly: true })).rejects.toMatchObject({ code: "validation_mutation_receipt" });
  });
  it("redacts stderr and fails closed even beside a success receipt", async () => {
    await expect(invoke(`console.error('private-fixture'); console.log(JSON.stringify(${JSON.stringify(response)}));`)).rejects.toMatchObject({ code: "unexpected_stderr" });
  });
  it("propagates only bounded native error identifiers", async () => {
    await expect(invoke(`console.log(JSON.stringify({schema:'rudder.migration-apply/v1',protocolVersion:1,status:'error',error:{code:'requires_apply'}})); process.exitCode=2;`)).rejects.toMatchObject({ code: "requires_apply" });
  });
  it("returns Rust's typed startup approval request without deciding from database state in Node", async () => {
    const startupResponse = {
      schema: "rudder.migration-apply/v1",
      protocolVersion: 1,
      status: "startup",
      outcome: { kind: "approval-required", stateToken: "b".repeat(64), pendingMigrations: ["0001_test.sql"] },
    };
    const result = await invoke(`
      if (!request.startupGate?.facts?.interactive || request.startupGate.approval || request.startupGate.policy) process.exit(9);
      if (request.startupGate.facts.autoApplyRequested || request.startupGate.facts.promptNever) process.exit(13);
      if ('validateOnly' in request) process.exit(10);
      console.log(JSON.stringify(${JSON.stringify(startupResponse)}));
    `, { startupGate: { facts: { autoApplyRequested: false, promptNever: false, interactive: true } } });
    expect(result).toEqual({
      kind: "approval-required",
      stateToken: "b".repeat(64),
      pendingMigrations: ["0001_test.sql"],
    });
  });
  it("returns a typed refusal for prompt-never and rejects malformed approval outcomes", async () => {
    const refused = {
      schema: "rudder.migration-apply/v1", protocolVersion: 1, status: "startup",
      outcome: { kind: "refused", pendingMigrations: ["0001_test.sql"] },
    };
    await expect(invoke(`console.log(JSON.stringify(${JSON.stringify(refused)}));`, {
      startupGate: { facts: { autoApplyRequested: false, promptNever: true, interactive: true } },
    })).resolves.toEqual({ kind: "refused", pendingMigrations: ["0001_test.sql"] });

    const malformed = {
      schema: "rudder.migration-apply/v1", protocolVersion: 1, status: "startup",
      outcome: { kind: "approval-required", stateToken: "short", pendingMigrations: [] },
    };
    await expect(invoke(`console.log(JSON.stringify(${JSON.stringify(malformed)}));`, {
      startupGate: { facts: { autoApplyRequested: false, promptNever: false, interactive: true } },
    })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("does not accept a fresh approval request after a yes or a stale result without an approval", async () => {
    const approvalRequired = {
      schema: "rudder.migration-apply/v1", protocolVersion: 1, status: "startup",
      outcome: { kind: "approval-required", stateToken: "b".repeat(64), pendingMigrations: ["0001_test.sql"] },
    };
    await expect(invoke(`console.log(JSON.stringify(${JSON.stringify(approvalRequired)}));`, {
      startupGate: {
        facts: { autoApplyRequested: false, promptNever: false, interactive: true },
        approval: { stateToken: "b".repeat(64), approved: true },
      },
    })).rejects.toMatchObject({ code: "invalid_response" });

    const stale = {
      schema: "rudder.migration-apply/v1", protocolVersion: 1, status: "startup",
      outcome: { kind: "stale-approval" },
    };
    await expect(invoke(`console.log(JSON.stringify(${JSON.stringify(stale)}));`, {
      startupGate: { facts: { autoApplyRequested: false, promptNever: false, interactive: true } },
    })).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("terminates a timed-out operator before rejecting", async () => {
    await expect(invoke("setInterval(() => {}, 1000);", { timeoutMs: 100 })).rejects.toMatchObject({ code: "timeout" });
  });
  it("waits for child exit before rejecting cancellation", async () => {
    const controller = new AbortController();
    const initialRootCount = roots.length;
    const running = invoke(`
      const fs = await import('node:fs/promises');
      const ready = new URL('ready', import.meta.url);
      const cleaned = new URL('cleaned', import.meta.url);
      const cancelFile = process.env.RUDDER_MIGRATION_APPLY_CANCEL_FILE;
      process.on('SIGTERM', () => {});
      let ending = false;
      const poll = setInterval(async () => {
        if (ending) return;
        try {
          await fs.access(cancelFile);
          ending = true;
          clearInterval(poll);
          setTimeout(async () => { await fs.writeFile(cleaned, 'done'); process.exit(0); }, 1200);
        } catch {}
      }, 10);
      await fs.writeFile(ready, JSON.stringify({ pid: process.pid, cancelFile }));
    `, { signal: controller.signal });
    // Register the rejection observer before sending the cancellation signal.
    const outcome = running.then(() => ({ code: "unexpected_success" }), (error) => error);
    try {
      let root: string | undefined;
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          root = roots[initialRootCount];
          if (!root) throw new Error("fixture directory pending");
          await readFile(path.join(root, "ready")); break;
        } catch {
          if (Date.now() >= deadline) throw new Error("fixture did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const ready = JSON.parse(await readFile(path.join(root!, "ready"), "utf8")) as { pid: number; cancelFile: string };
      controller.abort();
      expect(await outcome).toMatchObject({ code: "aborted" });
      expect(() => process.kill(ready.pid, 0)).toThrow();
      expect(await readFile(path.join(root!, "cleaned"), "utf8")).toBe("done");
      await expect(readFile(ready.cancelFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      controller.abort();
      await outcome;
    }
  }, 10000);
  it("preserves an unconfirmed native cleanup failure during cancellation", async () => {
    const controller = new AbortController();
    const initialRootCount = roots.length;
    const cleanupFailure = {
      schema: "rudder.migration-apply/v1",
      protocolVersion: 1,
      status: "error",
      error: { code: "cancellation_cleanup_unconfirmed" },
    };
    const running = invoke(`
      const fs = await import('node:fs/promises');
      const ready = new URL('ready', import.meta.url);
      const cancelFile = process.env.RUDDER_MIGRATION_APPLY_CANCEL_FILE;
      process.on('SIGTERM', () => {});
      let ending = false;
      const poll = setInterval(async () => {
        if (ending) return;
        try {
          await fs.access(cancelFile);
          ending = true;
          clearInterval(poll);
          console.log(${JSON.stringify(JSON.stringify(cleanupFailure))});
          process.exitCode = 2;
        } catch {}
      }, 10);
      await fs.writeFile(ready, String(process.pid));
    `, { signal: controller.signal });
    const outcome = running.then(() => ({ code: "unexpected_success" }), (error) => error);
    try {
      let root: string | undefined;
      const deadline = Date.now() + 5000;
      while (true) {
        try {
          root = roots[initialRootCount];
          if (!root) throw new Error("fixture directory pending");
          await readFile(path.join(root, "ready")); break;
        } catch {
          if (Date.now() >= deadline) throw new Error("fixture did not become ready");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const childPid = Number(await readFile(path.join(root!, "ready"), "utf8"));
      controller.abort();
      expect(await outcome).toMatchObject({ code: "cancellation_cleanup_unconfirmed" });
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      controller.abort();
      await outcome;
    }
  }, 10000);
  it("rejects oversized output", async () => {
    await expect(invoke("process.stdout.write('x'.repeat(8*1024*1024+1));")).rejects.toMatchObject({ code: "output_too_large" });
  });
});
