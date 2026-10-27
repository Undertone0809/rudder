import { homedir, userInfo } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFoundationChildEnvironment } from "../services/rust-foundation-bridge.js";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("native log reader host handoff", () => {
  it("hands a Swedish host locale to the child without inheriting locale environment variables", () => {
    const swedish = new Intl.Collator("sv-SE");
    vi.spyOn(Intl, "Collator").mockReturnValue(swedish);
    vi.stubEnv("LANG", "sv_SE.UTF-8");
    vi.stubEnv("LC_ALL", "sv_SE.UTF-8");
    const environment = createFoundationChildEnvironment({
      databaseUrl: "postgres://fixture/db", actorEnvelopeKey: "fixture-key",
      secretsMasterKeyFile: "/fixture/master.key",
    });
    expect(environment.RUDDER_NATIVE_HOST_LOCALE).toBe(swedish.resolvedOptions().locale);
    expect(swedish.compare("Ångström", "Zebra")).toBeGreaterThan(0);
    for (const key of ["LANG", "LC_ALL", "LC_MESSAGES", "LANGUAGE"]) {
      expect(environment).not.toHaveProperty(key);
    }
  });

  it("resolves relative and empty log roots against the Node writer working directory", () => {
    vi.stubEnv("RUN_LOG_BASE_PATH", "relative-run-logs");
    vi.stubEnv("WORKSPACE_OPERATION_LOG_BASE_PATH", "");
    const environment = createFoundationChildEnvironment({
      databaseUrl: "postgres://fixture/db", actorEnvelopeKey: "fixture-key",
      secretsMasterKeyFile: "/fixture/master.key",
    });
    expect(environment.RUN_LOG_BASE_PATH).toBe(resolve("relative-run-logs"));
    expect(environment.WORKSPACE_OPERATION_LOG_BASE_PATH).toBe(process.cwd());
  });

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
    expect(environment.RUDDER_NATIVE_HOST_LOCALE).toBe(new Intl.Collator().resolvedOptions().locale);
    expect(environment.RUDDER_NATIVE_HOST_USERNAME).toBe(userInfo().username);
    expect(environment.RUDDER_NATIVE_HOST_HOME_DIRECTORY).toBe(homedir());
    expect(environment).not.toHaveProperty("UNRELATED_PROVIDER_SECRET");
  });
});
