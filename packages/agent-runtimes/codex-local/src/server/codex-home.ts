import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntimeExecutionContext } from "@rudder/agent-runtime-utils";

const TRUTHY_ENV_RE = /^(1|true|yes|on)$/i;
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
const DEFAULT_RUDDER_INSTANCE_ID = "default";
const LEGACY_RUDDER_MANAGED_SKILLS_MARKERS = new Set([
  "# rudder-managed-skills:start",
  "# rudder-managed-skills:end",
]);
const MANAGED_CODEX_HOME_PRUNE_TARGETS = [
  "plugins",
  path.join(".tmp", "plugins"),
  path.join(".tmp", "plugins.sha"),
  path.join(".tmp", "app-server-remote-plugin-sync-v1"),
] as const;

function nonEmpty(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export function resolveSharedCodexHomeDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromEnv = nonEmpty(env.CODEX_HOME);
  return fromEnv ? path.resolve(fromEnv) : path.join(os.homedir(), ".codex");
}

function isWorktreeMode(env: NodeJS.ProcessEnv): boolean {
  return TRUTHY_ENV_RE.test(env.RUDDER_IN_WORKTREE ?? "");
}

export function resolveManagedCodexHomeDir(
  env: NodeJS.ProcessEnv,
  orgId?: string,
): string {
  const rudderHome = nonEmpty(env.RUDDER_HOME) ?? path.resolve(os.homedir(), ".rudder");
  const instanceId = nonEmpty(env.RUDDER_INSTANCE_ID) ?? DEFAULT_RUDDER_INSTANCE_ID;
  return orgId
    ? path.resolve(rudderHome, "instances", instanceId, "organizations", orgId, "codex-home")
    : path.resolve(rudderHome, "instances", instanceId, "codex-home");
}

async function ensureParentDir(target: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await ensureParentDir(target);
    await fs.symlink(source, target);
    return;
  }

  if (!existing.isSymbolicLink()) {
    return;
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return;

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) return;

  await fs.unlink(target);
  await fs.symlink(source, target);
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
  if (/^\[plugins\..+\]$/.test(trimmedLine)) return true;
  return false;
}

function sanitizeCodexConfigToml(content: string): {
  content: string;
  removedSkillEntries: number;
  removedManagedTables: number;
} {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let blockLines: string[] | null = null;
  let blockIsSkillsConfig = false;
  let blockShouldBeRemoved = false;
  let removedSkillEntries = 0;
  let removedManagedTables = 0;

  const flushBlock = () => {
    if (!blockLines) return;
    if (blockShouldBeRemoved) {
      removedManagedTables += 1;
    } else if (blockIsSkillsConfig) {
      removedSkillEntries += 1;
    } else {
      output.push(...blockLines);
    }
    blockLines = null;
    blockIsSkillsConfig = false;
    blockShouldBeRemoved = false;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (isTomlTableBoundary(trimmedLine)) {
      flushBlock();
      blockLines = [line];
      blockIsSkillsConfig = trimmedLine === "[[skills.config]]";
      blockShouldBeRemoved = isManagedCodexConfigTableToStrip(trimmedLine);
      continue;
    }

    if (!blockLines) {
      output.push(line);
      continue;
    }

    blockLines.push(line);
  }

  flushBlock();
  return {
    content: output.join(newline),
    removedSkillEntries,
    removedManagedTables,
  };
}

function normalizeCodexFeaturesBlock(blockLines: string[]): {
  lines: string[];
  changed: boolean;
} {
  const output: string[] = [];
  let sawPlugins = false;
  let changed = false;

  for (const [index, line] of blockLines.entries()) {
    if (index === 0) {
      output.push(line);
      continue;
    }
    if (/^\s*plugins\s*=/.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      output.push(`${indent}plugins = false`);
      sawPlugins = true;
      if (line.trim() !== "plugins = false") {
        changed = true;
      }
      continue;
    }
    output.push(line);
  }

  if (!sawPlugins) {
    const trailingBlankLines: string[] = [];
    while (output.length > 1 && output.at(-1)?.trim() === "") {
      trailingBlankLines.unshift(output.pop() ?? "");
    }
    output.push("plugins = false");
    output.push(...trailingBlankLines);
    changed = true;
  }

  return { lines: output, changed };
}

function normalizeCodexBundledSkillsBlock(blockLines: string[]): {
  lines: string[];
  changed: boolean;
} {
  const output: string[] = [];
  let sawEnabled = false;
  let changed = false;

  for (const [index, line] of blockLines.entries()) {
    if (index === 0) {
      output.push(line);
      continue;
    }
    if (/^\s*enabled\s*=/.test(line)) {
      const indent = line.match(/^(\s*)/)?.[1] ?? "";
      output.push(`${indent}enabled = false`);
      sawEnabled = true;
      if (line.trim() !== "enabled = false") {
        changed = true;
      }
      continue;
    }
    output.push(line);
  }

  if (!sawEnabled) {
    const trailingBlankLines: string[] = [];
    while (output.length > 1 && output.at(-1)?.trim() === "") {
      trailingBlankLines.unshift(output.pop() ?? "");
    }
    output.push("enabled = false");
    output.push(...trailingBlankLines);
    changed = true;
  }

  return { lines: output, changed };
}

function normalizeCodexSkillSourceDir(source: string): string {
  const resolved = path.resolve(source);
  if (path.basename(resolved).toLowerCase() === "skill.md") {
    return path.dirname(resolved);
  }
  return resolved;
}

function ensureCodexPluginsDisabled(content: string): {
  content: string;
  changed: boolean;
} {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let blockLines: string[] | null = null;
  let blockIsFeatures = false;
  let sawFeatures = false;
  let changed = false;

  const flushBlock = () => {
    if (!blockLines) return;
    if (blockIsFeatures) {
      const normalized = normalizeCodexFeaturesBlock(blockLines);
      output.push(...normalized.lines);
      if (normalized.changed) changed = true;
    } else {
      output.push(...blockLines);
    }
    blockLines = null;
    blockIsFeatures = false;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (isTomlTableBoundary(trimmedLine)) {
      flushBlock();
      blockLines = [line];
      blockIsFeatures = trimmedLine === "[features]";
      if (blockIsFeatures) sawFeatures = true;
      continue;
    }

    if (!blockLines) {
      output.push(line);
      continue;
    }

    blockLines.push(line);
  }

  flushBlock();

  if (!sawFeatures) {
    const base = output.join(newline).replace(/\s+$/u, "");
    const next = base.length > 0
      ? `${base}${newline}${newline}[features]${newline}plugins = false${newline}`
      : `[features]${newline}plugins = false${newline}`;
    return {
      content: next,
      changed: true,
    };
  }

  return {
    content: output.join(newline),
    changed,
  };
}

function ensureCodexBundledSkillsDisabled(content: string): {
  content: string;
  changed: boolean;
} {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  let blockLines: string[] | null = null;
  let blockIsBundledSkills = false;
  let sawBundledSkills = false;
  let changed = false;

  const flushBlock = () => {
    if (!blockLines) return;
    if (blockIsBundledSkills) {
      const normalized = normalizeCodexBundledSkillsBlock(blockLines);
      output.push(...normalized.lines);
      if (normalized.changed) changed = true;
    } else {
      output.push(...blockLines);
    }
    blockLines = null;
    blockIsBundledSkills = false;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    if (isTomlTableBoundary(trimmedLine)) {
      flushBlock();
      blockLines = [line];
      blockIsBundledSkills = trimmedLine === "[skills.bundled]";
      if (blockIsBundledSkills) sawBundledSkills = true;
      continue;
    }

    if (!blockLines) {
      output.push(line);
      continue;
    }

    blockLines.push(line);
  }

  flushBlock();

  if (!sawBundledSkills) {
    const base = output.join(newline).replace(/\s+$/u, "");
    const next = base.length > 0
      ? `${base}${newline}${newline}[skills.bundled]${newline}enabled = false${newline}`
      : `[skills.bundled]${newline}enabled = false${newline}`;
    return {
      content: next,
      changed: true,
    };
  }

  return {
    content: output.join(newline),
    changed,
  };
}

async function syncManagedCodexConfigToml(
  target: string,
  source: string,
  onLog: AgentRuntimeExecutionContext["onLog"],
): Promise<void> {
  const existingTarget = await fs.lstat(target).catch(() => null);
  const sourceContent = await fs.readFile(source, "utf8").catch(() => "");
  const rawContent = existingTarget ? await fs.readFile(target, "utf8") : sourceContent;
  const withoutLegacyMarkers = rawContent
    .split(/\r?\n/)
    .filter((line) => !LEGACY_RUDDER_MANAGED_SKILLS_MARKERS.has(line.trim()))
    .join(rawContent.includes("\r\n") ? "\r\n" : "\n");
  const sanitized = sanitizeCodexConfigToml(withoutLegacyMarkers);
  const bundledSkillsDisabled = ensureCodexBundledSkillsDisabled(sanitized.content);
  const pluginsDisabled = ensureCodexPluginsDisabled(bundledSkillsDisabled.content);
  const nextContent = pluginsDisabled.content.replace(/\s+$/u, "").length > 0
    ? `${pluginsDisabled.content.replace(/\s+$/u, "")}\n`
    : "";

  if (!existingTarget || nextContent !== rawContent) {
    await ensureParentDir(target);
    await fs.writeFile(target, nextContent, "utf8");
  }

  if (sanitized.removedSkillEntries > 0) {
    await onLog(
      "stdout",
      `[rudder] Removed ${sanitized.removedSkillEntries} inherited Codex [[skills.config]] entr${sanitized.removedSkillEntries === 1 ? "y" : "ies"} from ${target}\n`,
    );
  }

  if (sanitized.removedManagedTables > 0) {
    await onLog(
      "stdout",
      `[rudder] Removed ${sanitized.removedManagedTables} inherited Codex plugin/MCP configuration tabl${sanitized.removedManagedTables === 1 ? "e" : "es"} from ${target}\n`,
    );
  }

  if (pluginsDisabled.changed) {
    await onLog(
      "stdout",
      `[rudder] Forced Codex plugins feature off in ${target} to prevent adapter plugin leakage.\n`,
    );
  }

  if (bundledSkillsDisabled.changed) {
    await onLog(
      "stdout",
      `[rudder] Forced Codex bundled skills off in ${target} to prevent platform default system skills from loading.\n`,
    );
  }
}

async function pruneManagedCodexPluginSurface(
  codexHome: string,
  onLog: AgentRuntimeExecutionContext["onLog"],
): Promise<void> {
  let removedEntries = 0;

  for (const relativeTarget of MANAGED_CODEX_HOME_PRUNE_TARGETS) {
    const absoluteTarget = path.join(codexHome, relativeTarget);
    if (!(await pathExists(absoluteTarget))) continue;
    await fs.rm(absoluteTarget, { recursive: true, force: true });
    removedEntries += 1;
  }

  const tmpDir = path.join(codexHome, ".tmp");
  const tmpEntries = await fs.readdir(tmpDir, { withFileTypes: true }).catch(() => []);
  for (const entry of tmpEntries) {
    if (!entry.name.startsWith("plugins-clone-")) continue;
    await fs.rm(path.join(tmpDir, entry.name), { recursive: true, force: true });
    removedEntries += 1;
  }

  if (removedEntries > 0) {
    await onLog(
      "stdout",
      `[rudder] Pruned ${removedEntries} inherited Codex plugin cache entr${removedEntries === 1 ? "y" : "ies"} from ${codexHome}\n`,
    );
  }
}

export async function prepareManagedCodexHome(
  env: NodeJS.ProcessEnv,
  onLog: AgentRuntimeExecutionContext["onLog"],
  orgId?: string,
): Promise<string> {
  const targetHome = resolveManagedCodexHomeDir(env, orgId);

  const sourceHome = resolveSharedCodexHomeDir(env);
  if (path.resolve(sourceHome) === path.resolve(targetHome)) return targetHome;

  await fs.mkdir(targetHome, { recursive: true });
  await pruneManagedCodexPluginSurface(targetHome, onLog);

  for (const name of SYMLINKED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    await ensureSymlink(path.join(targetHome, name), source);
  }

  for (const name of COPIED_SHARED_FILES) {
    const source = path.join(sourceHome, name);
    if (!(await pathExists(source))) continue;
    if (name === "config.toml") {
      await syncManagedCodexConfigToml(path.join(targetHome, name), source, onLog);
      continue;
    }
    await ensureCopiedFile(path.join(targetHome, name), source);
  }

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
  await fs.symlink(source, target);
}

async function syncManagedCodexSkillsHome(
  codexHome: string,
  skillSources: string[],
  onLog: AgentRuntimeExecutionContext["onLog"],
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

  await fs.mkdir(skillsHome, { recursive: true });

  const existingEntries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  let prunedEntries = 0;
  for (const entry of existingEntries) {
    if (desiredByRuntimeName.has(entry.name)) continue;
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
): Promise<void> {
  const sourceHome = resolveSharedCodexHomeDir(env);
  const sourceConfig = path.join(sourceHome, "config.toml");
  const targetConfig = path.join(codexHome, "config.toml");
  await syncManagedCodexConfigToml(targetConfig, sourceConfig, onLog);
  await syncManagedCodexSkillsHome(codexHome, skillSources, onLog);
}
