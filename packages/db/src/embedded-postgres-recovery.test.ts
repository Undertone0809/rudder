import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedPostgresStartupError,
  isEmbeddedPostgresSharedMemoryError,
  parseSysvSharedMemorySegments,
  readLivePostmasterPidFile,
  readPostmasterPidFile,
  removeStalePostmasterPidFile,
} from "./embedded-postgres-recovery.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createPidFile(contents: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-postmaster-recovery-"));
  tempRoots.push(root);
  const file = path.join(root, "postmaster.pid");
  writeFileSync(file, contents, "utf8");
  return file;
}

function stalePidFileContents(dataDir: string, port = 54329): string {
  return ["2147483647", dataDir, "0", String(port), "", "127.0.0.1", "", "ready", ""].join("\n");
}

describe("PostgreSQL postmaster pid recovery", () => {
  it("parses the data directory and port from a pid file", () => {
    const file = createPidFile(stalePidFileContents("C:/rudder/db", 54339));

    expect(readPostmasterPidFile(file)).toEqual({
      pid: 2147483647,
      dataDir: "C:/rudder/db",
      port: 54339,
    });
  });

  it("returns the actual port for a live postmaster even when startup configuration changes", () => {
    const dataDir = "/tmp/rudder-live-db";
    const file = createPidFile([
      String(process.pid),
      dataDir,
      "0",
      "54339",
      "",
      "127.0.0.1",
      "",
      "ready",
      "",
    ].join("\n"));

    expect(readLivePostmasterPidFile(file, {
      expectedDataDir: dataDir,
      processMatches: () => true,
    })).toEqual({
      pid: process.pid,
      dataDir,
      port: 54339,
    });
  });

  it("rejects a live PID that is not the expected PostgreSQL postmaster", () => {
    const dataDir = "/tmp/rudder-live-db";
    const file = createPidFile([
      String(process.pid),
      dataDir,
      "0",
      "54339",
      "",
      "127.0.0.1",
      "",
      "ready",
      "",
    ].join("\n"));

    expect(readLivePostmasterPidFile(file, {
      expectedDataDir: dataDir,
      processMatches: () => false,
    })).toBeNull();
  });

  it("rejects a live postmaster pid file for another data directory", () => {
    const file = createPidFile([
      String(process.pid),
      "/tmp/another-rudder-db",
      "0",
      "54339",
      "",
      "127.0.0.1",
      "",
      "ready",
      "",
    ].join("\n"));
    const processMatches = vi.fn(() => true);

    expect(readLivePostmasterPidFile(file, {
      expectedDataDir: "/tmp/rudder-live-db",
      processMatches,
    })).toBeNull();
    expect(processMatches).not.toHaveBeenCalled();
  });

  it("rejects a dead postmaster instead of reusing its port", () => {
    const file = createPidFile(stalePidFileContents("/tmp/rudder-dead-db", 54339));

    expect(readLivePostmasterPidFile(file, {
      expectedDataDir: "/tmp/rudder-dead-db",
      processMatches: () => true,
    })).toBeNull();
  });

  it("removes a dead pid file without touching the database cluster", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "rudder-postmaster-recovery-db-"));
    tempRoots.push(root);
    const dataDir = path.join(root, "db");
    const file = createPidFile(stalePidFileContents(dataDir, 54339));

    expect(removeStalePostmasterPidFile({ postmasterPidFile: file, expectedDataDir: dataDir })).toEqual({
      pid: 2147483647,
      dataDir,
      port: 54339,
    });
    expect(() => readFileSync(file)).toThrow();
  });

  it("refuses to remove a pid file for another data directory", () => {
    const file = createPidFile(stalePidFileContents("C:/other/db"));

    expect(removeStalePostmasterPidFile({
      postmasterPidFile: file,
      expectedDataDir: "C:/rudder/db",
    })).toBeNull();
    expect(readFileSync(file, "utf8")).toContain("C:/other/db");
  });
});

describe("createEmbeddedPostgresStartupError", () => {
  it("turns an undefined process rejection into an actionable error with buffered logs", () => {
    const error = createEmbeddedPostgresStartupError(
      undefined,
      "Embedded PostgreSQL failed during start",
      ["Library not loaded: liblz4", "library load denied by system policy"],
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("Embedded PostgreSQL failed during start");
    expect(error.message).toContain("Library not loaded: liblz4");
    expect(error.message).toContain("library load denied by system policy");
  });

  it("preserves the original error diagnostics when adding buffered logs", () => {
    const source = Object.assign(new Error("spawn failed"), { code: "ENOEXEC" });
    source.stack = "Error: spawn failed\n    at originalPostgresStart (postgres-start.ts:42:7)";

    const error = createEmbeddedPostgresStartupError(source, "fallback", ["postgres stderr"]);

    expect(error.cause).toBe(source);
    expect((error as Error & { code?: unknown }).code).toBe("ENOEXEC");
    expect(error.stack).toContain("originalPostgresStart");
    expect(error.message).toContain("postgres stderr");
  });
});

describe("parseSysvSharedMemorySegments", () => {
  it("extracts shared memory rows from ipcs output", () => {
    const parsed = parseSysvSharedMemorySegments(`
IPC status from <running system>
T     ID     KEY        MODE       OWNER    GROUP  CPID  LPID
Shared Memory:
m  65536 0x006df892 --rw-rw-rw-  zeeland    staff  13041  13041
m 38666242 0x037db5ba --rw-------  zeeland    staff  70396  70396
    `);

    expect(parsed).toEqual([
      {
        id: "65536",
        owner: "zeeland",
        creatorPid: 13041,
        lastOperatorPid: 13041,
      },
      {
        id: "38666242",
        owner: "zeeland",
        creatorPid: 70396,
        lastOperatorPid: 70396,
      },
    ]);
  });
});

describe("isEmbeddedPostgresSharedMemoryError", () => {
  it("matches shared memory exhaustion from embedded postgres logs", () => {
    expect(
      isEmbeddedPostgresSharedMemoryError(undefined, [
        "FATAL: could not create shared memory segment: No space left on device",
        "DETAIL: Failed system call was shmget(key=74602093, size=56, 03600).",
      ]),
    ).toBe(true);
  });

  it("ignores unrelated startup failures", () => {
    expect(
      isEmbeddedPostgresSharedMemoryError(new Error("password authentication failed")),
    ).toBe(false);
  });
});
