import { describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeExecutionContext,
  AgentRuntimeExecutionResult,
  ServerAgentRuntimeModule,
} from "@rudderhq/agent-runtime-utils";
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
