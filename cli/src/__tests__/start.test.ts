import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { access, chmod, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  assertChecksumMatch,
  buildGithubReleaseAssetDownloadUrl,
  buildLinuxDesktopEntry,
  buildWindowsRobocopyMirrorCommand,
  buildWindowsZipExtractCommand,
  compareStableSemver,
  copyPortableAppBundle,
  downloadAsset,
  downloadChecksums,
  downloadDesktopAssetWithCache,
  getCliUpdateNotice,
  isExactRuntimePackageSpec,
  isInstalledDesktopCurrent,
  isPersistentCliVersionCurrent,
  isSuccessfulRobocopyExitCode,
  parseChecksumFile,
  prepareForDesktopReplace,
  pruneDesktopAssetCache,
  resolveAssetChecksum,
  resolveCliInstallSpec,
  resolveCurrentCliVersion,
  resolveDefaultDesktopInstallRoot,
  resolveDesktopAssetCacheDir,
  resolveDesktopAssetCandidates,
  resolveDesktopAssetName,
  resolveDesktopAssetTarget,
  resolveDesktopInstallLockPath,
  resolveDesktopInstallPaths,
  resolveDesktopReleaseTag,
  resolveDesktopReleaseVersion,
  resolveDesktopShellAssetName,
  runtimeSupportsDesktopShellAssets,
  selectChecksumAsset,
  selectChecksummedDesktopAssetCandidate,
  selectDesktopAsset,
  selectDesktopShellAsset,
  startCommand,
  waitForProcessExit,
  withDesktopInstallLock,
} from "../commands/start.js";
import {
  CLI_NPM_PACKAGE_NAME,
  detectPersistentCliState,
  hasGlobalInstalledPackage,
  hasPersistentBinaryOnPath,
  installPersistentCli,
  isLikelyNpxExecutionContext,
  isTransientBinaryPath,
  resolvePersistentCliInstallSpec,
} from "../install.js";
import { runCli } from "../program.js";
import {
  ensureRuntimeInstalled,
  NPM_PUBLIC_REGISTRY_URL,
  pruneRuntimeCache,
  readRuntimeInstallMetadata,
  resolveRuntimeCacheDir,
  resolveRuntimePostgresPayloadBinDir,
  resolveSharedRuntimePostgresPayloadBinDir,
  RUNTIME_METADATA_FILE,
  type RuntimeInstallError,
} from "../runtime/install.js";
import { createByteProgress, formatByteProgress } from "../utils/progress.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const npmInstallCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmInstallSpawnOptions = {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
  ...(process.platform === "win32" ? { shell: true, windowsHide: true } : {}),
};

function currentEmbeddedPostgresPlatformPackage(): string | null {
  if (process.platform === "darwin" && process.arch === "arm64") return "@embedded-postgres/darwin-arm64";
  if (process.platform === "darwin" && process.arch === "x64") return "@embedded-postgres/darwin-x64";
  if (process.platform === "linux" && process.arch === "arm64") return "@embedded-postgres/linux-arm64";
  if (process.platform === "linux" && process.arch === "arm") return "@embedded-postgres/linux-arm";
  if (process.platform === "linux" && process.arch === "ia32") return "@embedded-postgres/linux-ia32";
  if (process.platform === "linux" && process.arch === "ppc64") return "@embedded-postgres/linux-ppc64";
  if (process.platform === "linux" && process.arch === "x64") return "@embedded-postgres/linux-x64";
  if (process.platform === "win32" && process.arch === "x64") return "@embedded-postgres/windows-x64";
  return null;
}

function writeRuntimePackageSync(cacheDir: string, packageName: string, version = "1.0.0"): void {
  const packageDir = path.join(cacheDir, "node_modules", ...packageName.split("/"));
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: packageName, version }), "utf8");
  writeFileSync(path.join(packageDir, "index.js"), "", "utf8");
}

async function writeFakePostgresRuntime(root: string): Promise<string> {
  const binDir = path.join(root, "pgsql", "bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(path.join(root, "pgsql", "lib"), { recursive: true });
  await mkdir(path.join(root, "pgsql", "share", "postgresql"), { recursive: true });
  for (const binary of ["initdb", "pg_ctl"]) {
    await writeFile(path.join(binDir, process.platform === "win32" ? `${binary}.exe` : binary), "", "utf8");
  }
  const postgresPath = path.join(binDir, process.platform === "win32" ? "postgres.exe" : "postgres");
  await writeFile(
    postgresPath,
    process.platform === "win32" ? "@echo off\r\necho PostgreSQL 18.4\r\n" : "#!/bin/sh\necho 'PostgreSQL 18.4'\n",
    "utf8",
  );
  await chmod(postgresPath, 0o755);
  await writeFile(path.join(root, "pgsql", "lib", "libpq.5.dylib"), "runtime lib", "utf8");
  await writeFile(path.join(root, "pgsql", "share", "postgresql", "postgres.bki"), "postgres template", "utf8");
  await writeFile(path.join(root, "pgsql", "share", "postgresql", "postgresql.conf.sample"), "postgres config template", "utf8");
  return binDir;
}

async function expectRuntimePostgresCompatibilityLink(
  compatibilityRoot: string,
  sharedRoot: string,
): Promise<void> {
  expect((await lstat(compatibilityRoot)).isSymbolicLink()).toBe(true);
  expect(await realpath(compatibilityRoot)).toBe(await realpath(sharedRoot));
  if (process.platform === "win32") {
    expect(path.resolve(await readlink(compatibilityRoot))).toBe(path.resolve(sharedRoot));
  } else {
    expect(await readlink(compatibilityRoot)).toBe(
      path.relative(path.dirname(compatibilityRoot), sharedRoot),
    );
  }
}

async function writeRuntimeCacheEntry(
  homeDir: string,
  version: string,
  options: { installedAt: string; lastUsedAt?: string; payload?: string } = { installedAt: "2026-01-01T00:00:00.000Z" },
): Promise<string> {
  const cacheDir = resolveRuntimeCacheDir(version, homeDir);
  const packageDir = path.join(cacheDir, "node_modules", "@rudderhq", "server");
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true }), "utf8");
  await writeFile(
    path.join(cacheDir, RUNTIME_METADATA_FILE),
    JSON.stringify({
      version: 1,
      packageName: "@rudderhq/server",
      packageVersion: version,
      installedAt: options.installedAt,
      ...(options.lastUsedAt ? { lastUsedAt: options.lastUsedAt } : {}),
    }),
    "utf8",
  );
  await writeFile(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "@rudderhq/server", version }),
    "utf8",
  );
  await writeFile(path.join(cacheDir, "payload.txt"), options.payload ?? version, "utf8");
  return cacheDir;
}

async function writeDesktopAssetCacheEntry(
  homeDir: string,
  assetName: string,
  payload: string,
  mtime: string,
): Promise<{ cacheDir: string; checksum: string; path: string }> {
  const checksum = sha256(payload);
  const cacheDir = resolveDesktopAssetCacheDir(checksum, homeDir);
  const assetPath = path.join(cacheDir, assetName);
  const timestamp = new Date(mtime);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(assetPath, payload, "utf8");
  await utimes(assetPath, timestamp, timestamp);
  await utimes(cacheDir, timestamp, timestamp);
  return { cacheDir, checksum, path: assetPath };
}

function responseFromChunks(chunks: string[], headers: Record<string, string> = {}): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    }),
  } as Response;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("persistent CLI install helpers", () => {
  it("detects npx execution from transient _npx entry paths", () => {
    expect(
      isLikelyNpxExecutionContext("/tmp/npm-cache/_npx/abc/node_modules/@rudderhq/cli/dist/index.js", {}),
    ).toBe(true);
  });

  it("does not treat normal local development execution as npx", () => {
    expect(
      isLikelyNpxExecutionContext("/Users/test/projects/rudder/cli/src/index.ts", {
        npm_command: "run-script",
      }),
    ).toBe(false);
  });

  it("resolves the install spec to the current package version when available", () => {
    expect(
      resolvePersistentCliInstallSpec({
        npm_package_name: CLI_NPM_PACKAGE_NAME,
        npm_package_version: "2026.327.0-canary.2",
      }),
    ).toBe("@rudderhq/cli@2026.327.0-canary.2");
  });

  it("falls back to the package name when version metadata is missing", () => {
    expect(resolvePersistentCliInstallSpec({})).toBe(CLI_NPM_PACKAGE_NAME);
  });

  it("reads the global install state from npm list output", () => {
    const execFileSyncImpl = vi.fn(() =>
      JSON.stringify({
        dependencies: {
          "@rudderhq/cli": { version: "0.1.0" },
        },
      }),
    );

    expect(hasGlobalInstalledPackage(CLI_NPM_PACKAGE_NAME, execFileSyncImpl as never)).toBe(true);
  });

  it("detects a persistent rudder binary on PATH", () => {
    const execFileSyncImpl = vi.fn(() => "/usr/local/bin/rudder\n");
    expect(hasPersistentBinaryOnPath(execFileSyncImpl as never)).toBe(true);
  });

  it("ignores transient npx binaries on PATH", () => {
    const execFileSyncImpl = vi.fn(() => "/tmp/npm-cache/_npx/abc/bin/rudder\n");
    expect(hasPersistentBinaryOnPath(execFileSyncImpl as never)).toBe(false);
    expect(isTransientBinaryPath("/tmp/npm-cache/_npx/abc/bin/rudder")).toBe(true);
  });

  it("marks npx execution as already installed when the package is present globally", () => {
    const execFileSyncImpl = vi
      .fn()
      .mockReturnValueOnce(
        JSON.stringify({
          dependencies: {
            "@rudderhq/cli": { version: "0.1.0" },
          },
        }),
      );

    expect(
      detectPersistentCliState({
        entryPath: "/tmp/npm-cache/_npx/abc/node_modules/@rudderhq/cli/dist/index.js",
        env: {},
        execFileSyncImpl: execFileSyncImpl as never,
      }),
    ).toEqual({
      usingNpx: true,
      alreadyInstalled: true,
      installSpec: "@rudderhq/cli",
      installCommand: "npm install --global @rudderhq/cli",
    });
  });

  it("requires installation when launched from npx without a global package or persistent binary", () => {
    const execFileSyncImpl = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("missing");
      })
      .mockImplementationOnce(() => "/tmp/npm-cache/_npx/abc/bin/rudder\n");

    expect(
      detectPersistentCliState({
        entryPath: "/tmp/npm-cache/_npx/abc/node_modules/@rudderhq/cli/dist/index.js",
        env: {
          npm_package_name: "@rudderhq/cli",
          npm_package_version: "0.1.0",
        },
        execFileSyncImpl: execFileSyncImpl as never,
      }),
    ).toEqual({
      usingNpx: true,
      alreadyInstalled: false,
      installSpec: "@rudderhq/cli@0.1.0",
      installCommand: "npm install --global @rudderhq/cli@0.1.0",
    });
  });

  it("runs npm install --global for the resolved package spec", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: 0,
      stdout: "added 1 package",
      stderr: "",
    }));

    expect(
      installPersistentCli({
        installSpec: "@rudderhq/cli@0.1.0",
        spawnSyncImpl: spawnSyncImpl as never,
      }),
    ).toEqual({
      ok: true,
      command: "npm install --global @rudderhq/cli@0.1.0",
      output: "added 1 package",
    });

    expect(spawnSyncImpl).toHaveBeenCalledWith(
      npmInstallCommand,
      ["install", "--global", "@rudderhq/cli@0.1.0"],
      npmInstallSpawnOptions,
    );
  });

  it("retries with --force when npm reports an existing rudder binary", () => {
    const spawnSyncImpl = vi
      .fn()
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "npm error code EEXIST\nnpm error File exists: /usr/local/bin/rudder\n",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "changed 1 package",
        stderr: "",
      });

    expect(
      installPersistentCli({
        installSpec: "@rudderhq/cli@0.1.0",
        spawnSyncImpl: spawnSyncImpl as never,
      }),
    ).toEqual({
      ok: true,
      command: "npm install --global --force @rudderhq/cli@0.1.0",
      output: "changed 1 package",
    });

    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      1,
      npmInstallCommand,
      ["install", "--global", "@rudderhq/cli@0.1.0"],
      npmInstallSpawnOptions,
    );
    expect(spawnSyncImpl).toHaveBeenNthCalledWith(
      2,
      npmInstallCommand,
      ["install", "--global", "--force", "@rudderhq/cli@0.1.0"],
      npmInstallSpawnOptions,
    );
  });

  it("includes npm spawn errors in failed install output", () => {
    const spawnSyncImpl = vi.fn(() => ({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("spawn npm failed"),
    }));

    expect(
      installPersistentCli({
        installSpec: "@rudderhq/cli@0.1.0",
        spawnSyncImpl: spawnSyncImpl as never,
      }),
    ).toEqual({
      ok: false,
      command: "npm install --global @rudderhq/cli@0.1.0",
      output: "spawn npm failed",
    });
  });
});

describe("desktop start command helpers", () => {
  it("parses an explicit desktop target version without invoking the root CLI version flag", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runCli([
        process.execPath,
        "rudder",
        "start",
        "--no-cli",
        "--target-version",
        "0.3.1",
        "--repo",
        "example/rudder",
        "--dry-run",
        "--no-open",
      ])).resolves.toBe(0);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    const output = [
      ...stdout.mock.calls.map((call) => String(call[0])),
      ...stderr.mock.calls.map((call) => String(call[0])),
    ].join("");
    expect(output).not.toBe("0.3.1\n");
  });

  it("parses deferred desktop replacement while active runs finish", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(runCli([
        process.execPath,
        "rudder",
        "start",
        "--no-cli",
        "--target-version",
        "0.3.1",
        "--repo",
        "example/rudder",
        "--wait-for-active-runs",
        "--dry-run",
        "--no-open",
      ])).resolves.toBe(0);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("treats server-only start as a first-class path that skips Desktop installation", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let output = "";
    try {
      await expect(runCli([
        process.execPath,
        "rudder",
        "start",
        "--server-only",
        "--target-version",
        "0.3.1",
        "--dry-run",
        "--no-version-check",
      ])).resolves.toBe(0);
      output = [
        ...stdout.mock.calls.map((call) => String(call[0])),
        ...stderr.mock.calls.map((call) => String(call[0])),
      ].join("");
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }

    expect(output).toContain("rudder start --server-only");
    expect(output).toContain("Preparing Rudder runtime");
    expect(output).toContain("Preparing persistent CLI");
    expect(output).toContain("Server-only install");
    expect(output).toContain("Desktop app installation was skipped");
    expect(output).not.toContain("Installing desktop app");
    expect(output).not.toContain("Would resolve, download, verify, install");
  });

  it("uses the explicit desktop target version before the legacy start version option", async () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(startCommand({
        cli: false,
        targetVersion: "0.3.1",
        version: "0.3.1-beta.1",
        repo: "example/rudder",
        dryRun: true,
        open: false,
      })).resolves.toBeUndefined();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("serializes desktop install work for the same install target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-desktop-install-lock."));
    try {
      const paths = resolveDesktopInstallPaths(
        { platform: "macos", arch: "arm64", extension: ".zip" },
        path.join(root, "Applications"),
      );
      const firstEntered = createDeferred();
      const releaseFirst = createDeferred();
      const order: string[] = [];
      let secondEntered = false;

      const first = withDesktopInstallLock(paths, async () => {
        order.push("first");
        firstEntered.resolve();
        await releaseFirst.promise;
        return "first";
      }, { pollMs: 5, timeoutMs: 1_000 });

      await firstEntered.promise;

      const second = withDesktopInstallLock(paths, async () => {
        secondEntered = true;
        order.push("second");
        return "second";
      }, { pollMs: 5, timeoutMs: 1_000 });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondEntered).toBe(false);

      releaseFirst.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
      expect(order).toEqual(["first", "second"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears stale desktop install locks from dead processes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-desktop-stale-lock."));
    try {
      const paths = resolveDesktopInstallPaths(
        { platform: "macos", arch: "arm64", extension: ".zip" },
        path.join(root, "Applications"),
      );
      const lockPath = resolveDesktopInstallLockPath(paths);
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          pid: 999_999_999,
          installRoot: paths.installRoot,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );

      await expect(
        withDesktopInstallLock(paths, async () => "recovered", { pollMs: 5, timeoutMs: 1_000 }),
      ).resolves.toBe("recovered");
      await expect(access(lockPath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not steal desktop install locks from live processes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-desktop-live-lock."));
    try {
      const paths = resolveDesktopInstallPaths(
        { platform: "macos", arch: "arm64", extension: ".zip" },
        path.join(root, "Applications"),
      );
      const lockPath = resolveDesktopInstallLockPath(paths);
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(
        lockPath,
        JSON.stringify({
          lockId: "other-lock",
          pid: process.pid,
          installRoot: paths.installRoot,
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
        }),
        "utf8",
      );

      await expect(
        withDesktopInstallLock(paths, async () => "unexpected", { pollMs: 5, timeoutMs: 20 }),
      ).rejects.toThrow("Timed out waiting for Rudder Desktop install lock");

      await expect(readFile(lockPath, "utf8")).resolves.toContain("other-lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not remove another desktop install lock holder on release", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-desktop-lock-owner."));
    try {
      const paths = resolveDesktopInstallPaths(
        { platform: "macos", arch: "arm64", extension: ".zip" },
        path.join(root, "Applications"),
      );
      const lockPath = resolveDesktopInstallLockPath(paths);

      await withDesktopInstallLock(paths, async () => {
        await writeFile(
          lockPath,
          JSON.stringify({
            lockId: "other-lock",
            pid: process.pid,
            installRoot: paths.installRoot,
            createdAt: new Date().toISOString(),
          }),
          "utf8",
        );
        return "done";
      }, { pollMs: 5, timeoutMs: 1_000 });

      await expect(readFile(lockPath, "utf8")).resolves.toContain("other-lock");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies portable app bundles without rewriting relative symlinks", async () => {
    if (process.platform === "win32") return;

    const root = await mkdtemp(path.join(tmpdir(), "rudder-copy-bundle-test."));
    try {
      const source = path.join(root, "source");
      const destination = path.join(root, "destination");
      const packagePath = path.join(source, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg");
      const symlinkPath = path.join(source, "node_modules", "pkg");
      await mkdir(packagePath, { recursive: true });
      await writeFile(path.join(packagePath, "index.js"), "export {};\n");
      await symlink(".pnpm/pkg@1.0.0/node_modules/pkg", symlinkPath);

      await copyPortableAppBundle(source, destination);

      const copiedSymlink = path.join(destination, "node_modules", "pkg");
      expect(await readlink(copiedSymlink)).toBe(".pnpm/pkg@1.0.0/node_modules/pkg");
      await access(path.join(copiedSymlink, "index.js"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Windows-native archive and mirror commands for portable app installs", () => {
    expect(buildWindowsZipExtractCommand("C:\\Temp\\Rudder.zip", "C:\\Temp\\rudder-extract")).toEqual({
      command: "tar.exe",
      args: ["-xf", "C:\\Temp\\Rudder.zip", "-C", "C:\\Temp\\rudder-extract"],
    });
    expect(buildWindowsRobocopyMirrorCommand("C:\\Temp\\win-unpacked", "C:\\Users\\test\\AppData\\Local\\Programs\\Rudder")).toEqual({
      command: "robocopy.exe",
      args: [
        "C:\\Temp\\win-unpacked",
        "C:\\Users\\test\\AppData\\Local\\Programs\\Rudder",
        "/MIR",
        "/R:2",
        "/W:1",
        "/NFL",
        "/NDL",
        "/NJH",
        "/NJS",
        "/NP",
      ],
    });
    expect(isSuccessfulRobocopyExitCode(0)).toBe(true);
    expect(isSuccessfulRobocopyExitCode(1)).toBe(true);
    expect(isSuccessfulRobocopyExitCode(7)).toBe(true);
    expect(isSuccessfulRobocopyExitCode(8)).toBe(false);
    expect(isSuccessfulRobocopyExitCode(null)).toBe(false);
  });

  it("resolves the current CLI version from npm execution metadata", () => {
    expect(
      resolveCurrentCliVersion({
        npm_package_name: "@rudderhq/cli",
        npm_package_version: "0.3.1",
      }),
    ).toBe("0.3.1");
  });

  it("pins the persistent CLI install spec to the resolved version", () => {
    expect(resolveCliInstallSpec("0.3.1", {})).toBe("@rudderhq/cli@0.3.1");
  });

  it("maps stable versions to stable GitHub release tags", () => {
    expect(resolveDesktopReleaseTag("0.3.1")).toBe("v0.3.1");
  });

  it("maps canary versions to canary GitHub release tags", () => {
    expect(resolveDesktopReleaseTag("0.3.1-canary.2")).toBe("canary/v0.3.1-canary.2");
  });

  it("rejects unsupported prerelease desktop starts", () => {
    expect(() => resolveDesktopReleaseTag("0.3.1-beta.2")).toThrow(
      "Desktop release lookup requires a release version",
    );
  });

  it("resolves platform portable asset targets", () => {
    expect(resolveDesktopAssetTarget("darwin", "arm64")).toEqual({
      platform: "macos",
      arch: "arm64",
      extension: ".zip",
    });
    expect(resolveDesktopAssetTarget("win32", "x64")).toEqual({
      platform: "windows",
      arch: "x64",
      extension: ".zip",
    });
    expect(resolveDesktopAssetTarget("win32", "arm64")).toEqual({
      platform: "windows",
      arch: "x64",
      extension: ".zip",
    });
    expect(resolveDesktopAssetTarget("linux", "x64")).toEqual({
      platform: "linux",
      arch: "x64",
      extension: ".AppImage",
    });
    expect(() => resolveDesktopAssetTarget("linux", "arm64")).toThrow("does not publish portable assets");
  });

  it("builds deterministic portable asset names and release download URLs", () => {
    const macTarget = { platform: "macos" as const, arch: "arm64" as const, extension: ".zip" as const };
    const linuxTarget = { platform: "linux" as const, arch: "x64" as const, extension: ".AppImage" as const };
    const windowsTarget = { platform: "windows" as const, arch: "x64" as const, extension: ".zip" as const };

    expect(resolveDesktopReleaseVersion("canary/v0.3.1-canary.2")).toBe("0.3.1-canary.2");
    expect(resolveDesktopReleaseVersion("v0.3.1")).toBe("0.3.1");
    expect(resolveDesktopReleaseVersion("latest")).toBeNull();
    expect(resolveDesktopAssetName("0.3.1-canary.2", macTarget)).toBe(
      "Rudder-0.3.1-canary.2-macos-arm64-portable.zip",
    );
    expect(resolveDesktopAssetName("0.3.1-canary.2", linuxTarget)).toBe(
      "Rudder-0.3.1-canary.2-linux-x64.AppImage",
    );
    expect(resolveDesktopAssetName("0.3.1-canary.2", windowsTarget)).toBe(
      "Rudder-0.3.1-canary.2-windows-x64-portable.zip",
    );
    expect(resolveDesktopShellAssetName("0.3.1-canary.2", macTarget)).toBe(
      "Rudder-0.3.1-canary.2-macos-arm64-shell.zip",
    );
    expect(resolveDesktopShellAssetName("0.3.1-canary.2", windowsTarget)).toBe(
      "Rudder-0.3.1-canary.2-windows-x64-shell.zip",
    );
    expect(resolveDesktopShellAssetName("0.3.1-canary.2", linuxTarget)).toBeNull();
    expect(
      buildGithubReleaseAssetDownloadUrl(
        "Undertone0809/rudder",
        "canary/v0.3.1-canary.2",
        "SHASUMS256.txt",
      ),
    ).toBe("https://github.com/Undertone0809/rudder/releases/download/canary/v0.3.1-canary.2/SHASUMS256.txt");
  });

  it("selects the best matching desktop asset by platform and architecture", () => {
    const assets = [
      { name: "Rudder-0.3.1-macos-x64-portable.zip", browser_download_url: "https://example.test/macos-x64" },
      { name: "Rudder-0.3.1-macos-arm64-portable.zip", browser_download_url: "https://example.test/macos-arm64" },
      { name: "Rudder-0.3.1-windows-x64-portable.zip", browser_download_url: "https://example.test/windows" },
    ];

    expect(selectDesktopAsset(assets, { platform: "macos", arch: "arm64", extension: ".zip" })?.name).toBe(
      "Rudder-0.3.1-macos-arm64-portable.zip",
    );
  });

  it("prefers layered shell desktop assets when the release publishes them", () => {
    const assets = [
      { name: "Rudder-0.3.1-macos-arm64-portable.zip", browser_download_url: "https://example.test/macos-arm64-full" },
      { name: "Rudder-0.3.1-macos-arm64-shell.zip", browser_download_url: "https://example.test/macos-arm64-shell" },
      { name: "Rudder-0.3.1-macos-x64-shell.zip", browser_download_url: "https://example.test/macos-x64-shell" },
    ];
    const target = { platform: "macos" as const, arch: "arm64" as const, extension: ".zip" as const };

    expect(selectDesktopShellAsset(assets, target)?.name).toBe("Rudder-0.3.1-macos-arm64-shell.zip");
    expect(
      resolveDesktopAssetCandidates({
        releaseAssets: assets,
        target,
        repo: "Undertone0809/rudder",
        tag: "v0.3.1",
        directReleaseVersion: "0.3.1",
      }).map((candidate) => candidate.kind),
    ).toEqual(["shell", "full"]);
  });

  it("uses full desktop assets when exact runtime preparation is unavailable", () => {
    const assets = [
      { name: "Rudder-0.3.1-macos-arm64-shell.zip", browser_download_url: "https://example.test/macos-arm64-shell" },
      { name: "Rudder-0.3.1-macos-arm64-portable.zip", browser_download_url: "https://example.test/macos-arm64-full" },
    ];
    const target = { platform: "macos" as const, arch: "arm64" as const, extension: ".zip" as const };

    expect(selectDesktopAsset([
      { name: "Rudder-0.3.1-macos-arm64-shell.zip", browser_download_url: "https://example.test/shell" },
    ], target)).toBeNull();
    expect(
      resolveDesktopAssetCandidates({
        releaseAssets: assets,
        target,
        repo: "Undertone0809/rudder",
        tag: "v0.3.1",
        directReleaseVersion: "0.3.1",
        allowShellAssets: false,
      }).map((candidate) => ({
        kind: candidate.kind,
        name: candidate.asset.name,
      })),
    ).toEqual([
      { kind: "full", name: "Rudder-0.3.1-macos-arm64-portable.zip" },
    ]);
  });

  it("requires an exact versioned runtime before shell assets are eligible", () => {
    expect(isExactRuntimePackageSpec("0.3.1", "@rudderhq/server@0.3.1")).toBe(true);
    expect(isExactRuntimePackageSpec("0.3.1", "@rudderhq/server@latest")).toBe(false);
    expect(isExactRuntimePackageSpec("latest", "@rudderhq/server@latest")).toBe(false);
    expect(runtimeSupportsDesktopShellAssets("0.3.1", {
      packageSpec: "@rudderhq/server@0.3.1",
      postgresPayloadBinDir: undefined,
    })).toBe(false);
    expect(runtimeSupportsDesktopShellAssets("0.3.1", {
      packageSpec: "@rudderhq/server@0.3.1",
      postgresPayloadBinDir: "/tmp/rudder/postgres-18.4/linux-x64/bin",
      postgresRuntime: {
        version: "18.4",
        platform: "linux",
        arch: "x64",
        binDir: "/tmp/rudder/postgres-18.4/linux-x64/bin",
        scope: "shared",
      },
    })).toBe(true);
    expect(runtimeSupportsDesktopShellAssets("0.3.1", {
      packageSpec: "@rudderhq/server@0.3.1",
      postgresPayloadBinDir: "/opt/postgres/18.4/bin",
      postgresRuntime: {
        version: "18.4",
        platform: "linux",
        arch: "x64",
        binDir: "/opt/postgres/18.4/bin",
        scope: "external",
      },
    })).toBe(false);
  });

  it("falls back to the full desktop asset when shell is not checksummed", () => {
    const candidates = [
      {
        kind: "shell" as const,
        asset: { name: "Rudder-0.3.1-macos-arm64-shell.zip", browser_download_url: "https://example.test/shell" },
      },
      {
        kind: "full" as const,
        asset: { name: "Rudder-0.3.1-macos-arm64-portable.zip", browser_download_url: "https://example.test/full" },
      },
    ];
    const selected = selectChecksummedDesktopAssetCandidate(
      candidates,
      parseChecksumFile(
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  Rudder-0.3.1-macos-arm64-portable.zip\n",
      ),
    );

    expect(selected.kind).toBe("full");
    expect(selected.asset.name).toBe("Rudder-0.3.1-macos-arm64-portable.zip");
    expect(selected.expectedChecksum).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(selected.warnings).toEqual([
      "Layered Desktop shell asset is missing from SHASUMS256.txt; falling back to the full portable asset.",
    ]);
  });

  it("tries deterministic shell URLs before full URLs when release metadata is unavailable", () => {
    const target = { platform: "macos" as const, arch: "arm64" as const, extension: ".zip" as const };

    expect(
      resolveDesktopAssetCandidates({
        releaseAssets: [],
        target,
        repo: "Undertone0809/rudder",
        tag: "v0.3.1",
        directReleaseVersion: "0.3.1",
      }).map((candidate) => ({
        kind: candidate.kind,
        name: candidate.asset.name,
      })),
    ).toEqual([
      { kind: "shell", name: "Rudder-0.3.1-macos-arm64-shell.zip" },
      { kind: "full", name: "Rudder-0.3.1-macos-arm64-portable.zip" },
    ]);
  });

  it("fails closed when only an unchecked shell desktop asset is available", () => {
    expect(() => selectChecksummedDesktopAssetCandidate(
      [
        {
          kind: "shell" as const,
          asset: { name: "Rudder-0.3.1-macos-arm64-shell.zip", browser_download_url: "https://example.test/shell" },
        },
      ],
      new Map(),
    )).toThrow("No checksummed Rudder Desktop asset candidate is available.");
  });

  it("supports legacy macOS zip names that omit the platform", () => {
    const assets = [
      { name: "Rudder-0.3.1-arm64.zip", browser_download_url: "https://example.test/macos-arm64" },
      { name: "Rudder-0.3.1-x64.zip", browser_download_url: "https://example.test/macos-x64" },
    ];

    expect(selectDesktopAsset(assets, { platform: "macos", arch: "x64", extension: ".zip" })?.name).toBe(
      "Rudder-0.3.1-x64.zip",
    );
  });

  it("selects checksum assets and parses checksum files", () => {
    const assets = [
      { name: "Rudder-0.3.1-linux-x64.AppImage", browser_download_url: "https://example.test/linux" },
      { name: "SHASUMS256.txt", browser_download_url: "https://example.test/checksums" },
    ];

    expect(selectChecksumAsset(assets)?.name).toBe("SHASUMS256.txt");
    const checksums = parseChecksumFile(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Rudder-0.3.1-linux-x64.AppImage\n",
    );
    expect(resolveAssetChecksum(checksums, "Rudder-0.3.1-linux-x64.AppImage")).toBe(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(() => resolveAssetChecksum(checksums, "Rudder-0.3.1-macos-arm64-portable.zip")).toThrow(
      "checksums do not include",
    );
  });

  it("formats determinate and unknown-size byte progress", () => {
    expect(formatByteProgress({ receivedBytes: 1024, totalBytes: 2048, width: 10 })).toBe(
      "[#####-----] 50% 1.0 KB/2.0 KB",
    );
    expect(formatByteProgress({ receivedBytes: 1024, totalBytes: null, width: 10 })).toBe(
      "[downloaded 1.0 KB]",
    );
  });

  it("uses stable non-TTY progress lines without cursor controls", () => {
    const writes: string[] = [];
    const stream = {
      write(chunk: string) {
        writes.push(String(chunk));
        return true;
      },
    } as unknown as Writable;

    const progress = createByteProgress("Downloading Rudder.zip", {
      stream,
      isTty: false,
    });
    progress.start(2048);
    progress.update(1024, 2048);
    progress.finish(2048, 2048);

    const output = writes.join("");
    expect(output).toContain("Downloading Rudder.zip...\n");
    expect(output).toContain("Downloading Rudder.zip complete (2.0 KB/2.0 KB).\n");
    expect(output).not.toContain("\r");
  });

  it("reports progress while downloading checksum and desktop assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-download-progress-test."));
    const originalFetch = globalThis.fetch;
    const checksumBody =
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Rudder-0.3.1-linux-x64.AppImage\n";
    const desktopBody = "desktop-asset";
    const progressEvents: Array<{ event: string; label: string; receivedBytes?: number; totalBytes?: number | null }> = [];
    const progressFactory = vi.fn((label: string) => ({
      start: vi.fn((totalBytes?: number | null) => {
        progressEvents.push({ event: "start", label, totalBytes });
      }),
      update: vi.fn((receivedBytes: number, totalBytes?: number | null) => {
        progressEvents.push({ event: "update", label, receivedBytes, totalBytes });
      }),
      finish: vi.fn((receivedBytes?: number, totalBytes?: number | null) => {
        progressEvents.push({ event: "finish", label, receivedBytes, totalBytes });
      }),
      fail: vi.fn(() => {
        progressEvents.push({ event: "fail", label });
      }),
    }));

    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        responseFromChunks([checksumBody], {
          "content-length": String(Buffer.byteLength(checksumBody)),
        }),
      )
      .mockResolvedValueOnce(
        responseFromChunks(["desktop-", "asset"], {
          "content-length": String(Buffer.byteLength(desktopBody)),
        }),
      ) as never;

    try {
      const checksums = await downloadChecksums(
        { name: "SHASUMS256.txt", browser_download_url: "https://example.test/checksums" },
        dir,
        progressFactory,
      );
      expect(resolveAssetChecksum(checksums, "Rudder-0.3.1-linux-x64.AppImage")).toBe(
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      );

      const assetPath = await downloadAsset(
        { name: "Rudder-0.3.1-linux-x64.AppImage", browser_download_url: "https://example.test/asset" },
        dir,
        progressFactory,
      );
      expect(await readFile(assetPath, "utf8")).toBe(desktopBody);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }

    expect(progressFactory).toHaveBeenCalledWith("Downloading SHASUMS256.txt");
    expect(progressFactory).toHaveBeenCalledWith("Downloading Rudder-0.3.1-linux-x64.AppImage");
    expect(progressEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "update", label: "Downloading SHASUMS256.txt" }),
        expect.objectContaining({ event: "finish", label: "Downloading SHASUMS256.txt" }),
        expect.objectContaining({ event: "update", label: "Downloading Rudder-0.3.1-linux-x64.AppImage" }),
        expect.objectContaining({ event: "finish", label: "Downloading Rudder-0.3.1-linux-x64.AppImage" }),
      ]),
    );
  });

  it("prefers the public browser download URL when downloading assets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-download-browser-test."));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce(responseFromChunks(["asset"])) as never;

    try {
      const assetPath = await downloadAsset(
        {
          name: "Rudder-0.3.1-linux-x64.AppImage",
          url: "https://api.github.com/repos/example/rudder/releases/assets/123",
          browser_download_url: "https://github.com/example/rudder/releases/download/v0.3.1/Rudder.AppImage",
        },
        dir,
      );

      expect(await readFile(assetPath, "utf8")).toBe("asset");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://github.com/example/rudder/releases/download/v0.3.1/Rudder.AppImage",
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: "*/*",
            "User-Agent": "rudder-cli-installer",
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the GitHub release asset API URL when the browser download URL fails", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-download-api-fallback-test."));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("browser download timed out"))
      .mockResolvedValueOnce(responseFromChunks(["asset"])) as never;

    try {
      const assetPath = await downloadAsset(
        {
          name: "Rudder-0.3.1-linux-x64.AppImage",
          url: "https://api.github.com/repos/example/rudder/releases/assets/123",
          browser_download_url: "https://github.com/example/rudder/releases/download/v0.3.1/Rudder.AppImage",
        },
        dir,
      );

      expect(await readFile(assetPath, "utf8")).toBe("asset");
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        "https://api.github.com/repos/example/rudder/releases/assets/123",
        expect.objectContaining({
          headers: expect.objectContaining({
            Accept: "application/octet-stream",
            "User-Agent": "rudder-cli-installer",
          }),
        }),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reuses a checksum-matched cached desktop asset without downloading", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-asset-cache-hit-test."));
    const originalFetch = globalThis.fetch;
    const assetName = "Rudder-0.3.1-linux-x64.AppImage";
    const assetBody = "cached-desktop-asset";
    const checksum = sha256(assetBody);
    const cacheDir = resolveDesktopAssetCacheDir(checksum, homeDir);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, assetName), assetBody, "utf8");
    globalThis.fetch = vi.fn(() => {
      throw new Error("unexpected download");
    }) as never;

    try {
      const result = await downloadDesktopAssetWithCache(
        { name: assetName, browser_download_url: "https://example.test/asset" },
        checksum,
        { homeDir },
      );

      expect(result).toEqual({
        path: path.join(cacheDir, assetName),
        checksum,
        cacheStatus: "hit",
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("redownloads and replaces a cached desktop asset when the checksum is stale", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-asset-cache-miss-test."));
    const outputDir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-asset-output-test."));
    const originalFetch = globalThis.fetch;
    const assetName = "Rudder-0.3.1-linux-x64.AppImage";
    const assetBody = "fresh-desktop-asset";
    const checksum = sha256(assetBody);
    const cacheDir = resolveDesktopAssetCacheDir(checksum, homeDir);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path.join(cacheDir, assetName), "stale-desktop-asset", "utf8");
    globalThis.fetch = vi.fn().mockResolvedValueOnce(
      responseFromChunks([assetBody], {
        "content-length": String(Buffer.byteLength(assetBody)),
      }),
    ) as never;

    try {
      const result = await downloadDesktopAssetWithCache(
        { name: assetName, browser_download_url: "https://example.test/asset" },
        checksum,
        { homeDir, outputDir },
      );

      expect(result).toEqual({
        path: path.join(cacheDir, assetName),
        checksum,
        cacheStatus: "miss",
      });
      expect(await readFile(result.path, "utf8")).toBe(assetBody);
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(homeDir, { recursive: true, force: true });
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  it("prunes old desktop asset caches while retaining current and previous entries", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-asset-prune-test."));
    try {
      const oldAsset = await writeDesktopAssetCacheEntry(
        homeDir,
        "Rudder-0.3.0-macos-arm64-portable.zip",
        "old-desktop-asset",
        "2026-01-01T00:00:00.000Z",
      );
      const previousAsset = await writeDesktopAssetCacheEntry(
        homeDir,
        "Rudder-0.3.1-macos-arm64-shell.zip",
        "previous-desktop-asset",
        "2026-01-02T00:00:00.000Z",
      );
      const currentAsset = await writeDesktopAssetCacheEntry(
        homeDir,
        "Rudder-0.3.2-macos-arm64-shell.zip",
        "current-desktop-asset",
        "2026-01-03T00:00:00.000Z",
      );

      const result = await pruneDesktopAssetCache({
        homeDir,
        protectedChecksums: [currentAsset.checksum],
        now: new Date("2026-01-04T00:00:00.000Z"),
        maxEntries: 2,
        maxAgeMs: 365 * 24 * 60 * 60 * 1000,
        maxTotalBytes: Number.POSITIVE_INFINITY,
        keepPreviousEntries: 1,
      });

      expect(result.deleted.map((entry) => entry.checksum)).toEqual([oldAsset.checksum]);
      expect(result.protectedChecksums).toEqual(expect.arrayContaining([currentAsset.checksum, previousAsset.checksum]));
      await expect(access(oldAsset.cacheDir)).rejects.toThrow();
      await expect(access(previousAsset.path)).resolves.toBeUndefined();
      await expect(access(currentAsset.path)).resolves.toBeUndefined();
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it("compares stable semver versions", () => {
    expect(compareStableSemver("0.3.2", "0.3.1")).toBeGreaterThan(0);
    expect(compareStableSemver("0.3.1", "0.3.1")).toBe(0);
    expect(compareStableSemver("0.3.0", "0.3.1")).toBeLessThan(0);
  });

  it("checks whether the global CLI is already the requested version", () => {
    expect(isPersistentCliVersionCurrent("0.3.1", "0.3.1")).toBe(true);
    expect(isPersistentCliVersionCurrent("0.3.1", "0.3.0")).toBe(false);
    expect(isPersistentCliVersionCurrent("latest", "0.3.1")).toBe(false);
  });

  it("checks whether installed desktop metadata already matches the release asset", () => {
    expect(
      isInstalledDesktopCurrent(
        {
          version: 1,
          releaseTag: "v0.3.1",
          assetName: "Rudder-0.3.1-macos-arm64-portable.zip",
          assetChecksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          installedAt: "2026-04-27T00:00:00.000Z",
        },
        "v0.3.1",
        "Rudder-0.3.1-macos-arm64-portable.zip",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ),
    ).toBe(true);
    expect(
      isInstalledDesktopCurrent(
        {
          version: 1,
          releaseTag: "v0.3.1",
          assetName: "Rudder-0.3.1-macos-arm64-portable.zip",
          assetChecksum: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          installedAt: "2026-04-27T00:00:00.000Z",
        },
        "v0.3.1",
        "Rudder-0.3.1-macos-arm64-portable.zip",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ),
    ).toBe(false);
  });

  it("resolves per-user portable install paths", () => {
    const macTarget = { platform: "macos" as const, arch: "arm64" as const, extension: ".zip" as const };
    const macInstallRoot = path.join("/Users/test", "Applications");
    const resolvedMacInstallRoot = path.resolve(macInstallRoot);
    const macAppPath = path.join(resolvedMacInstallRoot, "Rudder.app");
    expect(resolveDefaultDesktopInstallRoot(macTarget, {}, "/Users/test")).toBe(macInstallRoot);
    expect(resolveDesktopInstallPaths(macTarget, macInstallRoot)).toMatchObject({
      appPath: macAppPath,
      executablePath: path.join(macAppPath, "Contents", "MacOS", "Rudder"),
    });

    const winTarget = { platform: "windows" as const, arch: "x64" as const, extension: ".zip" as const };
    expect(resolveDefaultDesktopInstallRoot(winTarget, { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" }, "C:\\Users\\test")).toBe(
      path.join("C:\\Users\\test\\AppData\\Local", "Programs", "Rudder"),
    );
  });

  it("validates checksum matches and mismatches", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-checksum-test."));
    const filePath = path.join(dir, "Rudder-test.zip");
    await writeFile(filePath, "portable");
    try {
      expect(assertChecksumMatch(filePath, "01e782826ae5182220bd6158f883d01ceb1bce659dc020e7c511f802a9aa7737")).toBe(
        "01e782826ae5182220bd6158f883d01ceb1bce659dc020e7c511f802a9aa7737",
      );
      expect(() => assertChecksumMatch(filePath, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toThrow(
        "Checksum mismatch",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("waits for an existing Desktop process to exit before replacement", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 25)"], { stdio: "ignore" });
    try {
      expect(child.pid).toBeGreaterThan(0);
      await expect(waitForProcessExit(child.pid!, 1_000, 10)).resolves.toBe(true);
    } finally {
      if (!child.killed) child.kill();
    }
  });

  it("stops waiting when the Desktop process does not exit in time", async () => {
    await expect(waitForProcessExit(process.pid, 20, 5)).resolves.toBe(false);
  });

  it("allows first install when the managed Desktop executable does not exist yet", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-first-install-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(appPath, "Contents", "MacOS", "Rudder");

    try {
      await prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          findDesktopExecutablePids: vi.fn(() => []),
          forceQuitDesktopProcess: vi.fn(),
          waitForDesktopProcessExit: vi.fn(async () => true),
        },
      );

      await expect(access(appPath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not replace immediately when legacy Desktop confirms quit without a pid", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-legacy-quit-test."));
    const installRoot = path.join(dir, "Rudder");
    const executablePath = path.join(installRoot, "Rudder.exe");
    await mkdir(installRoot, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const prefix = ${JSON.stringify("--rudder-update-quit=")};`,
        "const arg = process.argv.find((value) => value.startsWith(prefix));",
        [
          "if (arg) fs.writeFileSync(",
          "arg.slice(prefix.length),",
          "JSON.stringify({ ok: true, status: 'quitting' }) + '\\n',",
          "'utf8'",
          ");",
        ].join(" "),
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      const forceQuitDesktopProcess = vi.fn();
      const waitForDesktopProcessExit = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);
      const replace = prepareForDesktopReplace(
        {
          installRoot,
          appPath: path.join(installRoot, "Rudder.app"),
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "windows", arch: "x64", extension: ".zip" },
        {
          legacyUpdateQuitGraceMs: 100,
          updateQuitForceDelayMs: 0,
          findDesktopExecutablePids: vi.fn(() => [4242]),
          forceQuitDesktopProcess,
          waitForDesktopProcessExit,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(access(installRoot)).resolves.toBeUndefined();

      await replace;
      expect(forceQuitDesktopProcess).toHaveBeenCalledWith(4242, { platform: "windows", arch: "x64", extension: ".zip" });
      await expect(access(installRoot)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not replace when Desktop reports a failed update quit", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-failed-quit-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(dir, "rudder-update-failed-quit-shim");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const prefix = ${JSON.stringify("--rudder-update-quit=")};`,
        "const arg = process.argv.find((value) => value.startsWith(prefix));",
        [
          "if (arg) fs.writeFileSync(",
          "arg.slice(prefix.length),",
          "JSON.stringify({ ok: false, status: 'failed', message: 'Could not cancel active runs.' }) + '\\n',",
          "'utf8'",
          ");",
        ].join(" "),
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      await expect(prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          updateQuitForceDelayMs: 0,
          findDesktopExecutablePids: vi.fn(() => [4242]),
          forceQuitDesktopProcess: vi.fn(),
          waitForDesktopProcessExit: vi.fn(async () => false),
        },
      )).rejects.toThrow("Could not cancel active runs.");

      await expect(access(appPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not replace when a forced update leaves active runs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-force-active-quit-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(dir, "rudder-update-force-active-quit-shim");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const prefix = ${JSON.stringify("--rudder-update-quit=")};`,
        "const arg = process.argv.find((value) => value.startsWith(prefix));",
        [
          "if (arg) fs.writeFileSync(",
          "arg.slice(prefix.length),",
          "JSON.stringify({ ok: false, status: 'active_runs', totalRuns: 2 }) + '\\n',",
          "'utf8'",
          ");",
        ].join(" "),
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      await expect(prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          forceUpdate: true,
          updateQuitForceDelayMs: 0,
          findDesktopExecutablePids: vi.fn(() => [4242]),
          forceQuitDesktopProcess: vi.fn(),
          waitForDesktopProcessExit: vi.fn(async () => false),
        },
      )).rejects.toThrow("still has 2 active runs after the force-update request");

      await expect(access(appPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("keeps polling update quit until running work clears", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-wait-active-quit-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(dir, "rudder-update-wait-active-quit-shim");
    const counterPath = path.join(dir, "quit-attempts.txt");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const counterPath = ${JSON.stringify(counterPath)};`,
        "const attempts = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) + 1 : 1;",
        "fs.writeFileSync(counterPath, String(attempts));",
        `const prefix = ${JSON.stringify("--rudder-update-quit=")};`,
        "const arg = process.argv.find((value) => value.startsWith(prefix));",
        "const response = attempts < 3",
        "  ? { ok: false, status: 'active_runs', totalRuns: 1 }",
        "  : { ok: true, status: 'quitting', pid: 4242 };",
        "if (arg) fs.writeFileSync(arg.slice(prefix.length), JSON.stringify(response) + '\\n', 'utf8');",
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      const waitForDesktopProcessExit = vi.fn(async () => true);
      await prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          waitForActiveRuns: true,
          activeRunPollIntervalMs: 1,
          updateQuitForceDelayMs: 0,
          waitForDesktopProcessExit,
        },
      );

      expect(await readFile(counterPath, "utf8")).toBe("3");
      expect(waitForDesktopProcessExit).toHaveBeenCalledWith(4242);
      await expect(access(appPath)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("upgrades the final active-run guard to a force update", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-force-upgrade-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(dir, "rudder-update-force-upgrade-shim");
    const argvPath = path.join(dir, "quit-argv.json");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const argvPath = ${JSON.stringify(argvPath)};`,
        "const calls = fs.existsSync(argvPath) ? JSON.parse(fs.readFileSync(argvPath, 'utf8')) : [];",
        "calls.push(process.argv);",
        "fs.writeFileSync(argvPath, JSON.stringify(calls));",
        `const prefix = ${JSON.stringify("--rudder-update-quit=")};`,
        "const arg = process.argv.find((value) => value.startsWith(prefix));",
        `const forced = process.argv.includes(${JSON.stringify("--rudder-update-force")});`,
        "const response = forced",
        "  ? { ok: true, status: 'quitting', pid: 4242 }",
        "  : { ok: false, status: 'active_runs', totalRuns: 1 };",
        "if (arg) fs.writeFileSync(arg.slice(prefix.length), JSON.stringify(response) + '\\n', 'utf8');",
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      const waitForForceUpdate = vi.fn(async () => true);
      await prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          waitForActiveRuns: true,
          waitForForceUpdate,
          waitForDesktopProcessExit: vi.fn(async () => true),
        },
      );

      const calls = JSON.parse(await readFile(argvPath, "utf8")) as string[][];
      expect(calls).toHaveLength(2);
      expect(calls[0]).not.toContain("--rudder-update-force");
      expect(calls[1]).toContain("--rudder-update-force");
      expect(waitForForceUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("does not replace when update quit receives no response", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-no-quit-response-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(dir, "rudder-update-no-response-shim");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        "setTimeout(() => {}, 25);",
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      const replace = prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          legacyUpdateQuitGraceMs: 50,
          updateQuitForceDelayMs: 0,
          updateQuitResponseTimeoutMs: 50,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(access(appPath)).resolves.toBeUndefined();

      await expect(replace).rejects.toThrow("Existing Rudder Desktop did not respond to the update quit request");
      await expect(access(appPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("passes the force update flag to the Desktop quit request", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-force-quit-flag-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(dir, "rudder-update-force-flag-shim");
    const argvPath = path.join(dir, "argv.json");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv));`,
        `const prefix = ${JSON.stringify("--rudder-update-quit=")};`,
        "const arg = process.argv.find((value) => value.startsWith(prefix));",
        [
          "if (arg) fs.writeFileSync(",
          "arg.slice(prefix.length),",
          "JSON.stringify({ ok: true, status: 'quitting', pid: 4242 }) + '\\n',",
          "'utf8'",
          ");",
        ].join(" "),
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      await prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          forceUpdate: true,
          updateQuitForceDelayMs: 0,
          forceQuitDesktopProcess: vi.fn(),
          waitForDesktopProcessExit: vi.fn(async () => true),
        },
      );

      const argv = JSON.parse(await readFile(argvPath, "utf8")) as string[];
      expect(argv).toContain("--rudder-update-force");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("force-quits only the reported Desktop pid after update quit timeout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-targeted-quit-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(dir, "rudder-update-quit-shim");
    await mkdir(appPath, { recursive: true });
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const prefix = ${JSON.stringify("--rudder-update-quit=")};`,
        "const arg = process.argv.find((value) => value.startsWith(prefix));",
        [
          "if (arg) fs.writeFileSync(",
          "arg.slice(prefix.length),",
          "JSON.stringify({ ok: true, status: 'quitting', pid: 4242 }) + '\\n',",
          "'utf8'",
          ");",
        ].join(" "),
      ].join("\n"),
      "utf8",
    );
    await chmod(executablePath, 0o755);

    try {
      const forceQuitDesktopProcess = vi.fn();
      await expect(prepareForDesktopReplace(
        {
          installRoot,
          appPath,
          executablePath,
          metadataPath: path.join(installRoot, ".rudder-install.json"),
        },
        { platform: "macos", arch: "arm64", extension: ".zip" },
        {
          updateQuitForceDelayMs: 0,
          forceQuitDesktopProcess,
          waitForDesktopProcessExit: vi.fn(async () => false),
        },
      )).rejects.toThrow("did not exit after force-quit fallback");

      expect(forceQuitDesktopProcess).toHaveBeenCalledWith(4242, { platform: "macos", arch: "arm64", extension: ".zip" });
      await expect(access(appPath)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds Linux desktop entries for the AppImage", () => {
    expect(buildLinuxDesktopEntry("/home/test/.local/share/rudder/Rudder.AppImage")).toContain(
      'Exec="/home/test/.local/share/rudder/Rudder.AppImage"',
    );
  });

  it("reports a non-blocking update notice when npm latest is newer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.3.2" }),
    })) as never;

    try {
      await expect(getCliUpdateNotice("0.3.1")).resolves.toContain("Rudder 0.3.2 is available");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not report an update notice when npm latest is not newer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ version: "0.3.1" }),
    })) as never;

    try {
      await expect(getCliUpdateNotice("0.3.1")).resolves.toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("runtime install helpers", () => {
  it("uses the versioned runtime cache when metadata and package version match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-cache-test."));
    try {
      const cacheDir = resolveRuntimeCacheDir("1.2.3", root);
      const packageDir = path.join(cacheDir, "node_modules", "@rudderhq", "server");
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true }), "utf8");
      await writeFile(
        path.join(cacheDir, RUNTIME_METADATA_FILE),
        JSON.stringify({ version: 1, packageName: "@rudderhq/server", packageVersion: "1.2.3", installedAt: "now" }),
        "utf8",
      );
      await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@rudderhq/server", version: "1.2.3" }), "utf8");
      const spawnSyncImpl = vi.fn();

      await expect(ensureRuntimeInstalled({ version: "1.2.3", homeDir: root, spawnSyncImpl: spawnSyncImpl as never })).resolves.toMatchObject({
        status: "hit",
        cacheDir,
        packageSpec: "@rudderhq/server@1.2.3",
      });
      expect(spawnSyncImpl).not.toHaveBeenCalled();
      await expect(readRuntimeInstallMetadata(cacheDir)).resolves.toMatchObject({
        packageVersion: "1.2.3",
        lastUsedAt: expect.any(String),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects runtime cache hits when the embedded Postgres platform package is missing", async () => {
    const platformPackage = currentEmbeddedPostgresPlatformPackage();
    if (!platformPackage) return;

    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-platform-cache-test."));
    try {
      const cacheDir = resolveRuntimeCacheDir("1.2.3", root);
      const packageDir = path.join(cacheDir, "node_modules", "@rudderhq", "server");
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true }), "utf8");
      await writeFile(
        path.join(cacheDir, RUNTIME_METADATA_FILE),
        JSON.stringify({ version: 1, packageName: "@rudderhq/server", packageVersion: "1.2.3", installedAt: "now" }),
        "utf8",
      );
      await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@rudderhq/server", version: "1.2.3" }), "utf8");
      await mkdir(path.join(cacheDir, "node_modules", "embedded-postgres"), { recursive: true });
      await writeFile(
        path.join(cacheDir, "node_modules", "embedded-postgres", "package.json"),
        JSON.stringify({ name: "embedded-postgres", version: "18.1.0-beta.16" }),
        "utf8",
      );
      await writeFile(path.join(cacheDir, "node_modules", "embedded-postgres", "index.js"), "", "utf8");
      const spawnSyncImpl = vi.fn(() => ({ status: 1, stdout: "", stderr: "registry unavailable" }));

      await expect(
        ensureRuntimeInstalled({ version: "1.2.3", homeDir: root, spawnSyncImpl: spawnSyncImpl as never }),
      ).rejects.toMatchObject({
        name: "RuntimeInstallError",
      } satisfies Partial<RuntimeInstallError>);
      expect(spawnSyncImpl).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a cache hit without embedded PostgreSQL after the shared 18.4 payload is verified", async () => {
    const platformPackage = currentEmbeddedPostgresPlatformPackage();
    if (!platformPackage) return;

    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-shared-platform-cache-test."));
    try {
      const cacheDir = resolveRuntimeCacheDir("1.2.3", root);
      const packageDir = path.join(cacheDir, "node_modules", "@rudderhq", "server");
      const embeddedDir = path.join(cacheDir, "node_modules", "embedded-postgres");
      const sourceBinDir = await writeFakePostgresRuntime(path.join(root, "source"));
      const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      await mkdir(path.dirname(sharedBinDir), { recursive: true });
      await cp(path.dirname(sourceBinDir), path.dirname(sharedBinDir), { recursive: true });
      await mkdir(packageDir, { recursive: true });
      await mkdir(embeddedDir, { recursive: true });
      await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true }), "utf8");
      await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "@rudderhq/server", version: "1.2.3" }), "utf8");
      await writeFile(path.join(embeddedDir, "package.json"), JSON.stringify({
        name: "embedded-postgres",
        version: "18.1.0-beta.16",
        optionalDependencies: { [platformPackage]: "18.1.0-beta.16" },
      }), "utf8");
      await writeFile(path.join(cacheDir, RUNTIME_METADATA_FILE), JSON.stringify({
        version: 1,
        packageName: "@rudderhq/server",
        packageVersion: "1.2.3",
        installedAt: "now",
        postgresRuntime: {
          version: "18.4",
          platform: process.platform,
          arch: process.arch,
          binDir: sharedBinDir,
          scope: "shared",
        },
      }), "utf8");
      const spawnSyncImpl = vi.fn();

      await expect(ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
        preparePostgresPayload: true,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        pruneRuntimeCache: false,
      })).resolves.toMatchObject({
        status: "hit",
        postgresPayloadBinDir: sharedBinDir,
      });
      expect(spawnSyncImpl).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes npm output and retry command when runtime installation fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-fail-test."));
    try {
      const spawnSyncImpl = vi.fn(() => ({ status: 1, stdout: "", stderr: "registry unavailable" }));

      await expect(
        ensureRuntimeInstalled({ version: "1.2.3", homeDir: root, spawnSyncImpl: spawnSyncImpl as never }),
      ).rejects.toMatchObject({
        name: "RuntimeInstallError",
        output: "registry unavailable",
        command: expect.stringMatching(/npm install --prefix .* --include=optional/),
      } satisfies Partial<RuntimeInstallError>);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forces optional dependencies into runtime installs for platform binaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-install-flags-test."));
    try {
      const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "added 1 package", stderr: "" }));

      await expect(
        ensureRuntimeInstalled({ version: "1.2.3", homeDir: root, spawnSyncImpl: spawnSyncImpl as never }),
      ).resolves.toMatchObject({
        status: "installed",
        packageSpec: "@rudderhq/server@1.2.3",
        command: expect.stringContaining("--include=optional"),
      });

      expect(spawnSyncImpl).toHaveBeenCalledWith(
        npmInstallCommand,
        [
          "install",
          "--prefix",
          resolveRuntimeCacheDir("1.2.3", root),
          "--omit=dev",
          "--include=optional",
          "--no-audit",
          "--no-fund",
          "@rudderhq/server@1.2.3",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          ...(process.platform === "win32" ? { shell: true, windowsHide: true } : {}),
        },
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stages a complete PostgreSQL payload for layered Desktop shell assets", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-postgres-payload-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      process.env.RUDDER_POSTGRES_BIN_DIR = await writeFakePostgresRuntime(root);
      process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = process.env.RUDDER_POSTGRES_BIN_DIR;
      const otherPlatformMarker = path.join(
        root,
        "runtime-payloads",
        "postgres-18.4",
        "other-platform",
        "marker",
      );
      await mkdir(path.dirname(otherPlatformMarker), { recursive: true });
      await writeFile(otherPlatformMarker, "preserve");
      const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" }));

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
      });

      const payloadBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      const compatibilityBinDir = resolveRuntimePostgresPayloadBinDir(result.cacheDir);
      expect(result.postgresPayloadBinDir).toBe(payloadBinDir);
      await expect(access(path.join(payloadBinDir, process.platform === "win32" ? "postgres.exe" : "postgres"))).resolves.toBeUndefined();
      await expect(access(path.join(payloadBinDir, "..", "share", "postgresql", "postgres.bki"))).resolves.toBeUndefined();
      await expect(access(path.join(payloadBinDir, "..", "share", "postgresql", "postgresql.conf.sample"))).resolves.toBeUndefined();
      await expect(access(path.join(compatibilityBinDir, process.platform === "win32" ? "postgres.exe" : "postgres"))).resolves.toBeUndefined();
      await expect(readFile(otherPlatformMarker, "utf8")).resolves.toBe("preserve");
      await expectRuntimePostgresCompatibilityLink(
        path.join(result.cacheDir, "postgres-18.4"),
        path.join(root, "runtime-payloads", "postgres-18.4"),
      );
      expect(await readRuntimeInstallMetadata(result.cacheDir)).toMatchObject({
        postgresRuntime: {
          version: "18.4",
          platform: process.platform,
          arch: process.arch,
          binDir: payloadBinDir,
          scope: "shared",
        },
      });
    } finally {
      if (previousPostgresBinDir === undefined) {
        delete process.env.RUDDER_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      }
      if (previousManagedPostgresBinDir === undefined) {
        delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not replace a legacy payload used by a live descriptor without PostgreSQL metadata", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-live-legacy-postgres-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    try {
      delete process.env.RUDDER_POSTGRES_BIN_DIR;
      const sourceBinDir = await writeFakePostgresRuntime(path.join(root, "source"));
      const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      await mkdir(path.dirname(sharedBinDir), { recursive: true });
      await cp(path.dirname(sourceBinDir), path.dirname(sharedBinDir), { recursive: true });

      const cacheDir = resolveRuntimeCacheDir("1.2.3", root);
      writeRuntimePackageSync(cacheDir, "@rudderhq/server", "1.2.3");
      const compatibilityRoot = path.join(cacheDir, "postgres-18.4");
      await cp(path.join(root, "source", "pgsql"), path.join(
        compatibilityRoot,
        `${process.platform}-${process.arch}`,
      ), { recursive: true });
      const descriptorDir = path.join(root, "instances", "legacy", "runtime");
      await mkdir(descriptorDir, { recursive: true });
      await writeFile(path.join(descriptorDir, "server.json"), JSON.stringify({
        instanceId: "legacy",
        pid: process.pid,
        version: "1.2.3",
      }));

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      expect(result.postgresPayloadBinDir).toBe(sharedBinDir);
      expect((await lstat(compatibilityRoot)).isDirectory()).toBe(true);
    } finally {
      if (previousPostgresBinDir === undefined) {
        delete process.env.RUDDER_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not repair a shared payload through a compatibility link used by a live runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-live-shared-link-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      delete process.env.RUDDER_POSTGRES_BIN_DIR;
      delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      const sharedSourceBinDir = await writeFakePostgresRuntime(path.join(root, "shared-source"));
      const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      await mkdir(path.dirname(sharedBinDir), { recursive: true });
      await cp(path.dirname(sharedSourceBinDir), path.dirname(sharedBinDir), { recursive: true });
      const liveMarker = path.join(sharedBinDir, "live-generation");
      await writeFile(liveMarker, "keep");
      await rm(path.join(sharedBinDir, "..", "share", "postgresql", "postgresql.conf.sample"));

      const liveRuntimeDir = resolveRuntimeCacheDir("1.2.3", root);
      await mkdir(liveRuntimeDir, { recursive: true });
      const compatibilityRoot = path.join(liveRuntimeDir, "postgres-18.4");
      const sharedRoot = path.join(root, "runtime-payloads", "postgres-18.4");
      await symlink(
        process.platform === "win32"
          ? sharedRoot
          : path.relative(path.dirname(compatibilityRoot), sharedRoot),
        compatibilityRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
      const descriptorDir = path.join(root, "instances", "live", "runtime");
      await mkdir(descriptorDir, { recursive: true });
      await writeFile(path.join(descriptorDir, "server.json"), JSON.stringify({
        instanceId: "live",
        pid: process.pid,
        version: "1.2.3",
        postgresBinDir: resolveRuntimePostgresPayloadBinDir(liveRuntimeDir),
      }));

      const legacySourceDir = resolveRuntimeCacheDir("legacy-source", root);
      const repairSourceBinDir = await writeFakePostgresRuntime(path.join(root, "repair-source"));
      const legacyBinDir = resolveRuntimePostgresPayloadBinDir(legacySourceDir);
      await mkdir(path.dirname(legacyBinDir), { recursive: true });
      await cp(path.dirname(repairSourceBinDir), path.dirname(legacyBinDir), { recursive: true });

      await expect(ensureRuntimeInstalled({
        version: "1.2.4",
        homeDir: root,
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      })).rejects.toThrow("Refusing to replace a damaged shared PostgreSQL payload");
      await expect(readFile(liveMarker, "utf8")).resolves.toBe("keep");
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) {
        delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the shared PostgreSQL payload for an exact runtime cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-shared-postgres-payload-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    try {
      delete process.env.RUDDER_POSTGRES_BIN_DIR;
      const sourceBinDir = await writeFakePostgresRuntime(path.join(root, "source"));
      const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      await mkdir(path.dirname(sharedBinDir), { recursive: true });
      await cp(path.dirname(sourceBinDir), path.dirname(sharedBinDir), { recursive: true });
      const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" }));

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
      });

      const payloadBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      expect(result.postgresPayloadBinDir).toBe(payloadBinDir);
      expect(result.output).not.toContain("staged PostgreSQL 18.4 runtime payload");
      await expect(access(path.join(payloadBinDir, process.platform === "win32" ? "postgres.exe" : "postgres"))).resolves.toBeUndefined();
      await expect(access(path.join(payloadBinDir, "..", "share", "postgresql", "postgres.bki"))).resolves.toBeUndefined();
      await expectRuntimePostgresCompatibilityLink(
        path.join(result.cacheDir, "postgres-18.4"),
        path.join(root, "runtime-payloads", "postgres-18.4"),
      );
    } finally {
      if (previousPostgresBinDir === undefined) {
        delete process.env.RUDDER_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("shares one PostgreSQL payload across consecutive Rudder runtime versions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-shared-postgres-versions-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      process.env.RUDDER_POSTGRES_BIN_DIR = await writeFakePostgresRuntime(path.join(root, "source"));
      process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = process.env.RUDDER_POSTGRES_BIN_DIR;
      const spawnSyncImpl = vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" }));

      const first = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });
      delete process.env.RUDDER_POSTGRES_BIN_DIR;
      delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      const second = await ensureRuntimeInstalled({
        version: "1.2.4",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      expect(first.postgresPayloadBinDir).toBe(sharedBinDir);
      expect(second.postgresPayloadBinDir).toBe(sharedBinDir);
      await expectRuntimePostgresCompatibilityLink(
        path.join(first.cacheDir, "postgres-18.4"),
        path.join(root, "runtime-payloads", "postgres-18.4"),
      );
      await expectRuntimePostgresCompatibilityLink(
        path.join(second.cacheDir, "postgres-18.4"),
        path.join(root, "runtime-payloads", "postgres-18.4"),
      );
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) {
        delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent shared payload preparation and leaves no partial state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-concurrent-shared-postgres-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      process.env.RUDDER_POSTGRES_BIN_DIR = await writeFakePostgresRuntime(path.join(root, "source"));
      process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = process.env.RUDDER_POSTGRES_BIN_DIR;
      const install = (version: string) => ensureRuntimeInstalled({
        version,
        homeDir: root,
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      const [first, second] = await Promise.all([install("1.2.3"), install("1.2.4")]);
      const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      expect(first.postgresPayloadBinDir).toBe(sharedBinDir);
      expect(second.postgresPayloadBinDir).toBe(sharedBinDir);
      await expect(access(path.join(sharedBinDir, process.platform === "win32" ? "postgres.exe" : "postgres"))).resolves.toBeUndefined();
      const payloadEntries = await readdir(path.join(root, "runtime-payloads"), { recursive: true });
      expect(payloadEntries.some((entry) => entry.includes(".tmp-") || entry.endsWith(".lock"))).toBe(false);
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      else process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers an interrupted shared payload publish and removes stale generations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-recover-shared-postgres-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      process.env.RUDDER_POSTGRES_BIN_DIR = await writeFakePostgresRuntime(path.join(root, "source"));
      process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = process.env.RUDDER_POSTGRES_BIN_DIR;
      const install = (version: string) => ensureRuntimeInstalled({
        version,
        homeDir: root,
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });
      await install("1.2.3");

      const sharedBinDir = resolveSharedRuntimePostgresPayloadBinDir(root);
      const sharedPlatformRoot = path.dirname(sharedBinDir);
      const previousRoot = `${sharedPlatformRoot}.previous-crash`;
      const temporaryRoot = `${sharedPlatformRoot}.tmp-crash`;
      await cp(sharedPlatformRoot, previousRoot, { recursive: true });
      await writeFile(path.join(previousRoot, "restored-marker"), "restored");
      await rm(path.join(sharedPlatformRoot, "share", "postgresql", "postgresql.conf.sample"));
      await mkdir(temporaryRoot, { recursive: true });
      await writeFile(path.join(temporaryRoot, "stale-marker"), "stale");

      await install("1.2.4");

      await expect(readFile(path.join(sharedPlatformRoot, "restored-marker"), "utf8")).resolves.toBe("restored");
      await expect(access(previousRoot)).rejects.toThrow();
      await expect(access(temporaryRoot)).rejects.toThrow();

      const healthyPreviousRoot = `${sharedPlatformRoot}.previous-after-publish`;
      const staleDownloadRoot = path.join(
        root,
        "runtime-payloads",
        ".downloads",
        "postgres-18.4-crashed",
      );
      await cp(sharedPlatformRoot, healthyPreviousRoot, { recursive: true });
      await mkdir(staleDownloadRoot, { recursive: true });
      await writeFile(path.join(staleDownloadRoot, "archive.part"), "partial");

      await install("1.2.5");

      await expect(access(healthyPreviousRoot)).rejects.toThrow();
      await expect(access(staleDownloadRoot)).rejects.toThrow();
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      else process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates a valid legacy runtime payload when no PostgreSQL override is inherited", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-legacy-postgres-scan-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      delete process.env.RUDDER_POSTGRES_BIN_DIR;
      delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      const legacyCacheDir = resolveRuntimeCacheDir("1.2.2", root);
      const legacyBinDir = resolveRuntimePostgresPayloadBinDir(legacyCacheDir);
      const sourceBinDir = await writeFakePostgresRuntime(path.join(root, "legacy-source"));
      await mkdir(path.dirname(legacyBinDir), { recursive: true });
      await cp(path.dirname(sourceBinDir), path.dirname(legacyBinDir), { recursive: true });

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      expect(result.postgresPayloadBinDir).toBe(resolveSharedRuntimePostgresPayloadBinDir(root));
      await expectRuntimePostgresCompatibilityLink(
        path.join(result.cacheDir, "postgres-18.4"),
        path.join(root, "runtime-payloads", "postgres-18.4"),
      );
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      else process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("downloads PostgreSQL 18.4 once when no managed payload exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-download-postgres-test."));
    const archiveSource = path.join(root, "archive-source");
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    const previousArchiveUrl = process.env.RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL;
    try {
      delete process.env.RUDDER_POSTGRES_BIN_DIR;
      delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      await writeFakePostgresRuntime(archiveSource);
      const archivePath = path.join(root, "postgresql-18.4.zip");
      const archiveResult = spawnSync("tar", ["-cf", archivePath, "pgsql"], {
        cwd: archiveSource,
        encoding: "utf8",
      });
      expect(archiveResult.status).toBe(0);
      process.env.RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL = pathToFileURL(archivePath).href;
      const install = (version: string) => ensureRuntimeInstalled({
        version,
        homeDir: path.join(root, "home"),
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      const first = await install("1.2.3");
      await rm(archivePath, { force: true });
      const second = await install("1.2.4");

      expect(first.postgresPayloadBinDir).toBe(second.postgresPayloadBinDir);
      await expect(access(first.postgresPayloadBinDir!)).resolves.toBeUndefined();
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      else process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      if (previousArchiveUrl === undefined) delete process.env.RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL;
      else process.env.RUDDER_POSTGRES_RUNTIME_ARCHIVE_URL = previousArchiveUrl;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the embedded PostgreSQL fallback until packaged health verification", async () => {
    const platformPackage = currentEmbeddedPostgresPlatformPackage();
    if (!platformPackage) return;
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-selective-platform-cleanup-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      process.env.RUDDER_POSTGRES_BIN_DIR = await writeFakePostgresRuntime(path.join(root, "source"));
      process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = process.env.RUDDER_POSTGRES_BIN_DIR;
      const spawnSyncImpl = vi.fn((_command, args: string[]) => {
        const prefixIndex = args.indexOf("--prefix");
        const cacheDir = args[prefixIndex + 1];
        writeRuntimePackageSync(cacheDir, "@rudderhq/server", "1.2.3");
        writeRuntimePackageSync(cacheDir, "embedded-postgres", "18.1.0-beta.16");
        writeRuntimePackageSync(cacheDir, platformPackage, "18.1.0-beta.16");
        writeRuntimePackageSync(cacheDir, "@img/sharp-darwin-arm64", "0.34.0");
        return { status: 0, stdout: "added runtime", stderr: "" };
      });

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      await expect(access(path.join(result.cacheDir, "node_modules", ...platformPackage.split("/"), "package.json"))).resolves.toBeUndefined();
      await expect(access(path.join(result.cacheDir, "node_modules", "@img", "sharp-darwin-arm64", "package.json"))).resolves.toBeUndefined();
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      else process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an explicit operator PostgreSQL path external to managed caches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-external-postgres-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      const externalBinDir = await writeFakePostgresRuntime(path.join(root, "external"));
      process.env.RUDDER_POSTGRES_BIN_DIR = externalBinDir;
      delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: path.join(root, "home"),
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      expect(result.postgresPayloadBinDir).toBe(externalBinDir);
      await expect(access(path.join(root, "home", "runtime-payloads", "postgres-18.4"))).rejects.toThrow();
      await expect(access(path.join(result.cacheDir, "postgres-18.4"))).rejects.toThrow();
      expect(await readRuntimeInstallMetadata(result.cacheDir)).toMatchObject({
        postgresRuntime: {
          version: "18.4",
          binDir: externalBinDir,
          scope: "external",
        },
      });
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) {
        delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an operator PostgreSQL path under runtimes external unless it has the managed layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-nested-external-postgres-test."));
    const previousPostgresBinDir = process.env.RUDDER_POSTGRES_BIN_DIR;
    const previousManagedPostgresBinDir = process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
    try {
      const homeDir = path.join(root, "home");
      const externalBinDir = await writeFakePostgresRuntime(
        path.join(homeDir, "runtimes", "operator-owned-pg"),
      );
      process.env.RUDDER_POSTGRES_BIN_DIR = externalBinDir;
      delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir,
        spawnSyncImpl: vi.fn(() => ({ status: 0, stdout: "added runtime", stderr: "" })) as never,
        postgresVersionProbe: () => "PostgreSQL 18.4",
        preparePostgresPayload: true,
        pruneRuntimeCache: false,
      });

      expect(result.postgresPayloadBinDir).toBe(externalBinDir);
      await expect(access(path.join(homeDir, "runtime-payloads", "postgres-18.4"))).rejects.toThrow();
      expect(await readRuntimeInstallMetadata(result.cacheDir)).toMatchObject({
        postgresRuntime: {
          binDir: externalBinDir,
          scope: "external",
        },
      });
    } finally {
      if (previousPostgresBinDir === undefined) delete process.env.RUDDER_POSTGRES_BIN_DIR;
      else process.env.RUDDER_POSTGRES_BIN_DIR = previousPostgresBinDir;
      if (previousManagedPostgresBinDir === undefined) {
        delete process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR;
      } else {
        process.env.RUDDER_DESKTOP_MANAGED_POSTGRES_BIN_DIR = previousManagedPostgresBinDir;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs runtime installs that omit the embedded Postgres platform package", async () => {
    const platformPackage = currentEmbeddedPostgresPlatformPackage();
    if (!platformPackage) return;
    const platformTarball = `${platformPackage.replace("@", "").replace("/", "-")}-18.1.0-beta.16.tgz`;

    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-platform-install-test."));
    try {
      const cacheDir = resolveRuntimeCacheDir("1.2.3", root);
      const platformPackageDir = path.join(cacheDir, "node_modules", ...platformPackage.split("/"));
      const rootLockPath = path.join(cacheDir, "package-lock.json");
      const nodeModulesLockPath = path.join(cacheDir, "node_modules", ".package-lock.json");
      let repairPrefix = "";
      const spawnSyncImpl = vi
        .fn()
        .mockImplementationOnce((_command, args: string[]) => {
          const prefixIndex = args.indexOf("--prefix");
          const runtimeCacheDir = args[prefixIndex + 1];
          writeRuntimePackageSync(runtimeCacheDir, "embedded-postgres", "18.1.0-beta.16");
          writeFileSync(
            path.join(runtimeCacheDir, "node_modules", "embedded-postgres", "package.json"),
            JSON.stringify({
              name: "embedded-postgres",
              version: "18.1.0-beta.16",
              optionalDependencies: { [platformPackage]: "^18.1.0-beta.16" },
            }),
            "utf8",
          );
          writeFileSync(rootLockPath, "{}", "utf8");
          writeFileSync(nodeModulesLockPath, "{}", "utf8");
          return { status: 0, stdout: "added runtime", stderr: "" };
        })
        .mockImplementationOnce((_command, args: string[]) => {
          repairPrefix = args[args.indexOf("--pack-destination") + 1];
          return {
            status: 0,
            stdout: `${platformTarball}\n`,
            stderr: "",
          };
        })
        .mockImplementationOnce((_command, args: string[]) => {
          const targetDir = args[args.indexOf("-C") + 1];
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(
            path.join(targetDir, "package.json"),
            JSON.stringify({ name: platformPackage, version: "18.1.0-beta.16" }),
            "utf8",
          );
          return { status: 0, stdout: "extracted platform package", stderr: "" };
        });

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
      });

      expect(result.status).toBe("installed");
      expect(result.output).toContain("added runtime");
      expect(result.output).toContain("extracted platform package");
      expect(spawnSyncImpl).toHaveBeenCalledTimes(3);
      expect(spawnSyncImpl).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        expect.arrayContaining([
          "pack",
          `${platformPackage}@18.1.0-beta.16`,
          "--registry",
          NPM_PUBLIC_REGISTRY_URL,
          "--silent",
        ]),
        expect.objectContaining({
          env: expect.objectContaining({ npm_config_registry: NPM_PUBLIC_REGISTRY_URL }),
        }),
      );
      expect(spawnSyncImpl).toHaveBeenNthCalledWith(
        3,
        "tar",
        [
          "-xzf",
          path.join(repairPrefix, platformTarball),
          "-C",
          platformPackageDir,
          "--strip-components",
          "1",
        ],
        expect.any(Object),
      );
      await expect(access(rootLockPath)).rejects.toThrow();
      await expect(access(nodeModulesLockPath)).rejects.toThrow();
      await expect(access(path.join(platformPackageDir, "package.json"))).resolves.toBeUndefined();
      await expect(access(repairPrefix)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs an existing runtime package that is missing only the embedded Postgres platform package", async () => {
    const platformPackage = currentEmbeddedPostgresPlatformPackage();
    if (!platformPackage) return;
    const platformTarball = `${platformPackage.replace("@", "").replace("/", "-")}-18.1.0-beta.16.tgz`;

    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-existing-platform-repair-test."));
    try {
      const cacheDir = resolveRuntimeCacheDir("1.2.3", root);
      const serverPackageDir = path.join(cacheDir, "node_modules", "@rudderhq", "server");
      const embeddedPackageDir = path.join(cacheDir, "node_modules", "embedded-postgres");
      const platformPackageDir = path.join(cacheDir, "node_modules", ...platformPackage.split("/"));
      await mkdir(serverPackageDir, { recursive: true });
      await mkdir(embeddedPackageDir, { recursive: true });
      await writeFile(path.join(cacheDir, "package.json"), JSON.stringify({ private: true }), "utf8");
      await writeFile(
        path.join(serverPackageDir, "package.json"),
        JSON.stringify({
          name: "@rudderhq/server",
          version: "1.2.3",
          dependencies: { "embedded-postgres": "18.1.0-beta.16" },
        }),
        "utf8",
      );
      await writeFile(
        path.join(embeddedPackageDir, "package.json"),
        JSON.stringify({
          name: "embedded-postgres",
          version: "18.1.0-beta.16",
          optionalDependencies: { [platformPackage]: "^18.1.0-beta.16" },
        }),
        "utf8",
      );

      const spawnSyncImpl = vi
        .fn()
        .mockImplementationOnce(() => ({
          status: 0,
          stdout: `${platformTarball}\n`,
          stderr: "",
        }))
        .mockImplementationOnce((_command, args: string[]) => {
          const targetDir = args[args.indexOf("-C") + 1];
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(
            path.join(targetDir, "package.json"),
            JSON.stringify({ name: platformPackage, version: "18.1.0-beta.16" }),
            "utf8",
          );
          return { status: 0, stdout: "extracted platform package", stderr: "" };
        });

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
      });

      expect(result.status).toBe("installed");
      expect(result.output).toContain("extracted platform package");
      expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
      expect(spawnSyncImpl).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining([
          "pack",
          `${platformPackage}@18.1.0-beta.16`,
          "--registry",
          NPM_PUBLIC_REGISTRY_URL,
        ]),
        expect.objectContaining({
          env: expect.objectContaining({ npm_config_registry: NPM_PUBLIC_REGISTRY_URL }),
        }),
      );
      await expect(access(path.join(platformPackageDir, "package.json"))).resolves.toBeUndefined();
      await expect(readRuntimeInstallMetadata(cacheDir)).resolves.toMatchObject({
        packageName: "@rudderhq/server",
        packageVersion: "1.2.3",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to latest when the exact version is not found on npm", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-fallback-test."));
    try {
      const spawnSyncImpl = vi
        .fn()
        .mockReturnValueOnce({
          status: 1,
          stdout: "",
          stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @rudderhq/server@1.2.3.",
        })
        .mockReturnValueOnce({
          status: 0,
          stdout: "added 1 package",
          stderr: "",
        });

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
      });

      expect(result.status).toBe("installed");
      expect(result.packageSpec).toBe("@rudderhq/server@latest");
      expect(result.cacheDir).toBe(resolveRuntimeCacheDir("latest", root));
      expect(result.output).toBe("added 1 package");
      expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to latest cache hit when the exact version is not found on npm", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-fallback-hit-test."));
    try {
      const fallbackCacheDir = resolveRuntimeCacheDir("latest", root);
      const packageDir = path.join(fallbackCacheDir, "node_modules", "@rudderhq", "server");
      await mkdir(packageDir, { recursive: true });
      await writeFile(path.join(fallbackCacheDir, "package.json"), JSON.stringify({ private: true }), "utf8");
      await writeFile(
        path.join(fallbackCacheDir, RUNTIME_METADATA_FILE),
        JSON.stringify({ version: 1, packageName: "@rudderhq/server", packageVersion: "latest", installedAt: "now" }),
        "utf8",
      );
      await writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "@rudderhq/server", version: "1.0.0" }),
        "utf8",
      );

      const spawnSyncImpl = vi.fn(() => ({
        status: 1,
        stdout: "",
        stderr: "npm error code ETARGET\nnpm error notarget No matching version found for @rudderhq/server@1.2.3.",
      }));

      const result = await ensureRuntimeInstalled({
        version: "1.2.3",
        homeDir: root,
        spawnSyncImpl: spawnSyncImpl as never,
      });

      expect(result.status).toBe("hit");
      expect(result.packageSpec).toBe("@rudderhq/server@latest");
      expect(result.cacheDir).toBe(fallbackCacheDir);
      expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent exact-version misses through the shared latest cache", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-concurrent-fallback-test."));
    try {
      let latestInstallCount = 0;
      const spawnSyncImpl = vi.fn((_command, args: string[]) => {
        const packageSpec = args.at(-1);
        if (packageSpec !== "@rudderhq/server@latest") {
          return {
            status: 1,
            stdout: "",
            stderr: `npm error code ETARGET\nNo matching version found for ${packageSpec}.`,
          };
        }
        latestInstallCount += 1;
        const cacheDir = args[args.indexOf("--prefix") + 1];
        writeRuntimePackageSync(cacheDir, "@rudderhq/server", "9.9.9");
        return { status: 0, stdout: "added latest runtime", stderr: "" };
      });

      const [first, second] = await Promise.all([
        ensureRuntimeInstalled({
          version: "1.2.3-missing",
          homeDir: root,
          spawnSyncImpl: spawnSyncImpl as never,
          pruneRuntimeCache: false,
        }),
        ensureRuntimeInstalled({
          version: "1.2.4-missing",
          homeDir: root,
          spawnSyncImpl: spawnSyncImpl as never,
          pruneRuntimeCache: false,
        }),
      ]);

      expect(latestInstallCount).toBe(1);
      expect([first.status, second.status].sort()).toEqual(["hit", "installed"]);
      expect(first.cacheDir).toBe(resolveRuntimeCacheDir("latest", root));
      expect(second.cacheDir).toBe(resolveRuntimeCacheDir("latest", root));
      await expect(access(`${resolveRuntimeCacheDir("latest", root)}.install.lock`)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("prunes older canary runtime caches while retaining current, latest stable, and previous entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-prune-test."));
    try {
      const canary1 = await writeRuntimeCacheEntry(root, "1.0.0-canary.1", {
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      });
      const canary2 = await writeRuntimeCacheEntry(root, "1.0.0-canary.2", {
        installedAt: "2026-01-02T00:00:00.000Z",
        lastUsedAt: "2026-01-02T00:00:00.000Z",
      });
      const previousCanary = await writeRuntimeCacheEntry(root, "1.0.0-canary.3", {
        installedAt: "2026-01-03T00:00:00.000Z",
        lastUsedAt: "2026-01-03T00:00:00.000Z",
      });
      const stable = await writeRuntimeCacheEntry(root, "1.0.0", {
        installedAt: "2026-01-04T00:00:00.000Z",
        lastUsedAt: "2026-01-04T00:00:00.000Z",
      });
      const current = await writeRuntimeCacheEntry(root, "1.0.1-canary.1", {
        installedAt: "2026-01-05T00:00:00.000Z",
        lastUsedAt: "2026-01-05T00:00:00.000Z",
      });

      const result = await pruneRuntimeCache({
        homeDir: root,
        requestedVersion: "1.0.1-canary.1",
        now: new Date("2026-01-06T00:00:00.000Z"),
        maxEntries: 3,
        maxAgeMs: 365 * 24 * 60 * 60 * 1000,
        maxTotalBytes: Number.POSITIVE_INFINITY,
        keepPreviousEntries: 1,
      });

      expect(result.deleted.map((entry) => entry.packageVersion).sort()).toEqual([
        "1.0.0-canary.1",
        "1.0.0-canary.2",
      ]);
      await expect(access(canary1)).rejects.toThrow();
      await expect(access(canary2)).rejects.toThrow();
      await expect(access(previousCanary)).resolves.toBeUndefined();
      await expect(access(stable)).resolves.toBeUndefined();
      await expect(access(current)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("protects runtime versions referenced by live instance descriptors", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-active-test."));
    try {
      const active = await writeRuntimeCacheEntry(root, "0.9.0", {
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
      });
      const stale = await writeRuntimeCacheEntry(root, "1.0.0", {
        installedAt: "2026-01-02T00:00:00.000Z",
        lastUsedAt: "2026-01-02T00:00:00.000Z",
      });
      const current = await writeRuntimeCacheEntry(root, "1.0.1", {
        installedAt: "2026-01-03T00:00:00.000Z",
        lastUsedAt: "2026-01-03T00:00:00.000Z",
      });
      const descriptorDir = path.join(root, "instances", "default", "runtime");
      await mkdir(descriptorDir, { recursive: true });
      await writeFile(
        path.join(descriptorDir, "server.json"),
        JSON.stringify({
          instanceId: "default",
          localEnv: "prod_local",
          pid: process.pid,
          listenPort: 3100,
          apiUrl: "http://127.0.0.1:3100",
          version: "0.9.0",
          ownerKind: "desktop",
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
        "utf8",
      );

      const result = await pruneRuntimeCache({
        homeDir: root,
        requestedVersion: "1.0.1",
        now: new Date("2026-01-04T00:00:00.000Z"),
        maxEntries: 1,
        maxAgeMs: 0,
        maxTotalBytes: 1,
        keepPreviousEntries: 0,
      });

      expect(result.protectedVersions).toEqual(expect.arrayContaining(["0.9.0", "1.0.1"]));
      expect(result.deleted.map((entry) => entry.packageVersion)).toContain("1.0.0");
      await expect(access(active)).resolves.toBeUndefined();
      await expect(access(stale)).rejects.toThrow();
      await expect(access(current)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the total size cap to continue deleting unprotected runtime caches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-runtime-size-test."));
    try {
      const oldStable = await writeRuntimeCacheEntry(root, "1.0.0", {
        installedAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        payload: "x".repeat(100),
      });
      const middleStable = await writeRuntimeCacheEntry(root, "1.0.1", {
        installedAt: "2026-01-02T00:00:00.000Z",
        lastUsedAt: "2026-01-02T00:00:00.000Z",
        payload: "x".repeat(100),
      });
      const current = await writeRuntimeCacheEntry(root, "1.0.2", {
        installedAt: "2026-01-03T00:00:00.000Z",
        lastUsedAt: "2026-01-03T00:00:00.000Z",
        payload: "x".repeat(100),
      });

      const result = await pruneRuntimeCache({
        homeDir: root,
        requestedVersion: "1.0.2",
        now: new Date("2026-01-04T00:00:00.000Z"),
        maxEntries: 10,
        maxAgeMs: 365 * 24 * 60 * 60 * 1000,
        maxTotalBytes: 1,
        keepPreviousEntries: 0,
      });

      expect(result.deleted.map((entry) => entry.packageVersion).sort()).toEqual(["1.0.0", "1.0.1"]);
      await expect(access(oldStable)).rejects.toThrow();
      await expect(access(middleStable)).rejects.toThrow();
      await expect(access(current)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("thin CLI bootstrap contract", () => {
  it("keeps heavy runtime packages out of production dependencies", async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, "cli", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const dependencies = Object.keys(pkg.dependencies ?? {});

    expect(dependencies).not.toContain("@rudderhq/server");
    expect(dependencies).not.toContain("@rudderhq/db");
    expect(dependencies).not.toContain("embedded-postgres");
    expect(dependencies).not.toContain("@rudderhq/agent-runtime-codex-local");
    expect(dependencies).not.toContain("@rudderhq/agent-runtime-claude-local");
  });

  it("does not statically import heavy command modules during program registration", async () => {
    const programSource = await readFile(path.join(repoRoot, "cli", "src", "program.ts"), "utf8");
    const staticImports = programSource
      .split(/\r?\n/)
      .filter((line) => line.startsWith("import "))
      .join("\n");

    expect(staticImports).not.toContain("./commands/worktree.js");
    expect(staticImports).not.toContain("./commands/db-backup.js");
    expect(staticImports).not.toContain("./commands/benchmark-create-agent.js");
  });

  it("does not statically import local agent runtime packages", async () => {
    const registrySource = await readFile(path.join(repoRoot, "cli", "src", "agent-runtimes", "registry.ts"), "utf8");
    const staticImports = registrySource
      .split(/\r?\n/)
      .filter((line) => line.startsWith("import "))
      .join("\n");

    expect(staticImports).not.toContain("@rudderhq/agent-runtime-codex-local");
    expect(staticImports).not.toContain("@rudderhq/agent-runtime-claude-local");
    expect(staticImports).not.toContain("@rudderhq/agent-runtime-openclaw-gateway");
  });
});
