import type { OrganizationIntelligenceProfile } from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { resolveDefaultIntelligenceProfile } from "../services/organization-intelligence-profile-defaults.js";

function profile(
  purpose: OrganizationIntelligenceProfile["purpose"],
  patch: Partial<OrganizationIntelligenceProfile> = {},
): OrganizationIntelligenceProfile {
  return {
    id: "profile-" + purpose,
    orgId: "org-1",
    purpose,
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: { model: "gpt-5.4-mini" },
    status: "configured",
    lastError: null,
    lastVerifiedAt: new Date("2026-09-20T00:00:00.000Z"),
    createdAt: new Date("2026-09-20T00:00:00.000Z"),
    updatedAt: new Date("2026-09-20T00:00:00.000Z"),
    ...patch,
  };
}

describe("default organization intelligence profile resolution", () => {
  it("always prefers a persisted canonical default", () => {
    const canonical = profile("default", {
      status: "disabled",
      agentRuntimeConfig: { model: "gpt-5.6-terra", modelReasoningEffort: "high" },
    });
    expect(resolveDefaultIntelligenceProfile("org-1", [
      profile("lightweight"),
      profile("reasoning"),
      canonical,
    ])).toEqual(canonical);
  });

  it("projects a legacy default model to Luna Medium and requires a fresh test", () => {
    expect(resolveDefaultIntelligenceProfile("org-1", [profile("lightweight")])).toMatchObject({
      purpose: "default",
      status: "disabled",
      agentRuntimeConfig: {
        model: "gpt-5.6-luna",
        modelReasoningEffort: "medium",
      },
      lastVerifiedAt: null,
      lastError: "Model defaults changed. Test the runtime chain before enabling.",
    });
  });

  it("preserves an explicit alternative Codex model", () => {
    expect(resolveDefaultIntelligenceProfile("org-1", [
      profile("reasoning", {
        agentRuntimeConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
      }),
    ])).toMatchObject({
      purpose: "default",
      status: "configured",
      agentRuntimeConfig: { model: "gpt-5.6-sol", modelReasoningEffort: "high" },
    });
  });
});
