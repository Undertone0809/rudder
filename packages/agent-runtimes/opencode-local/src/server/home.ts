import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureManagedHomeEntrySnapshot } from "@rudderhq/agent-runtime-utils/server-utils";

const DEFAULT_RUDDER_INSTANCE_ID = "default";
const OPENCODE_AUTH_FILE = path.join(".local", "share", "opencode", "auth.json");

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedOpenCodeHomeDir(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

export function resolveManagedOpenCodeHomeDir(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  orgId: string,
  agentId: string,
): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "opencode-home", "agents", agentId);
}

export function resolveManagedOpenCodeSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".claude", "skills");
}

export function resolveManagedOpenCodeConfigDir(homeDir: string): string {
  return path.join(homeDir, ".config");
}

function resolveManagedOpenCodeConfigFile(homeDir: string): string {
  return path.join(resolveManagedOpenCodeConfigDir(homeDir), "opencode", "opencode.json");
}

export function resolveManagedOpenCodeDataDir(homeDir: string): string {
  return path.join(homeDir, ".local", "share");
}

export function resolveManagedOpenCodeCacheDir(homeDir: string): string {
  return path.join(homeDir, ".cache");
}

async function syncOpenCodeAuthFile(sourceHome: string, targetHome: string) {
  const source = path.join(sourceHome, OPENCODE_AUTH_FILE);
  if (!(await pathExists(source))) return;
  await ensureManagedHomeEntrySnapshot(path.join(targetHome, OPENCODE_AUTH_FILE), source);
}

export async function prepareManagedOpenCodeHome(input: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  orgId: string;
  agentId: string;
  onPrepared?: (message: string) => Promise<void>;
}): Promise<string> {
  const sourceHome = resolveSharedOpenCodeHomeDir(input.env);
  const targetHome = resolveManagedOpenCodeHomeDir(input.env, input.orgId, input.agentId);
  if (targetHome === sourceHome) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });
  await fs.mkdir(resolveManagedOpenCodeSkillsDir(targetHome), { recursive: true });
  await fs.mkdir(resolveManagedOpenCodeConfigDir(targetHome), { recursive: true });
  await fs.mkdir(resolveManagedOpenCodeDataDir(targetHome), { recursive: true });
  await fs.mkdir(resolveManagedOpenCodeCacheDir(targetHome), { recursive: true });
  await syncOpenCodeAuthFile(sourceHome, targetHome);

  await input.onPrepared?.(
    `[rudder] Using Rudder-managed OpenCode home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

function hasDeepSeekKey(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return typeof env.DEEPSEEK_API_KEY === "string" && env.DEEPSEEK_API_KEY.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function ensureManagedOpenCodeDeepSeekConfig(input: {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir: string;
  model?: string;
}): Promise<void> {
  if (!hasDeepSeekKey(input.env)) return;

  const configFile = resolveManagedOpenCodeConfigFile(input.homeDir);
  await fs.mkdir(path.dirname(configFile), { recursive: true });

  let config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };
  try {
    const raw = await fs.readFile(configFile, "utf8");
    const parsed = JSON.parse(raw);
    if (isRecord(parsed)) config = parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
  }

  const provider = isRecord(config.provider) ? { ...config.provider } : {};
  const deepseek = isRecord(provider.deepseek) ? { ...provider.deepseek } : {};
  const models = isRecord(deepseek.models) ? { ...deepseek.models } : {};
  provider.deepseek = {
    npm: "@ai-sdk/openai-compatible",
    name: "DeepSeek",
    ...deepseek,
    options: {
      ...(isRecord(deepseek.options) ? deepseek.options : {}),
      baseURL: "https://api.deepseek.com",
      apiKey: "{env:DEEPSEEK_API_KEY}",
    },
    models: {
      "deepseek-chat": { name: "DeepSeek Chat" },
      "deepseek-reasoner": { name: "DeepSeek Reasoner" },
      "deepseek-v4-flash": { name: "DeepSeek V4 Flash" },
      "deepseek-v4-pro": { name: "DeepSeek V4 Pro" },
      ...models,
    },
  };
  config.provider = provider;

  await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function applyManagedOpenCodeEnv(env: Record<string, string>, managedHome: string): Record<string, string> {
  return {
    ...env,
    HOME: managedHome,
    XDG_CONFIG_HOME: resolveManagedOpenCodeConfigDir(managedHome),
    XDG_DATA_HOME: resolveManagedOpenCodeDataDir(managedHome),
    XDG_CACHE_HOME: resolveManagedOpenCodeCacheDir(managedHome),
  };
}
