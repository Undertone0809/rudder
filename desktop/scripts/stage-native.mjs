import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeTarget } from "./native-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const nativeRoot = path.join(repoRoot, "native");
const stagedNativeRoot = path.join(desktopRoot, ".packaged", "native");
const targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
const target = resolveNativeTarget(process.platform, targetArch);
const binaryName = process.platform === "win32" ? "rudder-process-host.exe" : "rudder-process-host";
const cargoBin = process.platform === "win32" ? "cargo.exe" : "cargo";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} exited with signal ${signal}`));
      if (code !== 0) return reject(new Error(`${command} exited with code ${code ?? 1}`));
      resolve();
    });
  });
}

async function main() {
  if (!target) {
    throw new Error(`Rust native process host has no supported target mapping for ${process.platform}/${targetArch}`);
  }
  const cargoArgs = ["build", "--manifest-path", path.join(nativeRoot, "Cargo.toml"), "--release", "--bin", "rudder-process-host"];
  const requestedTarget = process.env.RUDDER_NATIVE_TARGET || (target === resolveNativeTarget(process.platform, process.arch) ? null : target);
  if (requestedTarget) cargoArgs.push("--target", requestedTarget);
  await run(cargoBin, cargoArgs, repoRoot);

  const profileRoot = requestedTarget
    ? path.join(nativeRoot, "target", requestedTarget, "release")
    : path.join(nativeRoot, "target", "release");
  const sourcePath = path.join(profileRoot, binaryName);
  const targetRoot = path.join(stagedNativeRoot, target);
  const destinationPath = path.join(targetRoot, binaryName);
  await fs.access(sourcePath);
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  if (process.platform !== "win32") await fs.chmod(destinationPath, 0o755);
  console.log(`[desktop:stage-native] staged ${target}/${binaryName}`);
}

void main().catch((error) => {
  console.error("[desktop:stage-native] failed", error);
  process.exit(1);
});
