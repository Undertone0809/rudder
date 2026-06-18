import { describe, expect, it } from "vitest";
import {
  buildIntelligenceProfileConfigWithPurposeDefaults,
  organizationIntelligenceProfileService,
} from "../services/organization-intelligence-profiles.js";

describe("organization intelligence profiles", () => {
  it("filters agent identity and workspace fields from product intelligence configs", () => {
    const svc = organizationIntelligenceProfileService({} as any);

    expect(svc.sanitizeConfigForProductIntelligence({
      model: "gpt-5.4",
      modelReasoningEffort: "medium",
      promptTemplate: "{{issue.title}}",
      instructionsFilePath: "/agent/SOUL.md",
      rudderRuntimeSkills: [{ key: "rudder" }],
      workspaceStrategy: { type: "git_worktree" },
      cwd: "/repo",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
      modelFallbacks: [
        {
          agentRuntimeType: "codex_local",
          model: "gpt-5.4-mini",
          config: {
            model: "gpt-5.4-mini",
            promptTemplate: "agent prompt",
            instructionsRootPath: "/agent/instructions",
            workspaceRuntime: { services: [] },
            env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
          },
        },
      ],
    })).toEqual({
      model: "gpt-5.4",
      modelReasoningEffort: "medium",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
      modelFallbacks: [
        {
          agentRuntimeType: "codex_local",
          model: "gpt-5.4-mini",
          config: {
            model: "gpt-5.4-mini",
            env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
          },
        },
      ],
    });
  });

  it("derives Codex fast and smart defaults without copying agent identity fields", () => {
    const sourceConfig = {
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
      command: "codex",
      promptTemplate: "You are the CEO.",
      instructionsFilePath: "/agent/SOUL.md",
      workspaceStrategy: { type: "git_worktree" },
      cwd: "/repo",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    };

    expect(
      buildIntelligenceProfileConfigWithPurposeDefaults("lightweight", "codex_local", sourceConfig),
    ).toEqual({
      command: "codex",
      model: "gpt-5.4-mini",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    });

    expect(
      buildIntelligenceProfileConfigWithPurposeDefaults("reasoning", "codex_local", sourceConfig),
    ).toEqual({
      command: "codex",
      model: "gpt-5.4-mini",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    });
  });

  it("creates derived profile defaults as disabled until the chain is explicitly enabled", async () => {
    const insertedValues: any[] = [];
    const conflictSets: any[] = [];
    const createdAt = new Date("2026-06-18T00:00:00.000Z");
    const db = {
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
      insert: () => ({
        values: (values: any) => {
          insertedValues.push(values);
          return {
            onConflictDoUpdate: (config: any) => {
              conflictSets.push(config.set);
              return {
                returning: async () => [{
                  id: `profile-${values.purpose}`,
                  orgId: values.orgId,
                  purpose: values.purpose,
                  agentRuntimeType: values.agentRuntimeType,
                  agentRuntimeConfig: values.agentRuntimeConfig,
                  status: values.status,
                  lastError: null,
                  lastVerifiedAt: null,
                  createdAt,
                  updatedAt: createdAt,
                }],
              };
            },
          };
        },
      }),
    };
    const svc = organizationIntelligenceProfileService(db as any);

    const created = await svc.ensureDefaultsFromRuntime({
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {
        command: "codex",
        model: "gpt-5.3-codex",
      },
    });

    expect(created).toHaveLength(2);
    expect(created.every((profile) => profile.status === "disabled")).toBe(true);
    expect(created.map((profile) => profile.agentRuntimeConfig)).toEqual([
      {
        command: "codex",
        model: "gpt-5.4-mini",
      },
      {
        command: "codex",
        model: "gpt-5.4-mini",
      },
    ]);
    expect(insertedValues.every((values) => values.status === "disabled")).toBe(true);
    expect(conflictSets.every((set) => set.status === "disabled")).toBe(true);
  });
});
