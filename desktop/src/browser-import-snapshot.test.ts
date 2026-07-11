import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStableCookieDatabaseSnapshot } from "./browser-import-snapshot.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-browser-snapshot-test-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Chromium Cookie database snapshots", () => {
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
    })).rejects.toThrow("Close the source browser");
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
});
