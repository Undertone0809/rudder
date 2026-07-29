import { access, lstat, mkdir, mkdtemp, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeSupportsDesktopShellAssets } from "../../cli/src/commands/start.js";
import {
  ensureRuntimeInstalled,
  isRuntimeCacheHit,
  resolveRuntimePostgresPayloadBinDir,
} from "../../cli/src/runtime/install.js";
import {
  DESKTOP_POSTGRES_RUNTIME_DIR,
  RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV,
  RUDDER_POSTGRES_BIN_DIR_ENV,
  acquireDesktopPostgresLifecycleLock,
  createDesktopUpdateChildEnvironment,
  desktopPostgresPlatformSegment,
  finalizeSharedPostgresRuntime,
  isDesktopManagedPostgresBinDir,
  reconcileDesktopPostgresBinDir,
  resolveDesktopPostgresBinDir,
  resolvePreferredDesktopPostgresBinDir,
} from "./postgres-runtime.js";

const tempRoots: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-desktop-pg-runtime-"));
  tempRoots.push(root);
  return root;
}

async function makePostgresBinDir(root: string, segment = desktopPostgresPlatformSegment(), options: {
  includeTemplate?: boolean;
  timezoneLayout?: "flat" | "nested";
} = {}): Promise<string> {
  const binDir = path.join(root, DESKTOP_POSTGRES_RUNTIME_DIR, segment, "bin");
  await mkdir(binDir, { recursive: true });
  const platform = segment.split("-")[0] as NodeJS.Platform;
  for (const binary of ["initdb", "pg_ctl", "postgres"]) {
    await writeFile(path.join(binDir, platform === "win32" ? `${binary}.exe` : binary), "");
  }
  if (options.includeTemplate !== false) {
    const templatePath = path.join(root, DESKTOP_POSTGRES_RUNTIME_DIR, segment, "share", "postgresql", "postgres.bki");
    await mkdir(path.dirname(templatePath), { recursive: true });
    const timezoneDir = options.timezoneLayout === "nested"
      ? path.join(path.dirname(templatePath), "timezone")
      : path.join(root, DESKTOP_POSTGRES_RUNTIME_DIR, segment, "share", "timezone");
    await mkdir(timezoneDir, { recursive: true });
    await writeFile(templatePath, "postgres template");
    await writeFile(path.join(path.dirname(templatePath), "postgresql.conf.sample"), "postgres config template");
    await writeFile(path.join(timezoneDir, "UTC"), "timezone data");
  }
  return binDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop PostgreSQL runtime payload", () => {
  it("serializes PostgreSQL runtime startup and cleanup through one lifecycle lock", async () => {
    const rudderHome = await makeTempRoot();
    const env = { RUDDER_HOME: rudderHome };
    const releaseFirst = await acquireDesktopPostgresLifecycleLock(env);
    let secondAcquired = false;
    const secondPromise = acquireDesktopPostgresLifecycleLock(env, {
      timeoutMs: 2_000,
      pollMs: 5,
    }).then((release) => {
      secondAcquired = true;
      return release;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(secondAcquired).toBe(false);
    await releaseFirst();
    const releaseSecond = await secondPromise;
    expect(secondAcquired).toBe(true);
    await releaseSecond();
  });

  it("uses platform and architecture in the payload path", () => {
    expect(desktopPostgresPlatformSegment("win32", "x64")).toBe("win32-x64");
    expect(desktopPostgresPlatformSegment("darwin", "arm64")).toBe("darwin-arm64");
  });

  it("resolves a bundled PostgreSQL 18.4 bin directory", async () => {
    const root = await makeTempRoot();
    const binDir = await makePostgresBinDir(root, "win32-x64");

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBe(binDir);
  });

  it("resolves the official PostgreSQL layout with nested timezone data", async () => {
    const root = await makeTempRoot();
    const binDir = await makePostgresBinDir(root, "darwin-arm64", {
      timezoneLayout: "nested",
    });

    expect(resolveDesktopPostgresBinDir(root, {
      platform: "darwin",
      arch: "arm64",
      validateVersion: false,
    })).toBe(binDir);
  });

  it("ignores incomplete PostgreSQL payload directories", async () => {
    const root = await makeTempRoot();
    const binDir = path.join(root, DESKTOP_POSTGRES_RUNTIME_DIR, "win32-x64", "bin");
    await mkdir(binDir, { recursive: true });

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBeNull();
  });

  it("ignores PostgreSQL payload directories without initdb template files", async () => {
    const root = await makeTempRoot();
    await makePostgresBinDir(root, "win32-x64", { includeTemplate: false });

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBeNull();
  });

  it("ignores PostgreSQL payload directories without configuration template files", async () => {
    const root = await makeTempRoot();
    const binDir = await makePostgresBinDir(root, "win32-x64");
    await rm(path.join(binDir, "..", "share", "postgresql", "postgresql.conf.sample"));

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBeNull();
  });

  it("ignores PostgreSQL payload directories without timezone support files", async () => {
    const root = await makeTempRoot();
    const binDir = await makePostgresBinDir(root, "win32-x64");
    await rm(path.join(binDir, "..", "share", "timezone"), { recursive: true });

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBeNull();
  });

  it("prefers external runtime cache payloads over bundled resources", async () => {
    const resourcesRoot = await makeTempRoot();
    const cacheRoot = await makeTempRoot();
    await makePostgresBinDir(resourcesRoot, "win32-x64");
    const cachedBinDir = await makePostgresBinDir(cacheRoot, "win32-x64");

    expect(
      resolvePreferredDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        externalRuntimeCacheDir: cacheRoot,
        env: { RUDDER_HOME: resourcesRoot },
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBe(cachedBinDir);
  });

  it("prefers the shared PostgreSQL payload over version-local runtime copies", async () => {
    const resourcesRoot = await makeTempRoot();
    const rudderHome = await makeTempRoot();
    const runtimeRoot = path.join(rudderHome, "runtimes", "0.5.2-canary.3");
    await makePostgresBinDir(runtimeRoot, "win32-x64");
    const sharedPayloadRoot = path.join(rudderHome, "runtime-payloads");
    const sharedBinDir = await makePostgresBinDir(sharedPayloadRoot, "win32-x64");

    expect(
      resolvePreferredDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        externalRuntimeCacheDir: runtimeRoot,
        env: { RUDDER_HOME: rudderHome },
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBe(sharedBinDir);
  });

  it("recognizes the shared payload as a Desktop-managed PostgreSQL path", async () => {
    const resourcesRoot = await makeTempRoot();
    const rudderHome = await makeTempRoot();
    const sharedPayloadRoot = path.join(rudderHome, "runtime-payloads");
    const sharedBinDir = await makePostgresBinDir(sharedPayloadRoot, "darwin-arm64");

    expect(
      isDesktopManagedPostgresBinDir({
        binDir: sharedBinDir,
        resourcesPath: resourcesRoot,
        env: { RUDDER_HOME: rudderHome },
      }),
    ).toBe(true);
  });

  it("finalizes legacy payloads only after a healthy shared runtime is active", async () => {
    const rudderHome = await makeTempRoot();
    const sharedPayloadRoot = path.join(rudderHome, "runtime-payloads");
    const sharedBinDir = await makePostgresBinDir(sharedPayloadRoot);
    const previousPayloadDir = path.join(sharedPayloadRoot, "postgres-18.3");
    const expiredPayloadDir = path.join(sharedPayloadRoot, "postgres-17.6");
    await mkdir(previousPayloadDir, { recursive: true });
    await mkdir(expiredPayloadDir, { recursive: true });
    await utimes(previousPayloadDir, new Date("2026-07-23T00:00:00.000Z"), new Date("2026-07-23T00:00:00.000Z"));
    await utimes(expiredPayloadDir, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));
    const currentRuntimeDir = path.join(rudderHome, "runtimes", "0.5.3-canary.0");
    const currentBinDir = await makePostgresBinDir(currentRuntimeDir);
    const protectedRuntimeDir = path.join(rudderHome, "runtimes", "0.5.2");
    const protectedBinDir = await makePostgresBinDir(protectedRuntimeDir);
    const platformPackage = process.platform === "darwin" && process.arch === "arm64"
      ? ["@embedded-postgres", "darwin-arm64"]
      : null;
    await writeFile(path.join(currentRuntimeDir, "runtime.json"), JSON.stringify({
      version: 1,
      packageName: "@rudderhq/server",
      packageVersion: "0.5.3-canary.0",
      installedAt: "2026-07-24T00:00:00.000Z",
    }));
    const currentServerPackageDir = path.join(
      currentRuntimeDir,
      "node_modules",
      "@rudderhq",
      "server",
    );
    await mkdir(currentServerPackageDir, { recursive: true });
    await writeFile(path.join(currentServerPackageDir, "package.json"), JSON.stringify({
      name: "@rudderhq/server",
      version: "0.5.3-canary.0",
    }));
    const embeddedPostgresPackageDir = path.join(
      currentRuntimeDir,
      "node_modules",
      "embedded-postgres",
    );
    await mkdir(embeddedPostgresPackageDir, { recursive: true });
    await writeFile(path.join(embeddedPostgresPackageDir, "package.json"), JSON.stringify({
      name: "embedded-postgres",
      version: "18.1.0-beta.16",
    }));
    await writeFile(path.join(protectedRuntimeDir, "runtime.json"), JSON.stringify({
      version: 1,
      packageName: "@rudderhq/server",
      packageVersion: "0.5.2",
      installedAt: "2026-07-23T00:00:00.000Z",
    }));
    if (platformPackage) {
      await mkdir(path.join(currentRuntimeDir, "node_modules", ...platformPackage), { recursive: true });
      await writeFile(path.join(currentRuntimeDir, "node_modules", ...platformPackage, "package.json"), "{}");
      await mkdir(path.join(currentRuntimeDir, "node_modules", "@img", "sharp-darwin-arm64"), { recursive: true });
      await writeFile(path.join(currentRuntimeDir, "node_modules", "@img", "sharp-darwin-arm64", "package.json"), "{}");
    }
    const orphanDir = path.join(rudderHome, "runtimes", "0.5.1-incomplete");
    await mkdir(orphanDir, { recursive: true });
    await utimes(orphanDir, new Date("2026-07-20T00:00:00.000Z"), new Date("2026-07-20T00:00:00.000Z"));
    const lockedOrphanDir = path.join(rudderHome, "runtimes", "0.5.0-installing");
    await mkdir(lockedOrphanDir, { recursive: true });
    await utimes(lockedOrphanDir, new Date("2026-07-20T00:00:00.000Z"), new Date("2026-07-20T00:00:00.000Z"));
    await mkdir(`${lockedOrphanDir}.install.lock`);
    const activeRuntimeDir = path.join(rudderHome, "instances", "default", "runtime");
    await mkdir(activeRuntimeDir, { recursive: true });
    await writeFile(path.join(activeRuntimeDir, "server.json"), JSON.stringify({
      instanceId: "default",
      pid: process.pid,
      version: "0.5.3-canary.0",
      postgresBinDir: sharedBinDir,
      postgresRuntimeKey: `postgres-18.4/${desktopPostgresPlatformSegment()}`,
    }));
    const protectedDescriptorDir = path.join(rudderHome, "instances", "legacy", "runtime");
    await mkdir(protectedDescriptorDir, { recursive: true });
    await writeFile(path.join(protectedDescriptorDir, "server.json"), JSON.stringify({
      instanceId: "legacy",
      pid: process.pid,
      version: "0.5.2",
      postgresBinDir: protectedBinDir,
    }));

    const result = await finalizeSharedPostgresRuntime({
      env: { RUDDER_HOME: rudderHome },
      now: new Date("2026-07-24T00:00:00.000Z"),
      validateVersion: false,
      expectedInstanceId: "default",
      expectedVersion: "0.5.3-canary.0",
    });

    expect(result.sharedBinDir).toBe(sharedBinDir);
    expect(result.linkedRuntimeVersions).toContain("0.5.3-canary.0");
    expect(result.protectedRuntimeVersions).toContain("0.5.2");
    expect((await lstat(path.join(currentRuntimeDir, DESKTOP_POSTGRES_RUNTIME_DIR))).isSymbolicLink()).toBe(true);
    if (process.platform === "win32") {
      expect(path.resolve(await readlink(path.join(currentRuntimeDir, DESKTOP_POSTGRES_RUNTIME_DIR)))).toBe(
        path.resolve(sharedPayloadRoot, DESKTOP_POSTGRES_RUNTIME_DIR),
      );
    } else {
      expect(await readlink(path.join(currentRuntimeDir, DESKTOP_POSTGRES_RUNTIME_DIR))).toBe(
        path.join("..", "..", "runtime-payloads", DESKTOP_POSTGRES_RUNTIME_DIR),
      );
    }
    await expect(access(protectedBinDir)).resolves.toBeUndefined();
    await expect(access(orphanDir)).rejects.toThrow();
    await expect(access(lockedOrphanDir)).resolves.toBeUndefined();
    await expect(access(previousPayloadDir)).resolves.toBeUndefined();
    await expect(access(expiredPayloadDir)).rejects.toThrow();
    expect(result.removedSharedPayloadVersions).toEqual(["postgres-17.6"]);
    if (platformPackage) {
      await expect(access(path.join(currentRuntimeDir, "node_modules", ...platformPackage))).rejects.toThrow();
      await expect(access(path.join(currentRuntimeDir, "node_modules", "@img", "sharp-darwin-arm64", "package.json"))).resolves.toBeUndefined();
      await expect(isRuntimeCacheHit({
        cacheDir: currentRuntimeDir,
        version: "0.5.3-canary.0",
        postgresVersionProbe: () => "PostgreSQL 18.4",
      })).resolves.toBe(true);
    }
  });

  it("retains an older shared payload referenced by a bin-only live descriptor", async () => {
    const rudderHome = await makeTempRoot();
    const sharedPayloadRoot = path.join(rudderHome, "runtime-payloads");
    const sharedBinDir = await makePostgresBinDir(sharedPayloadRoot);
    const oldPayloadRoot = path.join(sharedPayloadRoot, "postgres-17.6");
    const oldBinDir = path.join(
      oldPayloadRoot,
      desktopPostgresPlatformSegment(),
      "bin",
    );
    await mkdir(oldBinDir, { recursive: true });
    await writeFile(path.join(oldBinDir, "live-marker"), "keep");
    await utimes(oldPayloadRoot, new Date("2026-07-01T00:00:00.000Z"), new Date("2026-07-01T00:00:00.000Z"));

    const activeDescriptorDir = path.join(rudderHome, "instances", "default", "runtime");
    await mkdir(activeDescriptorDir, { recursive: true });
    await writeFile(path.join(activeDescriptorDir, "server.json"), JSON.stringify({
      instanceId: "default",
      pid: process.pid,
      version: "0.5.3-canary.0",
      postgresBinDir: sharedBinDir,
      postgresRuntimeKey: `postgres-18.4/${desktopPostgresPlatformSegment()}`,
    }));
    const legacyDescriptorDir = path.join(rudderHome, "instances", "legacy", "runtime");
    await mkdir(legacyDescriptorDir, { recursive: true });
    await writeFile(path.join(legacyDescriptorDir, "server.json"), JSON.stringify({
      instanceId: "legacy",
      pid: process.pid,
      version: "0.5.1",
      postgresBinDir: oldBinDir,
    }));

    const result = await finalizeSharedPostgresRuntime({
      env: { RUDDER_HOME: rudderHome },
      now: new Date("2026-07-24T00:00:00.000Z"),
      validateVersion: false,
      expectedInstanceId: "default",
      expectedVersion: "0.5.3-canary.0",
    });

    expect(result.removedSharedPayloadVersions).not.toContain("postgres-17.6");
    await expect(access(path.join(oldBinDir, "live-marker"))).resolves.toBeUndefined();
  });

  it("refuses cleanup when the healthy descriptor belongs to another runtime instance", async () => {
    const rudderHome = await makeTempRoot();
    const sharedBinDir = await makePostgresBinDir(path.join(rudderHome, "runtime-payloads"));
    const descriptorDir = path.join(rudderHome, "instances", "other", "runtime");
    await mkdir(descriptorDir, { recursive: true });
    await writeFile(path.join(descriptorDir, "server.json"), JSON.stringify({
      instanceId: "other",
      pid: process.pid,
      version: "0.5.3-canary.0",
      postgresBinDir: sharedBinDir,
      postgresRuntimeKey: `postgres-18.4/${desktopPostgresPlatformSegment()}`,
    }));

    await expect(finalizeSharedPostgresRuntime({
      env: { RUDDER_HOME: rudderHome },
      validateVersion: false,
      expectedInstanceId: "default",
      expectedVersion: "0.5.3-canary.0",
    })).rejects.toThrow("requires a live runtime descriptor");
  });

  it("repairs a compatibility link that points at a noncanonical payload", async () => {
    if (process.platform === "win32") return;
    const rudderHome = await makeTempRoot();
    const sharedPayloadRoot = path.join(rudderHome, "runtime-payloads");
    const sharedBinDir = await makePostgresBinDir(sharedPayloadRoot);
    const stalePayloadRoot = path.join(rudderHome, "stale-payload");
    await mkdir(stalePayloadRoot, { recursive: true });
    const runtimeDir = path.join(rudderHome, "runtimes", "0.5.3-canary.0");
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(path.join(runtimeDir, "runtime.json"), JSON.stringify({
      version: 1,
      packageName: "@rudderhq/server",
      packageVersion: "0.5.3-canary.0",
      installedAt: "2026-07-24T00:00:00.000Z",
    }));
    const compatibilityRoot = path.join(runtimeDir, DESKTOP_POSTGRES_RUNTIME_DIR);
    await symlink(stalePayloadRoot, compatibilityRoot, "dir");
    const descriptorDir = path.join(rudderHome, "instances", "default", "runtime");
    await mkdir(descriptorDir, { recursive: true });
    await writeFile(path.join(descriptorDir, "server.json"), JSON.stringify({
      instanceId: "default",
      pid: process.pid,
      version: "0.5.3-canary.0",
      postgresBinDir: sharedBinDir,
      postgresRuntimeKey: `postgres-18.4/${desktopPostgresPlatformSegment()}`,
    }));

    const result = await finalizeSharedPostgresRuntime({
      env: { RUDDER_HOME: rudderHome },
      validateVersion: false,
      expectedInstanceId: "default",
      expectedVersion: "0.5.3-canary.0",
    });

    expect(result.linkedRuntimeVersions).toContain("0.5.3-canary.0");
    expect(await realpath(compatibilityRoot)).toBe(
      await realpath(path.join(sharedPayloadRoot, DESKTOP_POSTGRES_RUNTIME_DIR)),
    );
  });

  it("does not override an explicit operator PostgreSQL bin directory", async () => {
    const resourcesRoot = await makeTempRoot();
    await makePostgresBinDir(resourcesRoot, "win32-x64");

    expect(
      resolvePreferredDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        env: { [RUDDER_POSTGRES_BIN_DIR_ENV]: "C:\\PostgreSQL\\18\\bin" },
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBeNull();
  });

  it("replaces an inherited Desktop resource path with the external runtime payload", async () => {
    const resourcesRoot = await makeTempRoot();
    const cacheRoot = await makeTempRoot();
    const staleDesktopBinDir = path.join(
      resourcesRoot,
      DESKTOP_POSTGRES_RUNTIME_DIR,
      "win32-x64",
      "bin",
    );
    const cachedBinDir = await makePostgresBinDir(cacheRoot, "win32-x64");
    const env = {
      RUDDER_HOME: resourcesRoot,
      [RUDDER_POSTGRES_BIN_DIR_ENV]: staleDesktopBinDir,
    };

    expect(
      reconcileDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        externalRuntimeCacheDir: cacheRoot,
        env,
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBe(cachedBinDir);
    expect(env).toMatchObject({
      [RUDDER_POSTGRES_BIN_DIR_ENV]: cachedBinDir,
      [RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]: cachedBinDir,
    });
  });

  it("clears a stale managed Desktop path when no replacement payload exists", async () => {
    const resourcesRoot = await makeTempRoot();
    const staleDesktopBinDir = path.join(
      resourcesRoot,
      DESKTOP_POSTGRES_RUNTIME_DIR,
      "win32-x64",
      "bin",
    );
    const env = {
      RUDDER_HOME: resourcesRoot,
      [RUDDER_POSTGRES_BIN_DIR_ENV]: staleDesktopBinDir,
      [RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]: staleDesktopBinDir,
    };

    expect(
      reconcileDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        env,
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBeNull();
    expect(env[RUDDER_POSTGRES_BIN_DIR_ENV]).toBeUndefined();
    expect(env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]).toBeUndefined();
  });

  it("removes incomplete Desktop-managed PostgreSQL paths from update child environments", () => {
    const resourcesRoot = path.resolve("/Applications/Rudder.app/Contents/Resources");
    const managedBinDir = path.join(
      resourcesRoot,
      DESKTOP_POSTGRES_RUNTIME_DIR,
      "darwin-arm64",
      "bin",
    );
    const childEnv = createDesktopUpdateChildEnvironment({
      resourcesPath: resourcesRoot,
      env: {
        RUDDER_HOME: "/tmp/rudder-home",
        [RUDDER_POSTGRES_BIN_DIR_ENV]: managedBinDir,
      },
    });

    expect(childEnv.RUDDER_HOME).toBe("/tmp/rudder-home");
    expect(childEnv[RUDDER_POSTGRES_BIN_DIR_ENV]).toBeUndefined();
    expect(childEnv[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]).toBeUndefined();
  });

  it("preserves complete Desktop-managed PostgreSQL paths for target runtime staging", async () => {
    const resourcesRoot = await makeTempRoot();
    const managedBinDir = await makePostgresBinDir(resourcesRoot, "darwin-arm64");
    const childEnv = createDesktopUpdateChildEnvironment({
      resourcesPath: resourcesRoot,
      env: {
        RUDDER_HOME: "/tmp/rudder-home",
        [RUDDER_POSTGRES_BIN_DIR_ENV]: managedBinDir,
      },
      platform: "darwin",
      validateVersion: false,
    });

    expect(childEnv).toMatchObject({
      RUDDER_HOME: "/tmp/rudder-home",
      [RUDDER_POSTGRES_BIN_DIR_ENV]: managedBinDir,
      [RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]: managedBinDir,
    });
  });

  it("stages a preserved managed payload into the target runtime for shell updates", async () => {
    const resourcesRoot = await makeTempRoot();
    const rudderHome = await makeTempRoot();
    const managedBinDir = await makePostgresBinDir(
      resourcesRoot,
      desktopPostgresPlatformSegment(),
    );
    const childEnv = createDesktopUpdateChildEnvironment({
      resourcesPath: resourcesRoot,
      env: {
        RUDDER_HOME: rudderHome,
        [RUDDER_POSTGRES_BIN_DIR_ENV]: managedBinDir,
      },
      validateVersion: false,
    });
    const previousBinDir = process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
    const previousManagedBinDir = process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];
    process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = childEnv[RUDDER_POSTGRES_BIN_DIR_ENV];
    process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] =
      childEnv[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];

    try {
      const runtime = await ensureRuntimeInstalled({
        version: "0.5.2-canary.1",
        homeDir: rudderHome,
        spawnSyncImpl: vi.fn(() => ({
          status: 0,
          stdout: "installed target runtime",
          stderr: "",
        })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });
      const compatibilityBinDir = resolveRuntimePostgresPayloadBinDir(runtime.cacheDir);
      const sharedBinDir = path.join(
        rudderHome,
        "runtime-payloads",
        DESKTOP_POSTGRES_RUNTIME_DIR,
        desktopPostgresPlatformSegment(),
        "bin",
      );

      expect(runtime.postgresPayloadBinDir).toBe(sharedBinDir);
      expect(runtimeSupportsDesktopShellAssets("0.5.2-canary.1", runtime)).toBe(true);
      expect(
        resolveDesktopPostgresBinDir(runtime.cacheDir, { validateVersion: false }),
      ).toBe(compatibilityBinDir);
    } finally {
      if (previousBinDir === undefined) delete process.env[RUDDER_POSTGRES_BIN_DIR_ENV];
      else process.env[RUDDER_POSTGRES_BIN_DIR_ENV] = previousBinDir;
      if (previousManagedBinDir === undefined) {
        delete process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV];
      } else {
        process.env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV] = previousManagedBinDir;
      }
    }
  });

  it("migrates an unmarked PostgreSQL path from an older runtime cache", async () => {
    const resourcesRoot = await makeTempRoot();
    const rudderHome = await makeTempRoot();
    const oldRuntimeRoot = path.join(rudderHome, "runtimes", "0.5.1");
    const oldBinDir = await makePostgresBinDir(oldRuntimeRoot, "darwin-arm64");
    const newRuntimeRoot = path.join(rudderHome, "runtimes", "0.5.2-canary.1");
    const newBinDir = await makePostgresBinDir(newRuntimeRoot, "darwin-arm64");
    const env = {
      RUDDER_HOME: rudderHome,
      [RUDDER_POSTGRES_BIN_DIR_ENV]: oldBinDir,
    };

    expect(
      reconcileDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        externalRuntimeCacheDir: newRuntimeRoot,
        env,
        platform: "darwin",
        arch: "arm64",
        validateVersion: false,
      }),
    ).toBe(newBinDir);
    expect(env).toMatchObject({
      [RUDDER_POSTGRES_BIN_DIR_ENV]: newBinDir,
      [RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]: newBinDir,
    });
  });

  it("recognizes an unmarked legacy runtime under a tilde-expanded custom home", async () => {
    const resourcesRoot = await makeTempRoot();
    const homeToken = path.basename(await makeTempRoot());
    const configuredHome = `~/${homeToken}`;
    const oldBinDir = path.join(
      os.homedir(),
      homeToken,
      "runtimes",
      "0.5.1",
      DESKTOP_POSTGRES_RUNTIME_DIR,
      "win32-x64",
      "bin",
    );
    const newRuntimeRoot = await makeTempRoot();
    const newBinDir = await makePostgresBinDir(newRuntimeRoot, "win32-x64");
    const env = {
      RUDDER_HOME: configuredHome,
      [RUDDER_POSTGRES_BIN_DIR_ENV]: oldBinDir,
    };

    expect(
      reconcileDesktopPostgresBinDir({
        isPackaged: true,
        resourcesPath: resourcesRoot,
        externalRuntimeCacheDir: newRuntimeRoot,
        env,
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBe(newBinDir);
    expect(env[RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV]).toBe(newBinDir);
  });

  it("preserves operator-provided PostgreSQL paths for update children", () => {
    const childEnv = createDesktopUpdateChildEnvironment({
      resourcesPath: "/Applications/Rudder.app/Contents/Resources",
      env: {
        [RUDDER_POSTGRES_BIN_DIR_ENV]: "/opt/postgresql/18/bin",
      },
    });

    expect(childEnv[RUDDER_POSTGRES_BIN_DIR_ENV]).toBe("/opt/postgresql/18/bin");
  });

  it("does not select a payload for the development shell", async () => {
    const resourcesRoot = await makeTempRoot();
    await makePostgresBinDir(resourcesRoot, "win32-x64");

    expect(
      resolvePreferredDesktopPostgresBinDir({
        isPackaged: false,
        resourcesPath: resourcesRoot,
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBeNull();
  });
});
