import { describe, expect, it } from "vitest";
import {
  createDesktopRecoveryDiagnostic,
  createDesktopStartupFailureView,
} from "./desktop-startup-failure.js";

describe("desktop startup failure view", () => {
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
      instanceRoot: "/Users/alice/.rudder/instances/default",
    });

    expect(diagnostic).toContain("Failure ID: failure-456");
    expect(diagnostic).toContain("Instance folder: /Users/alice/.rudder/instances/default");
    expect(diagnostic).not.toContain("token=secret");
    expect(diagnostic).not.toContain("config.json");
    expect(diagnostic).not.toContain(".env");
    expect(diagnostic.length).toBeLessThan(1_200);
  });
});
