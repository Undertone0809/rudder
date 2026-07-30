import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AppBuilderDataManager } from "./app-builder-data.js";

async function fixture(dependencies: {
  writeCurrentRelease?: () => Promise<void>;
  cleanupBackup?: () => Promise<void>;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-app-data-"));
  const stateRoot = path.join(root, "state");
  const dataRoot = path.join(root, "data");
  const releaseRoot = path.join(root, "release");
  await mkdir(dataRoot);
  await mkdir(releaseRoot);
  await writeFile(path.join(dataRoot, "app.sqlite"), "real-data");
  await writeFile(path.join(releaseRoot, "server.mjs"), "export {};\n");
  let sequence = 0;
  const manager = new AppBuilderDataManager(stateRoot, {
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    randomId: () => `id-${sequence += 1}`,
    ...dependencies,
  });
  return { root, stateRoot, dataRoot, releaseRoot, manager };
}

describe("App Builder data lifecycle", () => {
  it("creates integrity-checked snapshots and exports without exposing live mutations", async () => {
    const { root, dataRoot, manager } = await fixture();
    const snapshot = await manager.snapshot("binding-1", "cold-email-crm", dataRoot);
    await writeFile(path.join(dataRoot, "app.sqlite"), "later-data");

    await expect(manager.validatePackage(snapshot.root, "cold-email-crm"))
      .resolves.toEqual(snapshot.manifest);
    await expect(readFile(path.join(snapshot.root, "data", "app.sqlite"), "utf8"))
      .resolves.toBe("real-data");

    const exported = path.join(root, "exported");
    await mkdir(exported);
    await manager.exportSnapshot(snapshot.root, exported);
    await writeFile(path.join(exported, "data", "app.sqlite"), "tampered");
    await expect(manager.validatePackage(exported, "cold-email-crm"))
      .rejects.toThrow("integrity");
  });

  it("restores the user's existing data when imported data activation fails", async () => {
    const { dataRoot, manager } = await fixture();
    const importedPackage = await manager.snapshot("binding-1", "cold-email-crm", dataRoot);
    await writeFile(path.join(dataRoot, "app.sqlite"), "existing-real-data");

    await expect(manager.importPackage({
      appKey: "binding-1",
      appId: "cold-email-crm",
      packageRoot: importedPackage.root,
      dataRoot,
      activate: async (activatedRoot) => {
        expect(await readFile(path.join(activatedRoot, "app.sqlite"), "utf8")).toBe("real-data");
        throw new Error("activation failed");
      },
    })).rejects.toThrow("activation failed");

    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8"))
      .resolves.toBe("existing-real-data");
  });

  it("does not touch live data or install a release when staged migration fails", async () => {
    const { stateRoot, dataRoot, releaseRoot, manager } = await fixture();
    await expect(manager.promoteRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      releaseId: "release-1",
      releaseSourceRoot: releaseRoot,
      dataRoot,
      migrate: async (stagedDataRoot) => {
        await writeFile(path.join(stagedDataRoot, "app.sqlite"), "migrated");
        throw new Error("migration failed");
      },
    })).rejects.toThrow("migration failed");

    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8")).resolves.toBe("real-data");
    await expect(access(path.join(stateRoot, "apps", "binding-1", "releases", "release-1")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back data and the immutable release when the release pointer cannot be committed", async () => {
    const { stateRoot, dataRoot, releaseRoot, manager } = await fixture({
      writeCurrentRelease: async () => {
        throw new Error("pointer write failed");
      },
    });
    await expect(manager.promoteRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      releaseId: "release-2",
      releaseSourceRoot: releaseRoot,
      dataRoot,
      migrate: async (stagedDataRoot) => {
        await writeFile(path.join(stagedDataRoot, "app.sqlite"), "migrated");
      },
    })).rejects.toThrow("pointer write failed");

    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8")).resolves.toBe("real-data");
    await expect(access(path.join(stateRoot, "apps", "binding-1", "releases", "release-2")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores a promotion snapshot and atomically clears the release pointer", async () => {
    const { stateRoot, dataRoot, releaseRoot, manager } = await fixture();
    const promoted = await manager.promoteRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      releaseId: "release-rollback",
      releaseSourceRoot: releaseRoot,
      dataRoot,
      migrate: async (stagedDataRoot) => {
        await writeFile(path.join(stagedDataRoot, "app.sqlite"), "migrated");
      },
    });
    const restored = await manager.rollbackRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      snapshotId: promoted.rollbackSnapshot.id,
      targetReleaseId: null,
      dataRoot,
    });

    expect(restored.safetySnapshot.manifest.appId).toBe("cold-email-crm");
    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8")).resolves.toBe("real-data");
    await expect(access(path.join(stateRoot, "apps", "binding-1", "current-release.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the current data and pointer when rollback pointer commit fails", async () => {
    const { stateRoot, dataRoot, releaseRoot, manager } = await fixture();
    const promoted = await manager.promoteRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      releaseId: "release-current",
      releaseSourceRoot: releaseRoot,
      dataRoot,
      migrate: async (stagedDataRoot) => {
        await writeFile(path.join(stagedDataRoot, "app.sqlite"), "current-data");
      },
    });
    let sequence = 100;
    const failingManager = new AppBuilderDataManager(stateRoot, {
      randomId: () => `failure-${sequence += 1}`,
      writeCurrentRelease: async () => { throw new Error("rollback pointer failed"); },
    });
    await expect(failingManager.rollbackRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      snapshotId: promoted.rollbackSnapshot.id,
      targetReleaseId: "release-current",
      dataRoot,
    })).rejects.toThrow("rollback pointer failed");
    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8")).resolves.toBe("current-data");
    await expect(readFile(
      path.join(stateRoot, "apps", "binding-1", "current-release.json"),
      "utf8",
    )).resolves.toContain('"releaseId": "release-current"');
  });

  it("does not roll back committed data when backup garbage collection fails", async () => {
    const { dataRoot, manager } = await fixture({
      cleanupBackup: async () => { throw new Error("cleanup failed"); },
    });
    const importedPackage = await manager.snapshot("binding-1", "cold-email-crm", dataRoot);
    await writeFile(path.join(dataRoot, "app.sqlite"), "current-data");
    await expect(manager.importPackage({
      appKey: "binding-1",
      appId: "cold-email-crm",
      packageRoot: importedPackage.root,
      dataRoot,
    })).resolves.toBeDefined();
    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8")).resolves.toBe("real-data");
  });

  it("serializes promotions by stable local binding identity", async () => {
    const { stateRoot, dataRoot, releaseRoot, manager } = await fixture();
    let releaseFirst!: () => void;
    let noteFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { noteFirstEntered = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = manager.promoteRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      releaseId: "release-a",
      releaseSourceRoot: releaseRoot,
      dataRoot,
      migrate: async (stagedDataRoot) => {
        noteFirstEntered();
        await firstGate;
        await writeFile(path.join(stagedDataRoot, "app.sqlite"), "data-a");
      },
    });
    await firstEntered;
    const second = manager.promoteRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      releaseId: "release-b",
      releaseSourceRoot: releaseRoot,
      dataRoot,
      migrate: async (stagedDataRoot) => {
        await writeFile(path.join(stagedDataRoot, "app.sqlite"), "data-b");
      },
    });
    releaseFirst();
    await Promise.all([first, second]);
    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8")).resolves.toBe("data-b");
    await expect(readFile(
      path.join(stateRoot, "apps", "binding-1", "current-release.json"),
      "utf8",
    )).resolves.toContain('"releaseId": "release-b"');
  });

  it("promotes migrated staged data and keeps a rollback snapshot on success", async () => {
    const { stateRoot, dataRoot, releaseRoot, manager } = await fixture();
    const result = await manager.promoteRelease({
      appKey: "binding-1",
      appId: "cold-email-crm",
      releaseId: "release-3",
      releaseSourceRoot: releaseRoot,
      dataRoot,
      migrate: async (stagedDataRoot) => {
        await writeFile(path.join(stagedDataRoot, "app.sqlite"), "migrated");
      },
    });

    await expect(readFile(path.join(dataRoot, "app.sqlite"), "utf8")).resolves.toBe("migrated");
    await expect(readFile(path.join(result.rollbackSnapshot.root, "data", "app.sqlite"), "utf8"))
      .resolves.toBe("real-data");
    await expect(readFile(
      path.join(stateRoot, "apps", "binding-1", "current-release.json"),
      "utf8",
    )).resolves.toContain('"releaseId": "release-3"');
  });
});
