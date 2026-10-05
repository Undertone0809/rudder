import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateFoundationBinary } from "../../server/scripts/stage-native.mjs";
import { resolveNativeTarget } from "./native-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");

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

async function canonicalPath(targetPath) {
  try { return await fs.realpath(targetPath); } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = path.dirname(targetPath);
    if (parent === targetPath) throw error;
    return path.join(await canonicalPath(parent), path.basename(targetPath));
  }
}

async function readFoundationArtifact(sourcePath, targetRoot, target) {
  if (!(await fs.lstat(sourcePath)).isFile()) {
    throw new Error("Desktop foundation artifact must be a regular, non-symlink file");
  }
  const relative = path.relative(await canonicalPath(targetRoot), await fs.realpath(sourcePath));
  if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("Desktop foundation artifact must be outside the replaced staging directory");
  }
  const bytes = await fs.readFile(sourcePath);
  validateFoundationBinary(bytes, target);
  return bytes;
}

export async function stageDesktopNative({
  root = repoRoot,
  platform = process.platform,
  hostArch = process.arch,
  targetArch = process.env.RUDDER_DESKTOP_TARGET_ARCH || hostArch,
  nativeTarget = process.env.RUDDER_NATIVE_TARGET,
  artifactDir = process.env.RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR,
  runCommand = run,
} = {}) {
  const nativeRoot = path.join(root, "native");
  const stagedNativeRoot = path.join(root, "desktop", ".packaged", "native");
  const target = resolveNativeTarget(platform, targetArch);
  if (!target) {
    throw new Error(`Rust native process host has no supported target mapping for ${platform}/${targetArch}`);
  }
  const extension = platform === "win32" ? ".exe" : "";
  const binaryName = `rudder-process-host${extension}`;
  const archiveBinaryName = `rudder-native${extension}`;
  const updateHelperBinaryName = `rudder-update-helper${extension}`;
  const migrationPreflightBinaryName = `migration-preflight${extension}`;
  const serverFoundationBinaryName = `rudder-server-foundation${extension}`;
  const targetRoot = path.join(stagedNativeRoot, target);
  const requestedTarget = nativeTarget || (target === resolveNativeTarget(platform, hostArch) ? null : target);
  if (artifactDir && requestedTarget && requestedTarget !== target) {
    throw new Error("Desktop foundation artifact target conflicts with the requested Cargo target");
  }
  // Release already binds this artifact directory to exact-source qualified CI.
  // Hold validated bytes before building or replacing staging. Only foundation
  // is version-independent; preflight must still be rebuilt at the release version.
  const foundationArtifact = artifactDir
    ? await readFoundationArtifact(path.join(path.resolve(artifactDir), target, serverFoundationBinaryName), targetRoot, target)
    : null;
  const cargoArgs = [
    "build", "--manifest-path", path.join(nativeRoot, "Cargo.toml"), "--release",
  ];
  if (foundationArtifact) {
    for (const [packageName, binary] of [
      ["rudder-process-host", "rudder-process-host"], ["rudder-native", "rudder-native"],
      ["rudder-update-helper", "rudder-update-helper"], ["rudder-migration-service", "migration-preflight"],
    ]) cargoArgs.push("-p", packageName, "--bin", binary);
  } else {
    cargoArgs.push("--bin", "rudder-process-host", "--bin", "rudder-native", "--bin", "rudder-update-helper",
      "--bin", "migration-preflight", "--bin", "rudder-server-foundation");
  }
  if (requestedTarget) cargoArgs.push("--target", requestedTarget);
  await runCommand(platform === "win32" ? "cargo.exe" : "cargo", cargoArgs, root);

  const profileRoot = requestedTarget
    ? path.join(nativeRoot, "target", requestedTarget, "release")
    : path.join(nativeRoot, "target", "release");
  const sourcePath = path.join(profileRoot, binaryName);
  const archiveSourcePath = path.join(profileRoot, archiveBinaryName);
  const updateHelperSourcePath = path.join(profileRoot, updateHelperBinaryName);
  const migrationPreflightSourcePath = path.join(profileRoot, migrationPreflightBinaryName);
  const serverFoundationSourcePath = path.join(profileRoot, serverFoundationBinaryName);
  const destinationPath = path.join(targetRoot, binaryName);
  const archiveDestinationPath = path.join(targetRoot, archiveBinaryName);
  const updateHelperDestinationPath = path.join(targetRoot, updateHelperBinaryName);
  const migrationPreflightDestinationPath = path.join(targetRoot, migrationPreflightBinaryName);
  const serverFoundationDestinationPath = path.join(targetRoot, serverFoundationBinaryName);
  await fs.access(sourcePath);
  await fs.access(archiveSourcePath);
  await fs.access(updateHelperSourcePath);
  await fs.access(migrationPreflightSourcePath);
  if (!foundationArtifact) await fs.access(serverFoundationSourcePath);
  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });
  await fs.copyFile(sourcePath, destinationPath);
  await fs.copyFile(archiveSourcePath, archiveDestinationPath);
  await fs.copyFile(updateHelperSourcePath, updateHelperDestinationPath);
  await fs.copyFile(migrationPreflightSourcePath, migrationPreflightDestinationPath);
  if (foundationArtifact) await fs.writeFile(serverFoundationDestinationPath, foundationArtifact);
  else await fs.copyFile(serverFoundationSourcePath, serverFoundationDestinationPath);
  if (platform !== "win32") await fs.chmod(destinationPath, 0o755);
  if (platform !== "win32") await fs.chmod(archiveDestinationPath, 0o755);
  if (platform !== "win32") await fs.chmod(updateHelperDestinationPath, 0o755);
  if (platform !== "win32") await fs.chmod(migrationPreflightDestinationPath, 0o755);
  if (platform !== "win32") await fs.chmod(serverFoundationDestinationPath, 0o755);
  console.log(`[desktop:stage-native] staged ${target}/${binaryName}, ${updateHelperBinaryName}, ${migrationPreflightBinaryName}, and ${serverFoundationBinaryName}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void stageDesktopNative().catch((error) => {
    console.error("[desktop:stage-native] failed", error);
    process.exit(1);
  });
}
