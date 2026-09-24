import {
  RUDDER_BROWSER_MCP_SERVER_NAME,
  RUDDER_COMPUTER_MCP_SERVER_NAME,
  RUDDER_MCP_SERVER_NAME,
  resolveManagedExternalMcpBindings,
  resolveOrganizationStorageKey,
  type AgentRuntimeExecutionContext,
  type RudderMcpCliCommand,
  type RudderMcpManagedEnv,
} from "@rudderhq/agent-runtime-utils";
import {
  resolveRudderBrowserMcpCliCommand,
  resolveRudderComputerMcpCliCommand,
  resolveRudderMcpCliCommand,
} from "@rudderhq/agent-runtime-utils/rudder-mcp-server";
import {
  createRudderSkillDirectoryLink,
  readInstalledSkillTargets,
  resolveLocalOperatorHome,
} from "@rudderhq/agent-runtime-utils/server-utils";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const MIRRORED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_RUDDER_INSTANCE_ID = "default";
const LEGACY_RUDDER_MANAGED_SKILLS_MARKERS = new Set([
  "# rudder-managed-skills:start",
  "# rudder-managed-skills:end",
]);
const codexHomeMutationLocks = new Map<string, Promise<void>>();

export type CodexSkillIsolationSurface = {
  disabledSkillPaths: string[];
  /** Provider-native skill roots explicitly retained from the authorized profile. */
  preservedSkillPaths?: string[];
};

export function resolveTrustedOperatorHome(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    typeof env.HOME === "string" && env.HOME.trim().length > 0
      ? path.resolve(env.HOME.trim())
      : null;
  if (home) return home;
  return resolveLocalOperatorHome(env);
}

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function discoverExternalCodexSkillDisablePaths(
  skillRoots: string[],
  preservedSkillRoots: string[] = [],
): Promise<string[]> {
  const disabledPaths = new Set<string>();
  const preservedRoots = preservedSkillRoots.map((value) => path.resolve(value));

  for (const root of skillRoots) {
    const resolvedRoot = path.resolve(root);
    if (preservedRoots.some((preservedRoot) => isPathWithin(resolvedRoot, preservedRoot))) continue;
    disabledPaths.add(resolvedRoot);
    const rootSkillFile = path.join(resolvedRoot, "SKILL.md");
    if (await fs.access(rootSkillFile).then(() => true).catch(() => false)) {
      disabledPaths.add(rootSkillFile);
    }

    const entries = await fs.readdir(resolvedRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(resolvedRoot, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      if (!(await fs.access(skillFile).then(() => true).catch(() => false))) continue;
      disabledPaths.add(skillDir);
      disabledPaths.add(skillFile);
    }
  }

  return Array.from(disabledPaths).sort((left, right) => left.localeCompare(right));
}

async function withCodexHomeMutationLock<T>(codexHome: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(codexHome);
  const previous = codexHomeMutationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const marker = previous.then(() => current, () => current);
  codexHomeMutationLocks.set(key, marker);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (codexHomeMutationLocks.get(key) === marker) {
      codexHomeMutationLocks.delete(key);
    }
  }
}

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromRudderSharedEnv = nonEmpty(env.RUDDER_SHARED_CODEX_HOME);
  if (fromRudderSharedEnv) return path.resolve(fromRudderSharedEnv);

  const fromEnv = nonEmpty(env.CODEX_HOME);
  if (fromEnv) return path.resolve(fromEnv);

  const fromHome = nonEmpty(env.HOME);
  return path.join(fromHome ? path.resolve(fromHome) : os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.RUDDER_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  orgId?: string,
  agentId?: string,
): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  if (orgId && agentId) {
    return path.resolve(
      rudderHome,
      "instances",
      instanceId,
      "organizations",
      resolveOrganizationStorageKey(orgId),
      "codex-home",
      "agents",
      agentId,
    );
  }
  return orgId
    ? path.resolve(rudderHome, "instances", instanceId, "organizations", resolveOrganizationStorageKey(orgId), "codex-home")
    : path.resolve(rudderHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

function isSharedFileRenameCollision(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM";
}

async function copySharedFileIntoPlace(source: string, target: string): Promise<void> {
  await ensureParentDir(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(source, temporary);
    try {
      await fs.rename(temporary, target);
    } catch (error) {
      if (!isSharedFileRenameCollision(error)) throw error;
      // Windows cannot replace an existing file with rename; retain the same
      // source-of-truth semantics with the platform's overwrite primitive.
      await fs.copyFile(temporary, target);
    }
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

async function mirrorSharedAuthSnapshot(
  target: string,
  source: string,
  onLog: AgentRuntimeExecutionContext["onLog"],
): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!(await pathExists(source))) {
    if (existing?.isFile() || existing?.isSymbolicLink()) {
      await fs.unlink(target).catch(() => undefined);
    }
    return;
  }

  // Auth policy is deliberately one-way: the operator's auth.json is the
  // source of truth and each run receives a private snapshot. A symlink would
  // let Codex write token refreshes and provider state into the shared home;
  // provider refreshes are therefore not persisted by Rudder. A manual Codex
  // login or auth-file refresh in the shared home is picked up on the next run.
  if (existing?.isSymbolicLink()) {
    await fs.unlink(target);
  } else if (existing && !existing.isFile()) {
    throw new Error(`Managed Codex auth path is not a regular file: ${target}`);
  }
  await copySharedFileIntoPlace(source, target);
  await onLog(
    "stdout",
    `[rudder] Mirrored shared Codex auth into isolated home "${target}" without provider-state writeback.\n`,
  ).catch(() => undefined);
}

async function ensureCopiedFile(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) return;
  await ensureParentDir(target);
  await fs.copyFile(source, target);
}

function isTomlTableBoundary(trimmedLine: string): boolean {
  return /^\[\[.+\]\]$/.test(trimmedLine) || /^\[(?!\[).+\]$/.test(trimmedLine);
}

function isManagedCodexConfigTableToStrip(trimmedLine: string): boolean {
  if (/^\[mcp_servers(?:\..+)?\]$/.test(trimmedLine)) return true;
  return false;
}

function unsupportedCodexServiceTierLine(trimmedLine: string): boolean {
  const match = trimmedLine.match(/^service_tier\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/i);
  if (!match) return false;
  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim().toLowerCase();
  return value !== "fast" && value !== "flex";
}

function ensureCodexIsolationDefaults(content: string): {
  content: string;
  addedFeatures: boolean;
  addedBundledSkills: boolean;
} {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let blockLines: string[] | null = null;
  let blockName: string | null = null;
  let hasFeatures = false;
  let hasFeaturePlugins = false;
  let hasBundledSkills = false;
  let hasBundledSkillsEnabled = false;
  let addedFeatures = false;
  let addedBundledSkills = false;

  const appendDefaultToBlock = (block: string[], property: string): string[] => {
    let end = block.length;
    while (end > 1 && block[end - 1].trim() === "") end -= 1;
    return [...block.slice(0, end), property, ...block.slice(end)];
  };

  const flushBlock = () => {
    if (!blockLines || !blockName) return;
    if (blockName === "[features]" && !hasFeaturePlugins) {
      blockLines = appendDefaultToBlock(blockLines, "plugins = false");
      addedFeatures = true;
    }
    if (blockName === "[skills.bundled]" && !hasBundledSkillsEnabled) {
      blockLines = appendDefaultToBlock(blockLines, "enabled = false");
      addedBundledSkills = true;
    }
    output.push(...blockLines);
    blockLines = null;
    blockName = null;
    hasFeaturePlugins = false;
    hasBundledSkillsEnabled = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (isTomlTableBoundary(trimmed)) {
      flushBlock();
      blockLines = [line];
      blockName = trimmed;
      if (trimmed === "[features]") hasFeatures = true;
      if (trimmed === "[skills.bundled]") hasBundledSkills = true;
      continue;
    }

    if (!blockLines) {
      output.push(line);
      continue;
    }
    blockLines.push(line);
    if (blockName === "[features]" && /^plugins\s*=/.test(trimmed)) hasFeaturePlugins = true;
    if (blockName === "[skills.bundled]" && /^enabled\s*=/.test(trimmed)) hasBundledSkillsEnabled = true;
  }
  flushBlock();

  if (!hasFeatures) {
    while (output.at(-1)?.trim() === "") output.pop();
    if (output.length > 0) output.push("");
    output.push("[features]", "plugins = false");
    addedFeatures = true;
  }

  if (!hasBundledSkills) {
    while (output.at(-1)?.trim() === "") output.pop();
    if (output.length > 0) output.push("");
    output.push("[skills.bundled]", "enabled = false");
    addedBundledSkills = true;
  }

  return { content: output.join(newline), addedFeatures, addedBundledSkills };
}

function renderDisabledCodexSkillConfigEntries(
  skillPaths: string[],
  preservedSkillPaths: string[] = [],
): string {
  const normalized = Array.from(
    new Set(skillPaths.map((value) => path.resolve(value))),
  )
    .filter((skillPath) => !preservedSkillPaths.some((preservedPath) => isPathWithin(skillPath, path.resolve(preservedPath))))
    .sort((left, right) => left.localeCompare(right));

  if (normalized.length === 0) return "";

  return normalized
    .map((skillPath) => [
      "[[skills.config]]",
      `path = ${JSON.stringify(skillPath)}`,
      "enabled = false",
    ].join("\n"))
    .join("\n\n");
}

async function renderRudderMcpCodexConfig(
  moduleDir: string,
  managedEnv: RudderMcpManagedEnv = {},
  verifiedCommand?: RudderMcpCliCommand,
  verifiedBrowserCommand?: RudderMcpCliCommand,
  verifiedComputerCommand?: RudderMcpCliCommand,
  includeCore = true,
): Promise<string> {
  const renderServer = (
    serverName: string,
    server: RudderMcpCliCommand,
    env: Record<string, string>,
  ) => [
    `[mcp_servers.${serverName}]`,
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    ...(Object.keys(env).length > 0
      ? [
          "",
          `[mcp_servers.${serverName}.env]`,
          ...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        ]
      : []),
  ].join("\n");

  const servers: string[] = [];
  if (includeCore) {
    const coreServer = verifiedCommand ?? await resolveRudderMcpCliCommand(moduleDir);
    const coreEnv = {
      ...(coreServer.env ?? {}),
      ...managedEnv,
    };
    delete coreEnv.RUDDER_BROWSER_ENABLED;
    delete coreEnv.RUDDER_COMPUTER_ENABLED;
    servers.push(renderServer(RUDDER_MCP_SERVER_NAME, coreServer, coreEnv));
  }
  if (managedEnv.RUDDER_BROWSER_ENABLED === "true") {
    const browserServer = verifiedBrowserCommand ?? await resolveRudderBrowserMcpCliCommand(moduleDir);
    servers.push(renderServer(RUDDER_BROWSER_MCP_SERVER_NAME, browserServer, {
      ...(browserServer.env ?? {}),
      ...managedEnv,
    }));
  }
  if (managedEnv.RUDDER_COMPUTER_ENABLED === "true") {
    const computerServer = verifiedComputerCommand ?? await resolveRudderComputerMcpCliCommand(moduleDir);
    servers.push(renderServer(RUDDER_COMPUTER_MCP_SERVER_NAME, computerServer, {
      ...(computerServer.env ?? {}),
      ...managedEnv,
    }));
  }
  return servers.join("\n\n");
}

export function renderManagedExternalMcpCodexConfig(
  runtimeConfig: unknown,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  onFailure?: (serverName: string | null, error: Error) => void,
): string {
  return resolveManagedExternalMcpBindings(runtimeConfig, env, { onFailure })
    .map((binding) => [
      `[mcp_servers.${binding.serverName}]`,
      `url = ${JSON.stringify(binding.proxyUrl)}`,
      `bearer_token_env_var = ${JSON.stringify(binding.bearerTokenEnvVar)}`,
      // External MCP is a degradable capability. Codex must remain runnable
      // when a provider or proxy is unavailable, even for operator-attention
      // bindings persisted with required=true.
      "required = false",
      `startup_timeout_sec = ${Math.min(binding.startupTimeoutMs, 3_000) / 1_000}`,
      `tool_timeout_sec = ${binding.toolTimeoutMs / 1_000}`,
      `enabled_tools = ${JSON.stringify(binding.toolPolicy.allowedToolNames)}`,
    ].join("\n"))
    .join("\n\n");
}

function sanitizeCodexConfigToml(content: string): {
  content: string;
  removedManagedTables: number;
  removedNotifyHooks: number;
  removedUnsupportedServiceTiers: number;
} {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let blockLines: string[] | null = null;
  let blockShouldBeRemoved = false;
  let removedManagedTables = 0;
  let removedNotifyHooks = 0;
  let removedUnsupportedServiceTiers = 0;

  const flushBlock = () => {
    if (!blockLines) return;
    if (blockShouldBeRemoved) {
      removedManagedTables += 1;
    } else {
      output.push(...blockLines);
    }
    blockLines = null;
    blockShouldBeRemoved = false;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (isTomlTableBoundary(trimmedLine)) {
      flushBlock();
      blockLines = [line];
      blockShouldBeRemoved = isManagedCodexConfigTableToStrip(trimmedLine);
      continue;
    }

    if (!blockLines) {
      if (/^\s*notify\s*=/.test(trimmedLine)) {
        removedNotifyHooks += 1;
        continue;
      }
      if (unsupportedCodexServiceTierLine(trimmedLine)) {
        removedUnsupportedServiceTiers += 1;
        continue;
      }
      output.push(line);
      continue;
    }

    blockLines.push(line);
  }

  flushBlock();
  return {
    content: output.join(newline),
    removedManagedTables,
    removedNotifyHooks,
    removedUnsupportedServiceTiers,
  };
}

function normalizeCodexSkillSourceDir(source: string): string {
  const resolved = path.resolve(source);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
}

async function syncManagedCodexConfigToml(
  target: string,
  source: string,
  onLog: AgentRuntimeExecutionContext["onLog"],
  isolationSurface: CodexSkillIsolationSurface = { disabledSkillPaths: [] },
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  mcpEnv: RudderMcpManagedEnv = {},
  verifiedMcpCommand?: RudderMcpCliCommand,
  verifiedBrowserMcpCommand?: RudderMcpCliCommand,
  runtimeConfig: unknown = {},
  includeCoreMcp = true,
  verifiedComputerMcpCommand?: RudderMcpCliCommand,
): Promise<void> {
  const existingTarget = await fs.lstat(target).catch(() => null);
  const existingTargetContent = existingTarget ? await fs.readFile(target, "utf8") : null;
  const sourceExists = await pathExists(source);
  // The managed home is rebuilt from the authorized provider profile. Runtime
  // state remains in the managed home, while this config snapshot refreshes
  // profile changes without sharing the operator's writable home.
  const rawContent = sourceExists ? await fs.readFile(source, "utf8") : "";
  const withoutLegacyMarkers = rawContent
    .split(/\r?\n/)
    .filter((line) => !LEGACY_RUDDER_MANAGED_SKILLS_MARKERS.has(line.trim()))
    .join(rawContent.includes("\r\n") ? "\r\n" : "\n");
  const sanitized = sanitizeCodexConfigToml(withoutLegacyMarkers);
  const isolationDefaults = ensureCodexIsolationDefaults(sanitized.content);
  const baseContent = isolationDefaults.content.replace(/\s+$/u, "");
  const disabledSkillConfigEntries = renderDisabledCodexSkillConfigEntries(
    isolationSurface.disabledSkillPaths,
    isolationSurface.preservedSkillPaths,
  );
  const mergedContent = [
    baseContent,
    await renderRudderMcpCodexConfig(
      moduleDir,
      mcpEnv,
      verifiedMcpCommand,
      verifiedBrowserMcpCommand,
      verifiedComputerMcpCommand,
      includeCoreMcp,
    ),
    renderManagedExternalMcpCodexConfig(runtimeConfig, mcpEnv, (serverName, error) => {
      void onLog(
        "stderr",
        `[rudder] Managed MCP ${serverName ? `server "${serverName}"` : "configuration"} was omitted: ${error.message}\n`,
      ).catch(() => undefined);
    }),
    disabledSkillConfigEntries,
  ].filter((part) => part.length > 0).join("\n\n");
  const nextContent = mergedContent.length > 0 ? `${mergedContent}\n` : "";

  if (existingTargetContent === null || nextContent !== existingTargetContent) {
    await ensureParentDir(target);
    await fs.writeFile(target, nextContent, "utf8");
  }

  if (sanitized.removedManagedTables > 0) {
    await onLog(
      "stdout",
      `[rudder] Removed ${sanitized.removedManagedTables} inherited Codex MCP configuration tabl${sanitized.removedManagedTables === 1 ? "e" : "es"} from ${target}; provider-native plugin tables were retained.\n`,
    );
  }

  if (sanitized.removedNotifyHooks > 0) {
    await onLog(
      "stdout",
      `[rudder] Removed ${sanitized.removedNotifyHooks} inherited Codex notify hook${sanitized.removedNotifyHooks === 1 ? "" : "s"} from ${target}\n`,
    );
  }

  if (sanitized.removedUnsupportedServiceTiers > 0) {
    await onLog(
      "stdout",
      `[rudder] Removed ${sanitized.removedUnsupportedServiceTiers} unsupported inherited Codex service_tier entr${sanitized.removedUnsupportedServiceTiers === 1 ? "y" : "ies"} from ${target}\n`,
    );
  }

  if (isolationDefaults.addedFeatures) {
    await onLog(
      "stdout",
      `[rudder] Added a disabled Codex plugins default to ${target}; explicit provider-native plugin settings remain profile-controlled.\n`,
    );
  }

  if (isolationDefaults.addedBundledSkills) {
    await onLog(
      "stdout",
      `[rudder] Added a disabled Codex bundled-skills default to ${target}; explicit provider-native skill settings remain profile-controlled.\n`,
    );
  }

  if (isolationSurface.disabledSkillPaths.length > 0) {
    await onLog(
      "stdout",
      `[rudder] Disabled ${isolationSurface.disabledSkillPaths.length} external Codex skill path${isolationSurface.disabledSkillPaths.length === 1 ? "" : "s"} in ${target} to keep runtime skills controlled by Rudder.\n`,
    );
  }
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId?: string,
  agentId?: string,
  isolationSurface: CodexSkillIsolationSurface = { disabledSkillPaths: [] },
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  mcpEnv: RudderMcpManagedEnv = {},
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, orgId, agentId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await withCodexHomeMutationLock(targetHome, async () => {
    await fs.mkdir(targetHome, { recursive: true });

    for (const name of MIRRORED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      await mirrorSharedAuthSnapshot(path.join(targetHome, name), source, onLog);
    }

    for (const name of COPIED_SHARED_FILES) {
      const source = path.join(sourceHome, name);
      if (name === "config.toml") {
        // Rebuild even when the operator removed config.toml so an old
        // provider configuration cannot survive in the managed snapshot.
        await syncManagedCodexConfigToml(path.join(targetHome, name), source, onLog, isolationSurface, moduleDir, mcpEnv);
        continue;
      }
      if (!(await pathExists(source))) continue;
      await ensureCopiedFile(path.join(targetHome, name), source);
    }
  });

  await onLog(
    "stdout",
    `[rudder] Using ${isWorktreeMode(env) ? "worktree-isolated" : "Rudder-managed"} Codex home "${targetHome}" (seeded from "${sourceHome}").\n`,
  );
  return targetHome;
}

async function ensureManagedCodexSkillLink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) {
    const linkedPath = await fs.readlink(target).catch(() => null);
    if (linkedPath) {
      const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
      if (resolvedLinkedPath === source) return;
    }
  }

  if (existing) {
    await fs.rm(target, { recursive: true, force: true });
  }

  await ensureParentDir(target);
  await createRudderSkillDirectoryLink(source, target);
}

async function syncManagedCodexSkillsHome(
  codexHome: string,
  skillSources: string[],
  onLog: AgentRuntimeExecutionContext["onLog"],
  managedSkillSources: string[] = skillSources,
): Promise<void> {
  const skillsHome = path.join(codexHome, "skills");
  const desiredSkillSources = Array.from(
    new Set(
      skillSources
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => normalizeCodexSkillSourceDir(value)),
    ),
  ).sort((left, right) => left.localeCompare(right));
  const desiredByRuntimeName = new Map(
    desiredSkillSources.map((sourceDir) => [path.basename(sourceDir), sourceDir]),
  );
  const managedSourcePaths = new Set(
    managedSkillSources.map((source) => normalizeCodexSkillSourceDir(source)),
  );

  await fs.mkdir(skillsHome, { recursive: true });

  const existingEntries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const installed = await readInstalledSkillTargets(skillsHome);
  let prunedEntries = 0;
  for (const entry of existingEntries) {
    if (desiredByRuntimeName.has(entry.name)) continue;
    const installedEntry = installed.get(entry.name);
    if (installedEntry?.kind !== "symlink" || !installedEntry.targetPath || !managedSourcePaths.has(path.resolve(installedEntry.targetPath))) {
      continue;
    }
    await fs.rm(path.join(skillsHome, entry.name), { recursive: true, force: true });
    prunedEntries += 1;
  }

  for (const [runtimeName, sourceDir] of desiredByRuntimeName.entries()) {
    await ensureManagedCodexSkillLink(path.join(skillsHome, runtimeName), sourceDir);
  }

  if (prunedEntries > 0) {
    await onLog(
      "stdout",
      `[rudder] Pruned ${prunedEntries} stale managed Codex skill entr${prunedEntries === 1 ? "y" : "ies"} from ${skillsHome}\n`,
    );
  }

  await onLog(
    "stdout",
    `[rudder] Realized ${desiredByRuntimeName.size} Rudder-managed Codex skill entr${desiredByRuntimeName.size === 1 ? "y" : "ies"} in ${skillsHome}\n`,
  );
}

export async function realizeManagedCodexSkillEntries(
  env: NodeJS.ProcessEnv,
  codexHome: string,
  skillSources: string[],
  onLog: AgentRuntimeExecutionContext["onLog"],
  isolationSurface: CodexSkillIsolationSurface = { disabledSkillPaths: [] },
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
  mcpEnv: RudderMcpManagedEnv = {},
  verifiedMcpCommand?: RudderMcpCliCommand,
  verifiedBrowserMcpCommand?: RudderMcpCliCommand,
  runtimeConfig: unknown = {},
  includeCoreMcp = true,
  verifiedComputerMcpCommand?: RudderMcpCliCommand,
  managedSkillSources: string[] = skillSources,
): Promise<void> {
  await withCodexHomeMutationLock(codexHome, async () => {
    const sourceHome = resolveSharedCodexHomeDir(env);
    const sourceConfig = path.join(sourceHome, "config.toml");
    const targetConfig = path.join(codexHome, "config.toml");
    await syncManagedCodexConfigToml(
      targetConfig,
      sourceConfig,
      onLog,
      isolationSurface,
      moduleDir,
      mcpEnv,
      verifiedMcpCommand,
      verifiedBrowserMcpCommand,
      runtimeConfig,
      includeCoreMcp,
      verifiedComputerMcpCommand,
    );
    await syncManagedCodexSkillsHome(codexHome, skillSources, onLog, managedSkillSources);
  });
}
