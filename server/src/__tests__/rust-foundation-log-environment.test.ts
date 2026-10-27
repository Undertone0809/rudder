import { homedir, userInfo } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFoundationChildEnvironment } from "../services/rust-foundation-bridge.js";

afterEach(() => vi.unstubAllEnvs());

describe("native log reader host handoff", () => {
  it("passes both custom log roots and host masking facts without ambient secrets", () => {
    vi.stubEnv("RUN_LOG_BASE_PATH", "/custom/run logs");
    vi.stubEnv("WORKSPACE_OPERATION_LOG_BASE_PATH", "/custom/operation logs");
    vi.stubEnv("USERNAME", "legacy-host-alias");
    vi.stubEnv("USERPROFILE", "C:\\Users\\legacy-host-alias");
    vi.stubEnv("UNRELATED_PROVIDER_SECRET", "must-not-reach-child");
    const environment = createFoundationChildEnvironment({
      databaseUrl: "postgres://fixture/db", actorEnvelopeKey: "fixture-key",
      secretsMasterKeyFile: "/fixture/master.key",
    });
    expect(environment.RUN_LOG_BASE_PATH).toBe("/custom/run logs");
    expect(environment.WORKSPACE_OPERATION_LOG_BASE_PATH).toBe("/custom/operation logs");
    expect(environment.USERNAME).toBe("legacy-host-alias");
    expect(environment.USERPROFILE).toBe("C:\\Users\\legacy-host-alias");
    expect(environment.RUDDER_NATIVE_HOST_USERNAME).toBe(userInfo().username);
    expect(environment.RUDDER_NATIVE_HOST_HOME_DIRECTORY).toBe(homedir());
    expect(environment).not.toHaveProperty("UNRELATED_PROVIDER_SECRET");
  });
});
