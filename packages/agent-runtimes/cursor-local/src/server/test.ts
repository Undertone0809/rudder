import fs from "node:fs/promises";
import os from "node:os";
import type {
  AgentRuntimeEnvironmentCheck,
  AgentRuntimeEnvironmentTestContext,
  AgentRuntimeEnvironmentTestResult,
} from "@rudderhq/agent-runtime-utils";
import {
  asString,
  asStringArray,
  parseObject,
  ensureAbsoluteDirectory,
  ensureCommandResolvable,
  ensureManagedHomeEntrySnapshot,
  ensurePathInEnv,
  runChildProcess,
} from "@rudderhq/agent-runtime-utils/server-utils";
import path from "node:path";
import { DEFAULT_CURSOR_LOCAL_COMMAND, DEFAULT_CURSOR_LOCAL_MODEL } from "../index.js";
import { parseCursorJsonl } from "./parse.js";
import { hasCursorTrustBypassArg } from "../shared/trust.js";

const DEFAULT_RUDDER_INSTANCE_ID = "default";
const CURSOR_SKILL_HOME_ENTRIES = new Set(["skills", "skills-cursor"]);

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

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

async function removeManagedCursorEntry(targetCursorDir: string, entryName: string): Promise<void> {
  const target = path.join(targetCursorDir, entryName);
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) return;
  if (entryName === "skills" && existing.isDirectory() && !existing.isSymbolicLink()) return;
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

async function pruneManagedCursorConfigSnapshots(targetCursorDir: string): Promise<void> {
  const entries = await fs.readdir(targetCursorDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "skills") continue;
    await removeManagedCursorEntry(targetCursorDir, entry.name);
  }
}

function resolveManagedCursorHomeDir(env: Record<string, string>, orgId: string, agentId: string): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "cursor-home", "agents", agentId);
}

async function prepareManagedCursorHome(env: Record<string, string>, orgId: string, agentId: string): Promise<string> {
  const sourceHome = nonEmpty(env.HOME);
  const resolvedSourceHome = sourceHome ? path.resolve(sourceHome) : null;
  const targetHome = resolveManagedCursorHomeDir(env, orgId, agentId);
  if (resolvedSourceHome && targetHome === resolvedSourceHome) return targetHome;

  const targetCursorDir = path.join(targetHome, ".cursor");
  await fs.mkdir(path.join(targetCursorDir, "skills"), { recursive: true });
  await pruneManagedCursorConfigSnapshots(targetCursorDir);

  if (resolvedSourceHome) {
    const sourceCursorDir = path.join(resolvedSourceHome, ".cursor");
    if (await pathExists(sourceCursorDir)) {
      const entries = await fs.readdir(sourceCursorDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (CURSOR_SKILL_HOME_ENTRIES.has(entry.name)) continue;
        await ensureManagedHomeEntrySnapshot(path.join(targetCursorDir, entry.name), path.join(sourceCursorDir, entry.name));
      }
    }

    if (process.platform === "darwin") {
      const sourceKeychainsDir = path.join(resolvedSourceHome, "Library", "Keychains");
      if (await pathExists(sourceKeychainsDir)) {
        await ensureManagedHomeEntrySnapshot(path.join(targetHome, "Library", "Keychains"), sourceKeychainsDir);
      }
    }
  }
  return targetHome;
}

const CURSOR_AUTH_REQUIRED_RE =
  /(?:authentication\s+required|not\s+authenticated|not\s+logged\s+in|not\s+logged\s+in|press\s+any\s+key\s+to\s+sign\s+in|authenticating\s+with\s+cursor|unauthorized|invalid(?:\s+or\s+missing)?\s+api(?:[_\s-]?key)?|cursor[_\s-]?api[_\s-]?key|run\s+'?(?:cursor-agent|agent)\s+login'?\s+first|api(?:[_\s-]?key)?(?:\s+is)?\s+required)/i;

export async function testEnvironment(
  ctx: AgentRuntimeEnvironmentTestContext,
): Promise<AgentRuntimeEnvironmentTestResult> {
  const checks: AgentRuntimeEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, DEFAULT_CURSOR_LOCAL_COMMAND);
  const cwd = asString(config.cwd, process.cwd());

  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
    checks.push({
      code: "cursor_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "cursor_cwd_invalid",
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
  const baseEnv = Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (!Object.prototype.hasOwnProperty.call(env, "HOME")) {
    delete baseEnv.HOME;
  }
  const managedHome = await prepareManagedCursorHome(baseEnv, ctx.orgId, "environment-test");
  const runtimeEnv = Object.fromEntries(
    Object.entries(ensurePathInEnv({ ...baseEnv, HOME: managedHome })).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  try {
    await ensureCommandResolvable(command, cwd, runtimeEnv);
    checks.push({
      code: "cursor_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "cursor_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const configCursorApiKey = env.CURSOR_API_KEY;
  const hostCursorApiKey = process.env.CURSOR_API_KEY;
  if (isNonEmpty(configCursorApiKey) || isNonEmpty(hostCursorApiKey)) {
    const source = isNonEmpty(configCursorApiKey) ? "adapter config env" : "server environment";
    checks.push({
      code: "cursor_api_key_present",
      level: "info",
      message: "CURSOR_API_KEY is set for Cursor authentication.",
      detail: `Detected in ${source}.`,
    });
  } else {
    checks.push({
      code: "cursor_api_key_missing",
      level: "warn",
      message: "CURSOR_API_KEY is not set. Cursor runs may fail until authentication is configured.",
      hint: "Set CURSOR_API_KEY in adapter env or run `cursor-agent login`.",
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "cursor_cwd_invalid" && check.code !== "cursor_command_unresolvable");
  if (canRunProbe) {
    if (!commandLooksLike(command, DEFAULT_CURSOR_LOCAL_COMMAND)) {
      checks.push({
        code: "cursor_hello_probe_skipped_custom_command",
        level: "info",
        message: "Skipped hello probe because command is not `cursor-agent`.",
        detail: command,
        hint: "Use the `cursor-agent` CLI command to run the automatic installation and auth probe.",
      });
    } else {
      const model = asString(config.model, DEFAULT_CURSOR_LOCAL_MODEL).trim();
      const extraArgs = (() => {
        const fromExtraArgs = asStringArray(config.extraArgs);
        if (fromExtraArgs.length > 0) return fromExtraArgs;
        return asStringArray(config.args);
      })();
      const autoTrustEnabled = !hasCursorTrustBypassArg(extraArgs);
      const args = ["-p", "--output-format", "json"];
      if (model) args.push("--model", model);
      if (autoTrustEnabled) args.push("-f");
      if (extraArgs.length > 0) args.push(...extraArgs);
      args.push("Respond with hello.");

      const probe = await runChildProcess(
        `cursor-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        command,
        args,
        {
          cwd,
          env: runtimeEnv,
          timeoutSec: 45,
          graceSec: 5,
          onLog: async () => {},
        },
      );
      const parsed = parseCursorJsonl(probe.stdout);
      const detail = summarizeProbeDetail(probe.stdout, probe.stderr, parsed.errorMessage);
      const authEvidence = `${parsed.errorMessage ?? ""}\n${probe.stdout}\n${probe.stderr}`.trim();

      if (probe.timedOut) {
        checks.push({
          code: "cursor_hello_probe_timed_out",
          level: "warn",
          message: "Cursor hello probe timed out.",
          hint: "Retry the probe. If this persists, verify `cursor-agent -p --output-format json \"Respond with hello.\"` manually.",
        });
      } else if ((probe.exitCode ?? 1) === 0) {
        const summary = parsed.summary.trim();
        const hasHello = /\bhello\b/i.test(summary);
        checks.push({
          code: hasHello ? "cursor_hello_probe_passed" : "cursor_hello_probe_unexpected_output",
          level: hasHello ? "info" : "warn",
          message: hasHello
            ? "Cursor hello probe succeeded."
            : "Cursor probe ran but did not return `hello` as expected.",
          ...(summary ? { detail: summary.replace(/\s+/g, " ").trim().slice(0, 240) } : {}),
          ...(hasHello
            ? {}
            : {
                hint: "Try `cursor-agent -p --output-format json \"Respond with hello.\"` manually to inspect full output.",
              }),
        });
      } else if (CURSOR_AUTH_REQUIRED_RE.test(authEvidence)) {
        checks.push({
          code: "cursor_hello_probe_auth_required",
          level: "warn",
          message: "Cursor CLI is installed, but authentication is not ready.",
          ...(detail ? { detail } : {}),
          hint: "Run `cursor-agent login` or configure CURSOR_API_KEY in adapter env/shell, then retry the probe.",
        });
      } else {
        checks.push({
          code: "cursor_hello_probe_failed",
          level: "error",
          message: "Cursor hello probe failed.",
          ...(detail ? { detail } : {}),
          hint: "Run `cursor-agent -p --output-format json \"Respond with hello.\"` manually in this working directory to debug.",
        });
      }
    }
  }

  return {
    agentRuntimeType: ctx.agentRuntimeType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
