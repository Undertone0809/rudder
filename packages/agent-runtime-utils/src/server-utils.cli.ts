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

export async function resolveRudderCliShimTarget(moduleDir: string): Promise<SpawnTarget | null> {
  const packagedCli = await findAncestorWithFile(moduleDir, "desktop-cli.js");
  if (packagedCli) {
    return {
      command: process.execPath,
      args: [packagedCli],
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
    };
  }

  const builtCliEntry = path.join(rootDir, "cli", "dist", "index.js");
  if (await fileExists(builtCliEntry)) {
    return {
      command: process.execPath,
      args: [builtCliEntry],
    };
  }

  return null;
}

export async function materializeRudderCliShim(target: SpawnTarget): Promise<string> {
  const hash = createHash("sha1")
    .update(JSON.stringify({ command: target.command, args: target.args, platform: process.platform }))
    .digest("hex")
    .slice(0, 12);
  const shimDir = path.join(os.tmpdir(), "rudder-cli-shims", hash);
  await fs.mkdir(shimDir, { recursive: true });

  if (process.platform === "win32") {
    const shimPath = path.join(shimDir, "rudder.cmd");
    const commandLine = [quoteForCmd(target.command), ...target.args.map(quoteForCmd), "%*"].join(" ");
    await fs.writeFile(shimPath, `@echo off\r\n${commandLine}\r\n`, "utf8");
    return shimPath;
  }

  const shimPath = path.join(shimDir, "rudder");
  const commandLine = [target.command, ...target.args].map(shellQuote).join(" ");
  await fs.writeFile(shimPath, `#!/bin/sh\nexec ${commandLine} "$@"\n`, "utf8");
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

export async function readRudderRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<RudderSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(
    config.rudderRuntimeSkills ?? config.paperclipRuntimeSkills,
  );
  if (configuredEntries.length > 0) return configuredEntries;
  return listRudderSkillEntries(moduleDir, additionalCandidates);
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
  const normalizedReference = reference.trim().toLowerCase().replace(/^rudder\/rudder\//, "rudder/");
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
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
  const authCheckArgs = input.command.authCheckArgs;
  if (!authCheckArgs || authCheckArgs.length === 0) return true;

  if (input.command.credentialEntries && input.command.credentialEntries.length > 0) {
    const hasOperatorCredentialEntry = await Promise.all(
      input.command.credentialEntries.map((entry) => localCliPathExists(path.join(input.operatorHome, entry))),
    );
    if (!hasOperatorCredentialEntry.some(Boolean)) return false;
  }

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
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
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

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGTERM");
                setTimeout(() => {
                  if (isChildProcessAlive(child)) {
                    child.kill("SIGKILL");
                  }
                }, Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        let abortCleanup: (() => void) | null = null;
        if (opts.abortSignal) {
          const onAbort = () => {
            aborted = true;
            child.kill("SIGTERM");
            setTimeout(() => {
              if (isChildProcessAlive(child)) {
                child.kill("SIGKILL");
              }
            }, Math.max(1, opts.graceSec) * 1000);
          };

          opts.abortSignal.addEventListener("abort", onAbort, { once: true });
          abortCleanup = () => opts.abortSignal?.removeEventListener("abort", onAbort);
        }

        child.stdout?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"));
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"));
        });

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          if (abortCleanup) abortCleanup();
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
          runningProcesses.delete(runId);
          void logChain.finally(() => {
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
