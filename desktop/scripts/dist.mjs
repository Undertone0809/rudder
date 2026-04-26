import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const packagingNodeModulesDir = path.join(desktopRoot, "node_modules");
const hiddenPackagingNodeModulesDir = path.join(desktopRoot, ".node_modules.packaging-hidden");
const requireFromScript = createRequire(import.meta.url);
const electronBuilderCliPath = requireFromScript.resolve("electron-builder/cli.js");
const targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
const requireReleaseSigning = process.env.RUDDER_DESKTOP_REQUIRE_SIGNING === "1";

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
      await run(process.execPath, ["scripts/create-dmg.mjs"]);
      if (requireReleaseSigning) {
        await run(process.execPath, ["scripts/verify-macos-release-signing.mjs", "--arch", targetArch]);
      }
      return;
    }

    const args = [electronBuilderCliPath];
    if (process.platform === "win32") args.push("--win");
    if (process.platform === "linux") args.push("--linux");
    const archFlag = archFlagFor(targetArch);
    if (archFlag) args.push(archFlag);
    await run(process.execPath, args);
  } finally {
    await restorePackagingNodeModules(nodeModulesHidden);
  }
}

void main().catch((error) => {
  console.error("[desktop:dist] failed to build installer", error);
  process.exit(1);
});
