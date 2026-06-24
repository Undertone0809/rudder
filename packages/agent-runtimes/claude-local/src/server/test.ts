import type {
  AgentRuntimeEnvironmentCheck,
  AgentRuntimeEnvironmentTestContext,
  AgentRuntimeEnvironmentTestResult,
} from "@rudderhq/agent-runtime-utils";
import { resolveOrganizationStorageKey } from "@rudderhq/agent-runtime-utils";
import {
  asBoolean,
  asNumber,
  asString,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensurePathInEnv,
  parseObject,
  resolveLocalOperatorHome,
  runChildProcess,
  syncLocalCliCredentialHomeEntries,
} from "@rudderhq/agent-runtime-utils/server-utils";
import fs from "node:fs/promises";
import path from "node:path";
import {
  configuredClaudeExtraArgs,
  resolveClaudePermissionMode,
  sanitizeClaudeExtraArgs,
} from "./cli-args.js";
import { detectClaudeLoginRequired, parseClaudeStreamJson } from "./parse.js";

function summarizeStatus(checks: AgentRuntimeEnvironmentCheck[]): AgentRuntimeEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function commandLooksLike(command: string, expected: string): boolean {
  const base = path.basename(command).toLowerCase();
  return base === expected || base === `${expected}.cmd` || base === `${expected}.exe`;
}

function isDeepSeekClaudeModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("deepseek");
}

const DEFAULT_RUDDER_INSTANCE_ID = "default";
const CLAUDE_PROTECTED_ENV_KEYS = new Set([
  "AGENT_HOME",
  "HOME",
  "RUDDER_AGENT_ROOT",
  "RUDDER_OPERATOR_HOME",
  "USERPROFILE",
]);
const CLAUDE_SETTINGS_AUTH_ENV_PREFIXES = ["ANTHROPIC_", "DEEPSEEK_"] as const;
const SHARED_CLAUDE_HOME_ENTRIES = [
  ".config/claude",
  ".config/anthropic",
  ".anthropic",
] as const;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveManagedClaudeHomeDir(env: NodeJS.ProcessEnv, orgId: string): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(process.env.HOME ?? ".", ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", resolveOrganizationStorageKey(orgId), "claude-home");
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function ensureParentDir(target: string) {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureSymlink(target: string, source: string) {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(source, target);
    return;
  }
  if (!existing.isSymbolicLink()) return;

  const linkedPath = await fs.readlink(target).catch(() => null);
  const resolvedLinkedPath = linkedPath ? path.resolve(path.dirname(target), linkedPath) : null;
  if (resolvedLinkedPath === source) return;
  await fs.unlink(target);
  await fs.symlink(source, target);
}

async function writeSanitizedClaudeSettings(sourceHome: string, targetHome: string): Promise<string> {
  const sourceSettings = await readJsonObject(path.join(sourceHome, ".claude", "settings.json"));
  const targetSettingsPath = path.join(targetHome, ".claude", "settings.json");
  const sourceEnv = parseObject(sourceSettings?.env);
  const authEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (!CLAUDE_SETTINGS_AUTH_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (typeof value === "string" && value.trim().length > 0) authEnv[key] = value;
  }

  const sanitized = Object.keys(authEnv).length > 0 ? { env: authEnv } : {};
  await fs.mkdir(path.dirname(targetSettingsPath), { recursive: true });
  await fs.writeFile(targetSettingsPath, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  return targetSettingsPath;
}

async function prepareManagedClaudeProbeHome(
  sourceEnv: NodeJS.ProcessEnv,
  orgId: string,
): Promise<{ home: string; configDir: string; settingsPath: string; operatorHome: string }> {
  const operatorHome = resolveLocalOperatorHome(sourceEnv);
  const home = resolveManagedClaudeHomeDir(sourceEnv, orgId);
  const configDir = path.join(home, ".claude");
  await fs.mkdir(home, { recursive: true });
  await fs.rm(path.join(configDir, "skills"), { recursive: true, force: true });
  await fs.rm(path.join(configDir, "plugins"), { recursive: true, force: true });
  await fs.rm(path.join(home, ".claude.json"), { force: true });
  await fs.mkdir(path.join(configDir, "skills"), { recursive: true });
  const settingsPath = await writeSanitizedClaudeSettings(operatorHome, home);
  for (const relativeEntry of SHARED_CLAUDE_HOME_ENTRIES) {
    const source = path.join(operatorHome, relativeEntry);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(home, relativeEntry), source);
  }
  await syncLocalCliCredentialHomeEntries({
    sourceHome: operatorHome,
    targetHome: home,
    onLog: async () => {},
  });
  return { home, configDir, settingsPath, operatorHome };
}

function summarizeProbeDetail(stdout: string, stderr: string): string | null {
  const raw = firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function classifyClaudeHelloProbe(input: {
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): AgentRuntimeEnvironmentCheck {
  const parsedStream = parseClaudeStreamJson(input.stdout);
  const parsed = parsedStream.resultJson;
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout,
    stderr: input.stderr,
  });
  const detail = summarizeProbeDetail(input.stdout, input.stderr);

  if (loginMeta.requiresLogin) {
    return {
      code: "claude_hello_probe_auth_required",
      level: "warn",
      message: "Claude CLI is installed, but login is required.",
      ...(detail ? { detail } : {}),
      hint: loginMeta.loginUrl
        ? `Run \`claude auth login\` and complete sign-in at ${loginMeta.loginUrl}, then retry.`
        : "Run `claude auth login` in this environment, then retry the probe.",
    };
  }

  const summary = parsedStream.summary.trim();
  const hasHello = /\bhello\b/i.test(summary);
  if (hasHello && ((input.exitCode ?? 0) === 0 || input.timedOut)) {
    return {
      code: input.timedOut ? "claude_hello_probe_passed_with_timeout" : "claude_hello_probe_passed",
      level: input.timedOut ? "warn" : "info",
      message: input.timedOut
        ? "Claude hello probe produced the expected response before the CLI process timed out."
        : "Claude hello probe succeeded.",
      ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
    };
  }

  if (input.timedOut) {
    return {
      code: "claude_hello_probe_timed_out",
      level: "warn",
      message: "Claude hello probe timed out.",
      hint: "Retry the probe. If this persists, verify Claude can run `Respond with hello` from this directory manually.",
    };
  }

  if ((input.exitCode ?? 1) === 0) {
    return {
      code: "claude_hello_probe_unexpected_output",
      level: "warn",
      message: "Claude probe ran but did not return `hello` as expected.",
      ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
      hint: "Try the probe manually (`claude --print - --output-format stream-json --verbose`) and prompt `Respond with hello`.",
    };
  }

  return {
    code: "claude_hello_probe_failed",
    level: "error",
    message: "Claude hello probe failed.",
    ...(detail ? { detail } : {}),
    hint: "Run `claude --print - --output-format stream-json --verbose` manually in this directory and prompt `Respond with hello` to debug.",
  };
}

export async function testEnvironment(
  ctx: AgentRuntimeEnvironmentTestContext,
): Promise<AgentRuntimeEnvironmentTestResult> {
  const checks: AgentRuntimeEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "claude");
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "claude_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const envConfig = parseObject(config.env);
  const envConfigStrings: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && !CLAUDE_PROTECTED_ENV_KEYS.has(key)) envConfigStrings[key] = value;
  }
  const managedClaudeHome = await prepareManagedClaudeProbeHome(
    { ...process.env, ...envConfigStrings },
    ctx.orgId,
  );
  const env: Record<string, string> = {
    ...envConfigStrings,
    HOME: managedClaudeHome.home,
    USERPROFILE: managedClaudeHome.home,
    CLAUDE_CONFIG_DIR: managedClaudeHome.configDir,
    RUDDER_CLAUDE_HOME: managedClaudeHome.home,
    RUDDER_OPERATOR_HOME: managedClaudeHome.operatorHome,
  };
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "claude_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "claude_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configApiKey = env.ANTHROPIC_API_KEY;
  const hostApiKey = process.env.ANTHROPIC_API_KEY;
  const model = asString(config.model, "").trim();
  const usesDeepSeekModel = isDeepSeekClaudeModel(model);
  const configDeepSeekApiKey = env.DEEPSEEK_API_KEY;
  const hostDeepSeekApiKey = process.env.DEEPSEEK_API_KEY;
  if (isNonEmpty(configApiKey) || isNonEmpty(hostApiKey)) {
    const source = isNonEmpty(configApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "claude_anthropic_api_key_overrides_subscription",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set. Claude will use API-key auth instead of subscription credentials.",
      detail: `Detected in ${source}.`,
      hint: "Unset ANTHROPIC_API_KEY if you want subscription-based Claude login behavior.",
    });
  } else if (usesDeepSeekModel && (isNonEmpty(configDeepSeekApiKey) || isNonEmpty(hostDeepSeekApiKey))) {
    const source = isNonEmpty(configDeepSeekApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "claude_deepseek_api_key_configured",
      level: "info",
      message: "DEEPSEEK_API_KEY is set for the configured Claude Code DeepSeek model.",
      detail: `Detected in ${source}.`,
    });
  } else if (usesDeepSeekModel) {
    checks.push({
      code: "claude_deepseek_api_key_missing",
      level: "warn",
      message: "DEEPSEEK_API_KEY is not set for the configured Claude Code DeepSeek model.",
      hint: "Paste DEEPSEEK_API_KEY into the runtime env or configure the organization secret binding, then run Test now again.",
    });
  } else {
    checks.push({
      code: "claude_subscription_mode_possible",
      level: "info",
      message: "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if Claude is logged in.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "claude_cwd_invalid" && check.code !== "claude_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, "claude")) {
      checks.push({
        code: "claude_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `claude`.",
        detail: command,
        hint: "Use the `claude` CLI command to run the automatic login and installation probe.",
      });
    } else {
      const effort = asString(config.effort, "").trim();
      const chrome = asBoolean(config.chrome, false);
      const maxTurns = asNumber(config.maxTurnsPerRun, 0);
      const dangerouslySkipPermissions = asBoolean(config.dangerouslySkipPermissions, false);
      const permissionMode = resolveClaudePermissionMode(config);
      const extraArgs = sanitizeClaudeExtraArgs(configuredClaudeExtraArgs(config)).args;

      const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
      if (dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
      else args.push("--permission-mode", permissionMode);
      if (chrome) args.push("--chrome");
      if (model) args.push("--model", model);
      if (effort) args.push("--effort", effort);
      if (maxTurns > 0) args.push("--max-turns", String(maxTurns));
      args.push("--settings", managedClaudeHome.settingsPath, "--setting-sources", "user", "--strict-mcp-config");
      if (extraArgs.length > 0) args.push(...extraArgs);

      const probe = await runChildProcess(
        `claude-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env,
          timeoutSec: 45,
          graceSec: 5,
          stdin: "Respond with hello.",
          onLog: async () => {},
        },
      );

      checks.push(classifyClaudeHelloProbe(probe));
    }
  }

  return {
    agentRuntimeType: ctx.agentRuntimeType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
