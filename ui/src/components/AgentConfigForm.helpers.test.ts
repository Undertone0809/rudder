import { describe, expect, it } from "vitest";
import {
  blockingRuntimeEnvironmentMessage,
  explicitProviderModelError,
  isProviderModelFormat,
  requiresExplicitProviderModel,
  runtimeAuthRecoveryHint,
  runtimeManualProbeCommand,
  runtimeModelEmptyLabel,
  runtimeModelEmptyMessage,
  runtimeModelSearchPlaceholder,
  runtimeProviderCredentialEnvKey,
  runtimeProviderCredentialLabel,
  runtimeProviderSetupHint,
} from "../lib/runtime-models";
import {
  adapterLabels,
} from "./agent-config-primitives";
import {
  applyRuntimeChainOrder,
  createValuesForRuntime,
  defaultCommandForRuntime,
  defaultConfigForRuntime,
  defaultFallbackItemForChain,
  defaultModelForRuntime,
  runtimeChainItemsFromConfig,
  thinkingEffortOptionsForRuntime,
} from "./AgentConfigForm.helpers";

describe("AgentConfigForm runtime defaults", () => {
  it("labels the local Claude runtime as Claude Code for operator-facing runtime selectors", () => {
    expect(adapterLabels.claude_local).toBe("Claude Code (local)");
  });

  it("uses cursor-agent for new Cursor agents", () => {
    expect(defaultCommandForRuntime("cursor")).toBe("cursor-agent");
    expect(defaultConfigForRuntime("cursor")).toMatchObject({
      command: "cursor-agent",
    });
  });

  it("keeps Codex subscription cost estimation enabled by default without persisting a per-agent override", () => {
    expect(createValuesForRuntime("codex_local").countSubscriptionUsageAsCost).toBe(true);
    expect(defaultConfigForRuntime("codex_local")).not.toHaveProperty("countSubscriptionUsageAsCost");
    expect(defaultConfigForRuntime("codex_local")).toMatchObject({
      model: "gpt-5.5",
    });
  });

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "uses GPT-5.6 reasoning levels for %s",
    (model) => {
      expect(thinkingEffortOptionsForRuntime("codex_local", model)).toEqual([
        { id: "", label: "Auto" },
        { id: "light", label: "Light" },
        { id: "medium", label: "Medium" },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
        { id: "max", label: "Max" },
        { id: "ultra", label: "Ultra" },
      ]);
    },
  );

  it("keeps existing Codex models on the standard reasoning levels", () => {
    expect(thinkingEffortOptionsForRuntime("codex_local", "gpt-5.5")).toEqual([
      { id: "", label: "Auto" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ]);
  });

  it("uses non-dangerous Claude auto permission mode by default", () => {
    expect(createValuesForRuntime("claude_local")).toMatchObject({
      model: "deepseek-v4-pro[1m]",
      dangerouslySkipPermissions: false,
      permissionMode: "auto",
    });
    expect(defaultConfigForRuntime("claude_local")).toMatchObject({
      model: "deepseek-v4-pro[1m]",
      dangerouslySkipPermissions: false,
      permissionMode: "auto",
    });
  });

  it("uses locally runnable default models for OpenCode and Pi", () => {
    expect(defaultModelForRuntime("opencode_local")).toBe("opencode/deepseek-v4-flash-free");
    expect(defaultConfigForRuntime("opencode_local")).toMatchObject({
      model: "opencode/deepseek-v4-flash-free",
    });
    expect(defaultConfigForRuntime("opencode_local")).not.toHaveProperty("dangerouslySkipPermissions");

    expect(defaultModelForRuntime("pi_local")).toBe("kimi-coding/kimi-for-coding");
    expect(defaultConfigForRuntime("pi_local")).toMatchObject({
      model: "kimi-coding/kimi-for-coding",
    });
  });

  it("treats Pi and OpenCode models as explicit custom provider/model inputs", () => {
    expect(requiresExplicitProviderModel("opencode_local")).toBe(true);
    expect(requiresExplicitProviderModel("pi_local")).toBe(true);
    expect(requiresExplicitProviderModel("claude_local")).toBe(false);
    expect(runtimeModelEmptyLabel("pi_local")).toBe("Select or enter provider/model");
    expect(runtimeModelSearchPlaceholder("opencode_local")).toBe("Search or enter provider/model...");
    expect(runtimeModelEmptyMessage("pi_local")).toContain("pi --list-models");
    expect(runtimeModelEmptyMessage("opencode_local")).toContain("opencode models");
    expect(explicitProviderModelError("pi_local")).toContain("provider/model");
    expect(isProviderModelFormat("deepseek/deepseek-chat")).toBe(true);
    expect(isProviderModelFormat("deepseek-chat")).toBe(false);
    expect(isProviderModelFormat("deepseek/")).toBe(false);
  });

  it("gives Pi and OpenCode provider-specific onboarding commands", () => {
    expect(runtimeProviderSetupHint("pi_local", "deepseek/deepseek-chat")).toContain("DEEPSEEK_API_KEY");
    expect(runtimeProviderSetupHint("pi_local", "deepseek/deepseek-chat")).toContain("Paste");
    expect(runtimeProviderSetupHint("pi_local", "deepseek/deepseek-chat")).not.toContain("Advanced options");
    expect(runtimeProviderCredentialEnvKey("pi_local", "deepseek/deepseek-chat")).toBe("DEEPSEEK_API_KEY");
    expect(runtimeProviderCredentialLabel("pi_local", "deepseek/deepseek-chat")).toContain("DEEPSEEK_API_KEY");
    expect(runtimeManualProbeCommand("pi_local", "pi", "deepseek/deepseek-chat"))
      .toBe('pi -p "Respond with hello." --mode json --provider deepseek --model deepseek-chat --tools read');
    expect(runtimeProviderCredentialEnvKey("pi_local", "openrouter/deepseek/deepseek-chat")).toBe("OPENROUTER_API_KEY");
    expect(runtimeProviderSetupHint("claude_local", "deepseek-v4-pro[1m]")).toContain("DEEPSEEK_API_KEY");
    expect(runtimeProviderCredentialEnvKey("claude_local", "deepseek-v4-pro[1m]")).toBe("DEEPSEEK_API_KEY");
    expect(runtimeProviderCredentialLabel("claude_local", "deepseek-v4-pro[1m]")).toContain("DEEPSEEK_API_KEY");
    expect(runtimeManualProbeCommand("pi_local", "pi", "openrouter/deepseek/deepseek-chat"))
      .toBe('pi -p "Respond with hello." --mode json --provider openrouter --model deepseek/deepseek-chat --tools read');
    expect(runtimeProviderCredentialEnvKey("opencode_local", "opencode/deepseek-v4-flash-free")).toBeNull();
    expect(runtimeAuthRecoveryHint("pi_local", "deepseek/deepseek-chat")).toContain("DEEPSEEK_API_KEY");
    expect(runtimeAuthRecoveryHint("pi_local", "deepseek/deepseek-chat")).not.toContain("claude auth login");

    expect(runtimeManualProbeCommand("opencode_local", "opencode", "opencode/deepseek-v4-flash-free"))
      .toBe('opencode run --format json --model opencode/deepseek-v4-flash-free "Respond with hello."');
    expect(runtimeManualProbeCommand("codex_local", "codex", "gpt-5.1-codex-mini"))
      .toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(runtimeManualProbeCommand("gemini_local", "gemini", "gemini-3-flash-preview"))
      .toContain("--approval-mode yolo --skip-trust");
    expect(runtimeManualProbeCommand("cursor", "cursor-agent", "auto"))
      .toBe('cursor-agent --trust -p --mode ask --output-format json "Respond with hello."');
    expect(runtimeManualProbeCommand("claude_local", "claude", "claude-sonnet-4-6"))
      .toContain("--permission-mode auto");
    expect(runtimeManualProbeCommand("claude_local", "claude", "claude-sonnet-4-6"))
      .not.toContain("bypassPermissions");
    expect(runtimeAuthRecoveryHint("claude_local", "deepseek-v4-pro[1m]")).toContain("DEEPSEEK_API_KEY");
  });

  it("blocks onboarding when the runtime hello probe fails or needs provider auth", () => {
    expect(blockingRuntimeEnvironmentMessage({
      status: "warn",
      checks: [
        {
          code: "pi_hello_probe_auth_required",
          level: "warn",
          message: "Pi is installed, but provider authentication is not ready.",
          hint: "Set DEEPSEEK_API_KEY.",
        },
      ],
    })).toContain("DEEPSEEK_API_KEY");

    expect(blockingRuntimeEnvironmentMessage({
      status: "warn",
      checks: [
        {
          code: "opencode_hello_probe_model_unavailable",
          level: "warn",
          message: "The configured model was not found by the provider.",
        },
      ],
    })).toContain("model was not found");

    expect(blockingRuntimeEnvironmentMessage({
      status: "warn",
      checks: [
        {
          code: "pi_hello_probe_timed_out",
          level: "warn",
          message: "Pi hello probe timed out.",
        },
      ],
    })).toContain("timed out");

    expect(blockingRuntimeEnvironmentMessage({
      status: "warn",
      checks: [
        {
          code: "codex_hello_probe_unexpected_output",
          level: "warn",
          message: "Codex probe ran but did not return `hello` as expected.",
        },
      ],
    })).toContain("did not return");

    expect(blockingRuntimeEnvironmentMessage({
      status: "warn",
      checks: [
        {
          code: "pi_model_not_discovered",
          level: "info",
          message: "Custom model will be proven by hello probe.",
        },
      ],
    })).toBeNull();
  });
});

describe("AgentConfigForm runtime chain ordering", () => {
  it("chooses a distinct default runtime when adding another fallback", () => {
    const firstFallback = defaultFallbackItemForChain("codex_local", []);
    const secondFallback = defaultFallbackItemForChain("codex_local", [firstFallback]);

    expect(firstFallback).toMatchObject({
      agentRuntimeType: "claude_local",
    });
    expect(`${secondFallback.agentRuntimeType}\u0000${secondFallback.model}`)
      .not.toBe(`${firstFallback.agentRuntimeType}\u0000${firstFallback.model}`);
  });

  it("promotes a fallback to primary when it is moved to the start of the runtime chain", () => {
    const chain = runtimeChainItemsFromConfig({
      primaryRuntimeType: "codex_local",
      primaryModel: "gpt-primary",
      primaryConfig: {
        model: "gpt-primary",
        modelReasoningEffort: "high",
        modelFallbacks: [
          {
            agentRuntimeType: "claude_local",
            model: "claude-fallback",
            config: {
              model: "claude-fallback",
              effort: "medium",
            },
          },
          {
            agentRuntimeType: "gemini_local",
            model: "gemini-fallback",
            config: {
              model: "gemini-fallback",
              approvalMode: "yolo",
            },
          },
        ],
      },
    });

    const reordered = applyRuntimeChainOrder(
      chain,
      "fallback-1",
      "primary",
    );

    expect(reordered.primary.agentRuntimeType).toBe("gemini_local");
    expect(reordered.primary.model).toBe("gemini-fallback");
    expect(reordered.primary.config).toMatchObject({
      model: "gemini-fallback",
      approvalMode: "yolo",
    });
    expect(reordered.fallbacks).toEqual([
      {
        agentRuntimeType: "codex_local",
        model: "gpt-primary",
        config: {
          model: "gpt-primary",
          modelReasoningEffort: "high",
        },
      },
      {
        agentRuntimeType: "claude_local",
        model: "claude-fallback",
        config: {
          model: "claude-fallback",
          effort: "medium",
        },
      },
    ]);
  });
});
