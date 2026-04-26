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

function archFlagFor(arch) {
  if (arch === "arm64") return "--arm64";
  if (arch === "x64") return "--x64";
  return null;
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
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

  await run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -LiteralPath ${powershellQuote(appDir)} -DestinationPath ${powershellQuote(outputPath)} -Force`,
  ]);
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
    }
  } finally {
    await restorePackagingNodeModules(nodeModulesHidden);
  }
}

void main().catch((error) => {
  console.error("[desktop:dist] failed to build installer", error);
  process.exit(1);
});
