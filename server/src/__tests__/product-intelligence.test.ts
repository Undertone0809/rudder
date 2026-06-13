import type {
  AgentRuntimeExecutionResult,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import type { OrganizationIntelligenceProfile } from "@rudderhq/shared";
import { describe, expect, it, vi } from "vitest";
import { executeResolvedProductIntelligenceProfile } from "../services/product-intelligence.js";

function result(patch: Partial<AgentRuntimeExecutionResult>): AgentRuntimeExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    ...patch,
  };
}

const profile: OrganizationIntelligenceProfile = {
  id: "profile-1",
  orgId: "org-1",
  purpose: "lightweight",
  agentRuntimeType: "codex_local",
  agentRuntimeConfig: {},
  status: "configured",
  lastError: null,
  lastVerifiedAt: null,
  createdAt: new Date("2026-05-22T00:00:00.000Z"),
  updatedAt: new Date("2026-05-22T00:00:00.000Z"),
};

describe("product intelligence execution", () => {
  it("executes a profile as product intelligence without an agent session or auth token", async () => {
    const onMeta = vi.fn(async () => {});
    const adapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async (ctx) => {
        await ctx.onMeta?.({
          agentRuntimeType: "codex_local",
          command: "codex",
          env: {
            OPENAI_API_KEY: "secret-value",
            RUDDER_PUBLIC_FLAG: "visible",
          },
        });
        return result({ model: String(ctx.config.model) });
      }),
    };

    await executeResolvedProductIntelligenceProfile({
      orgId: "org-1",
      purpose: "lightweight",
      feature: "chat_title",
      prompt: "Generate a short title",
      profile,
      config: {
        model: "gpt-5.4-mini",
        promptTemplate: "stored agent prompt",
        instructionsFilePath: "/agent/SOUL.md",
        cwd: "/repo",
        env: {
          OPENAI_API_KEY: "secret-value",
          RUDDER_PUBLIC_FLAG: "visible",
        },
      },
      secretKeys: new Set(["OPENAI_API_KEY"]),
      adapter,
      runId: "run-1",
      workspaceCwd: "/tmp/rudder-product-intelligence-test",
      onMeta,
    });

    expect(adapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: undefined,
        agent: expect.objectContaining({
          id: "product-intelligence-lightweight",
          name: "Fast Intelligence",
        }),
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: expect.objectContaining({
          model: "gpt-5.4-mini",
          promptTemplate: "Generate a short title",
        }),
        context: expect.objectContaining({
          rudderScene: "product_intelligence",
          productIntelligence: {
            purpose: "lightweight",
            feature: "chat_title",
          },
          rudderWorkspace: {
            source: "product_intelligence",
            strategy: "none",
            cwd: "/tmp/rudder-product-intelligence-test",
          },
        }),
      }),
    );
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.not.objectContaining({
          instructionsFilePath: expect.anything(),
          cwd: expect.anything(),
        }),
      }),
    );
    expect(onMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          OPENAI_API_KEY: "***REDACTED***",
          RUDDER_PUBLIC_FLAG: "visible",
        },
      }),
    );
  });

  it("preserves fallback order while filtering stored agent identity fields", async () => {
    const primaryAdapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async () => result({ exitCode: 1, errorMessage: "primary failed" })),
    };
    const fallbackAdapter: ServerAgentRuntimeModule = {
      type: "claude_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async (ctx) => result({ model: String(ctx.config.model) })),
    };

    const executed = await executeResolvedProductIntelligenceProfile({
      orgId: "org-1",
      purpose: "reasoning",
      feature: "issue_ai_search",
      prompt: "Search issues",
      profile: {
        ...profile,
        purpose: "reasoning",
        agentRuntimeType: "codex_local",
      },
      config: {
        model: "gpt-5.4",
        promptTemplate: "stored agent prompt",
        cwd: "/repo",
        modelFallbacks: [
          {
            agentRuntimeType: "claude_local",
            model: "claude-sonnet-4-6",
            config: {
              command: "claude",
              promptTemplate: "stored fallback prompt",
              cwd: "/repo",
            },
          },
        ],
      },
      adapter: primaryAdapter,
      resolveAdapter: (agentRuntimeType) => agentRuntimeType === "claude_local" ? fallbackAdapter : null,
      runId: "run-1",
      workspaceCwd: "/tmp/rudder-product-intelligence-test",
    });

    expect(executed.model).toBe("claude-sonnet-4-6");
    expect(fallbackAdapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        authToken: undefined,
        agent: expect.objectContaining({
          id: "product-intelligence-reasoning",
          name: "Smart Intelligence",
          agentRuntimeType: "claude_local",
        }),
        config: {
          promptTemplate: "Search issues",
          command: "claude",
          model: "claude-sonnet-4-6",
        },
      }),
    );
  });
});
