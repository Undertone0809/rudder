import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupStaleBrowserImportTempDirectories,
  createPrivateBrowserImportTempDirectory,
  createStableCookieDatabaseSnapshot,
  deriveBrowserImportOwnerId,
} from "./browser-import-snapshot.js";

const tempRoots: string[] = [];
const importOwnerA = "a".repeat(64);
const importOwnerB = "b".repeat(64);
const ownerMarkerName = ".rudder-browser-import-owner-v1.json";

function importDirectory(root: string, ownerId: string, suffix: string): string {
  return path.join(root, `rudder-browser-import-v1-${ownerId}-${suffix}`);
}

async function writeOwnerMarker(directory: string, ownerId: string, pid: number): Promise<void> {
  await fs.writeFile(path.join(directory, ownerMarkerName), JSON.stringify({
    version: 1,
    ownerId,
    pid,
  }));
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-browser-snapshot-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Chromium Cookie database snapshots", () => {
  it("derives the opaque import owner from a valid Browser partition", () => {
    expect(deriveBrowserImportOwnerId(`persist:rudder-browser-v1-${importOwnerA}`)).toBe(importOwnerA);
    expect(() => deriveBrowserImportOwnerId("persist:rudder-browser-v1-/private/raw-instance-path"))
      .toThrow("valid Rudder Browser partition");
  });

  it("copies Cookies with WAL and SHM into private temporary storage", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(sourcePath, "database");
    await fs.writeFile(`${sourcePath}-wal`, "wal");
    await fs.writeFile(`${sourcePath}-shm`, "shm");

    const snapshot = await createStableCookieDatabaseSnapshot({
      sourcePath,
      isAnyPathOpen: async () => false,
    });
    tempRoots.push(snapshot.tempDirectory);

    expect(path.basename(snapshot.databasePath)).toBe("Cookies");
    expect(await fs.readFile(snapshot.databasePath, "utf8")).toBe("database");
    expect(await fs.readFile(`${snapshot.databasePath}-wal`, "utf8")).toBe("wal");
    expect(await fs.readFile(`${snapshot.databasePath}-shm`, "utf8")).toBe("shm");
    expect((await fs.stat(snapshot.tempDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(snapshot.databasePath)).mode & 0o777).toBe(0o600);

    await snapshot.cleanup();
    await expect(fs.stat(snapshot.tempDirectory)).rejects.toThrow();
  });

  it("rejects open source databases before copying", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(sourcePath, "database");
    const copyFile = vi.fn(async () => undefined);

    await expect(createStableCookieDatabaseSnapshot({
      sourcePath,
      isAnyPathOpen: async () => true,
      copyFile,
    })).rejects.toMatchObject({
      name: "BrowserImportSourceOpenError",
      code: "BROWSER_SOURCE_OPEN",
      message: "Close the source browser before importing its data.",
    });
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("rejects source snapshots that exceed the configured size limit", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(sourcePath, "database");

    await expect(createStableCookieDatabaseSnapshot({
      sourcePath,
      maxTotalBytes: 7n,
      isAnyPathOpen: async () => false,
    })).rejects.toThrow("too large");
  });

  it("rejects source changes during the copy and cleans its temporary directory", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(sourcePath, "database");
    let tempDirectory: string | null = null;

    await expect(createStableCookieDatabaseSnapshot({
      sourcePath,
      isAnyPathOpen: async () => false,
      onTempDirectory: (value) => {
        tempDirectory = value;
      },
      copyFile: async (source, destination) => {
        await fs.copyFile(source, destination);
        await fs.appendFile(source, "changed");
      },
    })).rejects.toThrow("changed during import");
    expect(tempDirectory).not.toBeNull();
    await expect(fs.stat(tempDirectory!)).rejects.toThrow();
  });

  it("rejects a WAL file created during the copy", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(sourcePath, "database");

    await expect(createStableCookieDatabaseSnapshot({
      sourcePath,
      isAnyPathOpen: async () => false,
      copyFile: async (source, destination) => {
        await fs.copyFile(source, destination);
        await fs.writeFile(`${sourcePath}-wal`, "new-wal");
      },
    })).rejects.toThrow("changed during import");
  });

  it("passes the captured size to bounded copies when a source starts growing", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(sourcePath, "database");
    let capturedSize: bigint | null = null;

    await expect(createStableCookieDatabaseSnapshot({
      sourcePath,
      isAnyPathOpen: async () => false,
      copyFile: async (source, destination, expectedSize) => {
        capturedSize = expectedSize;
        await fs.copyFile(source, destination);
        await fs.appendFile(source, "growing-after-open");
      },
    })).rejects.toThrow("changed during import");
    expect(capturedSize).toBe(8n);
  });

  it("rejects symlinked Cookie databases", async () => {
    const root = await makeTempRoot();
    const outside = path.join(root, "outside");
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, sourcePath);

    await expect(createStableCookieDatabaseSnapshot({
      sourcePath,
      isAnyPathOpen: async () => false,
    })).rejects.toThrow("regular file");
  });

  it("cleans the temporary directory when setup fails immediately after mkdtemp", async () => {
    const root = await makeTempRoot();
    const sourcePath = path.join(root, "Cookies");
    await fs.writeFile(sourcePath, "database");
    let tempDirectory: string | null = null;

    await expect(createStableCookieDatabaseSnapshot({
      sourcePath,
      isAnyPathOpen: async () => false,
      onTempDirectory: (value) => {
        tempDirectory = value;
        throw new Error("setup failed");
      },
    })).rejects.toThrow("setup failed");
    expect(tempDirectory).not.toBeNull();
    await expect(fs.stat(tempDirectory!)).rejects.toThrow();
  });

  it("creates an instance-owned private directory with an opaque live-process marker", async () => {
    const root = await makeTempRoot();
    const tempDirectory = await createPrivateBrowserImportTempDirectory({
      ownerId: importOwnerA,
      tempRoot: root,
      pid: 12345,
    });

    expect(path.basename(tempDirectory)).toMatch(new RegExp(`^rudder-browser-import-v1-${importOwnerA}-[A-Za-z0-9]{6}$`));
    expect((await fs.stat(tempDirectory)).mode & 0o777).toBe(0o700);
    await expect(fs.readFile(path.join(tempDirectory, ownerMarkerName), "utf8")).resolves.toBe(JSON.stringify({
      version: 1,
      ownerId: importOwnerA,
      pid: 12345,
    }));
    expect((await fs.stat(path.join(tempDirectory, ownerMarkerName))).mode & 0o777).toBe(0o600);
  });

  it("removes a dead same-instance import but never another instance", async () => {
    const root = await makeTempRoot();
    const staleSameInstance = importDirectory(root, importOwnerA, "StA123");
    const otherInstance = importDirectory(root, importOwnerB, "Oth456");
    await fs.mkdir(staleSameInstance);
    await fs.mkdir(otherInstance);
    await writeOwnerMarker(staleSameInstance, importOwnerA, 101);
    await writeOwnerMarker(otherInstance, importOwnerB, 202);
    await fs.writeFile(path.join(staleSameInstance, "Cookies"), "stale-secret");
    await fs.writeFile(path.join(otherInstance, "Cookies"), "live-other-secret");

    await cleanupStaleBrowserImportTempDirectories({
      tempRoot: root,
      ownerId: importOwnerA,
      isProcessAlive: async () => false,
    });

    await expect(fs.stat(staleSameInstance)).rejects.toThrow();
    await expect(fs.readFile(path.join(otherInstance, "Cookies"), "utf8")).resolves.toBe("live-other-secret");
  });

  it("keeps a live same-instance import while removing a dead sibling", async () => {
    const root = await makeTempRoot();
    const liveImport = importDirectory(root, importOwnerA, "Liv123");
    const deadImport = importDirectory(root, importOwnerA, "Ded456");
    await fs.mkdir(liveImport);
    await fs.mkdir(deadImport);
    await writeOwnerMarker(liveImport, importOwnerA, 303);
    await writeOwnerMarker(deadImport, importOwnerA, 404);

    await cleanupStaleBrowserImportTempDirectories({
      tempRoot: root,
      ownerId: importOwnerA,
      isProcessAlive: async (pid) => pid === 303,
    });

    await expect(fs.stat(liveImport)).resolves.toMatchObject({});
    await expect(fs.stat(deadImport)).rejects.toThrow();
  });

  it("conservatively skips unmarked, malformed, symlinked, and unrelated entries", async () => {
    const root = await makeTempRoot();
    const staleImport = importDirectory(root, importOwnerA, "Old123");
    const unmarkedCrashWindow = importDirectory(root, importOwnerA, "New456");
    const malformedMarker = importDirectory(root, importOwnerA, "Bad789");
    const symlinkTarget = path.join(root, "symlink-target");
    const matchingSymlink = importDirectory(root, importOwnerA, "Sym012");
    const unrelatedDirectory = path.join(root, "unrelated-data");
    await fs.mkdir(staleImport);
    await fs.mkdir(unmarkedCrashWindow);
    await fs.mkdir(malformedMarker);
    await fs.mkdir(symlinkTarget);
    await fs.mkdir(unrelatedDirectory);
    await writeOwnerMarker(staleImport, importOwnerA, 505);
    await fs.writeFile(path.join(malformedMarker, ownerMarkerName), "not-json");
    await fs.writeFile(path.join(unmarkedCrashWindow, "keep"), "unmarked-secret");
    await fs.writeFile(path.join(malformedMarker, "keep"), "malformed-secret");
    await fs.writeFile(path.join(symlinkTarget, "keep"), "target-secret");
    await fs.writeFile(path.join(unrelatedDirectory, "keep"), "unrelated-secret");
    await fs.symlink(symlinkTarget, matchingSymlink);

    await cleanupStaleBrowserImportTempDirectories({
      tempRoot: root,
      ownerId: importOwnerA,
      isProcessAlive: async () => false,
    });

    await expect(fs.stat(staleImport)).rejects.toThrow();
    await expect(fs.readFile(path.join(unmarkedCrashWindow, "keep"), "utf8")).resolves.toBe("unmarked-secret");
    await expect(fs.readFile(path.join(malformedMarker, "keep"), "utf8")).resolves.toBe("malformed-secret");
    await expect(fs.readFile(path.join(unrelatedDirectory, "keep"), "utf8")).resolves.toBe("unrelated-secret");
    await expect(fs.lstat(matchingSymlink)).resolves.toMatchObject({});
    await expect(fs.readFile(path.join(symlinkTarget, "keep"), "utf8")).resolves.toBe("target-secret");
  });
});
