/**
 * @fileoverview Agent instruction bundle service for managed and external
 * instruction roots, entry files, legacy prompt migration, and file editing.
 *
 * @see doc/product/domains/agents/instruction-loading.md - AGENT.INSTRUCTIONS.001 ordering and ownership
 * @see doc/product/domains/agents/identity-config.md - durable agent runtime configuration
 * @see doc/engineering/DEVELOPING.md - contributor expectations for local runtime work
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import {
  ensureAgentWorkspaceLayout,
  resolveAgentInstructionsDir,
  resolveHomeAwarePath,
} from "../home-paths.js";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "./default-agent-instructions.js";

const ENTRY_FILE_DEFAULT = "SOUL.md";
const MEMORY_FILE_NAME = "MEMORY.md";
const MODE_KEY = "instructionsBundleMode";
const ROOT_KEY = "instructionsRootPath";
const ENTRY_KEY = "instructionsEntryFile";
const FILE_KEY = "instructionsFilePath";
const PROMPT_KEY = "promptTemplate";
const BOOTSTRAP_PROMPT_KEY = "bootstrapPromptTemplate";
const LEGACY_PROMPT_TEMPLATE_PATH = "promptTemplate.legacy.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

type BundleMode = "managed" | "external";

type AgentLike = {
  id: string;
  orgId: string;
  name?: string | null;
  role?: string | null;
  workspaceKey?: string | null;
  agentRuntimeConfig: unknown;
};

type AgentInstructionsFileSummary = {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
};

type AgentInstructionsFileDetail = AgentInstructionsFileSummary & {
  content: string;
  editable: boolean;
};

type AgentInstructionsBundle = {
  agentId: string;
  orgId: string;
  mode: BundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
};

type ReconciledBundleResult = {
  bundle: AgentInstructionsBundle;
  agentRuntimeConfig: Record<string, unknown>;
  changed: boolean;
};

type BundleState = {
  config: Record<string, unknown>;
  mode: BundleMode | null;
  rootPath: string | null;
  entryFile: string;
  resolvedEntryPath: string | null;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundleMode(value: unknown): value is BundleMode {
  return value === "managed" || value === "external";
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

function resolveManagedInstructionsRoot(agent: AgentLike): string {
  return resolveAgentInstructionsDir(agent.orgId, agent);
}

function resolveLegacyInstructionsPath(candidatePath: string, config: Record<string, unknown>): string {
  if (path.isAbsolute(candidatePath)) return candidatePath;
  const cwd = asString(config.cwd);
  if (!cwd || !path.isAbsolute(cwd)) {
    throw unprocessable(
      "Legacy relative instructionsFilePath requires agentRuntimeConfig.cwd to be set to an absolute path",
    );
  }
  return path.resolve(cwd, candidatePath);
}

function isPathWithinRoot(rootPath: string, candidatePath: string) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === ""
    || (relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

export function isCanonicalManagedAgentInstructionsConfig(
  agent: AgentLike,
  candidateConfig: unknown = agent.agentRuntimeConfig,
) {
  const config = asRecord(candidateConfig);
  if (
    config[MODE_KEY] !== undefined
    && config[MODE_KEY] !== "managed"
  ) {
    return false;
  }

  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const configuredRootPath = asString(config[ROOT_KEY]);
  if (configuredRootPath) {
    if (
      !path.isAbsolute(configuredRootPath)
      && configuredRootPath !== "~"
      && !configuredRootPath.startsWith("~/")
    ) {
      return false;
    }
    if (path.resolve(resolveHomeAwarePath(configuredRootPath)) !== path.resolve(managedRootPath)) {
      return false;
    }
  }

  for (const key of [FILE_KEY, "agentsMdPath"]) {
    const configuredPath = asString(config[key]);
    if (!configuredPath) continue;
    let resolvedPath: string;
    try {
      resolvedPath = resolveLegacyInstructionsPath(configuredPath, config);
    } catch {
      return false;
    }
    if (!isPathWithinRoot(managedRootPath, resolvedPath)) return false;
  }

  return true;
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

async function lstatIfExists(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function symlinkBoundaryError() {
  return unprocessable(
    "Instructions file path must stay within the bundle root and cannot traverse symbolic links",
  );
}

async function assertSafeBundleRoot(rootPath: string): Promise<string> {
  const absoluteRoot = path.resolve(rootPath);
  const rootStat = await lstatIfExists(absoluteRoot);
  if (!rootStat) throw notFound("Agent instructions bundle is not configured");
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw symlinkBoundaryError();
  }
  return absoluteRoot;
}

async function inspectExistingPathWithinRoot(rootPath: string, relativePath: string) {
  const normalizedPath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = await assertSafeBundleRoot(rootPath);
  const pathSegments = normalizedPath.split("/");
  let currentPath = absoluteRoot;
  let targetStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;

  for (let index = 0; index < pathSegments.length; index += 1) {
    currentPath = path.join(currentPath, pathSegments[index]!);
    const currentStat = await lstatIfExists(currentPath);
    if (!currentStat) return null;
    if (currentStat.isSymbolicLink()) throw symlinkBoundaryError();
    if (index < pathSegments.length - 1 && !currentStat.isDirectory()) {
      throw unprocessable("Instructions file path has a non-directory parent");
    }
    targetStat = currentStat;
  }

  return {
    absolutePath: resolvePathWithinRoot(absoluteRoot, normalizedPath),
    normalizedPath,
    stat: targetStat!,
  };
}

async function prepareWritablePathWithinRoot(rootPath: string, relativePath: string) {
  const normalizedPath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = await assertSafeBundleRoot(rootPath);
  const pathSegments = normalizedPath.split("/");
  let currentPath = absoluteRoot;

  for (const segment of pathSegments.slice(0, -1)) {
    currentPath = path.join(currentPath, segment);
    let currentStat = await lstatIfExists(currentPath);
    if (!currentStat) {
      try {
        await fs.mkdir(currentPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      currentStat = await lstatIfExists(currentPath);
    }
    if (!currentStat?.isDirectory() || currentStat.isSymbolicLink()) {
      throw symlinkBoundaryError();
    }
  }

  const absolutePath = resolvePathWithinRoot(absoluteRoot, normalizedPath);
  const targetStat = await lstatIfExists(absolutePath);
  if (targetStat?.isSymbolicLink()) throw symlinkBoundaryError();
  return { absolutePath, normalizedPath };
}

async function readUtf8FileWithinRoot(rootPath: string, relativePath: string) {
  const inspected = await inspectExistingPathWithinRoot(rootPath, relativePath);
  if (!inspected) return null;

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      inspected.absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw symlinkBoundaryError();
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    const content = await handle.readFile({ encoding: "utf8" });
    return { ...inspected, content, stat };
  } finally {
    await handle.close();
  }
}

async function writeUtf8FileWithinRoot(
  rootPath: string,
  relativePath: string,
  content: string,
) {
  const prepared = await prepareWritablePathWithinRoot(rootPath, relativePath);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(
      prepared.absolutePath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_TRUNC
        | (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw symlinkBoundaryError();
    throw err;
  }
  try {
    await handle.writeFile(content, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  return prepared;
}

async function copyLegacyRootMemoryIntoManagedInstructions(agent: AgentLike): Promise<boolean> {
  const layout = await ensureAgentWorkspaceLayout(agent);
  const sourcePath = path.join(layout.root, MEMORY_FILE_NAME);
  const targetPath = path.join(layout.instructionsDir, MEMORY_FILE_NAME);
  const targetStat = await lstatIfExists(targetPath);
  if (targetStat?.isFile()) return false;
  if (targetStat?.isSymbolicLink()) throw symlinkBoundaryError();
  const sourceStat = await lstatIfExists(sourcePath);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) return false;
  await writeUtf8FileWithinRoot(
    layout.instructionsDir,
    MEMORY_FILE_NAME,
    await fs.readFile(sourcePath, "utf8"),
  );
  return true;
}

function shouldIgnoreInstructionsEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];
  const safeRootPath = await assertSafeBundleRoot(rootPath);

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(safeRootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<AgentInstructionsFileSummary> {
  const inspected = await inspectExistingPathWithinRoot(rootPath, relativePath);
  if (!inspected) throw notFound("Instructions file not found");
  const stat = inspected.stat;
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
  };
}

async function readLegacyInstructions(agent: AgentLike, config: Record<string, unknown>): Promise<string> {
  const instructionsFilePath = asString(config[FILE_KEY]);
  if (instructionsFilePath) {
    try {
      const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, config);
      return await fs.readFile(resolvedPath, "utf8");
    } catch {
      // Fall back to promptTemplate below.
    }
  }
  return asString(config[PROMPT_KEY]) ?? "";
}

async function defaultManagedBundleFiles(agent: AgentLike): Promise<Record<string, string>> {
  return loadDefaultAgentInstructionsBundle(
    resolveDefaultAgentInstructionsBundleRole(agent.role ?? "default"),
  );
}

async function managedEntryRecoveryFiles(
  agent: AgentLike,
  state: BundleState,
): Promise<Record<string, string>> {
  const legacyInstructions = await readLegacyInstructions(agent, state.config);
  if (legacyInstructions.trim().length > 0) {
    return { [state.entryFile || ENTRY_FILE_DEFAULT]: legacyInstructions };
  }
  const defaultFiles = await defaultManagedBundleFiles(agent);
  if (state.entryFile === ENTRY_FILE_DEFAULT || defaultFiles[state.entryFile]) {
    return defaultFiles;
  }
  return {
    ...defaultFiles,
    [state.entryFile]: defaultFiles[ENTRY_FILE_DEFAULT] ?? "",
  };
}

function deriveBundleState(agent: AgentLike): BundleState {
  const config = asRecord(agent.agentRuntimeConfig);
  const warnings: string[] = [];
  const storedModeRaw = config[MODE_KEY];
  const storedRootRaw = asString(config[ROOT_KEY]);
  const legacyInstructionsPath = asString(config[FILE_KEY]);

  let mode: BundleMode | null = isBundleMode(storedModeRaw) ? storedModeRaw : null;
  let rootPath = storedRootRaw ? resolveHomeAwarePath(storedRootRaw) : null;
  let entryFile = ENTRY_FILE_DEFAULT;

  const storedEntryRaw = asString(config[ENTRY_KEY]);
  if (storedEntryRaw) {
    try {
      entryFile = normalizeRelativeFilePath(storedEntryRaw);
    } catch {
      warnings.push(`Ignored invalid instructions entry file "${storedEntryRaw}".`);
    }
  }

  if (!rootPath && legacyInstructionsPath) {
    try {
      const resolvedLegacyPath = resolveLegacyInstructionsPath(legacyInstructionsPath, config);
      rootPath = path.dirname(resolvedLegacyPath);
      entryFile = path.basename(resolvedLegacyPath);
      mode = resolvedLegacyPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
        || resolvedLegacyPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
        ? "managed"
        : "external";
      if (!path.isAbsolute(legacyInstructionsPath)) {
        warnings.push("Using legacy relative instructionsFilePath; migrate this agent to a managed or absolute external bundle.");
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedEntryPath = rootPath ? path.resolve(rootPath, entryFile) : null;

  return {
    config,
    mode,
    rootPath,
    entryFile,
    resolvedEntryPath,
    warnings,
    legacyPromptTemplateActive: Boolean(asString(config[PROMPT_KEY])),
    legacyBootstrapPromptTemplateActive: Boolean(asString(config[BOOTSTRAP_PROMPT_KEY])),
  };
}

async function recoverManagedBundleState(
  agent: AgentLike,
  state: BundleState,
  options?: { materializeMissingManagedEntry?: boolean },
): Promise<BundleState> {
  await ensureAgentWorkspaceLayout(agent);
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const stat = await statIfExists(managedRootPath);
  if (!stat?.isDirectory()) return state;

  let files = await listFilesRecursive(managedRootPath);
  const configuredManagedRoot =
    state.mode === "managed"
    && state.rootPath
    && path.resolve(state.rootPath) === managedRootPath;
  if (
    files.length === 0
    && configuredManagedRoot
    && options?.materializeMissingManagedEntry
  ) {
    await writeBundleFiles(managedRootPath, await managedEntryRecoveryFiles(agent, state));
    await copyLegacyRootMemoryIntoManagedInstructions(agent);
    files = await listFilesRecursive(managedRootPath);
  }
  if (
    configuredManagedRoot
    && files.length > 0
    && !files.includes(state.entryFile)
    && options?.materializeMissingManagedEntry
  ) {
    await writeBundleFiles(managedRootPath, await managedEntryRecoveryFiles(agent, state));
    files = await listFilesRecursive(managedRootPath);
  }
  if (files.length === 0) return state;
  if (options?.materializeMissingManagedEntry && await copyLegacyRootMemoryIntoManagedInstructions(agent)) {
    files = await listFilesRecursive(managedRootPath);
  }

  const recoveredEntryFile = files.includes(state.entryFile)
    ? state.entryFile
    : files.includes(ENTRY_FILE_DEFAULT)
      ? ENTRY_FILE_DEFAULT
      : files[0]!;

  if (!state.rootPath) {
    return {
      ...state,
      mode: "managed",
      rootPath: managedRootPath,
      entryFile: recoveredEntryFile,
      resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    };
  }

  if (state.mode === "external") return state;

  const resolvedConfiguredRoot = path.resolve(state.rootPath);
  const configuredRootMatchesManaged = resolvedConfiguredRoot === managedRootPath;
  const hasEntryMismatch = recoveredEntryFile !== state.entryFile;

  if (configuredRootMatchesManaged && !hasEntryMismatch) {
    return state;
  }

  const warnings = [...state.warnings];
  if (!configuredRootMatchesManaged) {
    warnings.push(
      `Recovered managed instructions from disk at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
    );
  }
  if (hasEntryMismatch) {
    warnings.push(
      `Recovered managed instructions entry file from disk as ${recoveredEntryFile}; previous entry ${state.entryFile} was missing.`,
    );
  }

  return {
    ...state,
    mode: "managed",
    rootPath: managedRootPath,
    entryFile: recoveredEntryFile,
    resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    warnings,
  };
}

function toBundle(agent: AgentLike, state: BundleState, files: AgentInstructionsFileSummary[]): AgentInstructionsBundle {
  const nextFiles = [...files];
  if (state.legacyPromptTemplateActive && !nextFiles.some((file) => file.path === LEGACY_PROMPT_TEMPLATE_PATH)) {
    const legacyPromptTemplate = asString(state.config[PROMPT_KEY]) ?? "";
    nextFiles.push({
      path: LEGACY_PROMPT_TEMPLATE_PATH,
      size: legacyPromptTemplate.length,
      language: "markdown",
      markdown: true,
      isEntryFile: false,
      editable: true,
      deprecated: true,
      virtual: true,
    });
  }
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    agentId: agent.id,
    orgId: agent.orgId,
    mode: state.mode,
    rootPath: state.rootPath,
    managedRootPath: resolveManagedInstructionsRoot(agent),
    entryFile: state.entryFile,
    resolvedEntryPath: state.resolvedEntryPath,
    editable: Boolean(state.rootPath),
    warnings: state.warnings,
    legacyPromptTemplateActive: state.legacyPromptTemplateActive,
    legacyBootstrapPromptTemplateActive: state.legacyBootstrapPromptTemplateActive,
    files: nextFiles,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: {
    mode: BundleMode;
    rootPath: string;
    entryFile: string;
    clearLegacyPromptTemplate?: boolean;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    [MODE_KEY]: input.mode,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
    [FILE_KEY]: path.resolve(input.rootPath, input.entryFile),
  };
  if (input.clearLegacyPromptTemplate) {
    delete next[PROMPT_KEY];
    delete next[BOOTSTRAP_PROMPT_KEY];
  }
  return next;
}

function buildPersistedBundleConfig(
  derived: BundleState,
  current: BundleState,
  options?: { clearLegacyPromptTemplate?: boolean },
): Record<string, unknown> {
  const currentRootPath = current.rootPath ? path.resolve(current.rootPath) : null;
  const derivedRootPath = derived.rootPath ? path.resolve(derived.rootPath) : null;
  const configMatchesRecoveredState =
    derived.mode === current.mode
    && derivedRootPath !== null
    && currentRootPath !== null
    && derivedRootPath === currentRootPath
    && derived.entryFile === current.entryFile;

  if (configMatchesRecoveredState && !options?.clearLegacyPromptTemplate) {
    return current.config;
  }

  if (!current.rootPath || !current.mode) {
    return current.config;
  }

  return applyBundleConfig(current.config, {
    mode: current.mode,
    rootPath: current.rootPath,
    entryFile: current.entryFile,
    clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
  });
}

async function writeBundleFiles(
  rootPath: string,
  files: Record<string, string>,
  options?: { overwriteExisting?: boolean },
) {
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const existing = await inspectExistingPathWithinRoot(rootPath, normalizedPath);
    const existingStat = existing?.stat ?? null;
    if (existingStat?.isFile() && !options?.overwriteExisting) continue;
    await writeUtf8FileWithinRoot(rootPath, normalizedPath, content);
  }
}

export function syncInstructionsBundleConfigFromFilePath(
  agent: AgentLike,
  agentRuntimeConfig: Record<string, unknown>,
): Record<string, unknown> {
  const instructionsFilePath = asString(agentRuntimeConfig[FILE_KEY]);
  const next = { ...agentRuntimeConfig };
  if (!instructionsFilePath) {
    delete next[MODE_KEY];
    delete next[ROOT_KEY];
    delete next[ENTRY_KEY];
    return next;
  }
  const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, agentRuntimeConfig);
  const rootPath = path.dirname(resolvedPath);
  const entryFile = path.basename(resolvedPath);
  const mode: BundleMode = resolvedPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
    || resolvedPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
    ? "managed"
    : "external";
  return applyBundleConfig(next, { mode, rootPath, entryFile });
}

export function agentInstructionsService() {
  async function getBundle(agent: AgentLike): Promise<AgentInstructionsBundle> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (!state.rootPath) return toBundle(agent, state, []);
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return toBundle(agent, {
        ...state,
        warnings: [...state.warnings, `Instructions root does not exist: ${state.rootPath}`],
      }, []);
    }
    await assertSafeBundleRoot(state.rootPath);
    const files = await listFilesRecursive(state.rootPath);
    const summaries = await Promise.all(files.map((relativePath) => readFileSummary(state.rootPath!, relativePath, state.entryFile)));
    return toBundle(agent, state, summaries);
  }

  async function reconcileBundle(agent: AgentLike): Promise<ReconciledBundleResult> {
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived, {
      materializeMissingManagedEntry: true,
    });
    if (current.mode === "managed" && !current.rootPath && current.legacyPromptTemplateActive) {
      const prepared = await ensureWritableBundle(agent, { clearLegacyPromptTemplate: true });
      const nextAgent = { ...agent, agentRuntimeConfig: prepared.agentRuntimeConfig };
      return {
        bundle: await getBundle(nextAgent),
        agentRuntimeConfig: prepared.agentRuntimeConfig,
        changed: true,
      };
    }
    const agentRuntimeConfig = buildPersistedBundleConfig(derived, current);
    const changed = agentRuntimeConfig !== derived.config;
    const bundle = await getBundle(changed ? { ...agent, agentRuntimeConfig } : agent);
    return {
      bundle,
      agentRuntimeConfig,
      changed,
    };
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentInstructionsFileDetail> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const content = asString(state.config[PROMPT_KEY]);
      if (content === null) throw notFound("Instructions file not found");
      return {
        path: LEGACY_PROMPT_TEMPLATE_PATH,
        size: content.length,
        language: "markdown",
        markdown: true,
        isEntryFile: false,
        editable: true,
        deprecated: true,
        virtual: true,
        content,
      };
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const file = await readUtf8FileWithinRoot(state.rootPath, relativePath);
    if (!file) throw notFound("Instructions file not found");
    const { content, stat, normalizedPath } = file;
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      markdown: isMarkdown(normalizedPath),
      isEntryFile: normalizedPath === state.entryFile,
      editable: true,
      deprecated: false,
      virtual: false,
      content,
    };
  }

  async function ensureWritableBundle(
    agent: AgentLike,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{ agentRuntimeConfig: Record<string, unknown>; state: BundleState }> {
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived, {
      materializeMissingManagedEntry: true,
    });
    if (current.rootPath && current.mode) {
      const agentRuntimeConfig = buildPersistedBundleConfig(derived, current, options);
      return {
        agentRuntimeConfig,
        state: deriveBundleState({ ...agent, agentRuntimeConfig }),
      };
    }

    const managedRoot = resolveManagedInstructionsRoot(agent);
    const entryFile = current.entryFile || ENTRY_FILE_DEFAULT;
    const nextConfig = applyBundleConfig(current.config, {
      mode: "managed",
      rootPath: managedRoot,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    await ensureAgentWorkspaceLayout(agent);
    await fs.mkdir(managedRoot, { recursive: true });

    const existingEntry = await inspectExistingPathWithinRoot(managedRoot, entryFile);
    const entryStat = existingEntry?.stat ?? null;
    if (!entryStat?.isFile()) {
      const legacyInstructions = await readLegacyInstructions(agent, current.config);
      await writeUtf8FileWithinRoot(
        managedRoot,
        entryFile,
        legacyInstructions.trim().length > 0 ? legacyInstructions : "",
      );
    }

    return {
      agentRuntimeConfig: nextConfig,
      state: deriveBundleState({ ...agent, agentRuntimeConfig: nextConfig }),
    };
  }

  async function updateBundle(
    agent: AgentLike,
    input: {
      mode?: BundleMode;
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; agentRuntimeConfig: Record<string, unknown> }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent), {
      materializeMissingManagedEntry: true,
    });
    const nextMode = input.mode ?? state.mode ?? "managed";
    const nextEntryFile = input.entryFile ? normalizeRelativeFilePath(input.entryFile) : state.entryFile;
    let nextRootPath: string;

    if (nextMode === "managed") {
      nextRootPath = resolveManagedInstructionsRoot(agent);
      await ensureAgentWorkspaceLayout(agent);
    } else {
      const rootPath = asString(input.rootPath) ?? state.rootPath;
      if (!rootPath) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      if (
        !path.isAbsolute(rootPath)
        && rootPath !== "~"
        && !rootPath.startsWith("~/")
      ) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      const resolvedRoot = resolveHomeAwarePath(rootPath);
      nextRootPath = resolvedRoot;
    }

    await fs.mkdir(nextRootPath, { recursive: true });

    const existingFiles = await listFilesRecursive(nextRootPath);
    const exported = await exportFiles(agent);
    if (existingFiles.length === 0) {
      await writeBundleFiles(nextRootPath, exported.files);
    }
    const refreshedFiles = existingFiles.length === 0 ? await listFilesRecursive(nextRootPath) : existingFiles;
    if (!refreshedFiles.includes(nextEntryFile)) {
      const nextEntryContent = exported.files[nextEntryFile] ?? exported.files[exported.entryFile] ?? "";
      await writeBundleFiles(nextRootPath, { [nextEntryFile]: nextEntryContent });
    }

    const nextConfig = applyBundleConfig(state.config, {
      mode: nextMode,
      rootPath: nextRootPath,
      entryFile: nextEntryFile,
      clearLegacyPromptTemplate: input.clearLegacyPromptTemplate,
    });
    const nextBundle = await getBundle({ ...agent, agentRuntimeConfig: nextConfig });
    return { bundle: nextBundle, agentRuntimeConfig: nextConfig };
  }

  async function writeFile(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{
    bundle: AgentInstructionsBundle;
    file: AgentInstructionsFileDetail;
    agentRuntimeConfig: Record<string, unknown>;
  }> {
    const current = deriveBundleState(agent);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const agentRuntimeConfig: Record<string, unknown> = {
        ...current.config,
        [PROMPT_KEY]: content,
      };
      const nextAgent = { ...agent, agentRuntimeConfig };
      const [bundle, file] = await Promise.all([
        getBundle(nextAgent),
        readFile(nextAgent, LEGACY_PROMPT_TEMPLATE_PATH),
      ]);
      return { bundle, file, agentRuntimeConfig };
    }

    const prepared = await ensureWritableBundle(agent, options);
    await writeUtf8FileWithinRoot(prepared.state.rootPath!, relativePath, content);
    const nextAgent = { ...agent, agentRuntimeConfig: prepared.agentRuntimeConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, agentRuntimeConfig: prepared.agentRuntimeConfig };
  }

  async function deleteFile(agent: AgentLike, relativePath: string): Promise<{
    bundle: AgentInstructionsBundle;
    agentRuntimeConfig: Record<string, unknown>;
  }> {
    const derived = deriveBundleState(agent);
    const state = await recoverManagedBundleState(agent, derived, {
      materializeMissingManagedEntry: true,
    });
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw unprocessable("Cannot delete the legacy promptTemplate pseudo-file");
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalizedPath === state.entryFile) {
      throw unprocessable("Cannot delete the bundle entry file");
    }
    const inspected = await inspectExistingPathWithinRoot(state.rootPath, normalizedPath);
    if (inspected) await fs.rm(inspected.absolutePath, { force: true });
    const agentRuntimeConfig = buildPersistedBundleConfig(derived, state);
    const bundle = await getBundle({ ...agent, agentRuntimeConfig });
    return { bundle, agentRuntimeConfig };
  }

  async function exportFiles(agent: AgentLike): Promise<{
    files: Record<string, string>;
    entryFile: string;
    warnings: string[];
  }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (state.rootPath) {
      const stat = await statIfExists(state.rootPath);
      if (stat?.isDirectory()) {
        const relativePaths = await listFilesRecursive(state.rootPath);
        const files = Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
          const file = await readUtf8FileWithinRoot(state.rootPath!, relativePath);
          if (!file) throw notFound("Instructions file not found");
          return [relativePath, file.content] as const;
        })));
        if (Object.keys(files).length > 0) {
          return { files, entryFile: state.entryFile, warnings: state.warnings };
        }
      }
    }

    const legacyBody = await readLegacyInstructions(agent, state.config);
    return {
      files: { [state.entryFile]: legacyBody || "_No SOUL instructions were resolved from current agent config._" },
      entryFile: state.entryFile,
      warnings: state.warnings,
    };
  }

  async function materializeManagedBundle(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      replaceExisting?: boolean;
      entryFile?: string;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; agentRuntimeConfig: Record<string, unknown> }> {
    const rootPath = resolveManagedInstructionsRoot(agent);
    const entryFile = options?.entryFile ? normalizeRelativeFilePath(options.entryFile) : ENTRY_FILE_DEFAULT;

    await ensureAgentWorkspaceLayout(agent);
    if (options?.replaceExisting) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
    await fs.mkdir(rootPath, { recursive: true });

    const normalizedEntries = Object.entries(files).map(([relativePath, content]) => [
      normalizeRelativeFilePath(relativePath),
      content,
    ] as const);
    for (const [relativePath, content] of normalizedEntries) {
      await writeUtf8FileWithinRoot(rootPath, relativePath, content);
    }
    await copyLegacyRootMemoryIntoManagedInstructions(agent);
    if (!normalizedEntries.some(([relativePath]) => relativePath === entryFile)) {
      await writeUtf8FileWithinRoot(rootPath, entryFile, "");
    }

    const agentRuntimeConfig = applyBundleConfig(asRecord(agent.agentRuntimeConfig), {
      mode: "managed",
      rootPath,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    const bundle = await getBundle({ ...agent, agentRuntimeConfig });
    return { bundle, agentRuntimeConfig };
  }

  return {
    getBundle,
    reconcileBundle,
    readFile,
    updateBundle,
    writeFile,
    deleteFile,
    exportFiles,
    ensureManagedBundle: ensureWritableBundle,
    materializeManagedBundle,
  };
}
