import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureManagedHomeEntrySnapshot } from "@rudderhq/agent-runtime-utils/server-utils";

const DEFAULT_RUDDER_INSTANCE_ID = "default";

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function resolvePiRoot(homeDir: string): string {
  return path.join(homeDir, ".pi");
}

export function resolvePiAgentDir(homeDir: string): string {
  return path.join(resolvePiRoot(homeDir), "agent");
}

export function resolvePiSessionsDir(homeDir: string): string {
  return path.join(resolvePiAgentDir(homeDir), "rudder-sessions");
}

export function resolvePiSkillsDir(homeDir: string): string {
  return path.join(resolvePiAgentDir(homeDir), "skills");
}

function resolvePiDefaultSessionsDir(homeDir: string): string {
  return path.join(resolvePiAgentDir(homeDir), "sessions");
}

export function applyManagedPiEnv(
  env: Record<string, string | undefined>,
  managedHome: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") next[key] = value;
  }
  next.HOME = managedHome;
  next.PI_CODING_AGENT_DIR = resolvePiAgentDir(managedHome);
  next.PI_CODING_AGENT_SESSION_DIR = resolvePiSessionsDir(managedHome);
  return next;
}

function resolveSharedPiHomeDir(env: Record<string, string | undefined>): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

function resolveManagedPiHomeDir(
  env: Record<string, string | undefined>,
  orgId: string,
  agentId: string,
): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "pi-home", "agents", agentId);
}

async function syncPiSharedHomeEntries(sourceHome: string, targetHome: string) {
  const sourcePiDir = resolvePiRoot(sourceHome);
  const targetPiDir = resolvePiRoot(targetHome);
  await fs.mkdir(targetPiDir, { recursive: true });

  const topEntries = await fs.readdir(sourcePiDir, { withFileTypes: true }).catch(() => []);
  for (const entry of topEntries) {
    if (entry.name === "agent" || entry.name === "paperclips") continue;
    await ensureManagedHomeEntrySnapshot(path.join(targetPiDir, entry.name), path.join(sourcePiDir, entry.name));
  }

  const sourceAgentDir = resolvePiAgentDir(sourceHome);
  if (!(await pathExists(sourceAgentDir))) return;
  const targetAgentDir = resolvePiAgentDir(targetHome);
  await fs.mkdir(targetAgentDir, { recursive: true });
  const agentEntries = await fs.readdir(sourceAgentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of agentEntries) {
    if (entry.name === "skills" || entry.name === "sessions") continue;
    await ensureManagedHomeEntrySnapshot(path.join(targetAgentDir, entry.name), path.join(sourceAgentDir, entry.name));
  }
}

export async function prepareManagedPiHome(input: {
  env: Record<string, string | undefined>;
  orgId: string;
  agentId: string;
  onPrepared?: (message: string) => Promise<void>;
}): Promise<string> {
  const sourceHome = resolveSharedPiHomeDir(input.env);
  const targetHome = resolveManagedPiHomeDir(input.env, input.orgId, input.agentId);
  if (targetHome === sourceHome) return targetHome;

  await fs.rm(resolvePiDefaultSessionsDir(targetHome), { recursive: true, force: true });
  await fs.mkdir(resolvePiSkillsDir(targetHome), { recursive: true });
  await fs.mkdir(resolvePiSessionsDir(targetHome), { recursive: true });
  if (await pathExists(resolvePiRoot(sourceHome))) {
    await syncPiSharedHomeEntries(sourceHome, targetHome);
  }

  await input.onPrepared?.(
    `[rudder] Using Rudder-managed Pi home "${targetHome}" (credential/config snapshots seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}
