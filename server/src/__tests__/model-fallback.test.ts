import type {
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
import { describe, expect, it, vi } from "vitest";
import { executeAdapterWithModelFallbacks } from "../services/runtime-kernel/model-fallback.js";

function result(
  patch: Partial<AgentRuntimeExecutionResult>,
): AgentRuntimeExecutionResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    ...patch,
  };
}

function baseContext(config: Record<string, unknown>): AgentRuntimeExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      orgId: "org-1",
      name: "Builder",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
    },
    runtime: {
      sessionId: "session-1",
      sessionParams: { sessionId: "session-1" },
      sessionDisplayId: "session-1",
      taskKey: "issue:1",
    },
    config,
    context: { issueId: "issue-1" },
    onLog: vi.fn(async () => {}),
    onMeta: vi.fn(async () => {}),
  };
}

describe("executeAdapterWithModelFallbacks", () => {
  it("retries failed model attempts with ordered fallback models", async () => {
    const calls: Array<{ model: unknown; sessionId: string | null; fallback: unknown }> = [];
    const adapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async (ctx) => {
        calls.push({
          model: ctx.config.model,
          sessionId: ctx.runtime.sessionId,
          fallback: ctx.context.rudderModelFallback,
        });
        await ctx.onMeta?.({
          agentRuntimeType: "codex_local",
          command: "codex",
          commandNotes: [],
        });
        return calls.length === 1
          ? result({ exitCode: 1, errorMessage: "primary model unavailable", model: "gpt-primary" })
          : result({ model: "gpt-backup" });
      }),
    };
    const ctx = baseContext({
      model: "gpt-primary",
      modelFallbacks: [
        { agentRuntimeType: "codex_local", model: "gpt-backup" },
        { agentRuntimeType: "codex_local", model: "gpt-final" },
      ],
    });

    const executed = await executeAdapterWithModelFallbacks(adapter, ctx);

    expect(executed.model).toBe("gpt-backup");
    expect(calls).toEqual([
      { model: "gpt-primary", sessionId: "session-1", fallback: undefined },
      {
        model: "gpt-backup",
        sessionId: null,
        fallback: {
          attemptIndex: 1,
          agentRuntimeType: "codex_local",
          fallbackIndex: 1,
          totalFallbacks: 2,
          model: "gpt-backup",
        },
      },
    ]);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stdout",
      expect.stringContaining("retrying with fallback model 1/2: codex_local/gpt-backup"),
    );
    expect(ctx.onMeta).toHaveBeenLastCalledWith(
      expect.objectContaining({
        commandNotes: [expect.stringContaining("model fallback 1/2: codex_local/gpt-backup")],
      }),
    );
  });

  it("continues to the next fallback when an adapter throws before returning", async () => {
    const models: unknown[] = [];
    const adapter: ServerAgentRuntimeModule = {
      type: "opencode_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async (ctx) => {
        models.push(ctx.config.model);
        if (models.length === 1) {
          throw new Error("Configured model is unavailable");
        }
        return result({ model: String(ctx.config.model) });
      }),
    };

    const executed = await executeAdapterWithModelFallbacks(
      adapter,
      baseContext({
        model: "openai/down",
        modelFallbacks: [{ agentRuntimeType: "opencode_local", model: "anthropic/backup" }],
      }),
    );

    expect(executed.model).toBe("anthropic/backup");
    expect(models).toEqual(["openai/down", "anthropic/backup"]);
  });

  it("can switch adapters for provider-aware fallback attempts", async () => {
    const primaryAdapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async () => result({ exitCode: 1, errorMessage: "codex unavailable" })),
    };
    const fallbackAdapter: ServerAgentRuntimeModule = {
      type: "claude_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async (ctx) => {
        await ctx.onMeta?.({
          agentRuntimeType: "claude_local",
          command: "claude",
          commandNotes: [],
        });
        return result({ model: String(ctx.config.model) });
      }),
    };
    const ctx = baseContext({
      model: "gpt-primary",
      promptTemplate: "Keep going",
      rudderBrowserEnabled: true,
      rudderBrowserCapability: {
        instanceEligible: true,
        runtimeSkillEntries: [
          { key: "bundled:rudder/browser", runtimeName: "browser", source: "/tmp/browser" },
        ],
      },
      rudderSkillSync: {
        desiredSkills: ["bundled:rudder/browser", "bundled:rudder/rudder"],
      },
      paperclipSkillSync: {
        desiredSkills: ["bundled:rudder/browser", "bundled:rudder/rudder"],
      },
      rudderRuntimeSkills: [
        { key: "bundled:rudder/browser", runtimeName: "browser", source: "/tmp/browser" },
        { key: "bundled:rudder/rudder", runtimeName: "rudder", source: "/tmp/rudder" },
      ],
      paperclipRuntimeSkills: [
        { key: "bundled:rudder/browser", runtimeName: "browser", source: "/tmp/browser" },
        { key: "bundled:rudder/rudder", runtimeName: "rudder", source: "/tmp/rudder" },
      ],
      modelFallbacks: [
        {
          agentRuntimeType: "claude_local",
          model: "claude-sonnet-4-6",
          config: { effort: "high", command: "claude" },
        },
      ],
    });

    const executed = await executeAdapterWithModelFallbacks(primaryAdapter, ctx, {
      resolveAdapter: (agentRuntimeType) => agentRuntimeType === "claude_local" ? fallbackAdapter : null,
      createAuthToken: (agentRuntimeType) => `token:${agentRuntimeType}`,
    });

    expect(executed.model).toBe("claude-sonnet-4-6");
    expect(primaryAdapter.execute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapter.execute).toHaveBeenCalledTimes(1);
    expect(fallbackAdapter.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ agentRuntimeType: "claude_local" }),
        authToken: "token:claude_local",
        config: expect.objectContaining({
          model: "claude-sonnet-4-6",
          promptTemplate: "Keep going",
          effort: "high",
          command: "claude",
          rudderBrowserEnabled: true,
          rudderRuntimeSkills: expect.arrayContaining([
            expect.objectContaining({ key: "bundled:rudder/browser" }),
          ]),
        }),
        runtime: expect.objectContaining({ sessionId: null }),
      }),
    );
    expect(ctx.onMeta).toHaveBeenLastCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          rudderModelFallback: expect.objectContaining({
            agentRuntimeType: "claude_local",
            model: "claude-sonnet-4-6",
          }),
        }),
      }),
    );
  });

  it("fails closed when Browser-shaped user config lacks trusted capability metadata", async () => {
    const adapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async () => result({ model: "gpt-primary" })),
    };
    const browserSkill = {
      key: "bundled:rudder/browser",
      runtimeName: "browser",
      source: "/tmp/browser",
    };
    const rudderSkill = {
      key: "bundled:rudder/rudder",
      runtimeName: "rudder",
      source: "/tmp/rudder",
    };
    const ctx = baseContext({
      model: "gpt-primary",
      rudderBrowserEnabled: true,
      rudderSkillSync: { desiredSkills: [browserSkill.key, rudderSkill.key] },
      paperclipSkillSync: { desiredSkills: [browserSkill.key, rudderSkill.key] },
      rudderRuntimeSkills: [browserSkill, rudderSkill],
      paperclipRuntimeSkills: [browserSkill, rudderSkill],
    });

    await executeAdapterWithModelFallbacks(adapter, ctx);

    const projectedConfig = vi.mocked(adapter.execute).mock.calls[0]?.[0].config;
    expect(projectedConfig).toMatchObject({
      rudderBrowserEnabled: false,
      rudderSkillSync: { desiredSkills: [rudderSkill.key] },
      paperclipSkillSync: { desiredSkills: [rudderSkill.key] },
      rudderRuntimeSkills: [rudderSkill],
      paperclipRuntimeSkills: [rudderSkill],
    });
    expect(projectedConfig).not.toHaveProperty("rudderBrowserCapability");
  });

  it("does not let fallback attempt config elevate Browser eligibility", async () => {
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
    const browserSkill = {
      key: "bundled:rudder/browser",
      runtimeName: "browser",
      source: "/tmp/browser",
    };
    const rudderSkill = {
      key: "bundled:rudder/rudder",
      runtimeName: "rudder",
      source: "/tmp/rudder",
    };
    const ctx = baseContext({
      model: "gpt-primary",
      rudderSkillSync: { desiredSkills: [rudderSkill.key] },
      paperclipSkillSync: { desiredSkills: [rudderSkill.key] },
      rudderRuntimeSkills: [rudderSkill],
      paperclipRuntimeSkills: [rudderSkill],
      modelFallbacks: [{
        agentRuntimeType: "claude_local",
        model: "claude-backup",
        config: {
          rudderBrowserEnabled: true,
          rudderBrowserCapability: {
            instanceEligible: true,
            runtimeSkillEntries: [browserSkill],
          },
          rudderSkillSync: { desiredSkills: [browserSkill.key, rudderSkill.key] },
          paperclipSkillSync: { desiredSkills: [browserSkill.key, rudderSkill.key] },
          rudderRuntimeSkills: [browserSkill, rudderSkill],
          paperclipRuntimeSkills: [browserSkill, rudderSkill],
        },
      }],
    });

    await executeAdapterWithModelFallbacks(primaryAdapter, ctx, {
      resolveAdapter: (agentRuntimeType) => agentRuntimeType === "claude_local" ? fallbackAdapter : null,
    });

    const fallbackConfig = vi.mocked(fallbackAdapter.execute).mock.calls[0]?.[0].config;
    expect(fallbackConfig).toMatchObject({
      rudderBrowserEnabled: false,
      rudderSkillSync: { desiredSkills: [rudderSkill.key] },
      paperclipSkillSync: { desiredSkills: [rudderSkill.key] },
      rudderRuntimeSkills: [rudderSkill],
      paperclipRuntimeSkills: [rudderSkill],
    });
    expect(fallbackConfig).not.toHaveProperty("rudderBrowserCapability");
  });

  it("projects an instance-eligible Browser onto a supported fallback from an unsupported primary runtime", async () => {
    const primaryAdapter: ServerAgentRuntimeModule = {
      type: "gemini_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async () => result({ exitCode: 1, errorMessage: "gemini unavailable" })),
    };
    const fallbackAdapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async (ctx) => result({ model: String(ctx.config.model) })),
    };
    const browserSkill = {
      key: "bundled:rudder/browser",
      runtimeName: "browser",
      source: "/tmp/browser",
    };
    const rudderSkill = {
      key: "bundled:rudder/rudder",
      runtimeName: "rudder",
      source: "/tmp/rudder",
    };
    const ctx = baseContext({
      model: "gemini-primary",
      rudderBrowserEnabled: false,
      rudderBrowserCapability: {
        instanceEligible: true,
        runtimeSkillEntries: [browserSkill],
      },
      rudderSkillSync: { desiredSkills: [rudderSkill.key] },
      paperclipSkillSync: { desiredSkills: [rudderSkill.key] },
      rudderRuntimeSkills: [rudderSkill],
      paperclipRuntimeSkills: [rudderSkill],
      modelFallbacks: [{ agentRuntimeType: "codex_local", model: "gpt-backup" }],
    });
    ctx.agent = { ...ctx.agent, agentRuntimeType: "gemini_local" };

    await executeAdapterWithModelFallbacks(primaryAdapter, ctx, {
      resolveAdapter: (agentRuntimeType) => agentRuntimeType === "codex_local" ? fallbackAdapter : null,
    });

    const primaryConfig = vi.mocked(primaryAdapter.execute).mock.calls[0]?.[0].config;
    expect(primaryConfig).toMatchObject({
      rudderBrowserEnabled: false,
      rudderSkillSync: { desiredSkills: [rudderSkill.key] },
      paperclipSkillSync: { desiredSkills: [rudderSkill.key] },
      rudderRuntimeSkills: [rudderSkill],
      paperclipRuntimeSkills: [rudderSkill],
    });
    expect(primaryConfig).not.toHaveProperty("rudderBrowserCapability");

    const fallbackConfig = vi.mocked(fallbackAdapter.execute).mock.calls[0]?.[0].config;
    expect(fallbackConfig).toMatchObject({
      rudderBrowserEnabled: true,
      rudderSkillSync: { desiredSkills: [rudderSkill.key, browserSkill.key] },
      paperclipSkillSync: { desiredSkills: [rudderSkill.key, browserSkill.key] },
      rudderRuntimeSkills: [rudderSkill, browserSkill],
      paperclipRuntimeSkills: [rudderSkill, browserSkill],
    });
    expect(fallbackConfig).not.toHaveProperty("rudderBrowserCapability");
  });

  it("removes Browser skill and tools when a fallback switches to an unsupported runtime", async () => {
    const primaryAdapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async () => result({ exitCode: 1, errorMessage: "codex unavailable" })),
    };
    const fallbackAdapter: ServerAgentRuntimeModule = {
      type: "gemini_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async (ctx) => result({ model: String(ctx.config.model) })),
    };
    const ctx = baseContext({
      model: "gpt-primary",
      rudderBrowserEnabled: true,
      rudderBrowserCapability: {
        instanceEligible: true,
        runtimeSkillEntries: [
          { key: "bundled:rudder/browser", runtimeName: "browser", source: "/tmp/browser" },
        ],
      },
      rudderSkillSync: {
        desiredSkills: ["bundled:rudder/browser", "bundled:rudder/rudder"],
      },
      paperclipSkillSync: {
        desiredSkills: ["bundled:rudder/browser", "bundled:rudder/rudder"],
      },
      rudderRuntimeSkills: [
        { key: "bundled:rudder/browser", runtimeName: "browser", source: "/tmp/browser" },
        { key: "bundled:rudder/rudder", runtimeName: "rudder", source: "/tmp/rudder" },
      ],
      paperclipRuntimeSkills: [
        { key: "bundled:rudder/browser", runtimeName: "browser", source: "/tmp/browser" },
        { key: "bundled:rudder/rudder", runtimeName: "rudder", source: "/tmp/rudder" },
      ],
      modelFallbacks: [{ agentRuntimeType: "gemini_local", model: "gemini-backup" }],
    });

    await executeAdapterWithModelFallbacks(primaryAdapter, ctx, {
      resolveAdapter: (agentRuntimeType) => agentRuntimeType === "gemini_local" ? fallbackAdapter : null,
      createAuthToken: (agentRuntimeType) => `token:${agentRuntimeType}`,
    });

    const fallbackConfig = vi.mocked(fallbackAdapter.execute).mock.calls[0]?.[0].config;
    expect(fallbackConfig).toMatchObject({
      rudderBrowserEnabled: false,
      rudderSkillSync: { desiredSkills: ["bundled:rudder/rudder"] },
      paperclipSkillSync: { desiredSkills: ["bundled:rudder/rudder"] },
    });
    expect(fallbackConfig?.rudderRuntimeSkills).toEqual([
      expect.objectContaining({ key: "bundled:rudder/rudder" }),
    ]);
    expect(fallbackConfig?.paperclipRuntimeSkills).toEqual([
      expect.objectContaining({ key: "bundled:rudder/rudder" }),
    ]);
  });

  it("does not retry when no fallback models are configured", async () => {
    const adapter: ServerAgentRuntimeModule = {
      type: "codex_local",
      testEnvironment: vi.fn(),
      execute: vi.fn(async () => result({ exitCode: 1, errorMessage: "failed" })),
    };
    const ctx = baseContext({ model: "gpt-primary" });

    const executed = await executeAdapterWithModelFallbacks(adapter, ctx);

    expect(executed.errorMessage).toBe("failed");
    expect(adapter.execute).toHaveBeenCalledTimes(1);
  });
});
