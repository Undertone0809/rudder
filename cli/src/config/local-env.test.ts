import { afterEach, describe, expect, it } from "vitest";
import {
  applyLocalEnvProfile,
  getDisposableLocalEnvProfiles,
  parseLocalEnvName,
  resolveLocalEnvProfile,
} from "./local-env.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("local env profiles", () => {
  it("accepts hyphenated aliases", () => {
    expect(parseLocalEnvName("prod-local")).toBe("prod_local");
    expect(parseLocalEnvName(" e2e ")).toBe("e2e");
    expect(parseLocalEnvName("unknown")).toBeNull();
  });

  it("resolves stable profile defaults", () => {
    expect(resolveLocalEnvProfile("dev")).toMatchObject({
      instanceId: "dev",
      port: 3100,
      embeddedPostgresPort: 54329,
      resettable: true,
    });
    expect(resolveLocalEnvProfile("prod_local")).toMatchObject({
      instanceId: "default",
      port: 3200,
      embeddedPostgresPort: 54339,
      resettable: false,
    });
  });

  it("applies profile defaults to the process environment", () => {
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.PORT;
    delete process.env.RUDDER_EMBEDDED_POSTGRES_PORT;

    const profile = applyLocalEnvProfile({ localEnv: "e2e" });

    expect(profile?.name).toBe("e2e");
    expect(process.env.RUDDER_LOCAL_ENV).toBe("e2e");
    expect(process.env.RUDDER_INSTANCE_ID).toBe("e2e");
    expect(process.env.PORT).toBe("3300");
    expect(process.env.RUDDER_EMBEDDED_POSTGRES_PORT).toBe("54349");
  });

  it("does not override an explicit instance flag", () => {
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.PORT;
    delete process.env.RUDDER_EMBEDDED_POSTGRES_PORT;
    applyLocalEnvProfile({ localEnv: "prod_local", instance: "custom-instance" });
    expect(process.env.RUDDER_INSTANCE_ID).toBeUndefined();
    expect(process.env.PORT).toBe("3200");
  });

  it("exposes disposable profiles for reset flows", () => {
    expect(getDisposableLocalEnvProfiles().map((profile) => profile.name)).toEqual(["dev", "e2e"]);
  });
});
