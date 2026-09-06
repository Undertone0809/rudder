import { describe, expect, it } from "vitest";
import {
  parseRudderNativeMode,
  resolveRudderNativeCapability,
  rudderNativeCapabilityDisableEnv,
} from "./native-mode.js";

describe("native mode policy", () => {
  it("defaults every supported capability to Rust-first auto mode", () => {
    expect(resolveRudderNativeCapability({ capability: "workspace-backup" })).toMatchObject({
      mode: "auto",
      enabled: true,
      required: false,
      fallbackAllowed: true,
      disabledBy: null,
    });
  });

  it("supports the global Node rollback and required diagnostic modes", () => {
    expect(resolveRudderNativeCapability({
      capability: "agent-run-process",
      env: { RUDDER_NATIVE_MODE: "node" },
    })).toMatchObject({ enabled: false, fallbackAllowed: false, disabledBy: "RUDDER_NATIVE_MODE" });
    expect(resolveRudderNativeCapability({
      capability: "agent-run-process",
      env: { RUDDER_NATIVE_MODE: "required" },
    })).toMatchObject({ enabled: true, required: true, fallbackAllowed: false });
  });

  it("supports capability rollback and explicit legacy disable values", () => {
    expect(rudderNativeCapabilityDisableEnv("run-evidence")).toBe("RUDDER_NATIVE_RUN_EVIDENCE_DISABLED");
    expect(resolveRudderNativeCapability({
      capability: "run-evidence",
      env: { RUDDER_NATIVE_RUN_EVIDENCE_DISABLED: "1" },
    })).toMatchObject({ enabled: false, disabledBy: "RUDDER_NATIVE_RUN_EVIDENCE_DISABLED" });
    expect(resolveRudderNativeCapability({
      capability: "run-evidence",
      env: { RUDDER_NATIVE_RUN_EVIDENCE_INDEX: "false" },
      legacyToggleEnvs: ["RUDDER_NATIVE_RUN_EVIDENCE_INDEX"],
    })).toMatchObject({ enabled: false, disabledBy: "RUDDER_NATIVE_RUN_EVIDENCE_INDEX" });
    expect(rudderNativeCapabilityDisableEnv("workspace-files"))
      .toBe("RUDDER_NATIVE_WORKSPACE_FILES_DISABLED");
  });

  it("rejects invalid global modes instead of silently changing engines", () => {
    expect(() => parseRudderNativeMode("sometimes")).toThrow(/Invalid RUDDER_NATIVE_MODE/);
  });
});
