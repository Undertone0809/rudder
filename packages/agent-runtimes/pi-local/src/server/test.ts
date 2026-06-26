import type {
  AgentRuntimeEnvironmentCheck,
  AgentRuntimeEnvironmentTestContext,
  AgentRuntimeEnvironmentTestResult,
} from "@rudderhq/agent-runtime-utils";
import {
  asString,
  asStringArray,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  runChildProcess,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { discoverPiModelsCached } from "./models.js";
import { parsePiJsonl } from "./parse.js";

function summarizeStatus(checks: AgentRuntimeEnvironmentCheck[]): AgentRuntimeEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function isProviderModelFormat(model: string): boolean {
  const [provider, modelId] = model.split("/", 2).map((part) => part.trim());
  return Boolean(provider && modelId);
}

const PROVIDER_API_KEY_HINTS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  kimi: ["KIMI_API_KEY"],
  "kimi-coding": ["KIMI_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"],
};

function buildProviderAuthHint(provider: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const envKeys = PROVIDER_API_KEY_HINTS[normalizedProvider];
  if (envKeys && envKeys.length > 0) {
    const formattedKeys = envKeys.map((key) => `\`${key}\``).join(" or ");
    return `Set ${formattedKeys} for provider "${provider}" in the agent runtime env or run Pi /login, then retry.`;
  }
  return `Set the API key for provider "${provider}" in the agent runtime env or run Pi /login, then retry.`;
}

const PI_AUTH_REQUIRED_RE =
  /(?:auth(?:entication)?\s+required|api[-_\s]*key|invalid\s*api[-_\s]*key|x[-_\s]*api[-_\s]*key|not\s+logged\s+in|free\s+usage\s+exceeded|membership\s+benefits|membership\s+is\s+active|\b401\b.*status\s+code|\b401\b.*unauthorized)/i;
const PI_STALE_PACKAGE_RE = /pi-driver|npm:\s*pi-driver/i;

function buildPiModelDiscoveryFailureCheck(message: string): AgentRuntimeEnvironmentCheck {
  if (PI_STALE_PACKAGE_RE.test(message)) {
    return {
      code: "pi_package_install_failed",
      level: "warn",
      message: "Pi startup failed while installing configured package `npm:pi-driver`.",
      detail: message,
      hint: "Remove `npm:pi-driver` from ~/.pi/agent/settings.json or set adapter env HOME to a clean Pi profile, then retry `pi --list-models`.",
    };
  }

  return {
    code: "pi_models_discovery_failed",
    level: "warn",
    message,
    hint: "Run `pi --list-models` manually to verify provider auth and config.",
  };
}

export async function testEnvironment(
  ctx: AgentRuntimeEnvironmentTestContext,
): Promise<AgentRuntimeEnvironmentTestResult> {
  const checks: AgentRuntimeEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "pi");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "pi_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "pi_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  const runtimeEnv = normalizeEnv(ensurePathInEnv({ ...process.env, ...env }));

  const cwdInvalid = checks.some((check) => check.code === "pi_cwd_invalid");
  if (cwdInvalid) {
    checks.push({
      code: "pi_command_skipped",
      level: "warn",
      message: "Skipped command check because working directory validation failed.",
      detail: command,
    });
  } else {
    try {
      await ensureCommandResolvable(command, cwd, runtimeEnv);
      checks.push({
        code: "pi_command_resolvable",
        level: "info",
        message: `Command is executable: ${command}`,
      });
    } catch (err) {
      checks.push({
        code: "pi_command_unresolvable",
        level: "error",
        message: err instanceof Error ? err.message : "Command is not executable",
        detail: command,
      });
    }
  }

  const canRunProbe =
    checks.every((check) => check.code !== "pi_cwd_invalid" && check.code !== "pi_command_unresolvable");

  let discoveredModels: { id: string }[] | null = null;
  if (canRunProbe) {
    try {
      discoveredModels = await discoverPiModelsCached({ command, cwd, env: runtimeEnv });
      if (discoveredModels.length > 0) {
        checks.push({
          code: "pi_models_discovered",
          level: "info",
          message: `Discovered ${discoveredModels.length} model(s) from Pi.`,
        });
      } else {
        checks.push({
          code: "pi_models_empty",
          level: "warn",
          message: "Pi returned no models.",
          hint: "Run `pi --list-models` and verify provider authentication.",
        });
      }
    } catch (err) {
      checks.push(
        buildPiModelDiscoveryFailureCheck(
          err instanceof Error ? err.message : "Pi model discovery failed.",
        ),
      );
    }
  }

  const configuredModel = asString(config.model, "").trim();
  const configuredModelHasProvider = isProviderModelFormat(configuredModel);
  if (!configuredModel) {
    checks.push({
      code: "pi_model_required",
      level: "error",
      message: "Pi requires a configured model in provider/model format.",
      hint: "Set agentRuntimeConfig.model using an ID from `pi --list-models`, or enter a custom provider/model such as `deepseek/deepseek-chat` and run the hello probe.",
    });
  } else if (!configuredModelHasProvider) {
    checks.push({
      code: "pi_model_invalid",
      level: "error",
      message: "Pi requires a configured model in provider/model format.",
      hint: "Use provider/model, for example `kimi-coding/kimi-for-coding`.",
    });
  } else if (canRunProbe) {
    if (discoveredModels === null) {
      checks.push({
        code: "pi_model_configured",
        level: "info",
        message: `Configured model: ${configuredModel}`,
      });
    } else if (discoveredModels.some((m) => m.id === configuredModel)) {
      checks.push({
        code: "pi_model_configured",
        level: "info",
        message: `Configured model: ${configuredModel}`,
      });
    } else {
      checks.push({
        code: "pi_model_not_discovered",
        level: "info",
        message: `Configured model "${configuredModel}" was not found in discovered model suggestions.`,
        hint: "Keep this custom provider/model if your local Pi provider config supports it; the hello probe below is the source of truth.",
      });
    }
  }

  if (canRunProbe && configuredModel && configuredModelHasProvider) {
    // Parse model for probe
    const provider = configuredModel.includes("/") 
      ? configuredModel.slice(0, configuredModel.indexOf("/")) 
      : "";
    const modelId = configuredModel.includes("/")
      ? configuredModel.slice(configuredModel.indexOf("/") + 1)
      : configuredModel;
    const thinking = asString(config.thinking, "").trim();
    const extraArgs = (() => {
      const fromExtraArgs = asStringArray(config.extraArgs);
      if (fromExtraArgs.length > 0) return fromExtraArgs;
      return asStringArray(config.args);
    })();

    const args = ["-p", "Respond with hello.", "--mode", "json"];
    if (provider) args.push("--provider", provider);
    if (modelId) args.push("--model", modelId);
    if (thinking) args.push("--thinking", thinking);
    args.push("--tools", "read");
    if (extraArgs.length > 0) args.push(...extraArgs);

    try {
      const probe = await runChildProcess(
        `pi-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 60,
          graceSec: 5,
          onLog: async () => {},
        },
      );

      const parsed = parsePiJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errors[0] ?? null);
      const authEvidence = `${parsed.errors.join("\n")}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "pi_hello_probe_timed_out",
          level: "warn",
          message: "Pi hello probe timed out.",
          hint: "Retry the probe. If this persists, run Pi manually in this working directory.",
        });
      } else if ((probe.exitCode ?? 1) === 0 && parsed.errors.length === 0) {
        const summary = (parsed.finalMessage || parsed.messages.join(" ")).trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "pi_hello_probe_passed" : "pi_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Pi hello probe succeeded."
            : "Pi probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Run `pi --mode json` manually and prompt `Respond with hello` to inspect output.",
              }),
        });
      } else if (PI_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "pi_hello_probe_auth_required",
          level: "warn",
          message: "Pi is installed, but provider authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: buildProviderAuthHint(provider),
        });
      } else {
        checks.push({
          code: "pi_hello_probe_failed",
          level: "error",
          message: "Pi hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `pi --mode json` manually in this working directory to debug.",
        });
      }
    } catch (err) {
      checks.push({
        code: "pi_hello_probe_failed",
        level: "error",
        message: "Pi hello probe failed.",
        detail: err instanceof Error ? err.message : String(err),
        hint: "Run `pi --mode json` manually in this working directory to debug.",
      });
    }
  }

  return {
    agentRuntimeType: ctx.agentRuntimeType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
