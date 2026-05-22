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
      modelReasoningEffort: "low",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    });

    expect(
      buildIntelligenceProfileConfigWithPurposeDefaults("reasoning", "codex_local", sourceConfig),
    ).toEqual({
      command: "codex",
      model: "gpt-5.4",
      modelReasoningEffort: "medium",
      env: { OPENAI_API_KEY: { type: "secret_ref", secretId: "secret-1" } },
    });
  });
});
