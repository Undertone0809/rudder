import { describe, expect, it } from "vitest";
import {
  resolveDesktopLocalEnvProfile,
  resolveDesktopOwnedPorts,
  type LocalEnvProfile,
} from "./desktop-local-env.js";

const prodLocalProfile: LocalEnvProfile = {
  name: "prod_local",
  instanceId: "default",
  port: "3200",
  embeddedPostgresPort: "54339",
};

const devProfile: LocalEnvProfile = {
  name: "dev",
  instanceId: "dev",
  port: "3100",
  embeddedPostgresPort: "54329",
};

describe("resolveDesktopOwnedPorts", () => {
  it("ignores inherited CLI/updater ports for a normal Desktop launch", () => {
    expect(resolveDesktopOwnedPorts(prodLocalProfile, {
      PORT: "3100",
      RUDDER_EMBEDDED_POSTGRES_PORT: "54329",
    })).toEqual({ port: "3200", embeddedPostgresPort: "54339" });
  });

  it("preserves isolated ports for packaged smoke runs", () => {
    expect(resolveDesktopOwnedPorts(prodLocalProfile, {
      RUDDER_DESKTOP_APP_NAME: "Rudder-smoke-packaged-40101",
      PORT: "40101",
      RUDDER_EMBEDDED_POSTGRES_PORT: "40102",
    })).toEqual({ port: "40101", embeddedPostgresPort: "40102" });
  });

  it("uses the handed-off dev ports only for an unpackaged dev runtime", () => {
    const env = {
      RUDDER_DESKTOP_DEV_RUNTIME_OVERRIDE: "1",
      PORT: "3830",
      RUDDER_EMBEDDED_POSTGRES_PORT: "55334",
    };

    expect(resolveDesktopOwnedPorts(devProfile, env, false)).toEqual({
      port: "3830",
      embeddedPostgresPort: "55334",
    });
    expect(resolveDesktopOwnedPorts(devProfile, env, true)).toEqual({
      port: "3100",
      embeddedPostgresPort: "54329",
    });
    expect(resolveDesktopOwnedPorts(devProfile, {
      ...env,
      RUDDER_DESKTOP_DEV_RUNTIME_OVERRIDE: undefined,
    }, false)).toEqual({ port: "3100", embeddedPostgresPort: "54329" });
  });
});

describe("resolveDesktopLocalEnvProfile", () => {
  it("uses a handed-off explicit instance for an unpackaged dev runtime", () => {
    expect(resolveDesktopLocalEnvProfile({
      RUDDER_LOCAL_ENV: "dev",
      RUDDER_DESKTOP_DEV_RUNTIME_OVERRIDE: "1",
      RUDDER_INSTANCE_ID: "native-chat-preview-20260929",
    }, false)).toEqual({
      ...devProfile,
      instanceId: "native-chat-preview-20260929",
    });
  });

  it("keeps the standard profile when the handoff marker is absent or packaged", () => {
    const env = {
      RUDDER_LOCAL_ENV: "dev",
      RUDDER_INSTANCE_ID: "native-chat-preview-20260929",
    };
    expect(resolveDesktopLocalEnvProfile(env, false)).toEqual(devProfile);
    expect(resolveDesktopLocalEnvProfile({
      ...env,
      RUDDER_DESKTOP_DEV_RUNTIME_OVERRIDE: "1",
    }, true)).toEqual(devProfile);
  });

  it("rejects an unsafe handed-off instance id", () => {
    expect(() => resolveDesktopLocalEnvProfile({
      RUDDER_LOCAL_ENV: "dev",
      RUDDER_DESKTOP_DEV_RUNTIME_OVERRIDE: "1",
      RUDDER_INSTANCE_ID: "../outside",
    }, false)).toThrow("Invalid RUDDER_INSTANCE_ID");
  });
});
