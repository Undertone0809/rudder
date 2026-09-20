import type { MigrationState } from "@rudderhq/db";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  assertMigrationPreflightAgreement,
  createMigrationPreflightRequest,
  MIGRATION_PREFLIGHT_DATABASE_URL_ENV,
  MIGRATION_PREFLIGHT_PROTOCOL_VERSION,
  MIGRATION_PREFLIGHT_SCHEMA,
  MigrationPreflightAdapterError,
  resolveMigrationPreflightBinary,
  runMigrationPreflight,
  type MigrationPreflightReport,
  type MigrationPreflightSpawn,
} from "./migration-preflight.js";

const databaseUrl = "postgres://rudder:secret@127.0.0.1:5432/rudder";
const source = {
  migrationsDir: "/tmp/rudder-migrations",
  journalFile: "/tmp/rudder-migrations/meta/_journal.json",
  expectedFingerprint: "fixture-fingerprint",
};

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  exitCode: number | null = null;
}

function report(status: string) {
  const journalPresent = !["bootstrap", "unsafe-legacy"].includes(status);
  const tableCount = status === "bootstrap" ? 0 : 1;
  const current = status === "current";
  const missingCoreSchema = status === "missing-core-schema";
  const historyNeedsMigrations = !current && !missingCoreSchema;
  return {
    status,
    tableCount,
    journalPresent,
    journalSchema: journalPresent ? "drizzle" : null,
    coreSchemaPresent: !missingCoreSchema,
    organizationsTablePresent: current,
    history: {
      status: historyNeedsMigrations ? "needsMigrations" : "upToDate",
      reason: current || missingCoreSchema
        ? "manifest-match"
        : status === "pending"
          ? "pending-migrations"
          : status === "mismatch"
            ? "manifest-mismatch"
            : "migration-journal-missing",
      manifestFingerprint: "fixture-fingerprint",
      migrationTableSchema: null,
      journalEntryCount: 0,
      appliedMigrations: [],
      pendingMigrations: [],
      diagnostics: [],
    },
    diagnostics: [],
  };
}

function migrationIdentity(fileName: string, order: number) {
  return {
    order,
    fileName,
    sha256: `${fileName}-sha256`,
    id: order + 1,
    name: null,
    hash: null,
    createdAt: null,
  };
}

function agreementReport(options: {
  status: string;
  fingerprint?: string;
  appliedMigrations?: string[];
  pendingMigrations?: string[];
}): MigrationPreflightReport {
  const value = report(options.status) as unknown as MigrationPreflightReport;
  value.history.manifestFingerprint = options.fingerprint ?? source.expectedFingerprint;
  value.history.appliedMigrations = (options.appliedMigrations ?? []).map(migrationIdentity);
  value.history.pendingMigrations = (options.pendingMigrations ?? [])
    .map((fileName, order) => migrationIdentity(fileName, order));
  return value;
}

function nodeState(options: {
  reason?: "pending-migrations" | "missing-core-schema";
  appliedMigrations?: string[];
  pendingMigrations?: string[];
} = {}): MigrationState {
  const availableMigrations = ["0000_first.sql", "0001_second.sql"];
  return {
    status: "needsMigrations",
    tableCount: 1,
    availableMigrations,
    appliedMigrations: options.appliedMigrations ?? [availableMigrations[0]!],
    pendingMigrations: options.pendingMigrations ?? [availableMigrations[1]!],
    reason: options.reason ?? "pending-migrations",
  };
}

function agreementLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

function successResponse(status: string): string {
  return JSON.stringify({
    schema: MIGRATION_PREFLIGHT_SCHEMA,
    protocolVersion: MIGRATION_PREFLIGHT_PROTOCOL_VERSION,
    status,
    report: report(status),
  });
}

function errorResponse(
  classification = "database",
  code = "database_connect_failed",
  message = "database connection failed",
): string {
  return JSON.stringify({
    schema: MIGRATION_PREFLIGHT_SCHEMA,
    protocolVersion: MIGRATION_PREFLIGHT_PROTOCOL_VERSION,
    status: "error",
    error: { classification, code, message },
  });
}

function spawnResponse(
  stdout: string | Buffer,
  options: { exitCode?: number; stderr?: string } = {},
): { spawnProcess: MigrationPreflightSpawn; calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }>; child: FakeChild } {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const child = new FakeChild();
  const spawnProcess: MigrationPreflightSpawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions as Record<string, unknown> });
    queueMicrotask(() => {
      child.stdout.end(stdout);
      if (options.stderr) child.stderr.end(options.stderr);
      else child.stderr.end();
      child.exitCode = options.exitCode ?? 0;
      child.emit("close", child.exitCode, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnProcess, calls, child };
}

describe("migration preflight adapter", () => {
  it("fails closed on a Rust manifest fingerprint mismatch", () => {
    const logger = agreementLogger();

    expect(() => assertMigrationPreflightAgreement({
      label: "test",
      state: nodeState(),
      report: agreementReport({ status: "pending", fingerprint: "different-fingerprint" }),
      required: true,
      manifestFingerprint: source.expectedFingerprint,
      logger,
    })).toThrow(/manifest-fingerprint/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails closed when Rust applied migration order differs from Node", () => {
    const logger = agreementLogger();

    expect(() => assertMigrationPreflightAgreement({
      label: "test",
      state: nodeState({ appliedMigrations: ["0000_first.sql", "0001_second.sql"], pendingMigrations: [] }),
      report: agreementReport({
        status: "pending",
        appliedMigrations: ["0001_second.sql", "0000_first.sql"],
        pendingMigrations: [],
      }),
      required: true,
      manifestFingerprint: source.expectedFingerprint,
      logger,
    })).toThrow(/applied-migrations/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("fails closed when Rust pending migration order differs from Node", () => {
    const logger = agreementLogger();

    expect(() => assertMigrationPreflightAgreement({
      label: "test",
      state: nodeState({ pendingMigrations: ["0000_first.sql", "0001_second.sql"] }),
      report: agreementReport({
        status: "pending",
        appliedMigrations: ["0000_first.sql"],
        pendingMigrations: ["0001_second.sql", "0000_first.sql"],
      }),
      required: true,
      manifestFingerprint: source.expectedFingerprint,
      logger,
    })).toThrow(/pending-migrations/);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("uses the sent manifest order for Node's derived pending plan", () => {
    const logger = agreementLogger();
    const manifestOrder = ["0000_first.sql", "0162_last.sql", "0055_legacy.sql"];

    expect(() => assertMigrationPreflightAgreement({
      label: "test",
      state: nodeState({ pendingMigrations: ["0055_legacy.sql", "0162_last.sql"] }),
      report: agreementReport({
        status: "pending",
        appliedMigrations: ["0000_first.sql"],
        pendingMigrations: ["0162_last.sql", "0055_legacy.sql"],
      }),
      required: true,
      manifestFingerprint: source.expectedFingerprint,
      manifestMigrationFileNames: manifestOrder,
      logger,
    })).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("records one bounded warning and continues in auto mode", () => {
    const logger = agreementLogger();

    expect(() => assertMigrationPreflightAgreement({
      label: "test",
      state: nodeState(),
      report: agreementReport({
        status: "pending",
        fingerprint: "different-fingerprint",
        appliedMigrations: ["0001_second.sql"],
        pendingMigrations: ["0000_first.sql"],
      }),
      required: false,
      manifestFingerprint: source.expectedFingerprint,
      logger,
    })).not.toThrow();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      disagreements: ["manifest-fingerprint", "applied-migrations", "pending-migrations"],
    });
    expect(JSON.stringify(logger.warn.mock.calls[0]?.[0])).not.toContain("0000_first.sql");
  });

  it("allows missing-core-schema's explicit Rust empty pending plan", () => {
    const logger = agreementLogger();
    const allMigrations = ["0000_first.sql", "0001_second.sql"];

    // inspectMigrations synthesizes all available files as pending only after
    // confirming that every migration is already applied and core schema is missing.
    expect(() => assertMigrationPreflightAgreement({
      label: "test",
      state: nodeState({
        reason: "missing-core-schema",
        appliedMigrations: allMigrations,
        pendingMigrations: allMigrations,
      }),
      report: agreementReport({
        status: "missing-core-schema",
        appliedMigrations: allMigrations,
        pendingMigrations: [],
      }),
      required: true,
      manifestFingerprint: source.expectedFingerprint,
      logger,
    })).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("builds the versioned request without putting the database URL in JSON", () => {
    const request = JSON.parse(createMigrationPreflightRequest(source)) as Record<string, unknown>;

    expect(request).toEqual({
      schema: MIGRATION_PREFLIGHT_SCHEMA,
      protocolVersion: MIGRATION_PREFLIGHT_PROTOCOL_VERSION,
      source,
    });
    expect(JSON.stringify(request)).not.toContain("postgres://");
  });

  it("invokes the CLI shell-free and passes the database URL only in its environment", async () => {
    const fixture = spawnResponse(successResponse("current"));
    let stdin = "";
    fixture.child.stdin.on("data", (chunk) => { stdin += chunk.toString(); });

    await expect(runMigrationPreflight(
      { databaseUrl, source },
      {
        binaryPath: "/tmp/migration-preflight; touch /tmp/should-not-run",
        env: { RUDDER_TEST_MARKER: "kept" },
        spawnProcess: fixture.spawnProcess,
      },
    )).resolves.toMatchObject({ status: "current" });

    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]).toMatchObject({
      command: "/tmp/migration-preflight; touch /tmp/should-not-run",
      args: [],
      options: { shell: false, stdio: ["pipe", "pipe", "pipe"] },
    });
    const childEnv = fixture.calls[0]?.options.env as NodeJS.ProcessEnv;
    expect(childEnv.RUDDER_TEST_MARKER).toBe("kept");
    expect(childEnv[MIGRATION_PREFLIGHT_DATABASE_URL_ENV]).toBe(databaseUrl);
    expect(stdin).toContain(MIGRATION_PREFLIGHT_SCHEMA);
    expect(stdin).not.toContain(databaseUrl);
  });

  it.each([
    "bootstrap",
    "unsafe-legacy",
    "pending",
    "mismatch",
    "missing-core-schema",
    "current",
  ])("returns business status %s without treating it as a transport error", async (status) => {
    const fixture = spawnResponse(successResponse(status));

    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: fixture.spawnProcess },
    )).resolves.toMatchObject({ status });
  });

  it("maps a Rust error response to a typed error without exposing its message", async () => {
    const diagnosticMessage = "diagnostic fixture message";
    const fixture = spawnResponse(errorResponse("database", "database_connect_failed", diagnosticMessage), { exitCode: 2 });

    const error = await runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: fixture.spawnProcess },
    ).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(MigrationPreflightAdapterError);
    expect(error).toMatchObject({ classification: "database", code: "database_connect_failed" });
    expect((error as Error).message).not.toContain(diagnosticMessage);
  });

  it("rejects malformed envelopes, extra output, and unexpected stderr", async () => {
    const malformed = spawnResponse("{not-json\n");
    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: malformed.spawnProcess },
    )).rejects.toMatchObject({ classification: "protocol", code: "malformed_json" });

    const extraOutput = spawnResponse(`${successResponse("current")}\nextra\n`);
    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: extraOutput.spawnProcess },
    )).rejects.toMatchObject({ classification: "protocol", code: "response_line_count" });

    const stderr = spawnResponse(successResponse("current"), { stderr: "unexpected diagnostic" });
    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: stderr.spawnProcess },
    )).rejects.toMatchObject({ classification: "protocol", code: "unexpected_stderr" });
  });

  it("rejects a report whose status contradicts its database-shape facts", async () => {
    const value = JSON.parse(successResponse("current")) as Record<string, any>;
    value.report.organizationsTablePresent = false;
    const fixture = spawnResponse(JSON.stringify(value));

    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: fixture.spawnProcess },
    )).rejects.toMatchObject({ classification: "protocol", code: "report_semantics_invalid" });
  });

  it("fails closed when the process exit code disagrees with the response", async () => {
    const successWithFailureExit = spawnResponse(successResponse("current"), { exitCode: 1 });
    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: successWithFailureExit.spawnProcess },
    )).rejects.toMatchObject({ classification: "protocol", code: "response_envelope_mismatch" });

    const errorWithSuccessExit = spawnResponse(errorResponse(), { exitCode: 0 });
    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess: errorWithSuccessExit.spawnProcess },
    )).rejects.toMatchObject({ classification: "protocol", code: "error_exit_code_mismatch" });
  });

  it("bounds execution time and terminates a stuck child", async () => {
    const child = new FakeChild();
    const spawnProcess: MigrationPreflightSpawn = () => child as unknown as ChildProcessWithoutNullStreams;

    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", timeoutMs: 10, spawnProcess },
    )).rejects.toMatchObject({ classification: "process", code: "timeout" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("force-kills a child that ignores the graceful termination request", async () => {
    const child = new FakeChild();
    const spawnProcess: MigrationPreflightSpawn = () => child as unknown as ChildProcessWithoutNullStreams;

    await expect(runMigrationPreflight(
      { databaseUrl, source },
      { binaryPath: "/tmp/migration-preflight", timeoutMs: 10, spawnProcess },
    )).rejects.toMatchObject({ classification: "process", code: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("rejects invalid database configuration before spawning", async () => {
    const spawnProcess = vi.fn<MigrationPreflightSpawn>();

    await expect(runMigrationPreflight(
      { databaseUrl: "file://user:secret@database.invalid/rudder", source },
      { binaryPath: "/tmp/migration-preflight", spawnProcess },
    )).rejects.toMatchObject({ classification: "configuration", code: "database_url_protocol_unsupported" });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("resolves an explicit native binary path without probing fallback paths", () => {
    expect(resolveMigrationPreflightBinary({
      RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH: "/tmp/explicit migration-preflight",
    })).toBe("/tmp/explicit migration-preflight");
  });
});
