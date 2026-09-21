import { describe, expect, it } from "vitest";
import {
  buildIntelligenceProfileConfigWithPurposeDefaults,
  organizationIntelligenceProfileService,
} from "../services/organization-intelligence-profiles.js";

describe("organization intelligence profiles", () => {
  it("filters agent-only fields and defaults Codex product intelligence to Luna Medium", () => {
    expect(buildIntelligenceProfileConfigWithPurposeDefaults("default", "codex_local", {
      command: "codex",
      model: "gpt-5.5",
      modelReasoningEffort: "high",
      promptTemplate: "agent prompt",
      instructionsFilePath: "/agent/SOUL.md",
      cwd: "/repo",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    })).toEqual({
      command: "codex",
      model: "gpt-5.6-luna",
      modelReasoningEffort: "medium",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    });
  });

  it("returns one canonical default profile when only legacy rows exist", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [{
            id: "profile-lightweight",
            orgId: "org-1",
            purpose: "lightweight",
            agentRuntimeType: "codex_local",
            agentRuntimeConfig: { model: "gpt-5.4-mini" },
            status: "configured",
            lastError: null,
            lastVerifiedAt: new Date("2026-09-20T00:00:00.000Z"),
            createdAt: new Date("2026-09-20T00:00:00.000Z"),
            updatedAt: new Date("2026-09-20T00:00:00.000Z"),
          }],
        }),
      }),
    };

    const svc = organizationIntelligenceProfileService(db as never);
    const listed = await svc.list("org-1");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      purpose: "default",
      status: "disabled",
      agentRuntimeConfig: {
        model: "gpt-5.6-luna",
        modelReasoningEffort: "medium",
      },
    });
  });
});
