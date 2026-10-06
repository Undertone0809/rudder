import { describe, expect, it } from "vitest";
import { resolveRunLogDataDir } from "./common.js";

describe("resolveRunLogDataDir", () => {
  it("uses the explicit run log directory before the home and instance settings", () => {
    expect(resolveRunLogDataDir({
      HOME: "/tmp/user-home",
      RUDDER_RUN_LOG_DIR: "/tmp/custom-logs",
      RUDDER_HOME: "/tmp/other-home",
      RUDDER_INSTANCE_ID: "../unsafe",
    })).toBe("/tmp/custom-logs");
  });

  it("derives the run log directory from the configured Rudder home and instance", () => {
    expect(resolveRunLogDataDir({
      HOME: "/tmp/user-home",
      RUDDER_HOME: "/tmp/rudder-home",
      RUDDER_INSTANCE_ID: "codex-debug",
    })).toBe("/tmp/rudder-home/instances/codex-debug/data/run-logs");
  });

  it("preserves the legacy dev instance default when no overrides are set", () => {
    expect(resolveRunLogDataDir({ HOME: "/tmp/user-home" }))
      .toBe("/tmp/user-home/.rudder/instances/dev/data/run-logs");
  });

  it("rejects an unsafe instance id when deriving the directory", () => {
    expect(() => resolveRunLogDataDir({
      RUDDER_HOME: "/tmp/rudder-home",
      RUDDER_INSTANCE_ID: "../outside",
    })).toThrow("Invalid RUDDER_INSTANCE_ID");
  });
});
