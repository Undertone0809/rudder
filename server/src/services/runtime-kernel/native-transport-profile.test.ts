import { describe, expect, it } from "vitest";
import { filterNativeTransportProfile } from "./native-transport-profile.js";

describe("host native transport snapshots", () => {
  it("retains dynamic Pi selectors without provider credentials or raw payloads", () => {
    expect(filterNativeTransportProfile({
      runtimeType: "pi_local", cwd: "/workspace", command: "pi", sessionDir: "/sessions",
      rpcArgs: ["--extension", "/managed/extension.ts"],
      rpcEnv: { HOME: "/operator", PI_OFFLINE: "1", API_KEY: "secret" },
      env: { TOKEN: "secret" }, sessionParams: { arbitrary: "untrusted" },
    })).toEqual({ runtimeType: "pi_local", cwd: "/workspace", command: "pi", sessionDir: "/sessions",
      rpcArgs: ["--extension", "/managed/extension.ts"], rpcEnv: { HOME: "/operator", PI_OFFLINE: "1" } });
  });
  it.each(["--api-key", "--token=secret", "--password", "--headers", "--authorization", "-H"])("rejects credential argument %s", (arg) => {
    expect(() => filterNativeTransportProfile({ runtimeType: "pi_local", rpcArgs: [arg, "secret"] })).toThrow("not approved");
  });
  it.each(["Authorization: Bearer private-token-value", "api_key=private-value"])("rejects credential value %s", (value) => {
    expect(() => filterNativeTransportProfile({ runtimeType: "pi_local", rpcArgs: ["--extension", value] })).toThrow("credential-bearing");
  });
  it.each(["https://remote.invalid", "http://user:secret@127.0.0.1", "http://127.0.0.1?token=secret", "file:///tmp/server"])("rejects unauthorized transport %s", (serverUrl) => {
    expect(() => filterNativeTransportProfile({ runtimeType: "opencode_local", serverUrl })).toThrow();
  });
  it("preserves managed local OpenCode identity but excludes per-run config and auth", () => {
    expect(filterNativeTransportProfile({ runtimeType: "opencode_local", serverUrl: "http://127.0.0.1:1234",
      exportEnv: { XDG_DATA_HOME: "/managed/data", OPENCODE_CONFIG: "/credentials/config", TOKEN: "secret" },
    })).toEqual({ runtimeType: "opencode_local", serverUrl: "http://127.0.0.1:1234/", exportEnv: { XDG_DATA_HOME: "/managed/data" } });
  });
});
