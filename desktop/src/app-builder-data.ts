import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  copyDirectoryWithoutLinks,
  readJsonFileBounded,
  writeJsonAtomically,
} from "./app-builder-file-tree.js";
import { assertAppBuilderAppId } from "./app-builder-manifest.js";

const DATA_PACKAGE_FILENAME = "rudder-data.json";
const SAFE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

interface DataPackageFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AppBuilderDataPackageManifest {
  schemaVersion: 1;
  kind: "rudder-app-data";
  appId: string;
  createdAt: string;
  files: DataPackageFile[];
}

export interface AppBuilderDataSnapshot {
  id: string;
  root: string;
  manifest: AppBuilderDataPackageManifest;
}

interface AppBuilderDataManagerDependencies {
  now?: () => Date;
  randomId?: () => string;
  writeCurrentRelease?: (filePath: string, value: unknown) => Promise<void>;
  cleanupBackup?: (directory: string) => Promise<void>;
}

function assertSafeId(value: string, label: string): string {
  if (!SAFE_ID_PATTERN.test(value)) {
    throw new Error(`${label} has an invalid format`);
  }
  return value;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function parsePackageManifest(value: unknown): AppBuilderDataPackageManifest {
  assertPlainObject(value, "data package manifest");
  if (
    value.schemaVersion !== 1
    || value.kind !== "rudder-app-data"
    || typeof value.appId !== "string"
    || typeof value.createdAt !== "string"
    || !Array.isArray(value.files)
  ) {
    throw new Error("invalid data package manifest");
  }
  const appId = assertAppBuilderAppId(value.appId, "data package app id");
  if (!Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("invalid data package creation time");
  }

  const files = value.files.map((entry, index) => {
    assertPlainObject(entry, `data package file ${index}`);
    if (
      typeof entry.path !== "string"
      || !entry.path
      || path.posix.isAbsolute(entry.path)
      || entry.path.includes("\\")
      || entry.path.split("/").includes("..")
      || typeof entry.bytes !== "number"
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      throw new Error(`invalid data package file ${index}`);
    }
    return {
      path: entry.path,
      bytes: entry.bytes,
      sha256: entry.sha256,
    };
  });

  const sortedPaths = files.map((entry) => entry.path).sort((left, right) => left.localeCompare(right));
  if (
    new Set(sortedPaths).size !== sortedPaths.length
    || files.some((entry, index) => entry.path !== sortedPaths[index])
  ) {
    throw new Error("data package file list must be unique and sorted");
  }
  return {
    schemaVersion: 1,
    kind: "rudder-app-data",
    appId,
    createdAt: new Date(value.createdAt).toISOString(),
    files,
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function inventoryDirectory(root: string): Promise<DataPackageFile[]> {
  const files: DataPackageFile[] = [];
  let entryCount = 0;
  let totalBytes = 0;

  async function visit(relativeDirectory: string, depth: number): Promise<void> {
    if (depth > 32) {
      throw new Error("data directory exceeds maximum depth");
    }
    const directory = relativeDirectory ? path.join(root, relativeDirectory) : root;
    const entries = await readdir(directory);
    entries.sort((left, right) => left.localeCompare(right));
    for (const name of entries) {
      const relativePath = relativeDirectory ? path.join(relativeDirectory, name) : name;
      const absolutePath = path.join(root, relativePath);
      const entryStat = await lstat(absolutePath);
      entryCount += 1;
      if (entryCount > 4_096) throw new Error("data directory contains too many entries");
      if (entryStat.isSymbolicLink()) {
        throw new Error(`data directory contains a symbolic link: ${relativePath}`);
      }
      if (entryStat.isDirectory()) {
        await visit(relativePath, depth + 1);
      } else if (entryStat.isFile()) {
        if (entryStat.size > 256 * 1024 * 1024) throw new Error(`data file is too large: ${relativePath}`);
        totalBytes += entryStat.size;
        if (totalBytes > 512 * 1024 * 1024) throw new Error("data directory is too large");
        files.push({
          path: relativePath.split(path.sep).join("/"),
          bytes: entryStat.size,
          sha256: await sha256File(absolutePath),
        });
      } else {
        throw new Error(`data directory contains an unsupported entry: ${relativePath}`);
      }
    }
  }

  await visit("", 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertRegularDirectory(directory: string, label: string): Promise<void> {
  const directoryStat = await lstat(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".."
      && !path.isAbsolute(relative));
}

function assertDirectoriesDoNotOverlap(first: string, second: string, label: string): void {
  if (isInside(first, second) || isInside(second, first)) {
    throw new Error(`${label} must not overlap`);
  }
}

export class AppBuilderDataManager {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly writeCurrentRelease: (filePath: string, value: unknown) => Promise<void>;
  private readonly cleanupBackup: (directory: string) => Promise<void>;
  private readonly appOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly stateRoot: string,
    dependencies: AppBuilderDataManagerDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
    this.writeCurrentRelease = dependencies.writeCurrentRelease ?? writeJsonAtomically;
    this.cleanupBackup = dependencies.cleanupBackup
      ?? ((directory) => rm(directory, { recursive: true, force: true }));
  }

  private nextSafeId(label: string): string {
    return assertSafeId(this.randomId(), label);
  }

  private async appStateRoot(appKey: string): Promise<string> {
    const safeAppKey = assertSafeId(appKey, "app binding id");
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    const canonicalStateRoot = await realpath(this.stateRoot);
    const appRoot = path.join(canonicalStateRoot, "apps", safeAppKey);
    await mkdir(appRoot, { recursive: true, mode: 0o700 });
    return appRoot;
  }

  private async withAppOperation<T>(appKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.appOperations.get(appKey) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.appOperations.set(appKey, settled);
    try {
      return await result;
    } finally {
      if (this.appOperations.get(appKey) === settled) this.appOperations.delete(appKey);
    }
  }

  private async snapshotInternal(
    appKey: string,
    appId: string,
    dataRoot: string,
  ): Promise<AppBuilderDataSnapshot> {
    await assertRegularDirectory(dataRoot, "data root");
    const canonicalDataRoot = await realpath(dataRoot);
    const appStateRoot = await this.appStateRoot(appKey);
    assertDirectoriesDoNotOverlap(canonicalDataRoot, appStateRoot, "data and App Builder state");
    const snapshotsRoot = path.join(appStateRoot, "snapshots");
    await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });

    const id = `${this.now().toISOString().replace(/[:.]/g, "-")}-${this.nextSafeId("snapshot id")}`;
    const snapshotRoot = path.join(snapshotsRoot, id);
    const stagingRoot = await mkdtemp(path.join(snapshotsRoot, ".snapshot-"));
    try {
      const stagedDataRoot = path.join(stagingRoot, "data");
      await copyDirectoryWithoutLinks(canonicalDataRoot, stagedDataRoot);
      const manifest: AppBuilderDataPackageManifest = {
        schemaVersion: 1,
        kind: "rudder-app-data",
        appId: assertAppBuilderAppId(appId),
        createdAt: this.now().toISOString(),
        files: await inventoryDirectory(stagedDataRoot),
      };
      await writeJsonAtomically(path.join(stagingRoot, DATA_PACKAGE_FILENAME), manifest);
      await rename(stagingRoot, snapshotRoot);
      return { id, root: snapshotRoot, manifest };
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async snapshot(appKey: string, appId: string, dataRoot: string): Promise<AppBuilderDataSnapshot> {
    return this.withAppOperation(appKey, () => this.snapshotInternal(appKey, appId, dataRoot));
  }

  async validatePackage(
    packageRoot: string,
    expectedAppId?: string,
  ): Promise<AppBuilderDataPackageManifest> {
    await assertRegularDirectory(packageRoot, "data package");
    const canonicalPackageRoot = await realpath(packageRoot);
    const dataRoot = path.join(canonicalPackageRoot, "data");
    await assertRegularDirectory(dataRoot, "data package contents");
    const manifest = parsePackageManifest(
      await readJsonFileBounded(path.join(canonicalPackageRoot, DATA_PACKAGE_FILENAME)),
    );
    if (expectedAppId && manifest.appId !== assertAppBuilderAppId(expectedAppId)) {
      throw new Error("data package belongs to another app");
    }
    const actualFiles = await inventoryDirectory(dataRoot);
    if (JSON.stringify(actualFiles) !== JSON.stringify(manifest.files)) {
      throw new Error("data package integrity check failed");
    }
    return manifest;
  }

  async getSnapshot(appKey: string, appId: string, snapshotId: string): Promise<AppBuilderDataSnapshot> {
    const appStateRoot = await this.appStateRoot(appKey);
    const id = assertSafeId(snapshotId, "snapshot id");
    const root = path.join(appStateRoot, "snapshots", id);
    const manifest = await this.validatePackage(root, appId);
    return { id, root, manifest };
  }

  async exportSnapshot(snapshotRoot: string, destinationRoot: string): Promise<void> {
    await this.validatePackage(snapshotRoot);
    const canonicalSnapshotRoot = await realpath(snapshotRoot);
    let canonicalDestinationRoot: string;
    const destinationExisted = await pathExists(destinationRoot);
    if (destinationExisted) {
      await assertRegularDirectory(destinationRoot, "export destination");
      canonicalDestinationRoot = await realpath(destinationRoot);
      if ((await readdir(destinationRoot)).length > 0) {
        throw new Error("export destination must be empty");
      }
    } else {
      canonicalDestinationRoot = path.join(
        await realpath(path.dirname(destinationRoot)),
        path.basename(destinationRoot),
      );
    }
    assertDirectoriesDoNotOverlap(
      canonicalSnapshotRoot,
      canonicalDestinationRoot,
      "snapshot and export destination",
    );
    if (destinationExisted) await rmdir(destinationRoot);

    try {
      await copyDirectoryWithoutLinks(canonicalSnapshotRoot, canonicalDestinationRoot);
      await this.validatePackage(canonicalDestinationRoot);
    } catch (error) {
      await rm(canonicalDestinationRoot, { recursive: true, force: true });
      if (destinationExisted) await mkdir(canonicalDestinationRoot);
      throw error;
    }
  }

  async importPackage(options: {
    appKey: string;
    appId: string;
    packageRoot: string;
    dataRoot: string;
    activate?: (dataRoot: string) => Promise<void>;
  }): Promise<AppBuilderDataSnapshot> {
    return this.withAppOperation(options.appKey, () => this.importPackageInternal(options));
  }

  private async importPackageInternal(options: {
    appKey: string;
    appId: string;
    packageRoot: string;
    dataRoot: string;
    activate?: (dataRoot: string) => Promise<void>;
  }): Promise<AppBuilderDataSnapshot> {
    const packageManifest = await this.validatePackage(options.packageRoot, options.appId);
    const canonicalPackageRoot = await realpath(options.packageRoot);
    const canonicalDataRoot = await realpath(options.dataRoot);
    assertDirectoriesDoNotOverlap(
      canonicalPackageRoot,
      canonicalDataRoot,
      "data package and live data",
    );
    const rollbackSnapshot = await this.snapshotInternal(options.appKey, options.appId, options.dataRoot);
    const dataParent = await realpath(path.dirname(options.dataRoot));
    const stagingRoot = await mkdtemp(path.join(dataParent, ".rudder-import-"));
    const backupRoot = path.join(dataParent, `.rudder-import-backup-${this.nextSafeId("import id")}`);
    await rm(stagingRoot, { recursive: true, force: true });
    await copyDirectoryWithoutLinks(
      path.join(canonicalPackageRoot, "data"),
      stagingRoot,
    );
    if (JSON.stringify(await inventoryDirectory(stagingRoot)) !== JSON.stringify(packageManifest.files)) {
      await rm(stagingRoot, { recursive: true, force: true });
      throw new Error("data package changed while it was being imported");
    }

    let movedCurrent = false;
    let activated = false;
    try {
      await rename(options.dataRoot, backupRoot);
      movedCurrent = true;
      await rename(stagingRoot, options.dataRoot);
      activated = true;
      await options.activate?.(options.dataRoot);
    } catch (error) {
      if (activated) {
        await rm(options.dataRoot, { recursive: true, force: true });
      } else {
        await rm(stagingRoot, { recursive: true, force: true });
      }
      if (movedCurrent) {
        await rename(backupRoot, options.dataRoot);
      }
      throw error;
    }
    await this.cleanupBackup(backupRoot).catch(() => undefined);
    return rollbackSnapshot;
  }

  async promoteRelease(options: {
    appKey: string;
    appId: string;
    releaseId: string;
    releaseSourceRoot: string;
    dataRoot: string;
    migrate?: (stagedDataRoot: string, stagedReleaseRoot: string) => Promise<void>;
  }): Promise<{ releaseRoot: string; rollbackSnapshot: AppBuilderDataSnapshot }> {
    return this.withAppOperation(options.appKey, () => this.promoteReleaseInternal(options));
  }

  private async promoteReleaseInternal(options: {
    appKey: string;
    appId: string;
    releaseId: string;
    releaseSourceRoot: string;
    dataRoot: string;
    migrate?: (stagedDataRoot: string, stagedReleaseRoot: string) => Promise<void>;
  }): Promise<{ releaseRoot: string; rollbackSnapshot: AppBuilderDataSnapshot }> {
    const appId = assertAppBuilderAppId(options.appId);
    const releaseId = assertSafeId(options.releaseId, "release id");
    await assertRegularDirectory(options.releaseSourceRoot, "release source");
    await assertRegularDirectory(options.dataRoot, "data root");
    const canonicalReleaseSourceRoot = await realpath(options.releaseSourceRoot);
    const canonicalDataRoot = await realpath(options.dataRoot);
    assertDirectoriesDoNotOverlap(
      canonicalReleaseSourceRoot,
      canonicalDataRoot,
      "release source and live data",
    );

    const appStateRoot = await this.appStateRoot(options.appKey);
    const releasesRoot = path.join(appStateRoot, "releases");
    await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
    const releaseRoot = path.join(releasesRoot, releaseId);
    if (await pathExists(releaseRoot)) {
      throw new Error("release id already exists");
    }
    const rollbackSnapshot = await this.snapshotInternal(options.appKey, appId, options.dataRoot);

    const stagedReleaseRoot = await mkdtemp(path.join(releasesRoot, ".release-"));
    await rm(stagedReleaseRoot, { recursive: true, force: true });
    const dataParent = await realpath(path.dirname(options.dataRoot));
    const stagedDataRoot = await mkdtemp(path.join(dataParent, ".rudder-promotion-data-"));
    await rm(stagedDataRoot, { recursive: true, force: true });
    try {
      await copyDirectoryWithoutLinks(canonicalReleaseSourceRoot, stagedReleaseRoot);
      await copyDirectoryWithoutLinks(options.dataRoot, stagedDataRoot);
      await options.migrate?.(stagedDataRoot, stagedReleaseRoot);
    } catch (error) {
      await Promise.all([
        rm(stagedReleaseRoot, { recursive: true, force: true }),
        rm(stagedDataRoot, { recursive: true, force: true }),
      ]);
      throw error;
    }

    const backupDataRoot = path.join(
      dataParent,
      `.rudder-promotion-backup-${this.nextSafeId("promotion id")}`,
    );
    const currentReleasePath = path.join(appStateRoot, "current-release.json");
    const previousPointer = await pathExists(currentReleasePath)
      ? await readFile(currentReleasePath)
      : null;
    let installedRelease = false;
    let movedData = false;
    let activatedData = false;
    try {
      await rename(stagedReleaseRoot, releaseRoot);
      installedRelease = true;
      await rename(options.dataRoot, backupDataRoot);
      movedData = true;
      await rename(stagedDataRoot, options.dataRoot);
      activatedData = true;
      await this.writeCurrentRelease(currentReleasePath, {
        schemaVersion: 1,
        appId,
        releaseId,
        promotedAt: this.now().toISOString(),
      });
    } catch (error) {
      if (activatedData) {
        await rm(options.dataRoot, { recursive: true, force: true });
      } else {
        await rm(stagedDataRoot, { recursive: true, force: true });
      }
      if (movedData) {
        await rename(backupDataRoot, options.dataRoot);
      }
      if (installedRelease) {
        await rm(releaseRoot, { recursive: true, force: true });
      } else {
        await rm(stagedReleaseRoot, { recursive: true, force: true });
      }
      if (previousPointer) {
        await writeFile(currentReleasePath, previousPointer, { flag: "w", mode: 0o600 });
      } else {
        await rm(currentReleasePath, { force: true });
      }
      throw error;
    }
    await this.cleanupBackup(backupDataRoot).catch(() => undefined);
    return { releaseRoot, rollbackSnapshot };
  }

  async restoreSnapshot(options: {
    appKey: string;
    appId: string;
    snapshotId: string;
    dataRoot: string;
  }): Promise<{ safetySnapshot: AppBuilderDataSnapshot }> {
    return this.withAppOperation(options.appKey, async () => {
      const snapshot = await this.getSnapshot(options.appKey, options.appId, options.snapshotId);
      const safetySnapshot = await this.snapshotInternal(
        options.appKey,
        options.appId,
        options.dataRoot,
      );
      await this.restoreSnapshotInternal(snapshot, options.dataRoot);
      return { safetySnapshot };
    });
  }

  async rollbackRelease(options: {
    appKey: string;
    appId: string;
    snapshotId: string;
    targetReleaseId: string | null;
    dataRoot: string;
  }): Promise<{ safetySnapshot: AppBuilderDataSnapshot }> {
    return this.withAppOperation(options.appKey, async () => {
      const appStateRoot = await this.appStateRoot(options.appKey);
      const targetReleaseId = options.targetReleaseId === null
        ? null
        : assertSafeId(options.targetReleaseId, "target release id");
      if (targetReleaseId) {
        await assertRegularDirectory(
          path.join(appStateRoot, "releases", targetReleaseId),
          "rollback release",
        );
      }
      const snapshot = await this.getSnapshot(options.appKey, options.appId, options.snapshotId);
      const safetySnapshot = await this.snapshotInternal(
        options.appKey,
        options.appId,
        options.dataRoot,
      );
      const currentReleasePath = path.join(appStateRoot, "current-release.json");
      const previousPointer = await pathExists(currentReleasePath)
        ? await readFile(currentReleasePath)
        : null;
      await this.restoreSnapshotInternal(snapshot, options.dataRoot, async () => {
        if (targetReleaseId) {
          await this.writeCurrentRelease(currentReleasePath, {
            schemaVersion: 1,
            appId: assertAppBuilderAppId(options.appId),
            releaseId: targetReleaseId,
            promotedAt: this.now().toISOString(),
            rollbackFromSnapshotId: snapshot.id,
          });
        } else {
          await rm(currentReleasePath, { force: true });
        }
      }, async () => {
        if (previousPointer) {
          await writeFile(currentReleasePath, previousPointer, { flag: "w", mode: 0o600 });
        } else {
          await rm(currentReleasePath, { force: true });
        }
      });
      return { safetySnapshot };
    });
  }

  private async restoreSnapshotInternal(
    snapshot: AppBuilderDataSnapshot,
    dataRoot: string,
    commitMetadata?: () => Promise<void>,
    rollbackMetadata?: () => Promise<void>,
  ): Promise<void> {
    await assertRegularDirectory(dataRoot, "data root");
    const dataParent = await realpath(path.dirname(dataRoot));
    const stagedDataRoot = await mkdtemp(path.join(dataParent, ".rudder-restore-data-"));
    await rm(stagedDataRoot, { recursive: true, force: true });
    await copyDirectoryWithoutLinks(path.join(snapshot.root, "data"), stagedDataRoot);
    if (JSON.stringify(await inventoryDirectory(stagedDataRoot)) !== JSON.stringify(snapshot.manifest.files)) {
      await rm(stagedDataRoot, { recursive: true, force: true });
      throw new Error("snapshot changed while it was being restored");
    }
    const backupDataRoot = path.join(
      dataParent,
      `.rudder-restore-backup-${this.nextSafeId("restore id")}`,
    );
    let movedData = false;
    let activatedData = false;
    try {
      await rename(dataRoot, backupDataRoot);
      movedData = true;
      await rename(stagedDataRoot, dataRoot);
      activatedData = true;
      await commitMetadata?.();
    } catch (error) {
      if (activatedData) await rm(dataRoot, { recursive: true, force: true });
      else await rm(stagedDataRoot, { recursive: true, force: true });
      if (movedData) await rename(backupDataRoot, dataRoot);
      await rollbackMetadata?.();
      throw error;
    }
    await this.cleanupBackup(backupDataRoot).catch(() => undefined);
  }
}
