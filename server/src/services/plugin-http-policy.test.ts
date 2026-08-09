import { describe, expect, it } from "vitest";
import {
  isPluginHttpAddressBlocked,
  isPluginHttpOriginAllowed,
  normalizePluginHttpOrigin,
  parsePluginHttpAllowlistEnv,
} from "./plugin-http-policy.js";

describe("plugin HTTP allowlist", () => {
  it("normalizes exact origins and removes duplicates", () => {
    expect(parsePluginHttpAllowlistEnv({
      RUDDER_PLUGIN_HTTP_ALLOWLIST: "http://127.0.0.1:4311, http://127.0.0.1:4311/",
    })).toEqual(["http://127.0.0.1:4311"]);
  });

  it("rejects paths and non-HTTP origins", () => {
    expect(() => normalizePluginHttpOrigin("http://127.0.0.1:4311/path")).toThrow(
      "RUDDER_PLUGIN_HTTP_ALLOWLIST entries must contain only an HTTP(S) origin",
    );
    expect(() => normalizePluginHttpOrigin("file:///tmp/fixture")).toThrow(
      "RUDDER_PLUGIN_HTTP_ALLOWLIST entries must contain only an HTTP(S) origin",
    );
  });

  it("matches the exact origin while allowing paths below it", () => {
    const allowed = ["http://127.0.0.1:4311"];
    expect(isPluginHttpOriginAllowed(new URL("http://127.0.0.1:4311/plugin-http"), allowed)).toBe(true);
    expect(isPluginHttpOriginAllowed(new URL("http://127.0.0.1:4312/plugin-http"), allowed)).toBe(false);
  });

  it.each([
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ])("blocks non-public address %s", (address) => {
    expect(isPluginHttpAddressBlocked(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"])(
    "allows public address %s",
    (address) => {
      expect(isPluginHttpAddressBlocked(address)).toBe(false);
    },
  );
});
