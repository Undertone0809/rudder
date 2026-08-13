import { describe, expect, it } from "vitest";
import { buildCodexLoadedMcpServers } from "./mcp-evidence.js";

describe("buildCodexLoadedMcpServers", () => {
  it("reports only realized built-ins and admitted external bindings", () => {
    expect(buildCodexLoadedMcpServers({
      coreEnabled: false,
      browserEnabled: true,
      computerEnabled: true,
      externalBindings: [{ serverName: "supabase", bindingId: "id", proxyUrl: "https://secret.test", bearerTokenEnvVar: "RUDDER_API_KEY", accessMode: "read_only", toolPolicy: { mode: "allowlist", allowedToolNames: [] }, required: false, startupTimeoutMs: 1, toolTimeoutMs: 1 }],
    })).toEqual([
      { serverName: "rudder-browser", source: "built_in" },
      { serverName: "rudder-computer", source: "built_in" },
      { serverName: "supabase", source: "managed_external" },
    ]);
  });

  it("returns known empty evidence when no server is realized", () => {
    expect(buildCodexLoadedMcpServers({
      coreEnabled: false,
      browserEnabled: false,
      computerEnabled: false,
      externalBindings: [],
    })).toEqual([]);
  });
});
