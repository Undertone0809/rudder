import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureManagedHomeEntrySnapshot } from "@rudderhq/agent-runtime-utils/server-utils";

const DEFAULT_RUDDER_INSTANCE_ID = "default";

export const CURSOR_MANAGED_HOME_INCLUDED_ENTRIES = new Set([
  "agent-cli-state.json",
  "cli-config.json",
  "config.json",
  "ide_state.json",
  "mcp.json",
  "settings",
  "statsig-cache.json",
]);

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

function resolveSharedCursorHomeDir(env: Record<string, string | undefined>): string {
  return path.resolve(nonEmpty(env.HOME) ?? os.homedir());
}

export function resolveManagedCursorHomeDir(
  env: Record<string, string | undefined>,
  orgId: string,
  agentId: string,
): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "cursor-home", "agents", agentId);
}

export function resolveManagedCursorSkillsDir(homeDir: string): string {
  return path.join(homeDir, ".cursor", "skills");
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

async function syncCursorSharedHomeEntries(sourceHome: string, targetHome: string): Promise<void> {
  const sourceCursorDir = path.join(sourceHome, ".cursor");
  const entries = await fs.readdir(sourceCursorDir, { withFileTypes: true }).catch(() => []);
  const targetCursorDir = path.join(targetHome, ".cursor");
  await fs.mkdir(targetCursorDir, { recursive: true });
  await pruneManagedCursorConfigSnapshots(targetCursorDir);
  for (const entry of entries) {
    if (!CURSOR_MANAGED_HOME_INCLUDED_ENTRIES.has(entry.name)) continue;
    await ensureManagedHomeEntrySnapshot(
      path.join(targetCursorDir, entry.name),
      path.join(sourceCursorDir, entry.name),
    );
  }
}

async function ensureSymlinkToDirectory(source: string, target: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) {
    const linkedPath = existing.isSymbolicLink()
      ? await fs.readlink(target).catch(() => null)
      : null;
    const resolvedLinkedPath = linkedPath
      ? path.resolve(path.dirname(target), linkedPath)
      : null;
    if (resolvedLinkedPath === source) return;
    await fs.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.symlink(source, target, "dir");
}

async function syncCursorMacOSKeychainSearchPath(sourceHome: string, targetHome: string): Promise<boolean> {
  if (process.platform !== "darwin") return false;

  const sourceKeychainsDir = path.join(sourceHome, "Library", "Keychains");
  if (!(await pathExists(sourceKeychainsDir))) return false;

  await ensureSymlinkToDirectory(sourceKeychainsDir, path.join(targetHome, "Library", "Keychains"));
  return true;
}

export async function prepareManagedCursorHome(input: {
  env: Record<string, string | undefined>;
  orgId: string;
  agentId: string;
  onPrepared?: (message: string) => Promise<void>;
}): Promise<{ homeDir: string; keychainLinked: boolean }> {
  const sourceHome = resolveSharedCursorHomeDir(input.env);
  const targetHome = resolveManagedCursorHomeDir(input.env, input.orgId, input.agentId);
  if (targetHome === sourceHome) {
    return { homeDir: targetHome, keychainLinked: false };
  }

  await fs.mkdir(resolveManagedCursorSkillsDir(targetHome), { recursive: true });
  if (await pathExists(path.join(sourceHome, ".cursor"))) {
    await syncCursorSharedHomeEntries(sourceHome, targetHome);
  }
  const keychainLinked = await syncCursorMacOSKeychainSearchPath(sourceHome, targetHome);

  await input.onPrepared?.(
    `[rudder] Using Rudder-managed Cursor home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return { homeDir: targetHome, keychainLinked };
}
