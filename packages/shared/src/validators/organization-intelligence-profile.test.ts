import { describe, expect, it } from "vitest";
import { upsertOrganizationIntelligenceProfileSchema } from "./organization-intelligence-profile.js";

describe("organization intelligence profile validators", () => {
  it("accepts runtime configs with provider-aware fallback models", () => {
    const parsed = upsertOrganizationIntelligenceProfileSchema.parse({
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        modelReasoningEffort: "medium",
        modelFallbacks: [
          {
            agentRuntimeType: "codex_local",
            model: "gpt-5.4-mini",
            config: {
              modelReasoningEffort: "low",
            },
          },
        ],
      },
    });

    expect(parsed.status).toBe("configured");
    expect(parsed.agentRuntimeConfig.modelFallbacks).toHaveLength(1);
  });

  it("rejects invalid fallback runtime types", () => {
    expect(() => upsertOrganizationIntelligenceProfileSchema.parse({
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        model: "gpt-5.4",
        modelFallbacks: [
          {
            agentRuntimeType: "unknown",
            model: "backup",
          },
        ],
      },
    })).toThrow();
  });
});
