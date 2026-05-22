import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type GitIdentitySource = "environment" | "repository" | "global";

export type GitIdentity = {
  name: string;
  email: string;
  source: GitIdentitySource;
};

export type GitIdentityPreparationResult = {
  identity: GitIdentity | null;
  configTarget: string;
  configuredUseConfigOnly: boolean;
  warnings: string[];
};

type GitCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
};

type LogFn = (stream: "stdout" | "stderr", chunk: string) => Promise<void>;

const LOCAL_EMAIL_RE = /@[^@\s<>]+\.local$/i;
const EMAIL_RE = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

function normalizeEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env ?? process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function nonEmpty(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function isUnsafeGitIdentityEmail(email: string | null | undefined): boolean {
  const normalized = nonEmpty(email);
  if (!normalized) return true;
  if (!EMAIL_RE.test(normalized)) return true;
  return LOCAL_EMAIL_RE.test(normalized);
}

export function applyGitIdentityPreparationEnv(
  env: Record<string, string>,
  preparation: GitIdentityPreparationResult,
): void {
  env.GIT_CONFIG_GLOBAL = preparation.configTarget;
  clearUnsafeIdentityEnvPair(env, "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL");
  clearUnsafeIdentityEnvPair(env, "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL");
}

function buildIdentity(
  name: string | null | undefined,
  email: string | null | undefined,
  source: GitIdentitySource,
): GitIdentity | null {
  const normalizedName = nonEmpty(name);
  const normalizedEmail = nonEmpty(email);
  if (!normalizedName || !normalizedEmail) return null;
  if (isUnsafeGitIdentityEmail(normalizedEmail)) return null;
  return {
    name: normalizedName,
    email: normalizedEmail,
    source,
  };
}

function identityFromEnv(env: NodeJS.ProcessEnv): GitIdentity | null {
  return (
    buildIdentity(env.GIT_AUTHOR_NAME, env.GIT_AUTHOR_EMAIL, "environment") ??
    buildIdentity(env.GIT_COMMITTER_NAME, env.GIT_COMMITTER_EMAIL, "environment")
  );
}

function clearUnsafeIdentityEnvPair(
  env: Record<string, string>,
  nameKey: "GIT_AUTHOR_NAME" | "GIT_COMMITTER_NAME",
  emailKey: "GIT_AUTHOR_EMAIL" | "GIT_COMMITTER_EMAIL",
): void {
  const hasValue = nonEmpty(env[nameKey]) || nonEmpty(env[emailKey]);
  if (!hasValue) {
    delete env[nameKey];
    delete env[emailKey];
    return;
  }
  if (buildIdentity(env[nameKey], env[emailKey], "environment")) return;
  delete env[nameKey];
  delete env[emailKey];
}

async function runGit(
  args: string[],
  opts: { cwd?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<GitCommandResult> {
  const env = normalizeEnv(opts.env);
  return await new Promise<GitCommandResult>((resolve) => {
    const child = spawn("git", args, {
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      resolve({ code: null, stdout, stderr, error });
    });
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, error: null });
    });
  });
}

async function readGitConfigValue(
  args: string[],
  key: string,
  opts: { cwd?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const result = await runGit([...args, "--get", key], opts);
  if (result.code !== 0) return null;
  return nonEmpty(result.stdout);
}

async function readIdentityFromGitConfig(
  args: string[],
  source: GitIdentitySource,
  opts: { cwd?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<GitIdentity | null> {
  const [name, email] = await Promise.all([
    readGitConfigValue(args, "user.name", opts),
    readGitConfigValue(args, "user.email", opts),
  ]);
  return buildIdentity(name, email, source);
}

async function setGitConfigValue(args: string[], key: string, value: string, opts: { cwd?: string | null; env?: NodeJS.ProcessEnv }) {
  const result = await runGit([...args, key, value], opts);
  if (result.code === 0) return;
  const details = [result.stderr.trim(), result.stdout.trim(), result.error?.message]
    .filter(Boolean)
    .join("\n");
  throw new Error(details || `git config ${key} failed`);
}

async function unsetGitConfigValue(args: string[], key: string, opts: { cwd?: string | null; env?: NodeJS.ProcessEnv }) {
  await runGit([...args, "--unset-all", key], opts);
}

async function writeGitConfigSeed(configPath: string): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, "", "utf8");
}

async function writeFallbackGitConfigFile(configPath: string, identity: GitIdentity | null): Promise<void> {
  const lines = ["[user]", "\tuseConfigOnly = true"];
  if (identity?.source === "global") {
    lines.push(`\tname = ${identity.name}`, `\temail = ${identity.email}`);
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${lines.join("\n")}\n`, "utf8");
}

async function resolveBestGitIdentity(input: {
  cwd: string;
  sourceEnv: NodeJS.ProcessEnv;
}): Promise<GitIdentity | null> {
  return (
    identityFromEnv(input.sourceEnv) ??
    (await readIdentityFromGitConfig(["config", "--local"], "repository", {
      cwd: input.cwd,
      env: input.sourceEnv,
    })) ??
    (await readIdentityFromGitConfig(["config", "--global"], "global", {
      cwd: input.cwd,
      env: input.sourceEnv,
    }))
  );
}

export async function ensureGitIdentityFileConfig(input: {
  cwd: string;
  home: string;
  sourceEnv?: NodeJS.ProcessEnv;
  onLog?: LogFn | null;
}): Promise<GitIdentityPreparationResult> {
  const sourceEnv = normalizeEnv(input.sourceEnv);
  const home = path.resolve(input.home);
  const gitConfigPath = path.join(home, ".gitconfig");
  await fs.mkdir(home, { recursive: true });

  const configArgs = ["config", "--file", gitConfigPath];
  const identity = await resolveBestGitIdentity({
    cwd: input.cwd,
    sourceEnv,
  });
  const warnings: string[] = [];

  try {
    await writeGitConfigSeed(gitConfigPath);
    await setGitConfigValue(configArgs, "user.useConfigOnly", "true", { cwd: input.cwd, env: sourceEnv });
    await unsetGitConfigValue(configArgs, "user.name", { cwd: input.cwd, env: sourceEnv });
    await unsetGitConfigValue(configArgs, "user.email", { cwd: input.cwd, env: sourceEnv });
    if (identity?.source === "global") {
      await setGitConfigValue(configArgs, "user.name", identity.name, { cwd: input.cwd, env: sourceEnv });
      await setGitConfigValue(configArgs, "user.email", identity.email, { cwd: input.cwd, env: sourceEnv });
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
    await writeFallbackGitConfigFile(gitConfigPath, identity);
  }

  if (input.onLog) {
    const detail = identity
      ? `using ${identity.source} Git identity ${identity.name} <${identity.email}>`
      : "without a usable Git identity; commits will fail until user.name and user.email are configured";
    await input.onLog(
      "stdout",
      `[rudder] Prepared isolated Git config at ${gitConfigPath} with user.useConfigOnly=true (${detail}).\n`,
    );
  }

  return {
    identity,
    configTarget: gitConfigPath,
    configuredUseConfigOnly: true,
    warnings,
  };
}

function readGitConfigEnvCount(env: Record<string, string>): number {
  const raw = nonEmpty(env.GIT_CONFIG_COUNT);
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function appendGitConfigEnvValue(env: Record<string, string>, key: string, value: string): void {
  const index = readGitConfigEnvCount(env);
  env[`GIT_CONFIG_KEY_${index}`] = key;
  env[`GIT_CONFIG_VALUE_${index}`] = value;
  env.GIT_CONFIG_COUNT = String(index + 1);
}

export function applyGitCredentialHelperPolicyEnv(
  env: Record<string, string>,
  options: {
    helper?: string;
    resetExistingHelpers?: boolean;
  } = {},
): void {
  if (options.resetExistingHelpers ?? true) {
    appendGitConfigEnvValue(env, "credential.helper", "");
  }
  appendGitConfigEnvValue(env, "credential.helper", options.helper ?? "!gh auth git-credential");
}

export async function ensureGitRepositoryIdentityConfig(input: {
  cwd: string;
  sourceEnv?: NodeJS.ProcessEnv;
  onLog?: LogFn | null;
}): Promise<GitIdentityPreparationResult> {
  const sourceEnv = normalizeEnv(input.sourceEnv);
  const cwd = path.resolve(input.cwd);
  const configArgs = ["config", "--local"];
  const identity = await resolveBestGitIdentity({
    cwd,
    sourceEnv,
  });
  const warnings: string[] = [];

  await setGitConfigValue(configArgs, "user.useConfigOnly", "true", { cwd, env: sourceEnv });

  if (input.onLog) {
    const detail = identity
      ? `using ${identity.source} Git identity ${identity.name} <${identity.email}>`
      : "without a usable Git identity; commits will fail until user.name and user.email are configured";
    await input.onLog(
      "stdout",
      `[rudder] Prepared repository Git config in ${cwd} with user.useConfigOnly=true (${detail}).\n`,
    );
  }

  return {
    identity,
    configTarget: cwd,
    configuredUseConfigOnly: true,
    warnings,
  };
}
