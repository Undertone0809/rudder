import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeSupportsDesktopShellAssets } from "../../cli/src/commands/start.js";
import {
  ensureRuntimeInstalled,
  resolveRuntimePostgresPayloadBinDir,
} from "../../cli/src/runtime/install.js";
import {
  DESKTOP_POSTGRES_RUNTIME_DIR,
  RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR_ENV,
  RUDDER_POSTGRES_BIN_DIR_ENV,
  createDesktopUpdateChildEnvironment,
  desktopPostgresPlatformSegment,
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
    await writeFile(templatePath, "postgres template");
  }
  return binDir;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop PostgreSQL runtime payload", () => {
  it("uses platform and architecture in the payload path", () => {
    expect(desktopPostgresPlatformSegment("win32", "x64")).toBe("win32-x64");
    expect(desktopPostgresPlatformSegment("darwin", "arm64")).toBe("darwin-arm64");
  });

  it("resolves a bundled PostgreSQL 18.4 bin directory", async () => {
    const root = await makeTempRoot();
    const binDir = await makePostgresBinDir(root, "win32-x64");

    expect(resolveDesktopPostgresBinDir(root, { platform: "win32", arch: "x64", validateVersion: false })).toBe(binDir);
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
        platform: "win32",
        arch: "x64",
        validateVersion: false,
      }),
    ).toBe(cachedBinDir);
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
    const env = { [RUDDER_POSTGRES_BIN_DIR_ENV]: staleDesktopBinDir };

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
      const stagedBinDir = resolveRuntimePostgresPayloadBinDir(runtime.cacheDir);

      expect(runtime.postgresPayloadBinDir).toBe(stagedBinDir);
      expect(runtimeSupportsDesktopShellAssets("0.5.2-canary.1", runtime)).toBe(true);
      expect(
        resolveDesktopPostgresBinDir(runtime.cacheDir, { validateVersion: false }),
      ).toBe(stagedBinDir);
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
