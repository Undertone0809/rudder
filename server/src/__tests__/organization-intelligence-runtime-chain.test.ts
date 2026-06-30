import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockingEnvironmentMessage,
  buildRuntimeChainTestTargets,
  organizationIntelligenceRuntimeChainService,
} from "../services/organization-intelligence-runtime-chain.js";

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_orgId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_orgId: string, config: Record<string, unknown>) => ({
    config,
    secretKeys: new Set<string>(),
  })),
}));
const mockTestEnvironment = vi.hoisted(() => vi.fn());
const mockFindServerAdapter = vi.hoisted(() => vi.fn(() => ({
  type: "codex_local",
  testEnvironment: mockTestEnvironment,
})));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: mockFindServerAdapter,
}));

vi.mock("../services/secrets.js", () => ({
  secretService: () => mockSecretService,
}));

describe("organization intelligence runtime chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTestEnvironment.mockResolvedValue({
      agentRuntimeType: "codex_local",
      status: "pass",
      testedAt: "2026-06-18T00:00:00.000Z",
      checks: [],
    });
  });

  it("builds primary and fallback runtime test targets without leaking primary fallbacks", () => {
    expect(buildRuntimeChainTestTargets("codex_local", {
      model: "gpt-5.4-mini",
      modelReasoningEffort: "low",
      modelFallbacks: [{
        agentRuntimeType: "claude_local",
        model: "claude-sonnet-4-5",
        config: { effort: "medium" },
      }],
    })).toEqual([
      {
        label: "Primary",
        runtimeType: "codex_local",
        config: {
          model: "gpt-5.4-mini",
          modelReasoningEffort: "low",
        },
      },
      {
        label: "Fallback 1",
        runtimeType: "claude_local",
        config: {
          effort: "medium",
          model: "claude-sonnet-4-5",
        },
      },
    ]);
  });

  it("tests every target in the runtime chain", async () => {
    const service = organizationIntelligenceRuntimeChainService({} as any);

    await service.assertUsable("org-1", "codex_local", {
      model: "gpt-5.4-mini",
      modelFallbacks: [{
        agentRuntimeType: "claude_local",
        model: "claude-sonnet-4-5",
        config: { effort: "medium" },
      }],
    });

    expect(mockFindServerAdapter).toHaveBeenCalledWith("codex_local");
    expect(mockFindServerAdapter).toHaveBeenCalledWith("claude_local");
    expect(mockTestEnvironment).toHaveBeenCalledTimes(2);
    expect(mockTestEnvironment).toHaveBeenNthCalledWith(1, {
      orgId: "org-1",
      agentRuntimeType: "codex_local",
      config: { model: "gpt-5.4-mini" },
    });
    expect(mockTestEnvironment).toHaveBeenNthCalledWith(2, {
      orgId: "org-1",
      agentRuntimeType: "claude_local",
      config: {
        effort: "medium",
        model: "claude-sonnet-4-5",
      },
    });
  });

  it("returns blocking messages for non-passing runtime checks", () => {
    expect(blockingEnvironmentMessage({
      status: "fail",
      checks: [{ level: "error", message: "Model is not available." }],
    })).toBe("Model is not available.");
  });
});
