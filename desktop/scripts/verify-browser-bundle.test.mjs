import { describe, expect, it } from "vitest";
import {
  packagedCliArgs,
  packagedCliRuntimeEnv,
} from "./verify-browser-bundle.mjs";

describe("packaged Browser bundle verifier", () => {
  it("runs the Linux Electron CLI handshake without a display or inherited session bus", () => {
    expect(packagedCliArgs("linux", ["--desktop-cli", "mcp-server"])).toEqual([
      "--no-sandbox",
      "--headless",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--desktop-cli",
      "mcp-server",
    ]);
    expect(packagedCliRuntimeEnv("linux", {
      DBUS_SESSION_BUS_ADDRESS: "/dev/null",
      PATH: "/usr/bin",
    })).toEqual({
      PATH: "/usr/bin",
    });
  });

  it("preserves normal packaged CLI arguments and environment on desktop platforms", () => {
    const args = ["desktop-cli-runner.js", "mcp-server"];
    const env = {
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/dbus",
      PATH: "/usr/bin",
    };

    expect(packagedCliArgs("darwin", args)).toBe(args);
    expect(packagedCliRuntimeEnv("darwin", env)).toEqual(env);
  });
});
