import { describe, expect, it, vi } from "vitest";
import { resolveDesktopOwnedPorts, type LocalEnvProfile } from "./desktop-local-env.js";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

const prodLocalProfile: LocalEnvProfile = {
  name: "prod_local",
  instanceId: "default",
  port: "3200",
  embeddedPostgresPort: "54339",
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
});
