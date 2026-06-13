import * as p from "@clack/prompts";
import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  formatDatabaseBackupResult,
  projectWorkspaces,
  runDatabaseBackup,
  runDatabaseRestore
} from "@rudderhq/db";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  promises as fsPromises,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import pc from "picocolors";
import { ensureAgentJwtSecret, loadRudderEnvFile, mergePaperclipEnvEntries, readPaperclipEnvEntries, resolvePaperclipEnvFile } from "../config/env.js";
import { expandHomePrefix } from "../config/home.js";
import type { RudderConfig } from "../config/schema.js";
import { readConfig, resolveConfigPath, writeConfig } from "../config/store.js";
import { printRudderCliBanner } from "../utils/banner.js";
import { resolveRuntimeLikePath } from "../utils/path-resolver.js";
import {
  buildWorktreeConfig,
  buildWorktreeEnvEntries,
  DEFAULT_WORKTREE_HOME,
  generateWorktreeColor,
  isWorktreeSeedMode,
  resolveSuggestedWorktreeName,
  resolveWorktreeLocalPaths,
  resolveWorktreeSeedPlan,
  sanitizeWorktreeInstanceId,
  type WorktreeLocalPaths,
  type WorktreeSeedMode
} from "./worktree-lib.js";
import type {
  CopiedGitHooksResult,
  EmbeddedPostgresCtor,
  EmbeddedPostgresHandle,
  GitWorkspaceInfo,
  SeedWorktreeDatabaseResult,
  WorktreeInitOptions,
  WorktreeMakeOptions,
} from "./worktree-types.js";

export function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isCurrentSourceConfigPath(sourceConfigPath: string): boolean {
  const currentConfigPath = process.env.RUDDER_CONFIG;
  if (!currentConfigPath || currentConfigPath.trim().length === 0) {
    return false;
  }
  return path.resolve(currentConfigPath) === path.resolve(sourceConfigPath);
}

export const WORKTREE_NAME_PREFIX = "rudder-";

export function resolveWorktreeMakeName(name: string): string {
  const value = nonEmpty(name);
  if (!value) {
    throw new Error("Worktree name is required.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      "Worktree name must contain only letters, numbers, dots, underscores, or dashes.",
    );
  }
  return value.startsWith(WORKTREE_NAME_PREFIX) ? value : `${WORKTREE_NAME_PREFIX}${value}`;
}

export function resolveWorktreeHome(explicit?: string): string {
  return explicit ?? process.env.RUDDER_WORKTREES_DIR ?? DEFAULT_WORKTREE_HOME;
}

export function resolveWorktreeStartPoint(explicit?: string): string | undefined {
  return explicit ?? nonEmpty(process.env.RUDDER_WORKTREE_START_POINT) ?? undefined;
}

export type ConfiguredStorage = {
  getObject(orgId: string, objectKey: string): Promise<Buffer>;
  putObject(orgId: string, objectKey: string, body: Buffer, contentType: string): Promise<void>;
};

export function assertStorageCompanyPrefix(orgId: string, objectKey: string): void {
  if (!objectKey.startsWith(`${orgId}/`) || objectKey.includes("..")) {
    throw new Error(`Invalid object key for company ${orgId}.`);
  }
}

export function normalizeStorageObjectKey(objectKey: string): string {
  const normalized = objectKey.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) {
    throw new Error("Invalid object key.");
  }
  const parts = normalized.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid object key.");
  }
  return parts.join("/");
}

export function resolveLocalStoragePath(baseDir: string, objectKey: string): string {
  const resolved = path.resolve(baseDir, normalizeStorageObjectKey(objectKey));
  const root = path.resolve(baseDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid object key path.");
  }
  return resolved;
}

export async function s3BodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    throw new Error("Object not found.");
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Readable) {
    return await streamToBuffer(body);
  }

  const candidate = body as {
    transformToWebStream?: () => ReadableStream<Uint8Array>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  };
  if (typeof candidate.transformToWebStream === "function") {
    const webStream = candidate.transformToWebStream();
    const reader = webStream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }
  if (typeof candidate.arrayBuffer === "function") {
    return Buffer.from(await candidate.arrayBuffer());
  }

  throw new Error("Unsupported storage response body.");
}

export function normalizeS3Prefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export function buildS3ObjectKey(prefix: string, objectKey: string): string {
  return prefix ? `${prefix}/${objectKey}` : objectKey;
}

export const dynamicImport = new Function("specifier", "return import(specifier);") as (specifier: string) => Promise<any>;

export function createConfiguredStorageFromRudderConfig(config: RudderConfig): ConfiguredStorage {
  if (config.storage.provider === "local_disk") {
    const baseDir = expandHomePrefix(config.storage.localDisk.baseDir);
    return {
      async getObject(orgId: string, objectKey: string) {
        assertStorageCompanyPrefix(orgId, objectKey);
        return await fsPromises.readFile(resolveLocalStoragePath(baseDir, objectKey));
      },
      async putObject(orgId: string, objectKey: string, body: Buffer) {
        assertStorageCompanyPrefix(orgId, objectKey);
        const filePath = resolveLocalStoragePath(baseDir, objectKey);
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(filePath, body);
      },
    };
  }

  const prefix = normalizeS3Prefix(config.storage.s3.prefix);
  let s3ClientPromise: Promise<any> | null = null;
  async function getS3Client() {
    if (!s3ClientPromise) {
      s3ClientPromise = (async () => {
        const sdk = await dynamicImport("@aws-sdk/client-s3");
        return {
          sdk,
          client: new sdk.S3Client({
            region: config.storage.s3.region,
            endpoint: config.storage.s3.endpoint,
            forcePathStyle: config.storage.s3.forcePathStyle,
          }),
        };
      })();
    }
    return await s3ClientPromise;
  }
  const bucket = config.storage.s3.bucket;
  return {
    async getObject(orgId: string, objectKey: string) {
      assertStorageCompanyPrefix(orgId, objectKey);
      const { sdk, client } = await getS3Client();
      const response = await client.send(
        new sdk.GetObjectCommand({
          Bucket: bucket,
          Key: buildS3ObjectKey(prefix, objectKey),
        }),
      );
      return await s3BodyToBuffer(response.Body);
    },
    async putObject(orgId: string, objectKey: string, body: Buffer, contentType: string) {
      assertStorageCompanyPrefix(orgId, objectKey);
      const { sdk, client } = await getS3Client();
      await client.send(
        new sdk.PutObjectCommand({
          Bucket: bucket,
          Key: buildS3ObjectKey(prefix, objectKey),
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
        }),
      );
    },
  };
}

export function openConfiguredStorage(configPath: string): ConfiguredStorage {
  const config = readConfig(configPath);
  if (!config) {
    throw new Error(`Config not found at ${configPath}.`);
  }
  return createConfiguredStorageFromRudderConfig(config);
}

export async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function isMissingStorageObjectError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown };
  return candidate.code === "ENOENT"
    || candidate.status === 404
    || candidate.name === "NoSuchKey"
    || candidate.name === "NotFound"
    || candidate.message === "Object not found.";
}

export async function readSourceAttachmentBody(
  sourceStorages: Array<Pick<ConfiguredStorage, "getObject">>,
  orgId: string,
  objectKey: string,
): Promise<Buffer | null> {
  for (const sourceStorage of sourceStorages) {
    try {
      return await sourceStorage.getObject(orgId, objectKey);
    } catch (error) {
      if (isMissingStorageObjectError(error)) {
        continue;
      }
      throw error;
    }
  }
  return null;
}

export function resolveWorktreeMakeTargetPath(name: string): string {
  return path.resolve(os.homedir(), resolveWorktreeMakeName(name));
}

export function extractExecSyncErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return error instanceof Error ? error.message : null;
  }

  const stderr = "stderr" in error ? error.stderr : null;
  if (typeof stderr === "string") {
    return nonEmpty(stderr);
  }
  if (stderr instanceof Buffer) {
    return nonEmpty(stderr.toString("utf8"));
  }

  return error instanceof Error ? nonEmpty(error.message) : null;
}

export function localBranchExists(cwd: string, branchName: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function resolveGitWorktreeAddArgs(input: {
  branchName: string;
  targetPath: string;
  branchExists: boolean;
  startPoint?: string;
}): string[] {
  if (input.branchExists && !input.startPoint) {
    return ["worktree", "add", input.targetPath, input.branchName];
  }
  const commitish = input.startPoint ?? "HEAD";
  return ["worktree", "add", "-b", input.branchName, input.targetPath, commitish];
}

export function readPidFilePort(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const lines = readFileSync(postmasterPidFile, "utf8").split("\n");
    const port = Number(lines[3]?.trim());
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export function readRunningPostmasterPid(postmasterPidFile: string): number | null {
  if (!existsSync(postmasterPidFile)) return null;
  try {
    const pid = Number(readFileSync(postmasterPidFile, "utf8").split("\n")[0]?.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function findAvailablePort(preferredPort: number, reserved = new Set<number>()): Promise<number> {
  let port = Math.max(1, Math.trunc(preferredPort));
  while (reserved.has(port) || !(await isPortAvailable(port))) {
    port += 1;
  }
  return port;
}

export function detectGitBranchName(cwd: string): string | null {
  try {
    const value = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return nonEmpty(value);
  } catch {
    return null;
  }
}

export function detectGitWorkspaceInfo(cwd: string): GitWorkspaceInfo | null {
  try {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const gitDirRaw = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const hooksPathRaw = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return {
      root: path.resolve(root),
      commonDir: path.resolve(root, commonDirRaw),
      gitDir: path.resolve(root, gitDirRaw),
      hooksPath: path.resolve(root, hooksPathRaw),
    };
  } catch {
    return null;
  }
}

export function copyDirectoryContents(sourceDir: string, targetDir: string): boolean {
  if (!existsSync(sourceDir)) return false;

  const entries = readdirSync(sourceDir, { withFileTypes: true });
  if (entries.length === 0) return false;

  mkdirSync(targetDir, { recursive: true });

  let copied = false;
  for (const entry of entries) {
    const sourcePath = path.resolve(sourceDir, entry.name);
    const targetPath = path.resolve(targetDir, entry.name);

    if (entry.isDirectory()) {
      mkdirSync(targetPath, { recursive: true });
      copyDirectoryContents(sourcePath, targetPath);
      copied = true;
      continue;
    }

    if (entry.isSymbolicLink()) {
      rmSync(targetPath, { recursive: true, force: true });
      symlinkSync(readlinkSync(sourcePath), targetPath);
      copied = true;
      continue;
    }

    copyFileSync(sourcePath, targetPath);
    try {
      chmodSync(targetPath, statSync(sourcePath).mode & 0o777);
    } catch {
      // best effort
    }
    copied = true;
  }

  return copied;
}

export function copyGitHooksToWorktreeGitDir(cwd: string): CopiedGitHooksResult | null {
  const workspace = detectGitWorkspaceInfo(cwd);
  if (!workspace) return null;

  const sourceHooksPath = workspace.hooksPath;
  const targetHooksPath = path.resolve(workspace.gitDir, "hooks");

  if (sourceHooksPath === targetHooksPath) {
    return {
      sourceHooksPath,
      targetHooksPath,
      copied: false,
    };
  }

  return {
    sourceHooksPath,
    targetHooksPath,
    copied: copyDirectoryContents(sourceHooksPath, targetHooksPath),
  };
}

export function rebindWorkspaceCwd(input: {
  sourceRepoRoot: string;
  targetRepoRoot: string;
  workspaceCwd: string;
}): string | null {
  const sourceRepoRoot = path.resolve(input.sourceRepoRoot);
  const targetRepoRoot = path.resolve(input.targetRepoRoot);
  const workspaceCwd = path.resolve(input.workspaceCwd);
  const relative = path.relative(sourceRepoRoot, workspaceCwd);
  if (!relative || relative === "") {
    return targetRepoRoot;
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return path.resolve(targetRepoRoot, relative);
}

export async function rebindSeededProjectWorkspaces(input: {
  targetConnectionString: string;
  currentCwd: string;
}): Promise<SeedWorktreeDatabaseResult["reboundWorkspaces"]> {
  const targetRepo = detectGitWorkspaceInfo(input.currentCwd);
  if (!targetRepo) return [];

  const db = createDb(input.targetConnectionString);
  const closableDb = db as typeof db & {
    $client?: { end?: (opts?: { timeout?: number }) => Promise<void> };
  };

  try {
    const rows = await db
      .select({
        id: projectWorkspaces.id,
        name: projectWorkspaces.name,
        cwd: projectWorkspaces.cwd,
      })
      .from(projectWorkspaces);

    const rebound: SeedWorktreeDatabaseResult["reboundWorkspaces"] = [];
    for (const row of rows) {
      const workspaceCwd = nonEmpty(row.cwd);
      if (!workspaceCwd) continue;

      const sourceRepo = detectGitWorkspaceInfo(workspaceCwd);
      if (!sourceRepo) continue;
      if (sourceRepo.commonDir !== targetRepo.commonDir) continue;

      const reboundCwd = rebindWorkspaceCwd({
        sourceRepoRoot: sourceRepo.root,
        targetRepoRoot: targetRepo.root,
        workspaceCwd,
      });
      if (!reboundCwd) continue;

      const normalizedCurrent = path.resolve(workspaceCwd);
      if (reboundCwd === normalizedCurrent) continue;
      if (!existsSync(reboundCwd)) continue;

      await db
        .update(projectWorkspaces)
        .set({
          cwd: reboundCwd,
          updatedAt: new Date(),
        })
        .where(eq(projectWorkspaces.id, row.id));

      rebound.push({
        name: row.name,
        fromCwd: normalizedCurrent,
        toCwd: reboundCwd,
      });
    }

    return rebound;
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

export function resolveSourceConfigPath(opts: WorktreeInitOptions): string {
  if (opts.sourceConfigPathOverride) return path.resolve(opts.sourceConfigPathOverride);
  if (opts.fromConfig) return path.resolve(opts.fromConfig);
  if (!opts.fromDataDir && !opts.fromInstance) {
    return resolveConfigPath();
  }
  const sourceHome = path.resolve(expandHomePrefix(opts.fromDataDir ?? "~/.rudder"));
  const sourceInstanceId = sanitizeWorktreeInstanceId(opts.fromInstance ?? "default");
  return path.resolve(sourceHome, "instances", sourceInstanceId, "config.json");
}

export function resolveSourceConnectionString(config: RudderConfig, envEntries: Record<string, string>, portOverride?: number): string {
  if (config.database.mode === "postgres") {
    const connectionString = nonEmpty(envEntries.DATABASE_URL) ?? nonEmpty(config.database.connectionString);
    if (!connectionString) {
      throw new Error(
        "Source instance uses postgres mode but has no connection string in config or adjacent .env.",
      );
    }
    return connectionString;
  }

  const port = portOverride ?? config.database.embeddedPostgresPort;
  return `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
}

export function copySeededSecretsKey(input: {
  sourceConfigPath: string;
  sourceConfig: RudderConfig;
  sourceEnvEntries: Record<string, string>;
  targetKeyFilePath: string;
}): void {
  if (input.sourceConfig.secrets.provider !== "local_encrypted") {
    return;
  }

  mkdirSync(path.dirname(input.targetKeyFilePath), { recursive: true });

  const allowProcessEnvFallback = isCurrentSourceConfigPath(input.sourceConfigPath);
  const sourceInlineMasterKey =
    nonEmpty(input.sourceEnvEntries.RUDDER_SECRETS_MASTER_KEY) ??
    (allowProcessEnvFallback ? nonEmpty(process.env.RUDDER_SECRETS_MASTER_KEY) : null);
  if (sourceInlineMasterKey) {
    writeFileSync(input.targetKeyFilePath, sourceInlineMasterKey, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(input.targetKeyFilePath, 0o600);
    } catch {
      // best effort
    }
    return;
  }

  const sourceKeyFileOverride =
    nonEmpty(input.sourceEnvEntries.RUDDER_SECRETS_MASTER_KEY_FILE) ??
    (allowProcessEnvFallback ? nonEmpty(process.env.RUDDER_SECRETS_MASTER_KEY_FILE) : null);
  const sourceConfiguredKeyPath = sourceKeyFileOverride ?? input.sourceConfig.secrets.localEncrypted.keyFilePath;
  const sourceKeyFilePath = resolveRuntimeLikePath(sourceConfiguredKeyPath, input.sourceConfigPath);

  if (!existsSync(sourceKeyFilePath)) {
    throw new Error(
      `Cannot seed worktree database because source local_encrypted secrets key was not found at ${sourceKeyFilePath}.`,
    );
  }

  copyFileSync(sourceKeyFilePath, input.targetKeyFilePath);
  try {
    chmodSync(input.targetKeyFilePath, 0o600);
  } catch {
    // best effort
  }
}

export async function ensureEmbeddedPostgres(dataDir: string, preferredPort: number): Promise<EmbeddedPostgresHandle> {
  const moduleName = "embedded-postgres";
  let EmbeddedPostgres: EmbeddedPostgresCtor;
  try {
    const mod = await import(moduleName);
    EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  } catch {
    throw new Error(
      "Embedded PostgreSQL support requires dependency `embedded-postgres`. Reinstall dependencies and try again.",
    );
  }

  const postmasterPidFile = path.resolve(dataDir, "postmaster.pid");
  const runningPid = readRunningPostmasterPid(postmasterPidFile);
  if (runningPid) {
    return {
      port: readPidFilePort(postmasterPidFile) ?? preferredPort,
      startedByThisProcess: false,
      stop: async () => {},
    };
  }

  const port = await findAvailablePort(preferredPort);
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });

  if (!existsSync(path.resolve(dataDir, "PG_VERSION"))) {
    await instance.initialise();
  }
  if (existsSync(postmasterPidFile)) {
    rmSync(postmasterPidFile, { force: true });
  }
  await instance.start();

  return {
    port,
    startedByThisProcess: true,
    stop: async () => {
      await instance.stop();
    },
  };
}

export async function seedWorktreeDatabase(input: {
  sourceConfigPath: string;
  sourceConfig: RudderConfig;
  targetConfig: RudderConfig;
  targetPaths: WorktreeLocalPaths;
  instanceId: string;
  seedMode: WorktreeSeedMode;
}): Promise<SeedWorktreeDatabaseResult> {
  const seedPlan = resolveWorktreeSeedPlan(input.seedMode);
  const sourceEnvFile = resolvePaperclipEnvFile(input.sourceConfigPath);
  const sourceEnvEntries = readPaperclipEnvEntries(sourceEnvFile);
  copySeededSecretsKey({
    sourceConfigPath: input.sourceConfigPath,
    sourceConfig: input.sourceConfig,
    sourceEnvEntries,
    targetKeyFilePath: input.targetPaths.secretsKeyFilePath,
  });
  let sourceHandle: EmbeddedPostgresHandle | null = null;
  let targetHandle: EmbeddedPostgresHandle | null = null;

  try {
    if (input.sourceConfig.database.mode === "embedded-postgres") {
      sourceHandle = await ensureEmbeddedPostgres(
        input.sourceConfig.database.embeddedPostgresDataDir,
        input.sourceConfig.database.embeddedPostgresPort,
      );
    }
    const sourceConnectionString = resolveSourceConnectionString(
      input.sourceConfig,
      sourceEnvEntries,
      sourceHandle?.port,
    );
    const backup = await runDatabaseBackup({
      connectionString: sourceConnectionString,
      backupDir: path.resolve(input.targetPaths.backupDir, "seed"),
      retentionDays: 7,
      filenamePrefix: `${input.instanceId}-seed`,
      includeMigrationJournal: true,
      excludeTables: seedPlan.excludedTables,
      nullifyColumns: seedPlan.nullifyColumns,
    });

    targetHandle = await ensureEmbeddedPostgres(
      input.targetConfig.database.embeddedPostgresDataDir,
      input.targetConfig.database.embeddedPostgresPort,
    );

    const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${targetHandle.port}/postgres`;
    await ensurePostgresDatabase(adminConnectionString, "rudder");
    const targetConnectionString = `postgres://rudder:rudder@127.0.0.1:${targetHandle.port}/rudder`;
    await runDatabaseRestore({
      connectionString: targetConnectionString,
      backupFile: backup.backupFile,
    });
    await applyPendingMigrations(targetConnectionString);
    const reboundWorkspaces = await rebindSeededProjectWorkspaces({
      targetConnectionString,
      currentCwd: input.targetPaths.cwd,
    });

    return {
      backupSummary: formatDatabaseBackupResult(backup),
      reboundWorkspaces,
    };
  } finally {
    if (targetHandle?.startedByThisProcess) {
      await targetHandle.stop();
    }
    if (sourceHandle?.startedByThisProcess) {
      await sourceHandle.stop();
    }
  }
}

export async function runWorktreeInit(opts: WorktreeInitOptions): Promise<void> {
  const cwd = process.cwd();
  const worktreeName = resolveSuggestedWorktreeName(
    cwd,
    opts.name ?? detectGitBranchName(cwd) ?? undefined,
  );
  const seedMode = opts.seedMode ?? "minimal";
  if (!isWorktreeSeedMode(seedMode)) {
    throw new Error(`Unsupported seed mode "${seedMode}". Expected one of: minimal, full.`);
  }
  const instanceId = sanitizeWorktreeInstanceId(opts.instance ?? worktreeName);
  const paths = resolveWorktreeLocalPaths({
    cwd,
    homeDir: resolveWorktreeHome(opts.home),
    instanceId,
  });
  const branding = {
    name: worktreeName,
    color: generateWorktreeColor(),
  };
  const sourceConfigPath = resolveSourceConfigPath(opts);
  const sourceConfig = existsSync(sourceConfigPath) ? readConfig(sourceConfigPath) : null;

  if ((existsSync(paths.configPath) || existsSync(paths.instanceRoot)) && !opts.force) {
    throw new Error(
      `Worktree config already exists at ${paths.configPath} or instance data exists at ${paths.instanceRoot}. Re-run with --force to replace it.`,
    );
  }

  if (opts.force) {
    rmSync(paths.repoConfigDir, { recursive: true, force: true });
    rmSync(paths.instanceRoot, { recursive: true, force: true });
  }

  const preferredServerPort = opts.serverPort ?? ((sourceConfig?.server.port ?? 3100) + 1);
  const serverPort = await findAvailablePort(preferredServerPort);
  const preferredDbPort = opts.dbPort ?? ((sourceConfig?.database.embeddedPostgresPort ?? 54329) + 1);
  const databasePort = await findAvailablePort(preferredDbPort, new Set([serverPort]));
  const targetConfig = buildWorktreeConfig({
    sourceConfig,
    paths,
    serverPort,
    databasePort,
  });

  writeConfig(targetConfig, paths.configPath);
  const sourceEnvEntries = readPaperclipEnvEntries(resolvePaperclipEnvFile(sourceConfigPath));
  const existingAgentJwtSecret =
    nonEmpty(sourceEnvEntries.RUDDER_AGENT_JWT_SECRET) ??
    nonEmpty(process.env.RUDDER_AGENT_JWT_SECRET);
  mergePaperclipEnvEntries(
    {
      ...buildWorktreeEnvEntries(paths, branding),
      ...(existingAgentJwtSecret ? { RUDDER_AGENT_JWT_SECRET: existingAgentJwtSecret } : {}),
    },
    paths.envPath,
  );
  ensureAgentJwtSecret(paths.configPath);
  loadRudderEnvFile(paths.configPath);
  const copiedGitHooks = copyGitHooksToWorktreeGitDir(cwd);

  let seedSummary: string | null = null;
  let reboundWorkspaceSummary: SeedWorktreeDatabaseResult["reboundWorkspaces"] = [];
  if (opts.seed !== false) {
    if (!sourceConfig) {
      throw new Error(
        `Cannot seed worktree database because source config was not found at ${sourceConfigPath}. Use --no-seed or provide --from-config.`,
      );
    }
    const spinner = p.spinner();
    spinner.start(`Seeding isolated worktree database from source instance (${seedMode})...`);
    try {
      const seeded = await seedWorktreeDatabase({
        sourceConfigPath,
        sourceConfig,
        targetConfig,
        targetPaths: paths,
        instanceId,
        seedMode,
      });
      seedSummary = seeded.backupSummary;
      reboundWorkspaceSummary = seeded.reboundWorkspaces;
      spinner.stop(`Seeded isolated worktree database (${seedMode}).`);
    } catch (error) {
      spinner.stop(pc.red("Failed to seed worktree database."));
      throw error;
    }
  }

  p.log.message(pc.dim(`Repo config: ${paths.configPath}`));
  p.log.message(pc.dim(`Repo env: ${paths.envPath}`));
  p.log.message(pc.dim(`Isolated home: ${paths.homeDir}`));
  p.log.message(pc.dim(`Instance: ${paths.instanceId}`));
  p.log.message(pc.dim(`Worktree badge: ${branding.name} (${branding.color})`));
  p.log.message(pc.dim(`Server port: ${serverPort} | DB port: ${databasePort}`));
  if (copiedGitHooks?.copied) {
    p.log.message(
      pc.dim(`Mirrored git hooks: ${copiedGitHooks.sourceHooksPath} -> ${copiedGitHooks.targetHooksPath}`),
    );
  }
  if (seedSummary) {
    p.log.message(pc.dim(`Seed mode: ${seedMode}`));
    p.log.message(pc.dim(`Seed snapshot: ${seedSummary}`));
    for (const rebound of reboundWorkspaceSummary) {
      p.log.message(
        pc.dim(`Rebound workspace ${rebound.name}: ${rebound.fromCwd} -> ${rebound.toCwd}`),
      );
    }
  }
  p.outro(
    pc.green(
      `Worktree ready. Run Rudder inside this repo and the CLI/server will use ${paths.instanceId} automatically.`,
    ),
  );
}

export async function worktreeInitCommand(opts: WorktreeInitOptions): Promise<void> {
  printRudderCliBanner();
  p.intro(pc.bgCyan(pc.black(" rudder worktree init ")));
  await runWorktreeInit(opts);
}

export async function worktreeMakeCommand(nameArg: string, opts: WorktreeMakeOptions): Promise<void> {
  printRudderCliBanner();
  p.intro(pc.bgCyan(pc.black(" rudder worktree:make ")));

  const name = resolveWorktreeMakeName(nameArg);
  const startPoint = resolveWorktreeStartPoint(opts.startPoint);
  const sourceCwd = process.cwd();
  const sourceConfigPath = resolveSourceConfigPath(opts);
  const targetPath = resolveWorktreeMakeTargetPath(name);
  if (existsSync(targetPath)) {
    throw new Error(`Target path already exists: ${targetPath}`);
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  if (startPoint) {
    const [remote] = startPoint.split("/", 1);
    try {
      execFileSync("git", ["fetch", remote], {
        cwd: sourceCwd,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(
        `Failed to fetch from remote "${remote}": ${extractExecSyncErrorMessage(error) ?? String(error)}`,
      );
    }
  }

  const worktreeArgs = resolveGitWorktreeAddArgs({
    branchName: name,
    targetPath,
    branchExists: !startPoint && localBranchExists(sourceCwd, name),
    startPoint,
  });

  const spinner = p.spinner();
  spinner.start(`Creating git worktree at ${targetPath}...`);
  try {
    execFileSync("git", worktreeArgs, {
      cwd: sourceCwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    spinner.stop(`Created git worktree at ${targetPath}.`);
  } catch (error) {
    spinner.stop(pc.red("Failed to create git worktree."));
    throw new Error(extractExecSyncErrorMessage(error) ?? String(error));
  }

  const installSpinner = p.spinner();
  installSpinner.start("Installing dependencies...");
  try {
    execFileSync("pnpm", ["install"], {
      cwd: targetPath,
      stdio: ["ignore", "pipe", "pipe"],
    });
    installSpinner.stop("Installed dependencies.");
  } catch (error) {
    installSpinner.stop(pc.yellow("Failed to install dependencies (continuing anyway)."));
    p.log.warning(extractExecSyncErrorMessage(error) ?? String(error));
  }

  const originalCwd = process.cwd();
  try {
    process.chdir(targetPath);
    await runWorktreeInit({
      ...opts,
      name,
      sourceConfigPathOverride: sourceConfigPath,
    });
  } catch (error) {
    throw error;
  } finally {
    process.chdir(originalCwd);
  }
}
