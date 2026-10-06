import { AGENT_RUNTIME_TYPES } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { getServerAdapter, listServerAdapters } from "./registry.js";

describe("server agent runtime registry", () => {
  it("retains the six native-chat runtimes while excluding Gemini CLI", () => {
    expect(AGENT_RUNTIME_TYPES).toEqual(expect.arrayContaining([
      "codex_local",
      "claude_local",
      "hermes_gateway",
      "opencode_local",
      "pi_local",
      "cursor",
    ]));
    expect(AGENT_RUNTIME_TYPES).not.toContain("gemini_local");
    expect(listServerAdapters().some((adapter) => adapter.type === "gemini_local")).toBe(false);
  });

  it("rejects persisted Gemini agents instead of falling through to Process", () => {
    expect(() => getServerAdapter("gemini_local")).toThrow(
      "Gemini CLI runtime has been removed; reconfigure this agent with a supported runtime.",
    );
  });

  it("keeps OpenClaw registered independently of Gemini CLI removal", () => {
    expect(AGENT_RUNTIME_TYPES).toContain("openclaw_gateway");
    expect(getServerAdapter("openclaw_gateway").type).toBe("openclaw_gateway");
  });

  it("fails closed for legacy Hermes execution while retaining its historical codec", async () => {
    const adapter = getServerAdapter("hermes_local");

    expect(adapter.type).toBe("hermes_local");
    expect(adapter.sessionCodec).toBeDefined();
    expect(adapter.supportsLocalAgentJwt).toBe(false);
    await expect(adapter.execute({} as never)).resolves.toMatchObject({
      exitCode: 1,
      errorCode: "hermes_local_migration_required",
      nativeWriterQuiescence: { status: "confirmed", source: "not_started" },
      errorMessage: expect.stringContaining("hermes_gateway"),
    });
    await expect(adapter.testEnvironment({ agentRuntimeType: "hermes_local" } as never)).resolves.toMatchObject({
      agentRuntimeType: "hermes_local",
      status: "fail",
      checks: [{ code: "hermes_local_migration_required", level: "error" }],
    });
  });
});
