import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyNativeReleaseVersion } from "../../scripts/native-release-version.mjs";
import {
  createNativeArtifactManifest,
  verifyNativeArtifactManifest,
  writeNativeArtifactManifest,
} from "./native-artifact-manifest.mjs";
import { resolveNativeTarget } from "./native-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const nativeRoot = path.join(repoRoot, "native");
const stagedNativeRoot = path.join(desktopRoot, ".packaged", "native");
const targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || process.arch;
const target = resolveNativeTarget(process.platform, targetArch);
const binaryName = process.platform === "win32" ? "rudder-process-host.exe" : "rudder-process-host";
const archiveBinaryName = process.platform === "win32" ? "rudder-native.exe" : "rudder-native";
const updateHelperBinaryName = process.platform === "win32" ? "rudder-update-helper.exe" : "rudder-update-helper";
const cliBinaryName = process.platform === "win32" ? "rudder-cli.exe" : "rudder-cli";
const mcpBinaryName = process.platform === "win32" ? "rudder-mcp.exe" : "rudder-mcp";
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
  const cargoArgs = [
    "build", "--manifest-path", path.join(nativeRoot, "Cargo.toml"), "--release",
    "--bin", "rudder-process-host", "--bin", "rudder-native", "--bin", "rudder-update-helper",
    "--bin", "rudder-cli", "--bin", "rudder-mcp",
  ];
  const requestedTarget = process.env.RUDDER_NATIVE_TARGET || (target === resolveNativeTarget(process.platform, process.arch) ? null : target);
  if (requestedTarget && requestedTarget !== target) {
    throw new Error(`RUDDER_NATIVE_TARGET ${requestedTarget} does not match the desktop target ${target}`);
  }
  if (requestedTarget) cargoArgs.push("--target", requestedTarget);
  await run(cargoBin, cargoArgs, repoRoot);

  const profileRoot = requestedTarget
    ? path.join(nativeRoot, "target", requestedTarget, "release")
    : path.join(nativeRoot, "target", "release");
  const sourcePath = path.join(profileRoot, binaryName);
  const archiveSourcePath = path.join(profileRoot, archiveBinaryName);
  const updateHelperSourcePath = path.join(profileRoot, updateHelperBinaryName);
  const cliSourcePath = path.join(profileRoot, cliBinaryName);
  const mcpSourcePath = path.join(profileRoot, mcpBinaryName);
  const targetRoot = path.join(stagedNativeRoot, target);
  const destinationPath = path.join(targetRoot, binaryName);
  const archiveDestinationPath = path.join(targetRoot, archiveBinaryName);
  const updateHelperDestinationPath = path.join(targetRoot, updateHelperBinaryName);
  const cliDestinationPath = path.join(targetRoot, cliBinaryName);
  const mcpDestinationPath = path.join(targetRoot, mcpBinaryName);
  const manifestPath = path.join(targetRoot, "rudder-native-artifacts.json");
  await fs.access(sourcePath);
  await fs.access(archiveSourcePath);
  await fs.access(updateHelperSourcePath);
  await fs.access(cliSourcePath);
  await fs.access(mcpSourcePath);
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  await fs.copyFile(archiveSourcePath, archiveDestinationPath);
  await fs.copyFile(updateHelperSourcePath, updateHelperDestinationPath);
  await fs.copyFile(cliSourcePath, cliDestinationPath);
  await fs.copyFile(mcpSourcePath, mcpDestinationPath);
  if (process.platform !== "win32") await fs.chmod(destinationPath, 0o755);
  if (process.platform !== "win32") await fs.chmod(archiveDestinationPath, 0o755);
  if (process.platform !== "win32") await fs.chmod(updateHelperDestinationPath, 0o755);
  if (process.platform !== "win32") await fs.chmod(cliDestinationPath, 0o755);
  if (process.platform !== "win32") await fs.chmod(mcpDestinationPath, 0o755);

  const desktopManifest = JSON.parse(await fs.readFile(path.join(desktopRoot, "package.json"), "utf8"));
  const binaryPaths = [
    destinationPath,
    archiveDestinationPath,
    updateHelperDestinationPath,
    cliDestinationPath,
    mcpDestinationPath,
  ];
  verifyNativeReleaseVersion({
    repoRoot,
    expectedVersion: desktopManifest.version,
    binaryPaths,
  });
  const manifest = await createNativeArtifactManifest({
    version: desktopManifest.version,
    target,
    platform: process.platform,
    arch: targetArch,
    targetRoot,
  });
  await writeNativeArtifactManifest(manifestPath, manifest);
  await verifyNativeArtifactManifest({
    manifestPath,
    expectedVersion: desktopManifest.version,
    expectedTarget: target,
    expectedPlatform: process.platform,
    expectedArch: targetArch,
    targetRoot,
  });
  console.log(`[desktop:stage-native] staged ${target}/${cliBinaryName}, ${mcpBinaryName}, and native runtime binaries`);
}

void main().catch((error) => {
  console.error("[desktop:stage-native] failed", error);
  process.exit(1);
});
