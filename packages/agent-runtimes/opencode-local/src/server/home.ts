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

export function applyManagedOpenCodeEnv(env: Record<string, string>, managedHome: string): Record<string, string> {
  return {
    ...env,
    HOME: managedHome,
    XDG_CONFIG_HOME: resolveManagedOpenCodeConfigDir(managedHome),
    XDG_DATA_HOME: resolveManagedOpenCodeDataDir(managedHome),
    XDG_CACHE_HOME: resolveManagedOpenCodeCacheDir(managedHome),
  };
}
