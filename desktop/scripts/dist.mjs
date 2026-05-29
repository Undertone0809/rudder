import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const releaseDir = path.join(desktopRoot, "release");
const packagingNodeModulesDir = path.join(desktopRoot, "node_modules");
const hiddenPackagingNodeModulesDir = path.join(desktopRoot, ".node_modules.packaging-hidden");
const requireFromScript = createRequire(import.meta.url);
const electronBuilderCliPath = requireFromScript.resolve("electron-builder/cli.js");
const targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
const desktopCliKeepFiles = new Set(["desktop-cli.js", "rudder-cli-package.json", "package.json"]);

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
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appDir, outputPath]);
    return;
  }

  if (platform === "windows") {
    await run("7z", ["a", "-tzip", outputPath, path.basename(appDir)], {
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
  if (!(await exists(cliEntry))) {
    throw new Error(`shell server-package is missing desktop-cli.js: ${serverPackageDir}`);
  }

  const script = [
    "const m = await import('./desktop-cli.js');",
    "if (typeof m.runCli !== 'function') throw new Error('desktop-cli.js does not export runCli');",
    "const code = await m.runCli([process.execPath, 'rudder', 'start', '--no-cli', '--no-runtime', '--target-version',",
    JSON.stringify(version),
    ", '--dry-run', '--no-open', '--no-version-check']);",
    "if (code !== 0) process.exit(code);",
  ].join(" ");
  const verifyScriptPath = path.join(serverPackageDir, ".rudder-shell-cli-verify.mjs");
  await fs.writeFile(verifyScriptPath, script, "utf8");
  try {
    await run(process.execPath, [verifyScriptPath], {
      cwd: serverPackageDir,
    });
  } finally {
    await fs.rm(verifyScriptPath, { force: true });
  }
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
  return shellAppDir;
}

async function createShellZip(platform, arch) {
  if (platform !== "macos" && platform !== "windows") return;

  const { productName, version } = await readPackageInfo();
  const appDir = await createShellAppCopy(platform, arch, productName);
  const outputPath = path.join(releaseDir, `${productName}-${version}-${platform}-${arch}-shell.zip`);

  await fs.rm(outputPath, { force: true });
  if (platform === "macos") {
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appDir, outputPath]);
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
      await fs.symlink(electronLinkTarget, path.join(packagingNodeModulesDir, "electron"));
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
    await run(process.execPath, args);
    if (process.platform === "win32") {
      await createPortableZip("windows", targetArch);
      await createShellZip("windows", targetArch);
    }
  } finally {
    await restorePackagingNodeModules(nodeModulesHidden);
  }
}

void main().catch((error) => {
  console.error("[desktop:dist] failed to build installer", error);
  process.exit(1);
});
