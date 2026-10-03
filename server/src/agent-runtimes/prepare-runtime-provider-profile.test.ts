import { resolveManagedCodexHomeDir } from "@rudderhq/agent-runtime-codex-local/server";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { codexMethodsFromSchema, prepareRuntimeProviderProfile } from "./prepare-runtime-provider-profile.js";

const protocol = vi.hoisted(() => ({ methods: ["thread/resume", "thread/read", "thread/fork"] }));
vi.mock("node:child_process", () => ({
  execFile: Object.assign((..._args: unknown[]) => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: async (_command: string, args: string[]) => {
      if (args[0] === "--version") return { stdout: process.versions.node, stderr: "" };
      await writeFile(path.join(args[3], "ClientRequest.json"), JSON.stringify({
        oneOf: protocol.methods.map((method) => ({ properties: { method: { enum: [method] } } })),
      }));
      return { stdout: "", stderr: "" };
    },
  }),
}));

describe("native provider profile preparation", () => {
  it("discovers installed version and binds the host managed home without replacing the shared auth source", async () => {
    const config = { command: process.execPath, providerVersion: "invented", env: { CODEX_HOME: "/shared/auth", RUDDER_HOME: "/untrusted/override" } };
    const prepared = await prepareRuntimeProviderProfile({
      runtimeType: "codex_local", orgId: "test-org", agentId: "test-agent", config,
      workspace: { cwd: process.cwd(), source: "agent_home" },
    });
    expect(prepared.providerVersion).toBe(process.versions.node);
    expect(prepared.chatAppServerEnabled).toBe(true);
    expect(prepared.nativeCapabilityMethods).toEqual({ threadResume: true, threadRead: true, threadFork: true });
    expect(prepared.codexHome).toBe(resolveManagedCodexHomeDir(process.env, "test-org", "test-agent"));
    expect(prepared.env).toEqual(config.env);
    expect(config.providerVersion).toBe("invented");
    const other = await prepareRuntimeProviderProfile({ runtimeType: "codex_local", orgId: "test-org", agentId: "other-agent", config });
    expect(other.codexHome).not.toBe(prepared.codexHome);
  });
  it("leaves other runtime profiles to their own transport preparation", async () => {
    const config = { command: "not-a-codex-command" };
    expect(await prepareRuntimeProviderProfile({ runtimeType: "process", orgId: "org", agentId: "agent", config })).toBe(config);
  });
  it("keeps a provider without native history methods on its compatibility execution path", async () => {
    protocol.methods = [];
    try {
      const prepared = await prepareRuntimeProviderProfile({
        runtimeType: "codex_local", orgId: "test-org", agentId: "legacy-agent",
        config: { command: process.execPath },
      });
      expect(prepared.nativeCapabilityMethods).toEqual({ threadResume: false, threadRead: false, threadFork: false });
      expect(prepared.chatAppServerEnabled).toBe(false);
    } finally {
      protocol.methods = ["thread/resume", "thread/read", "thread/fork"];
    }
  });
  it("never treats version or unrelated nested method strings as protocol declarations", () => {
    expect(codexMethodsFromSchema({ definitions: { method: "thread/fork" }, version: "999.0" }))
      .toEqual({ threadResume: false, threadRead: false, threadFork: false });
    expect(codexMethodsFromSchema({ oneOf: [{ properties: { method: { const: "thread/read" } } }] }))
      .toEqual({ threadResume: false, threadRead: true, threadFork: false });
  });
});
