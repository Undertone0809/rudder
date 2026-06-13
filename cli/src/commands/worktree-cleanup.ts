import * as p from "@clack/prompts";
import {
  createDb,
  inspectMigrations
} from "@rudderhq/db";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  rmSync
} from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { readPaperclipEnvEntries, resolvePaperclipEnvFile } from "../config/env.js";
import { expandHomePrefix } from "../config/home.js";
import { readConfig, resolveConfigPath } from "../config/store.js";
import { printRudderCliBanner } from "../utils/banner.js";
import { ConfiguredStorage, ensureEmbeddedPostgres, extractExecSyncErrorMessage, localBranchExists, openConfiguredStorage, resolveSourceConnectionString, resolveWorktreeHome, resolveWorktreeMakeName, resolveWorktreeMakeTargetPath } from "./worktree-init.js";
import {
  formatShellExports,
  sanitizeWorktreeInstanceId
} from "./worktree-lib.js";
import type {
  EmbeddedPostgresHandle,
  WorktreeEnvOptions,
} from "./worktree-types.js";

export type WorktreeCleanupOptions = {
  instance?: string;
  home?: string;
  force?: boolean;
};

export type GitWorktreeListEntry = {
  worktree: string;
  branch: string | null;
  bare: boolean;
  detached: boolean;
};

export type MergeSourceChoice = {
  worktree: string;
  branch: string | null;
  branchLabel: string;
  hasRudderConfig: boolean;
  isCurrent: boolean;
};

export type ResolvedWorktreeEndpoint = {
  rootPath: string;
  configPath: string;
  label: string;
  isCurrent: boolean;
};

export function parseGitWorktreeList(cwd: string): GitWorktreeListEntry[] {
  const raw = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const entries: GitWorktreeListEntry[] = [];
  let current: Partial<GitWorktreeListEntry> = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { worktree: line.slice("worktree ".length) };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length);
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "" && current.worktree) {
      entries.push({
        worktree: current.worktree,
        branch: current.branch ?? null,
        bare: current.bare ?? false,
        detached: current.detached ?? false,
      });
      current = {};
    }
  }
  if (current.worktree) {
    entries.push({
      worktree: current.worktree,
      branch: current.branch ?? null,
      bare: current.bare ?? false,
      detached: current.detached ?? false,
    });
  }
  return entries;
}

export function toMergeSourceChoices(cwd: string): MergeSourceChoice[] {
  const currentCwd = path.resolve(cwd);
  return parseGitWorktreeList(cwd).map((entry) => {
    const branchLabel = entry.branch?.replace(/^refs\/heads\//, "") ?? "(detached)";
    const worktreePath = path.resolve(entry.worktree);
    return {
      worktree: worktreePath,
      branch: entry.branch,
      branchLabel,
      hasRudderConfig: existsSync(path.resolve(worktreePath, ".rudder", "config.json")),
      isCurrent: worktreePath === currentCwd,
    };
  });
}

export function branchHasUniqueCommits(cwd: string, branchName: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["log", "--oneline", branchName, "--not", "--remotes", "--exclude", `refs/heads/${branchName}`, "--branches"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

export function branchExistsOnAnyRemote(cwd: string, branchName: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["branch", "-r", "--list", `*/${branchName}`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

export function worktreePathHasUncommittedChanges(worktreePath: string): boolean {
  try {
    const output = execFileSync(
      "git",
      ["status", "--porcelain"],
      { cwd: worktreePath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

export async function worktreeCleanupCommand(nameArg: string, opts: WorktreeCleanupOptions): Promise<void> {
  printRudderCliBanner();
  p.intro(pc.bgCyan(pc.black(" rudder worktree:cleanup ")));

  const name = resolveWorktreeMakeName(nameArg);
  const sourceCwd = process.cwd();
  const targetPath = resolveWorktreeMakeTargetPath(name);
  const instanceId = sanitizeWorktreeInstanceId(opts.instance ?? name);
  const homeDir = path.resolve(expandHomePrefix(resolveWorktreeHome(opts.home)));
  const instanceRoot = path.resolve(homeDir, "instances", instanceId);

  // ── 1. Assess current state ──────────────────────────────────────────

  const hasBranch = localBranchExists(sourceCwd, name);
  const hasTargetDir = existsSync(targetPath);
  const hasInstanceData = existsSync(instanceRoot);

  const worktrees = parseGitWorktreeList(sourceCwd);
  const linkedWorktree = worktrees.find(
    (wt) => wt.branch === `refs/heads/${name}` || path.resolve(wt.worktree) === path.resolve(targetPath),
  );

  if (!hasBranch && !hasTargetDir && !hasInstanceData && !linkedWorktree) {
    p.log.info("Nothing to clean up — no branch, worktree directory, or instance data found.");
    p.outro(pc.green("Already clean."));
    return;
  }

  // ── 2. Safety checks ────────────────────────────────────────────────

  const problems: string[] = [];

  if (hasBranch && branchHasUniqueCommits(sourceCwd, name)) {
    const onRemote = branchExistsOnAnyRemote(sourceCwd, name);
    if (onRemote) {
      p.log.info(
        `Branch "${name}" has unique local commits, but the branch also exists on a remote — safe to delete locally.`,
      );
    } else {
      problems.push(
        `Branch "${name}" has commits not found on any other branch or remote. ` +
          `Deleting it will lose work. Push it first, or use --force.`,
      );
    }
  }

  if (hasTargetDir && worktreePathHasUncommittedChanges(targetPath)) {
    problems.push(
      `Worktree directory ${targetPath} has uncommitted changes. Commit or stash first, or use --force.`,
    );
  }

  if (problems.length > 0 && !opts.force) {
    for (const problem of problems) {
      p.log.error(problem);
    }
    throw new Error("Safety checks failed. Resolve the issues above or re-run with --force.");
  }
  if (problems.length > 0 && opts.force) {
    for (const problem of problems) {
      p.log.warning(`Overridden by --force: ${problem}`);
    }
  }

  // ── 3. Clean up (idempotent steps) ──────────────────────────────────

  // 3a. Remove the git worktree registration
  if (linkedWorktree) {
    const worktreeDirExists = existsSync(linkedWorktree.worktree);
    const spinner = p.spinner();
    if (worktreeDirExists) {
      spinner.start(`Removing git worktree at ${linkedWorktree.worktree}...`);
      try {
        const removeArgs = ["worktree", "remove", linkedWorktree.worktree];
        if (opts.force) removeArgs.push("--force");
        execFileSync("git", removeArgs, {
          cwd: sourceCwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        spinner.stop(`Removed git worktree at ${linkedWorktree.worktree}.`);
      } catch (error) {
        spinner.stop(pc.yellow(`Could not remove worktree cleanly, will prune instead.`));
        p.log.warning(extractExecSyncErrorMessage(error) ?? String(error));
      }
    } else {
      spinner.start("Pruning stale worktree entry...");
      execFileSync("git", ["worktree", "prune"], {
        cwd: sourceCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      spinner.stop("Pruned stale worktree entry.");
    }
  } else {
    // Even without a linked worktree, prune to clean up any orphaned entries
    execFileSync("git", ["worktree", "prune"], {
      cwd: sourceCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  // 3b. Remove the worktree directory if it still exists (e.g. partial creation)
  if (existsSync(targetPath)) {
    const spinner = p.spinner();
    spinner.start(`Removing worktree directory ${targetPath}...`);
    rmSync(targetPath, { recursive: true, force: true });
    spinner.stop(`Removed worktree directory ${targetPath}.`);
  }

  // 3c. Delete the local branch (now safe — worktree is gone)
  if (localBranchExists(sourceCwd, name)) {
    const spinner = p.spinner();
    spinner.start(`Deleting local branch "${name}"...`);
    try {
      const deleteFlag = opts.force ? "-D" : "-d";
      execFileSync("git", ["branch", deleteFlag, name], {
        cwd: sourceCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
      spinner.stop(`Deleted local branch "${name}".`);
    } catch (error) {
      spinner.stop(pc.yellow(`Could not delete branch "${name}".`));
      p.log.warning(extractExecSyncErrorMessage(error) ?? String(error));
    }
  }

  // 3d. Remove instance data
  if (existsSync(instanceRoot)) {
    const spinner = p.spinner();
    spinner.start(`Removing instance data at ${instanceRoot}...`);
    rmSync(instanceRoot, { recursive: true, force: true });
    spinner.stop(`Removed instance data at ${instanceRoot}.`);
  }

  p.outro(pc.green("Cleanup complete."));
}

export async function worktreeEnvCommand(opts: WorktreeEnvOptions): Promise<void> {
  const configPath = resolveConfigPath(opts.config);
  const envPath = resolvePaperclipEnvFile(configPath);
  const envEntries = readPaperclipEnvEntries(envPath);
  const out = {
    RUDDER_CONFIG: configPath,
    ...(envEntries.RUDDER_HOME ? { RUDDER_HOME: envEntries.RUDDER_HOME } : {}),
    ...(envEntries.RUDDER_INSTANCE_ID ? { RUDDER_INSTANCE_ID: envEntries.RUDDER_INSTANCE_ID } : {}),
    ...(envEntries.RUDDER_CONTEXT ? { RUDDER_CONTEXT: envEntries.RUDDER_CONTEXT } : {}),
    ...envEntries,
  };

  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.log(formatShellExports(out));
}

export type ClosableDb = ReturnType<typeof createDb> & {
  $client?: { end?: (opts?: { timeout?: number }) => Promise<void> };
};

export type OpenDbHandle = {
  db: ClosableDb;
  stop: () => Promise<void>;
};

export type ResolvedMergeCompany = {
  id: string;
  name: string;
  issuePrefix: string;
};

export async function closeDb(db: ClosableDb): Promise<void> {
  await db.$client?.end?.({ timeout: 5 }).catch(() => undefined);
}

export function resolveCurrentEndpoint(): ResolvedWorktreeEndpoint {
  return {
    rootPath: path.resolve(process.cwd()),
    configPath: resolveConfigPath(),
    label: "current",
    isCurrent: true,
  };
}

export function resolveAttachmentLookupStorages(input: {
  sourceEndpoint: ResolvedWorktreeEndpoint;
  targetEndpoint: ResolvedWorktreeEndpoint;
}): ConfiguredStorage[] {
  const orderedConfigPaths = [
    input.sourceEndpoint.configPath,
    resolveCurrentEndpoint().configPath,
    input.targetEndpoint.configPath,
    ...toMergeSourceChoices(process.cwd())
      .filter((choice) => choice.hasRudderConfig)
      .map((choice) => path.resolve(choice.worktree, ".rudder", "config.json")),
  ];
  const seen = new Set<string>();
  const storages: ConfiguredStorage[] = [];
  for (const configPath of orderedConfigPaths) {
    const resolved = path.resolve(configPath);
    if (seen.has(resolved) || !existsSync(resolved)) continue;
    seen.add(resolved);
    storages.push(openConfiguredStorage(resolved));
  }
  return storages;
}

export async function openConfiguredDb(configPath: string): Promise<OpenDbHandle> {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`Config not found at ${configPath}.`);
  }
  const envEntries = readPaperclipEnvEntries(resolvePaperclipEnvFile(configPath));
  let embeddedHandle: EmbeddedPostgresHandle | null = null;

  try {
    if (config.database.mode === "embedded-postgres") {
      embeddedHandle = await ensureEmbeddedPostgres(
        config.database.embeddedPostgresDataDir,
        config.database.embeddedPostgresPort,
      );
    }
    const connectionString = resolveSourceConnectionString(config, envEntries, embeddedHandle?.port);
    const migrationState = await inspectMigrations(connectionString);
    if (migrationState.status !== "upToDate") {
      const pending =
        migrationState.reason === "pending-migrations"
          ? ` Pending migrations: ${migrationState.pendingMigrations.join(", ")}.`
          : "";
      throw new Error(
        `Database for ${configPath} is not up to date.${pending} Run \`pnpm db:migrate\` (or start Rudder once) before using worktree merge history.`,
      );
    }
    const db = createDb(connectionString) as ClosableDb;
    return {
      db,
      stop: async () => {
        await closeDb(db);
        if (embeddedHandle?.startedByThisProcess) {
          await embeddedHandle.stop();
        }
      },
    };
  } catch (error) {
    if (embeddedHandle?.startedByThisProcess) {
      await embeddedHandle.stop().catch(() => undefined);
    }
    throw error;
  }
}
