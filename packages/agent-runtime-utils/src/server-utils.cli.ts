import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultPathForPlatform, fileExists, quoteForCmd, resolveCommandPath, resolveSpawnTarget } from "./server-utils.instructions.js";
import { appendWithCap, asString, buildManagedSkillOrigin, ChildProcessWithEvents, compactSkillText, DEFAULT_LOCAL_CLI_CREDENTIAL_HOME_ENTRIES, DEFAULT_LOCAL_CLI_OPERATOR_HOME_SHIM_COMMANDS, InstalledSkillTarget, isChildProcessAlive, isMaintainerOnlySkillTarget, LocalCliCredentialShimCommand, parseObject, PersistentSkillSnapshotOptions, readSkillMetadataFromDirectory, resolveInstalledEntryTarget, RUDDER_SKILL_ROOT_RELATIVE_CANDIDATES, RudderSkillEntry, runningProcesses, RunProcessResult, skillLocationLabel, SpawnTarget } from "./server-utils.process.js";
import type {
  AgentRuntimeSkillEntry,
  AgentRuntimeSkillSnapshot,
} from "./types.js";

const LOCAL_CLI_CREDENTIAL_AUTH_CHECK_TIMEOUT_MS = 3000;
const RUDDER_DESKTOP_CLI_ENTRY_ENV = "RUDDER_DESKTOP_CLI_ENTRY";
const RETIRED_RUDDER_CREATION_SKILL_SLUGS = new Set([
  "rudder-create-agent",
  "rudder-create-plugin",
]);
export const OPERATOR_INTERRUPT_ABORT_REASON_KIND = "operator_interrupt" as const;

export interface OperatorInterruptAbortReason {
  kind: typeof OPERATOR_INTERRUPT_ABORT_REASON_KIND;
  /** Maximum milliseconds from abort until the process group receives SIGKILL. */
  hardDeadlineMs: number;
}

export function createOperatorInterruptAbortReason(hardDeadlineMs: number): OperatorInterruptAbortReason {
  if (!Number.isFinite(hardDeadlineMs) || hardDeadlineMs <= 0) {
    throw new RangeError("operator interrupt hardDeadlineMs must be a positive finite number");
  }
  return {
    kind: OPERATOR_INTERRUPT_ABORT_REASON_KIND,
    hardDeadlineMs: Math.max(1, Math.floor(hardDeadlineMs)),
  };
}

function operatorInterruptHardDeadlineMs(reason: unknown): number | null {
  if (!reason || typeof reason !== "object" || Array.isArray(reason)) return null;
  const candidate = reason as Partial<OperatorInterruptAbortReason>;
  if (candidate.kind !== OPERATOR_INTERRUPT_ABORT_REASON_KIND) return null;
  if (typeof candidate.hardDeadlineMs !== "number" || !Number.isFinite(candidate.hardDeadlineMs)) return null;
  if (candidate.hardDeadlineMs <= 0) return null;
  return Math.max(1, Math.floor(candidate.hardDeadlineMs));
}

type RudderCliSpawnTarget = SpawnTarget & {
  env?: Record<string, string>;
  provenance: "desktop_bundle" | "external_runtime" | "repo";
  version: string | null;
};

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export function prependPathEntry(env: NodeJS.ProcessEnv, entry: string): NodeJS.ProcessEnv {
  const normalized = ensurePathInEnv(env);
  const pathKey = typeof normalized.PATH === "string" ? "PATH" : "Path";
  const current = normalized[pathKey] ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const segments = current.split(delimiter).filter(Boolean);
  if (segments.includes(entry)) return normalized;
  return {
    ...normalized,
    [pathKey]: current.length > 0 ? `${entry}${delimiter}${current}` : entry,
  };
}

export function killChildProcessTree(child: ChildProcessWithEvents, force: boolean): void {
  if (process.platform === "win32" && typeof child.pid === "number" && child.pid > 0) {
    const args = ["/pid", String(child.pid), "/t"];
    if (force) args.push("/f");
    const killer = spawn("taskkill.exe", args, {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => {});
    return;
  }

  const signal = force ? "SIGKILL" : "SIGTERM";
  if (typeof child.pid === "number" && child.pid > 0) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if its process group is already gone.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // The process may have exited between the liveness check and signal.
  }
}

function isChildProcessTreeAlive(child: ChildProcessWithEvents): boolean {
  if (process.platform === "win32") return isChildProcessAlive(child);
  const pid = child.pid;
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : null;
    if (code === "EPERM") return true;
    return isChildProcessAlive(child);
  }
}

export async function findAncestorWithFile(
  startDir: string,
  relativePath: string,
  maxDepth = 12,
): Promise<string | null> {
  let current = path.resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(current, relativePath);
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

async function readPackageVersion(filePath: string, expectedName?: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { name?: unknown; version?: unknown };
    if (expectedName && parsed.name !== expectedName) return null;
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version.trim() : null;
  } catch {
    return null;
  }
}

async function cliVersionBesideEntry(cliEntry: string): Promise<string | null> {
  const directory = path.dirname(cliEntry);
  return await readPackageVersion(path.join(directory, "rudder-cli-package.json"), "@rudderhq/cli")
    ?? await readPackageVersion(path.join(directory, "package.json"), "@rudderhq/cli");
}
async function resolveExplicitDesktopCliEntry(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env[RUDDER_DESKTOP_CLI_ENTRY_ENV]?.trim();
  if (!configured) return null;
  const cliEntry = path.resolve(configured);
  return await fileExists(cliEntry) ? cliEntry : null;
}

async function resolveDesktopExecutableBesideCliEntry(cliEntry: string): Promise<string | null> {
  const resourcesDir = path.dirname(path.dirname(cliEntry));
  const appRoot = path.dirname(resourcesDir);
  const executable = process.platform === "darwin"
    ? path.join(appRoot, "MacOS", "Rudder")
    : path.join(appRoot, process.platform === "win32" ? "Rudder.exe" : "Rudder");
  return await fileExists(executable) ? executable : null;
}

export function resolveDesktopCliSpawnTarget(
  cliEntry: string,
  executable: string,
  _platform: NodeJS.Platform = process.platform,
  nodeRunner: string | null = null,
): Pick<RudderCliSpawnTarget, "command" | "args" | "env"> {
  if (nodeRunner) {
    return {
      command: executable,
      args: [nodeRunner],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }

  return {
    command: executable,
    args: ["--desktop-cli"],
  };
}

export async function resolveRudderCliShimTarget(moduleDir: string): Promise<RudderCliSpawnTarget | null> {
  const explicitDesktopCli = await resolveExplicitDesktopCliEntry();
  if (explicitDesktopCli) {
    const executable = await resolveDesktopExecutableBesideCliEntry(explicitDesktopCli) ?? process.execPath;
    const nodeRunner = path.join(path.dirname(explicitDesktopCli), "desktop-cli-runner.js");
    return {
      ...resolveDesktopCliSpawnTarget(
        explicitDesktopCli,
        executable,
        process.platform,
        await fileExists(nodeRunner) ? nodeRunner : null,
      ),
      provenance: "desktop_bundle",
      version: await cliVersionBesideEntry(explicitDesktopCli),
    };
  }

  const packagedCli = await findAncestorWithFile(moduleDir, "desktop-cli.js");
  if (packagedCli) {
    const runtimeMetadata = await findAncestorWithFile(moduleDir, "runtime.json");
    return {
      command: process.execPath,
      args: [packagedCli],
      provenance: runtimeMetadata ? "external_runtime" : "desktop_bundle",
      version: await cliVersionBesideEntry(packagedCli),
    };
  }

  const repoRoot = await findAncestorWithFile(moduleDir, path.join("cli", "src", "index.ts"));
  if (!repoRoot) return null;
  const rootDir = path.dirname(path.dirname(path.dirname(repoRoot)));
  const tsxEntry = path.join(rootDir, "cli", "node_modules", "tsx", "dist", "cli.mjs");
  const cliSource = path.join(rootDir, "cli", "src", "index.ts");
  if (await fileExists(tsxEntry)) {
    return {
      command: process.execPath,
      args: [tsxEntry, cliSource],
      provenance: "repo",
      version: await readPackageVersion(path.join(rootDir, "cli", "package.json"), "@rudderhq/cli"),
    };
  }

  const builtCliEntry = path.join(rootDir, "cli", "dist", "index.js");
  if (await fileExists(builtCliEntry)) {
    return {
      command: process.execPath,
      args: [builtCliEntry],
      provenance: "repo",
      version: await readPackageVersion(path.join(rootDir, "cli", "package.json"), "@rudderhq/cli"),
    };
  }

  return null;
}

export async function materializeRudderCliShim(
  target: SpawnTarget & { env?: Record<string, string> },
): Promise<string> {
  const hash = createHash("sha1")
    .update(JSON.stringify({ command: target.command, args: target.args, env: target.env, platform: process.platform }))
    .digest("hex")
    .slice(0, 12);
  const shimDir = path.join(os.tmpdir(), "rudder-cli-shims", hash);
  await fs.mkdir(shimDir, { recursive: true });
  const electronNodeMode = target.env?.ELECTRON_RUN_AS_NODE === "1";

  if (process.platform === "win32") {
    const shimPath = path.join(shimDir, "rudder.cmd");
    const commandLine = [quoteForCmd(target.command), ...target.args.map(quoteForCmd), "%*"].join(" ");
    await fs.writeFile(
      shimPath,
      `@echo off\r\n${electronNodeMode ? "set \"ELECTRON_RUN_AS_NODE=1\"\r\n" : ""}${commandLine}\r\n`,
      "utf8",
    );
    return shimPath;
  }

  const shimPath = path.join(shimDir, "rudder");
  const commandLine = [target.command, ...target.args].map(shellQuote).join(" ");
  await fs.writeFile(
    shimPath,
    `#!/bin/sh\n${electronNodeMode ? "export ELECTRON_RUN_AS_NODE=1\n" : ""}exec ${commandLine} "$@"\n`,
    "utf8",
  );
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

export async function ensureRudderCliInPath(
  moduleDir: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const normalized = ensurePathInEnv(env);
  const target = await resolveRudderCliShimTarget(moduleDir);
  if (!target) {
    return normalized;
  }

  const shimPath = await materializeRudderCliShim(target);
  return prependPathEntry(normalized, path.dirname(shimPath));
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolveRudderSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...RUDDER_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

export async function listRudderSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<RudderSkillEntry[]> {
  const root = await resolveRudderSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const skillDirectories = entries
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    const skillEntries = await Promise.all(
      skillDirectories.map(async (entry) => {
        const source = path.join(root, entry.name);
        const metadata = await readSkillMetadataFromDirectory(source);
        return {
          key: `rudder/${entry.name}`,
          runtimeName: entry.name,
          source,
          name: metadata.name ?? entry.name,
          description: metadata.description,
        };
      }),
    );
    return skillEntries;
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AgentRuntimeSkillSnapshot {
  const {
    agentRuntimeType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AgentRuntimeSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AgentRuntimeSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      description: available.description ?? null,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      ...buildManagedSkillOrigin(),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Rudder skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Rudder cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      description: null,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    agentRuntimeType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

export function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): RudderSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RudderSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      name: compactSkillText(asString(entry.displayName, asString(entry.name, ""))) ?? runtimeName,
      description: compactSkillText(
        typeof entry.description === "string"
          ? entry.description
          : typeof entry.summary === "string"
            ? entry.summary
            : null,
      ),
    });
  }
  return out;
}

function isRetiredRudderCreationSkillReference(value: string | null | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  const withoutSelectionPrefix = normalized.startsWith("bundled:")
    ? normalized.slice("bundled:".length)
    : normalized;
  const segments = withoutSelectionPrefix.split("/").filter(Boolean);

  if (segments.length === 1) {
    return RETIRED_RUDDER_CREATION_SKILL_SLUGS.has(segments[0]!);
  }
  if (segments.length === 2 && segments[0] === "rudder") {
    return RETIRED_RUDDER_CREATION_SKILL_SLUGS.has(segments[1]!);
  }
  if (segments.length === 3 && segments[0] === "rudder" && segments[1] === "rudder") {
    return RETIRED_RUDDER_CREATION_SKILL_SLUGS.has(segments[2]!);
  }
  return false;
}

function isRetiredRudderCreationRuntimeEntry(entry: { key: string; runtimeName?: string | null }) {
  return isRetiredRudderCreationSkillReference(entry.key)
    || isRetiredRudderCreationSkillReference(entry.runtimeName);
}

export async function readRudderRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<RudderSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(
    config.rudderRuntimeSkills ?? config.paperclipRuntimeSkills,
  );
  if (configuredEntries.length > 0) {
    return configuredEntries.filter((entry) => !isRetiredRudderCreationRuntimeEntry(entry));
  }
  return (await listRudderSkillEntries(moduleDir, additionalCandidates))
    .filter((entry) => !isRetiredRudderCreationRuntimeEntry(entry));
}

export async function readRudderSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase().replace(/^rudder\/rudder\//, "rudder/");
  if (!normalized) return null;

  const entries = await listRudderSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readRudderSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.rudderSkillSync ?? config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

export function canonicalizeDesiredRudderSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";
  if (isRetiredRudderCreationSkillReference(normalizedReference)) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return isRetiredRudderCreationRuntimeEntry(exactKey) ? "" : exactKey.key;

  if (
    normalizedReference === "rudder"
    || normalizedReference === "rudder/rudder"
    || normalizedReference === "bundled:rudder/rudder"
  ) {
    const canonicalRudderDocsEntry = availableEntries.find((entry) =>
      entry.key.trim().toLowerCase() === "rudder/rudder-docs"
      || entry.key.trim().toLowerCase() === "bundled:rudder/rudder-docs"
      || entry.runtimeName?.trim().toLowerCase() === "rudder-docs"
    );
    return canonicalRudderDocsEntry?.key ?? "rudder/rudder-docs";
  }

  const lookupReference = normalizedReference.replace(/^rudder\/rudder\//, "rudder/");
  const legacyNestedKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === lookupReference);
  if (legacyNestedKey) {
    return isRetiredRudderCreationRuntimeEntry(legacyNestedKey) ? "" : legacyNestedKey.key;
  }

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === lookupReference,
  );
  if (byRuntimeName.length === 1) {
    return isRetiredRudderCreationRuntimeEntry(byRuntimeName[0]!) ? "" : byRuntimeName[0]!.key;
  }

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === lookupReference,
  );
  if (slugMatches.length === 1) {
    return isRetiredRudderCreationRuntimeEntry(slugMatches[0]!) ? "" : slugMatches[0]!.key;
  }

  return lookupReference;
}

export function resolveRudderDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string[] {
  const preference = readRudderSkillSyncPreference(config);
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredRudderSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set(desiredSkills));
}

export function filterRudderDesiredSkillsForBrowserCapability(
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
  desiredSkills: string[],
  browserEnabled: boolean,
): string[] {
  if (browserEnabled) return [...desiredSkills];
  const browserSkillKeys = new Set(
    availableEntries
      .filter((entry) => entry.runtimeName?.trim().toLowerCase() === "browser")
      .map((entry) => entry.key),
  );
  return desiredSkills.filter((skill) => !browserSkillKeys.has(skill));
}

export function writeRudderSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.rudderSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.rudderSkillSync = current;
  return next;
}

export function nonEmptyEnvPath(value: string | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? path.resolve(value.trim()) : null;
}

export function resolveLocalOperatorHome(sourceEnv: NodeJS.ProcessEnv = process.env): string {
  return (
    nonEmptyEnvPath(sourceEnv.RUDDER_OPERATOR_HOME)
    ?? nonEmptyEnvPath(process.env.RUDDER_OPERATOR_HOME)
    ?? nonEmptyEnvPath(process.env.HOME)
    ?? nonEmptyEnvPath(sourceEnv.HOME)
    ?? path.resolve(os.homedir())
  );
}

export function applyLocalCliHomeEnv(
  targetEnv: Record<string, string>,
  sourceEnv: NodeJS.ProcessEnv = process.env,
): void {
  const home = nonEmptyEnvPath(sourceEnv.HOME) ?? path.resolve(os.homedir());
  targetEnv.HOME = home;

  const userProfile = nonEmptyEnvPath(sourceEnv.USERPROFILE);
  if (userProfile) {
    targetEnv.USERPROFILE = userProfile;
  } else if (process.platform === "win32") {
    targetEnv.USERPROFILE = home;
  }
}

export async function localCliPathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

export async function directoryIsEmpty(target: string): Promise<boolean> {
  const entries = await fs.readdir(target).catch(() => null);
  return Array.isArray(entries) && entries.length === 0;
}

export async function ensureSymlinkToSource(target: string, source: string): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    if (existing.isDirectory() && await directoryIsEmpty(target)) {
      await fs.rmdir(target);
      await fs.symlink(source, target);
      return "repaired";
    }
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.isAbsolute(linkedPath)
    ? linkedPath
    : path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) return "skipped";

  await fs.unlink(target);
  await fs.symlink(source, target);
  return "repaired";
}

export async function syncLocalCliCredentialHomeEntries(input: {
  sourceHome?: string | null;
  targetHome: string;
  entries?: readonly string[];
  onLog?: ((stream: "stdout" | "stderr", chunk: string) => Promise<void>) | null;
}): Promise<{ linked: string[]; skipped: string[] }> {
  const sourceHome = nonEmptyEnvPath(input.sourceHome ?? undefined) ?? path.resolve(os.homedir());
  const targetHome = path.resolve(input.targetHome);
  const linked: string[] = [];
  const skipped: string[] = [];
  if (sourceHome === targetHome) return { linked, skipped };

  const entries = input.entries ?? DEFAULT_LOCAL_CLI_CREDENTIAL_HOME_ENTRIES;
  for (const relativeEntry of entries) {
    const source = path.join(sourceHome, relativeEntry);
    if (!(await localCliPathExists(source))) continue;

    const target = path.join(targetHome, relativeEntry);
    try {
      const result = await ensureSymlinkToSource(target, source);
      if (result === "skipped") skipped.push(relativeEntry);
      else linked.push(relativeEntry);
    } catch {
      skipped.push(relativeEntry);
    }
  }

  if (input.onLog && linked.length > 0) {
    await input.onLog(
      "stdout",
      `[rudder] Shared ${linked.length} local CLI credential entr${linked.length === 1 ? "y" : "ies"} into managed HOME ${targetHome}: ${linked.join(", ")}\n`,
    );
  }

  return { linked, skipped };
}

export async function pruneLegacyLocalCliCredentialHomeEntries(input: {
  targetHome: string;
  entries?: readonly string[];
  onLog?: ((stream: "stdout" | "stderr", chunk: string) => Promise<void>) | null;
}): Promise<{ removed: string[]; skipped: string[] }> {
  const targetHome = path.resolve(input.targetHome);
  const removed: string[] = [];
  const skipped: string[] = [];
  const entries = input.entries ?? [
    ...DEFAULT_LOCAL_CLI_CREDENTIAL_HOME_ENTRIES,
    ".npm",
    ".vscode",
  ];

  for (const relativeEntry of entries) {
    const target = path.join(targetHome, relativeEntry);
    const existing = await fs.lstat(target).catch(() => null);
    if (!existing) continue;

    try {
      if (existing.isSymbolicLink()) {
        await fs.unlink(target);
        removed.push(relativeEntry);
        continue;
      }
      if (existing.isDirectory() && await directoryIsEmpty(target)) {
        await fs.rmdir(target);
        removed.push(relativeEntry);
        continue;
      }
      if (existing.isFile() && existing.size === 0) {
        await fs.unlink(target);
        removed.push(relativeEntry);
        continue;
      }
      skipped.push(relativeEntry);
    } catch {
      skipped.push(relativeEntry);
    }
  }

  if (input.onLog && removed.length > 0) {
    await input.onLog(
      "stdout",
      `[rudder] Removed ${removed.length} legacy local CLI credential bridge entr${removed.length === 1 ? "y" : "ies"} from adapter-managed runtime state ${targetHome}: ${removed.join(", ")}\n`,
    );
  }

  return { removed, skipped };
}

export async function writeOperatorHomeShim(input: {
  shimDir: string;
  command: string;
  targetCommand: string;
  operatorHome: string;
}): Promise<string> {
  await fs.mkdir(input.shimDir, { recursive: true });

  if (process.platform === "win32") {
    const shimPath = path.join(input.shimDir, `${input.command}.cmd`);
    const lines = [
      "@echo off",
      `set "HOME=${input.operatorHome}"`,
      `set "USERPROFILE=${input.operatorHome}"`,
      `${quoteForCmd(input.targetCommand)} %*`,
      "",
    ];
    await fs.writeFile(shimPath, lines.join("\r\n"), "utf8");
    return shimPath;
  }

  const shimPath = path.join(input.shimDir, input.command);
  await fs.writeFile(
    shimPath,
    [
      "#!/bin/sh",
      `export HOME=${shellQuote(input.operatorHome)}`,
      `export USERPROFILE=${shellQuote(input.operatorHome)}`,
      `exec ${shellQuote(input.targetCommand)} "$@"`,
      "",
    ].join("\n"),
    "utf8",
  );
  await fs.chmod(shimPath, 0o755);
  return shimPath;
}

export function normalizeShimCommand(input: string | LocalCliCredentialShimCommand): LocalCliCredentialShimCommand {
  return typeof input === "string" ? { command: input } : input;
}

export async function runCredentialShimAuthCheck(input: {
  targetCommand: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
}): Promise<boolean> {
  const env = {
    ...input.env,
    HOME: input.home,
    USERPROFILE: input.home,
  };
  return await new Promise<boolean>((resolve) => {
    const child = spawn(input.targetCommand, [...input.args], {
      cwd: input.cwd,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(false);
    }, LOCAL_CLI_CREDENTIAL_AUTH_CHECK_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

export async function shouldPrepareOperatorHomeShim(input: {
  command: LocalCliCredentialShimCommand;
  targetCommand: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  targetHome: string;
  operatorHome: string;
}): Promise<boolean> {
  if (input.command.credentialEntries && input.command.credentialEntries.length > 0) {
    const hasOperatorCredentialEntry = await Promise.all(
      input.command.credentialEntries.map((entry) => localCliPathExists(path.join(input.operatorHome, entry))),
    );
    if (!hasOperatorCredentialEntry.some(Boolean)) return false;
  }

  const authCheckArgs = input.command.authCheckArgs;
  if (!authCheckArgs || authCheckArgs.length === 0) return true;

  const managedHomeWorks = await runCredentialShimAuthCheck({
    targetCommand: input.targetCommand,
    args: authCheckArgs,
    cwd: input.cwd,
    env: input.env,
    home: input.targetHome,
  });
  if (managedHomeWorks) return false;

  return await runCredentialShimAuthCheck({
    targetCommand: input.targetCommand,
    args: authCheckArgs,
    cwd: input.cwd,
    env: input.env,
    home: input.operatorHome,
  });
}

export async function ensureLocalCliCredentialShimsInPath(input: {
  operatorHome?: string | null;
  targetHome: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  commands?: readonly (string | LocalCliCredentialShimCommand)[];
  onLog?: ((stream: "stdout" | "stderr", chunk: string) => Promise<void>) | null;
}): Promise<NodeJS.ProcessEnv> {
  const operatorHome = nonEmptyEnvPath(input.operatorHome ?? undefined);
  const targetHome = nonEmptyEnvPath(input.targetHome);
  if (!operatorHome || !targetHome || operatorHome === targetHome) {
    return ensurePathInEnv(input.env);
  }

  const normalized = ensurePathInEnv(input.env);
  const cwd = input.cwd ?? process.cwd();
  const commands = input.commands ?? DEFAULT_LOCAL_CLI_OPERATOR_HOME_SHIM_COMMANDS;
  const shimDir = path.join(targetHome, ".rudder", "local-cli-shims");
  const prepared: string[] = [];

  for (const rawCommand of commands) {
    const command = normalizeShimCommand(rawCommand);
    const targetCommand = await resolveCommandPath(command.command, cwd, normalized);
    if (!targetCommand) continue;
    if (path.dirname(targetCommand) === shimDir) continue;
    if (!(await shouldPrepareOperatorHomeShim({
      command,
      targetCommand,
      cwd,
      env: normalized,
      targetHome,
      operatorHome,
    }))) {
      continue;
    }
    await writeOperatorHomeShim({ shimDir, command: command.command, targetCommand, operatorHome });
    prepared.push(command.command);
  }

  if (prepared.length === 0) return normalized;
  if (input.onLog) {
    await input.onLog(
      "stdout",
      `[rudder] Prepared local CLI credential shim${prepared.length === 1 ? "" : "s"} for: ${prepared.join(", ")}\n`,
    );
  }
  return prependPathEntry(normalized, shimDir);
}

export async function ensureRudderSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  return removeUnselectedRudderSkillSymlinks(skillsHome, allowedSkillNames);
}

type LegacyRudderDocsManagedEntryCleanupResultBase = {
  targetPath: string;
  legacySourcePath: string | null;
  kind: "symlink" | "directory" | "file" | "other" | null;
};

export type LegacyRudderDocsManagedEntryCleanupResult =
  | (LegacyRudderDocsManagedEntryCleanupResultBase & {
      state: "not_applicable" | "absent" | "removed" | "collision";
      detail?: never;
    })
  | (LegacyRudderDocsManagedEntryCleanupResultBase & {
      state: "failed";
      detail: string;
    });

function isFileSystemErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function sameFileSystemEntry(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function cleanupRetiredRudderManagedEntry(
  skillsHome: string,
  selectedEntries: Iterable<{ key: string; runtimeName: string; source: string }>,
  retiredRuntimeName: string,
  requireMissingSymlinkSource: boolean,
): Promise<LegacyRudderDocsManagedEntryCleanupResult> {
  const targetPath = path.join(path.resolve(skillsHome), retiredRuntimeName);
  const canonicalEntry = Array.from(selectedEntries).find((entry) =>
    (entry.key === "rudder/rudder-docs" || entry.key === "bundled:rudder/rudder-docs")
    && entry.runtimeName === "rudder-docs"
  );
  if (!canonicalEntry) {
    return { state: "not_applicable", targetPath, legacySourcePath: null, kind: null };
  }

  const legacySourcePath = path.join(
    path.dirname(path.resolve(canonicalEntry.source)),
    retiredRuntimeName,
  );
  let existing: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    existing = await fs.lstat(targetPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "absent", targetPath, legacySourcePath, kind: null };
    }
    return { state: "collision", targetPath, legacySourcePath, kind: "other" };
  }

  if (existing.isSymbolicLink()) {
    const linkedPath = await fs.readlink(targetPath).catch(() => null);
    if (linkedPath === null) {
      return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
    }
    const resolvedLinkedPath = path.resolve(path.dirname(targetPath), linkedPath);
    if (resolvedLinkedPath !== legacySourcePath) {
      return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
    }
    if (requireMissingSymlinkSource) {
      try {
        await fs.stat(resolvedLinkedPath);
        return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
      } catch (error) {
        if (!isFileSystemErrorCode(error, "ENOENT")) {
          return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
        }
      }
    }

    // Ownership evidence is path-based, so revalidate inode, type, and target immediately before deletion.
    const revalidated = await fs.lstat(targetPath).catch(() => null);
    if (!revalidated?.isSymbolicLink() || !sameFileSystemEntry(existing, revalidated)) {
      return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
    }
    const revalidatedLink = await fs.readlink(targetPath).catch(() => null);
    if (
      revalidatedLink === null
      || path.resolve(path.dirname(targetPath), revalidatedLink) !== legacySourcePath
    ) {
      return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
    }
    const finalEntry = await fs.lstat(targetPath).catch(() => null);
    if (!finalEntry?.isSymbolicLink() || !sameFileSystemEntry(existing, finalEntry)) {
      return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
    }
    if (requireMissingSymlinkSource) {
      try {
        await fs.stat(legacySourcePath);
        return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
      } catch (error) {
        if (!isFileSystemErrorCode(error, "ENOENT")) {
          return { state: "collision", targetPath, legacySourcePath, kind: "symlink" };
        }
      }
    }
    try {
      await fs.unlink(targetPath);
    } catch (error) {
      return {
        state: "failed",
        targetPath,
        legacySourcePath,
        kind: "symlink",
        detail: `unlink failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return { state: "removed", targetPath, legacySourcePath, kind: "symlink" };
  }

  if (existing.isDirectory()) {
    const materializedSource = await readRudderMaterializedSkillSource(targetPath);
    if (materializedSource === legacySourcePath) {
      // A matching manifest can move with a replacement; inode and provenance must both remain stable.
      const revalidated = await fs.lstat(targetPath).catch(() => null);
      if (!revalidated?.isDirectory() || !sameFileSystemEntry(existing, revalidated)) {
        return { state: "collision", targetPath, legacySourcePath, kind: "directory" };
      }
      const revalidatedSource = await readRudderMaterializedSkillSource(targetPath);
      if (revalidatedSource !== legacySourcePath) {
        return { state: "collision", targetPath, legacySourcePath, kind: "directory" };
      }
      const finalEntry = await fs.lstat(targetPath).catch(() => null);
      if (!finalEntry?.isDirectory() || !sameFileSystemEntry(existing, finalEntry)) {
        return { state: "collision", targetPath, legacySourcePath, kind: "directory" };
      }
      try {
        await fs.rm(targetPath, { recursive: true, force: true });
      } catch (error) {
        return {
          state: "failed",
          targetPath,
          legacySourcePath,
          kind: "directory",
          detail: `recursive removal failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { state: "removed", targetPath, legacySourcePath, kind: "directory" };
    }
    return { state: "collision", targetPath, legacySourcePath, kind: "directory" };
  }

  const kind = existing.isFile() ? "file" : "other";
  return { state: "collision", targetPath, legacySourcePath, kind };
}

export async function cleanupLegacyRudderDocsManagedEntry(
  skillsHome: string,
  selectedEntries: Iterable<{ key: string; runtimeName: string; source: string }>,
): Promise<LegacyRudderDocsManagedEntryCleanupResult> {
  return cleanupRetiredRudderManagedEntry(skillsHome, selectedEntries, "rudder", true);
}

export type RetiredRudderManagedEntryCleanupResult =
  LegacyRudderDocsManagedEntryCleanupResult & { runtimeName: string };

const RETIRED_RUDDER_MANAGED_RUNTIME_NAMES = [
  "rudder",
  "rudder-create-agent",
  "rudder-create-plugin",
] as const;

/**
 * Reconcile obsolete persistent runtime entries from known Rudder migrations.
 *
 * Ownership is derived from the selected canonical Rudder Docs source. Each
 * candidate is removed only when the existing symlink target or materialized
 * provenance exactly matches its retired sibling source, with inode/type and
 * target/provenance revalidation immediately before deletion.
 */
export async function cleanupRetiredRudderManagedEntries(
  skillsHome: string,
  selectedEntries: Iterable<{ key: string; runtimeName: string; source: string }>,
): Promise<RetiredRudderManagedEntryCleanupResult[]> {
  const selected = Array.from(selectedEntries);
  const results: RetiredRudderManagedEntryCleanupResult[] = [];
  for (const runtimeName of RETIRED_RUDDER_MANAGED_RUNTIME_NAMES) {
    const result = await cleanupRetiredRudderManagedEntry(
      skillsHome,
      selected,
      runtimeName,
      runtimeName === "rudder",
    );
    results.push({ ...result, runtimeName });
  }
  return results;
}

export function formatRetiredRudderManagedEntryCleanupWarnings(
  results: Iterable<RetiredRudderManagedEntryCleanupResult>,
  skillsHome: string,
): string[] {
  const warnings: string[] = [];
  for (const result of results) {
    const lifecycle = result.runtimeName === "rudder" ? "legacy" : "retired";
    if (result.state === "removed") {
      warnings.push(
        `Removed ${lifecycle} Rudder-managed skill entry "${result.runtimeName}" from ${skillsHome}.`,
      );
    } else if (result.state === "collision") {
      warnings.push(
        `Preserved existing "${result.runtimeName}" path at ${result.targetPath} because Rudder ownership could not be proven.`,
      );
    } else if (result.state === "failed") {
      warnings.push(
        `Failed to remove ${lifecycle} Rudder-managed skill entry "${result.runtimeName}" at ${result.targetPath}; ${result.detail}.`,
      );
    }
  }
  return warnings;
}

async function readRudderMaterializedSkillSource(target: string): Promise<string | null> {
  const manifestPath = path.join(target, ".rudder", "materialized-skill.json");
  const raw = await fs.readFile(manifestPath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = parseObject(JSON.parse(raw));
    const sourcePath = asString(parsed.sourcePath, "").trim();
    return sourcePath.length > 0 ? path.resolve(sourcePath) : null;
  } catch {
    return null;
  }
}

export async function removeUnselectedRudderSkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
  knownSkillSources: Iterable<string> = [],
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  const knownSources = new Set(
    Array.from(knownSkillSources)
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => path.resolve(value)),
  );
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing) continue;

      let isRudderManagedSkill = false;
      if (existing.isSymbolicLink()) {
        const linkedPath = await fs.readlink(target).catch(() => null);
        if (!linkedPath) continue;

        const resolvedLinkedPath = path.isAbsolute(linkedPath)
          ? linkedPath
          : path.resolve(path.dirname(target), linkedPath);
        isRudderManagedSkill =
          knownSources.has(path.resolve(resolvedLinkedPath)) ||
          isMaintainerOnlySkillTarget(linkedPath) ||
          isMaintainerOnlySkillTarget(resolvedLinkedPath);
      } else if (existing.isDirectory()) {
        const materializedSource = await readRudderMaterializedSkillSource(target);
        isRudderManagedSkill = materializedSource !== null && knownSources.has(materializedSource);
      }
      if (!isRudderManagedSkill) continue;
      if (allowed.has(entry.name)) continue;

      await fs.rm(target, { recursive: true, force: true });
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(command: string, cwd: string, env: NodeJS.ProcessEnv) {
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void>;
    stdin?: string;
    abortSignal?: AbortSignal;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));

  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
    delete rawMerged.RUDDER_DESKTOP_CLI_ENTRY;
    const requestedHome =
      typeof opts.env.HOME === "string" && opts.env.HOME.trim().length > 0
        ? path.resolve(opts.env.HOME)
        : null;
    const inheritedHome =
      typeof process.env.HOME === "string" && process.env.HOME.trim().length > 0
        ? path.resolve(process.env.HOME)
        : null;
    const hasExplicitZdotdir =
      typeof opts.env.ZDOTDIR === "string" && opts.env.ZDOTDIR.trim().length > 0;

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Rudder server itself is started from
    // within a Claude Code session (e.g. `npx rudder run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      delete rawMerged[key];
    }

    const GIT_IDENTITY_ENV_VARS = [
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
    ] as const;
    for (const key of GIT_IDENTITY_ENV_VARS) {
      if (rawMerged[key] === "" && !Object.prototype.hasOwnProperty.call(opts.env, key)) {
        delete rawMerged[key];
      }
    }

    // When Rudder isolates HOME for child agents, don't let zsh keep using the
    // host user's startup dir via an inherited ZDOTDIR. That mismatch makes
    // child `zsh -lc` invocations source the host `.zshenv` with the agent HOME.
    if (requestedHome && requestedHome !== inheritedHome && !hasExplicitZdotdir) {
      delete rawMerged.ZDOTDIR;
    }

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv)
      .then((target) => {
        if (opts.abortSignal?.aborted) {
          resolve({
            exitCode: null,
            signal: "SIGTERM",
            timedOut: false,
            stdout: "",
            stderr: "",
            pid: null,
            startedAt: null,
          });
          return;
        }

        const child = spawn(target.command, target.args, {
          cwd: opts.cwd,
          detached: process.platform !== "win32",
          env: mergedEnv,
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();

        if (opts.stdin != null && child.stdin) {
          child.stdin.write(opts.stdin);
          child.stdin.end();
        }

        if (typeof child.pid === "number" && child.pid > 0 && opts.onSpawn) {
          void opts.onSpawn({ pid: child.pid, startedAt }).catch((err) => {
            onLogError(err, runId, "failed to record child process metadata");
          });
        }

        runningProcesses.set(runId, { child, graceSec: opts.graceSec });

        let timedOut = false;
        let aborted = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();
        let operatorInterrupted = false;
        let forceKillTimer: NodeJS.Timeout | null = null;
        let forceKillAt = Number.POSITIVE_INFINITY;

        const clearForceKillTimer = () => {
          if (forceKillTimer) clearTimeout(forceKillTimer);
          forceKillTimer = null;
          forceKillAt = Number.POSITIVE_INFINITY;
        };
        const scheduleForceKill = (delayMs: number) => {
          const boundedDelayMs = Math.max(1, delayMs);
          const killAt = Date.now() + boundedDelayMs;
          if (forceKillTimer && forceKillAt <= killAt) return;
          clearForceKillTimer();
          forceKillAt = killAt;
          forceKillTimer = setTimeout(() => {
            forceKillTimer = null;
            forceKillAt = Number.POSITIVE_INFINITY;
            if (isChildProcessTreeAlive(child)) {
              killChildProcessTree(child, true);
            }
          }, boundedDelayMs);
        };

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                killChildProcessTree(child, false);
                scheduleForceKill(Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        let abortCleanup: (() => void) | null = null;
        if (opts.abortSignal) {
          const onAbort = () => {
            aborted = true;
            const operatorHardDeadlineMs = operatorInterruptHardDeadlineMs(opts.abortSignal?.reason);
            operatorInterrupted = operatorHardDeadlineMs !== null;
            killChildProcessTree(child, false);
            scheduleForceKill(operatorHardDeadlineMs ?? Math.max(1, opts.graceSec) * 1000);
          };

          if (opts.abortSignal.aborted) {
            onAbort();
          } else {
            opts.abortSignal.addEventListener("abort", onAbort, { once: true });
            abortCleanup = () => opts.abortSignal?.removeEventListener("abort", onAbort);
          }
        }

        child.stdout?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          if (operatorInterrupted) return;
          logChain = logChain
            .then(() => operatorInterrupted ? undefined : opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          if (operatorInterrupted) return;
          logChain = logChain
            .then(() => operatorInterrupted ? undefined : opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
        });

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          if (abortCleanup) abortCleanup();
          clearForceKillTimer();
          runningProcesses.delete(runId);
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          if (abortCleanup) abortCleanup();
          if (!isChildProcessTreeAlive(child)) clearForceKillTimer();
          runningProcesses.delete(runId);
          const completionBarrier = operatorInterrupted ? Promise.resolve() : logChain;
          void completionBarrier.finally(() => {
            resolve({
              exitCode: code,
              signal: aborted ? "SIGTERM" : signal,
              timedOut,
              stdout,
              stderr,
              pid: child.pid ?? null,
              startedAt,
            });
          });
        });
      })
      .catch(reject);
  });
}
