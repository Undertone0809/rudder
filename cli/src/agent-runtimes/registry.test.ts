import { AGENT_RUNTIME_TYPES } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { getCLIAdapter } from "./registry.js";

describe("CLI agent runtime registry", () => {
  it("excludes removed Gemini CLI while retaining OpenClaw", () => {
    expect(AGENT_RUNTIME_TYPES).not.toContain("gemini_local");
    expect(getCLIAdapter("openclaw_gateway").type).toBe("openclaw_gateway");
  });

  it("rejects persisted Gemini agents instead of falling through to Process", () => {
    expect(() => getCLIAdapter("gemini_local")).toThrow(
      "Gemini CLI runtime has been removed; reconfigure this agent with a supported runtime.",
    );
  });
});
