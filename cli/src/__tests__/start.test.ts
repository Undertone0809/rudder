import { access, chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../program.js";
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
import {
  assertChecksumMatch,
  buildGithubReleaseAssetDownloadUrl,
  buildForceQuitCommand,
  buildLinuxDesktopEntry,
  buildWindowsRobocopyMirrorCommand,
  buildWindowsZipExtractCommand,
  compareStableSemver,
  copyPortableAppBundle,
  downloadAsset,
  downloadDesktopAssetWithCache,
  downloadChecksums,
  getCliUpdateNotice,
  isExactRuntimePackageSpec,
  isInstalledDesktopCurrent,
  isPersistentCliVersionCurrent,
  isSuccessfulRobocopyExitCode,
  parseChecksumFile,
  prepareForDesktopReplace,
  resolveAssetChecksum,
  resolveCliInstallSpec,
  resolveCurrentCliVersion,
  resolveDesktopAssetTarget,
  resolveDesktopAssetCandidates,
  resolveDefaultDesktopInstallRoot,
  resolveDesktopAssetName,
  resolveDesktopShellAssetName,
  resolveDesktopAssetCacheDir,
  resolveDesktopInstallPaths,
  resolveDesktopReleaseVersion,
  resolveDesktopReleaseTag,
  selectChecksummedDesktopAssetCandidate,
  selectChecksumAsset,
  selectDesktopAsset,
  selectDesktopShellAsset,
  startCommand,
  waitForProcessExit,
} from "../commands/start.js";
import {
  ensureRuntimeInstalled,
  pruneRuntimeCache,
  readRuntimeInstallMetadata,
  resolveRuntimeCacheDir,
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

  it("builds Windows force-quit fallback commands", () => {
    expect(buildForceQuitCommand({ platform: "windows", arch: "x64", extension: ".zip" })).toEqual({
      command: "taskkill.exe",
      args: ["/IM", "Rudder.exe", "/T", "/F"],
    });
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
      const forceQuitDesktopProcesses = vi.fn();
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
          forceQuitDesktopProcesses,
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(access(installRoot)).resolves.toBeUndefined();
      expect(forceQuitDesktopProcesses).not.toHaveBeenCalled();

      await replace;
      expect(forceQuitDesktopProcesses).toHaveBeenCalledTimes(1);
      await expect(access(installRoot)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("force-quits only the reported Desktop pid after update quit timeout", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rudder-desktop-targeted-quit-test."));
    const installRoot = path.join(dir, "Applications");
    const appPath = path.join(installRoot, "Rudder.app");
    const executablePath = path.join(appPath, "Contents", "MacOS", "Rudder");
    await mkdir(path.dirname(executablePath), { recursive: true });
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
      const forceQuitDesktopProcesses = vi.fn();
      await prepareForDesktopReplace(
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
          forceQuitDesktopProcesses,
          waitForDesktopProcessExit: vi.fn(async () => false),
        },
      );

      expect(forceQuitDesktopProcess).toHaveBeenCalledWith(4242, { platform: "macos", arch: "arm64", extension: ".zip" });
      expect(forceQuitDesktopProcesses).not.toHaveBeenCalled();
      await expect(access(appPath)).rejects.toThrow();
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
