import { describe, expect, it } from "vitest";
import {
  createEmbeddedPostgresStartupError,
  isEmbeddedPostgresSharedMemoryError,
  parseSysvSharedMemorySegments,
} from "./embedded-postgres-recovery.js";

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
