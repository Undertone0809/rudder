import { describe, expect, it } from "vitest";
import {
  createDesktopRecoveryDiagnostic,
  createDesktopStartupFailureView,
} from "./desktop-startup-failure.js";

describe("desktop startup failure view", () => {
  it("classifies database errors thrown across a dynamic-loader realm", () => {
    expect(createDesktopStartupFailureView({
      error: {
        name: "Error",
        message: "RUDDER_POSTGRES_BIN_DIR is missing initdb and pg_ctl",
      },
      stage: "starting",
      attempt: 1,
    })).toMatchObject({
      category: "database",
      summary: "The local database did not start cleanly.",
    });
  });

  it("classifies startup errors without exposing the original error", () => {
    const failure = createDesktopStartupFailureView({
      error: new Error("postgres://rudder:secret@127.0.0.1:5432 migration failed at /Users/alice/private"),
      stage: "database",
      attempt: 2,
      id: "failure-123",
      occurredAt: "2026-07-15T10:00:00.000Z",
    });

    expect(failure).toEqual({
      id: "failure-123",
      occurredAt: "2026-07-15T10:00:00.000Z",
      stage: "database",
      attempt: 2,
      category: "migration",
      summary: "The local database could not finish its migration.",
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(JSON.stringify(failure)).not.toContain("/Users/alice");
  });

  it("creates a bounded diagnostic without config or environment contents", () => {
    const failure = createDesktopStartupFailureView({
      error: new Error("EACCES token=secret"),
      stage: "config",
      attempt: 1,
      id: "failure-456",
      occurredAt: "2026-07-15T10:00:00.000Z",
    });
    const diagnostic = createDesktopRecoveryDiagnostic({
      failure,
      version: "0.4.6",
      platform: "darwin",
      arch: "arm64",
      profile: "prod_local",
      instance: "default",
    });

    expect(diagnostic).toContain("Failure ID: failure-456");
    expect(diagnostic).toContain("Summary: Rudder could not access a required local file or folder.");
    expect(diagnostic).not.toContain("/Users/alice");
    expect(diagnostic).not.toContain("Instance folder");
    expect(diagnostic).not.toContain("token=secret");
    expect(diagnostic).not.toContain("config.json");
    expect(diagnostic).not.toContain(".env");
    expect(diagnostic.length).toBeLessThan(1_200);
  });

  it("classifies a macOS library policy rejection without exposing raw dyld output", () => {
    const failure = createDesktopStartupFailureView({
      error: new Error(
        "Library not loaded: liblz4.1.dylib; code signature not valid for use in process: library load denied by system policy",
      ),
      stage: "database",
      attempt: 1,
      id: "failure-policy",
      occurredAt: "2026-07-16T08:05:47.098Z",
    });

    expect(failure.category).toBe("system_policy");
    expect(failure.summary).toBe("The operating system blocked a required local database library.");
    expect(JSON.stringify(failure)).not.toContain("liblz4");
    expect(JSON.stringify(failure)).not.toContain("code signature");
  });

  it("uses the last startup stage when a child process rejects without an Error", () => {
    const failure = createDesktopStartupFailureView({
      error: undefined,
      stage: "database",
      attempt: 1,
    });

    expect(failure.category).toBe("database");
    expect(failure.summary).toBe("The local database did not start cleanly.");
  });
});
