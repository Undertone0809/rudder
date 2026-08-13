import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { macPortableZipArgs } from "./archive.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const releaseDir = path.join(desktopRoot, "release");
const packagingNodeModulesDir = path.join(desktopRoot, "node_modules");
// Keep this non-hidden and at the same directory depth as node_modules so pnpm's
// relative workspace links remain valid while electron-builder is packaging.
const hiddenPackagingNodeModulesDir = path.join(desktopRoot, "node_modules-packaging-hidden");
const requireFromScript = createRequire(import.meta.url);
const electronBuilderCliPath = requireFromScript.resolve("electron-builder/cli.js");
const { path7za } = createRequire(electronBuilderCliPath)("7zip-bin");
const targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
const WINDOWS_BUILDER_BINARIES_MIRROR =
  "https://npmmirror.com/mirrors/electron-builder-binaries/";
const WINDOWS_CODE_SIGN_RELEASE = "winCodeSign-2.6.0";
const WINDOWS_CODE_SIGN_ARCHIVE = `${WINDOWS_CODE_SIGN_RELEASE}.7z`;
const WINDOWS_CODE_SIGN_SHA512 =
  "6LQI2d9BPC3Xs0ZoTQe1o3tPiA28c7+PY69Q9i/pD8lY45psMtHuLwv3vRckiVr3Zx1cbNyLlBR8STwCdcHwtA==";
const desktopCliKeepFiles = new Set([
  "desktop-cli-runner.js",
  "desktop-cli.js",
  "rudder-cli-package.json",
  "package.json",
]);

function archFlagFor(arch) {
  if (arch === "arm64") return "--arm64";
  if (arch === "x64") return "--x64";
  return null;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

export async function runElectronBuilderWithMirrorFallback(args, options = {}) {
  const execute = options.execute ?? run;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  try {
    await execute(process.execPath, args);
    return;
  } catch (primaryError) {
    if (platform !== "win32" || environment.ELECTRON_BUILDER_BINARIES_MIRROR) {
      throw primaryError;
    }

    console.warn(
      "[desktop:dist] primary electron-builder binary download failed; retrying with the verified mirror",
    );
    try {
      await execute(process.execPath, args, {
        env: {
          ELECTRON_BUILDER_BINARIES_MIRROR: WINDOWS_BUILDER_BINARIES_MIRROR,
        },
      });
    } catch (mirrorError) {
      throw new AggregateError(
        [primaryError, mirrorError],
        "electron-builder failed with both the primary binary source and fallback mirror",
      );
    }
  }
}

function electronBuilderCacheRoot(environment = process.env) {
  const configured = environment.ELECTRON_BUILDER_CACHE?.trim();
  if (configured) return path.resolve(configured);
  const localAppData = environment.LOCALAPPDATA?.trim();
  if (localAppData) return path.join(localAppData, "electron-builder", "Cache");
  return path.join(os.tmpdir(), "electron-builder-cache");
}

export function windowsCodeSignArtifactUrls(environment = process.env) {
  const configuredMirror = environment.ELECTRON_BUILDER_BINARIES_MIRROR?.trim();
  const mirrors = configuredMirror
    ? [configuredMirror]
    : [
      "https://github.com/electron-userland/electron-builder-binaries/releases/download/",
      WINDOWS_BUILDER_BINARIES_MIRROR,
    ];
  return [...new Set(mirrors)].map((mirror) =>
    `${mirror.endsWith("/") ? mirror : `${mirror}/`}${WINDOWS_CODE_SIGN_RELEASE}/${WINDOWS_CODE_SIGN_ARCHIVE}`);
}

async function downloadVerifiedWindowsCodeSign(archivePath, environment) {
  const failures = [];
  for (const url of windowsCodeSignArtifactUrls(environment)) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const archive = Buffer.from(await response.arrayBuffer());
      const checksum = createHash("sha512").update(archive).digest("base64");
      if (checksum !== WINDOWS_CODE_SIGN_SHA512) {
        throw new Error(`SHA-512 mismatch for ${url}`);
      }
      await fs.writeFile(archivePath, archive);
      return;
    } catch (error) {
      failures.push(new Error(
        `Could not download ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      ));
    }
  }
  throw new AggregateError(failures, "Could not download a verified winCodeSign archive");
}

async function hasWindowsCodeSignTools(directory) {
  return await exists(path.join(directory, "rcedit-x64.exe"))
    && await exists(path.join(directory, "windows-10", "x64", "signtool.exe"));
}

export async function prepareWindowsCodeSignCache(environment = process.env) {
  if (process.platform !== "win32") return null;

  const cacheRoot = electronBuilderCacheRoot(environment);
  const artifactRoot = path.join(cacheRoot, "winCodeSign");
  const finalDirectory = path.join(artifactRoot, WINDOWS_CODE_SIGN_RELEASE);
  if (await hasWindowsCodeSignTools(finalDirectory)) return finalDirectory;

  await fs.rm(finalDirectory, { recursive: true, force: true });
  await fs.mkdir(artifactRoot, { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(artifactRoot, "rudder-win-codesign-"));
  const archivePath = path.join(temporaryRoot, WINDOWS_CODE_SIGN_ARCHIVE);
  const extractionDirectory = path.join(temporaryRoot, "extracted");
  try {
    await fs.mkdir(extractionDirectory, { recursive: true });
    await downloadVerifiedWindowsCodeSign(archivePath, environment);
    let extractionError = null;
    try {
      await run(path7za, ["x", "-bd", archivePath, `-o${extractionDirectory}`], {
        cwd: artifactRoot,
      });
    } catch (error) {
      extractionError = error;
    }
    if (!(await hasWindowsCodeSignTools(extractionDirectory))) {
      throw new Error("The verified winCodeSign archive is missing required Windows tools", {
        cause: extractionError,
      });
    }
    if (extractionError) {
      // The legacy archive contains two macOS-only symlinks. 7-Zip reports
      // exit code 2 when an ordinary Windows token cannot create them, even
      // though every Windows packaging tool was extracted successfully.
      console.warn(
        "[desktop:dist] ignored unavailable macOS symlinks after verifying the extracted Windows tools",
      );
    }
    try {
      await fs.rename(extractionDirectory, finalDirectory);
    } catch (error) {
      if (!(await hasWindowsCodeSignTools(finalDirectory))) throw error;
    }
    return finalDirectory;
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function stagePackagedRuntime() {
  /**
   * Generic Desktop builds must remain runnable in offline CI without a
   * production PostgreSQL payload. The actual distributable path restages the
   * server package with the payload enabled immediately before electron-builder
   * copies `.packaged/postgres-18.4` into app resources.
   */
  await run(process.execPath, ["scripts/stage-server.mjs"], {
    cwd: desktopRoot,
    env: {
      RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME: "1",
    },
  });
  await run(process.execPath, ["scripts/stage-cli.mjs"], {
    cwd: desktopRoot,
  });
}

async function stagePackagedTestIdentityMarker() {
  if (process.env.RUDDER_DESKTOP_PACKAGED_TEST_IDENTITY !== "1") return;
  const markerPath = path.join(desktopRoot, ".packaged", "native", "packaged-test-identity.marker");
  await fs.writeFile(markerPath, "rudder-packaged-test-identity-v1\n", { mode: 0o600 });
  console.log("[desktop:dist] staged isolated packaged-test Identity marker");
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function powershellQuote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function readPackageInfo() {
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  return {
    productName: packageJson.build?.productName ?? packageJson.productName ?? packageJson.name,
    version: packageJson.version,
  };
}

async function resolvePackagedAppDir(platform, arch, productName) {
  const candidates = platform === "macos"
    ? [
        path.join(releaseDir, `mac-${arch}`, `${productName}.app`),
        path.join(releaseDir, "mac", `${productName}.app`),
      ]
    : [
        path.join(releaseDir, arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked"),
        path.join(releaseDir, "win-unpacked"),
      ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  throw new Error(`packaged app not found in: ${candidates.join(", ")}`);
}

async function createPortableZip(platform, arch) {
  const { productName, version } = await readPackageInfo();
  const appDir = await resolvePackagedAppDir(platform, arch, productName);
  const outputPath = path.join(releaseDir, `${productName}-${version}-${platform}-${arch}-portable.zip`);

  await fs.rm(outputPath, { force: true });
  if (platform === "macos") {
    await run("ditto", macPortableZipArgs(appDir, outputPath));
    return;
  }

  if (platform === "windows") {
    await run(path7za, ["a", "-tzip", outputPath, path.basename(appDir)], {
      cwd: path.dirname(appDir),
    });
    return;
  }

  await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -LiteralPath ${powershellQuote(appDir)} -DestinationPath ${powershellQuote(outputPath)} -Force`,
  ]);
}

async function pruneShellServerPackage(serverPackageDir) {
  if (!(await exists(serverPackageDir))) {
    throw new Error(`packaged server-package is required to create a Desktop shell asset: ${serverPackageDir}`);
  }

  const keepDir = `${serverPackageDir}.shell-keep`;
  await fs.rm(keepDir, { recursive: true, force: true });
  await fs.mkdir(keepDir, { recursive: true });

  for (const fileName of desktopCliKeepFiles) {
    const sourcePath = path.join(serverPackageDir, fileName);
    if (await exists(sourcePath)) {
      await fs.cp(sourcePath, path.join(keepDir, fileName), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }

  const commanderDir = path.join(serverPackageDir, "node_modules", "commander");
  if (await exists(commanderDir)) {
    await fs.cp(commanderDir, path.join(keepDir, "node_modules", "commander"), {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  await fs.rm(serverPackageDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(serverPackageDir), { recursive: true });
  await fs.rename(keepDir, serverPackageDir);
  await verifyShellDesktopCli(serverPackageDir);
}

async function verifyShellDesktopCli(serverPackageDir) {
  const { version } = await readPackageInfo();
  const cliEntry = path.join(serverPackageDir, "desktop-cli.js");
  const cliRunner = path.join(serverPackageDir, "desktop-cli-runner.js");
  if (!(await exists(cliEntry))) {
    throw new Error(`shell server-package is missing desktop-cli.js: ${serverPackageDir}`);
  }
  if (!(await exists(cliRunner))) {
    throw new Error(`shell server-package is missing desktop-cli-runner.js: ${serverPackageDir}`);
  }
  await run(process.execPath, [
    cliRunner,
    "start",
    "--no-cli",
    "--no-runtime",
    "--target-version",
    version,
    "--dry-run",
    "--no-open",
    "--no-version-check",
  ], {
    cwd: serverPackageDir,
  });
}

async function createShellAppCopy(platform, arch, productName) {
  const sourceAppDir = await resolvePackagedAppDir(platform, arch, productName);
  const shellRoot = platform === "macos"
    ? path.join(releaseDir, `mac-${arch}-shell`)
    : path.join(releaseDir, arch === "arm64" ? "win-arm64-shell" : "win-shell");
  const shellAppDir = platform === "macos"
    ? path.join(shellRoot, `${productName}.app`)
    : shellRoot;
  const resourcesDir = platform === "macos"
    ? path.join(shellAppDir, "Contents", "Resources")
    : path.join(shellAppDir, "resources");

  await fs.rm(shellRoot, { recursive: true, force: true });
  await fs.mkdir(shellRoot, { recursive: true });
  await fs.cp(sourceAppDir, shellAppDir, { recursive: true, verbatimSymlinks: true });
  await pruneShellServerPackage(path.join(resourcesDir, "server-package"));
  await fs.rm(path.join(resourcesDir, "postgres-18.4"), { recursive: true, force: true });
  return shellAppDir;
}

async function createShellZip(platform, arch) {
  if (platform !== "macos" && platform !== "windows") return;

  const { productName, version } = await readPackageInfo();
  const appDir = await createShellAppCopy(platform, arch, productName);
  const outputPath = path.join(releaseDir, `${productName}-${version}-${platform}-${arch}-shell.zip`);

  await fs.rm(outputPath, { force: true });
  if (platform === "macos") {
    await run("ditto", macPortableZipArgs(appDir, outputPath));
    return;
  }

  if (process.platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -LiteralPath ${powershellQuote(appDir)} -DestinationPath ${powershellQuote(outputPath)} -Force`,
    ]);
    return;
  }

  await run("7z", ["a", "-tzip", outputPath, path.basename(appDir)], {
    cwd: path.dirname(appDir),
  });
}

async function hidePackagingNodeModules() {
  await fs.rm(hiddenPackagingNodeModulesDir, { recursive: true, force: true });

  try {
    await fs.rename(packagingNodeModulesDir, hiddenPackagingNodeModulesDir);
    await fs.mkdir(packagingNodeModulesDir, { recursive: true });

    try {
      const electronLinkTarget = await fs.readlink(path.join(hiddenPackagingNodeModulesDir, "electron"));
      if (process.platform === "win32") {
        await fs.cp(
          path.resolve(hiddenPackagingNodeModulesDir, electronLinkTarget),
          path.join(packagingNodeModulesDir, "electron"),
          { recursive: true, dereference: true },
        );
      } else {
        await fs.symlink(electronLinkTarget, path.join(packagingNodeModulesDir, "electron"));
      }
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      if (code !== "ENOENT") throw error;
    }

    try {
      const identityCoreDir = path.join(packagingNodeModulesDir, "@rudderhq", "identity-core");
      const identityCoreLinkTarget = await fs.readlink(
        path.join(hiddenPackagingNodeModulesDir, "@rudderhq", "identity-core"),
      );
      await fs.mkdir(path.dirname(identityCoreDir), { recursive: true });
      if (process.platform === "win32") {
        await fs.cp(
          path.resolve(
            hiddenPackagingNodeModulesDir,
            "@rudderhq",
            identityCoreLinkTarget,
          ),
          identityCoreDir,
          { recursive: true, dereference: true },
        );
      } else {
        await fs.symlink(identityCoreLinkTarget, identityCoreDir);
      }
    } catch (error) {
      const code = /** @type {{ code?: string }} */ (error).code;
      if (code !== "ENOENT") throw error;
    }

    return true;
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error).code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function restorePackagingNodeModules(hidden) {
  if (!hidden) return;
  await fs.rm(packagingNodeModulesDir, { recursive: true, force: true });
  await fs.rename(hiddenPackagingNodeModulesDir, packagingNodeModulesDir);
}

async function main() {
  await stagePackagedRuntime();
  await stagePackagedTestIdentityMarker();
  await prepareWindowsCodeSignCache();
  const nodeModulesHidden = await hidePackagingNodeModules();

  try {
    if (process.platform === "darwin") {
      const archFlag = archFlagFor(targetArch);
      const args = [electronBuilderCliPath, "--mac", "dir"];
      if (archFlag) args.push(archFlag);

      await run(process.execPath, args);
      await createPortableZip("macos", targetArch);
      await createShellZip("macos", targetArch);
      return;
    }

    const args = [electronBuilderCliPath];
    if (process.platform === "win32") args.push("--win", "dir");
    if (process.platform === "linux") args.push("--linux");
    const archFlag = archFlagFor(targetArch);
    if (archFlag) args.push(archFlag);
    await runElectronBuilderWithMirrorFallback(args);
    if (process.platform === "win32") {
      await createPortableZip("windows", targetArch);
      await createShellZip("windows", targetArch);
    }
  } finally {
    await restorePackagingNodeModules(nodeModulesHidden);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error("[desktop:dist] failed to build installer", error);
    process.exit(1);
  });
}
