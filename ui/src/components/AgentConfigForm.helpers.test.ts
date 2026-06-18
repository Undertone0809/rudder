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
import { createValuesForRuntime, defaultCommandForRuntime, defaultConfigForRuntime, defaultModelForRuntime } from "./AgentConfigForm.helpers";

describe("AgentConfigForm runtime defaults", () => {
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
      .toContain("--permission-mode bypassPermissions");
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
