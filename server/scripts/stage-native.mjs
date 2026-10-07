import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(serverRoot, "..");
const nativeRoot = path.join(repoRoot, "native");

export const FOUNDATION_TARGETS = Object.freeze({
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64", format: "macho", machine: 0x0100000c, extension: "" },
  "x86_64-apple-darwin": { platform: "darwin", arch: "x64", format: "macho", machine: 0x01000007, extension: "" },
  "aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64", format: "elf", machine: 183, extension: "" },
  "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", format: "elf", machine: 62, extension: "" },
  "aarch64-pc-windows-msvc": { platform: "win32", arch: "arm64", format: "pe", machine: 0xaa64, extension: ".exe" },
  "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64", format: "pe", machine: 0x8664, extension: ".exe" },
});

export function resolveFoundationTarget(platform, arch) {
  return Object.entries(FOUNDATION_TARGETS)
    .find(([, value]) => value.platform === platform && value.arch === arch)?.[0] ?? null;
}

export function foundationBinaryName(target) {
  const config = FOUNDATION_TARGETS[target];
  if (!config) throw new Error(`Unsupported server foundation target: ${target}`);
  return `rudder-server-foundation${config.extension}`;
}

export function migrationPreflightBinaryName(target) {
  const config = FOUNDATION_TARGETS[target];
  if (!config) throw new Error(`Unsupported server migration preflight target: ${target}`);
  return `migration-preflight${config.extension}`;
}

function inspectBinary(buffer, target) {
  const expected = FOUNDATION_TARGETS[target];
  if (!expected) throw new Error(`Unsupported server foundation target: ${target}`);
  let format;
  let machine;

  if (buffer.length >= 20 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    format = "elf";
    const isLittleEndian = buffer[5] === 1;
    if (!isLittleEndian && buffer[5] !== 2) throw new Error("ELF binary has an invalid byte order");
    machine = isLittleEndian ? buffer.readUInt16LE(18) : buffer.readUInt16BE(18);
  } else if (buffer.length >= 8 && buffer.readUInt32LE(0) === 0xfeedfacf) {
    format = "macho";
    machine = buffer.readUInt32LE(4);
  } else if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0xfeedfacf) {
    format = "macho";
    machine = buffer.readUInt32BE(4);
  } else if (buffer.length >= 70 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    const peOffset = buffer.readUInt32LE(0x3c);
    if (peOffset + 6 > buffer.length || buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
      throw new Error("Windows binary has an invalid PE header");
    }
    format = "pe";
    machine = buffer.readUInt16LE(peOffset + 4);
  } else {
    throw new Error("Unrecognized server foundation executable format");
  }

  if (format !== expected.format || machine !== expected.machine) {
    throw new Error(`Binary payload does not match ${target} (found ${format} machine 0x${machine.toString(16)})`);
  }
  if (target.endsWith("-unknown-linux-gnu") && buffer.includes(Buffer.from("ld-musl"))) {
    throw new Error(`Binary payload for ${target} contains a musl loader marker`);
  }
}

export function validateFoundationBinary(buffer, target) {
  inspectBinary(buffer, target);
}

async function inspectSource(sourcePath, target, { requireExecutable = false } = {}) {
  const stat = await fs.lstat(sourcePath);
  if (!stat.isFile()) throw new Error(`Server foundation artifact is not a regular file: ${sourcePath}`);
  if (requireExecutable && process.platform !== "win32" && (stat.mode & 0o111) === 0) {
    throw new Error(`Packaged server foundation artifact is not executable: ${sourcePath}`);
  }
  inspectBinary(await fs.readFile(sourcePath), target);
}

async function validateFoundationArtifacts(artifacts, options) {
  for (const [target, sourcePath] of Object.entries(artifacts)) {
    await inspectSource(sourcePath, target, options);
  }
}

async function publishFoundationArtifact(sourcePath, destinationPath, target) {
  const destinationDir = path.dirname(destinationPath);
  await fs.mkdir(destinationDir, { recursive: true });
  const temporaryDir = await fs.mkdtemp(path.join(destinationDir, ".foundation-stage-"));
  const temporaryPath = path.join(temporaryDir, path.basename(destinationPath));
  try {
    await fs.copyFile(sourcePath, temporaryPath);
    await fs.chmod(temporaryPath, 0o755);
    await inspectSource(temporaryPath, target, { requireExecutable: true });
    // A fresh inode avoids macOS retaining the signature of an overwritten executable.
    await fs.rename(temporaryPath, destinationPath);
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function stageFoundationArtifacts({ artifactDir, resourcesDir, targets = Object.keys(FOUNDATION_TARGETS) }) {
  const sources = Object.fromEntries(targets.map((target) => [
    target,
    path.join(artifactDir, target, foundationBinaryName(target)),
  ]));
  const migrationSources = Object.fromEntries(targets.map((target) => [
    target, path.join(artifactDir, target, migrationPreflightBinaryName(target)),
  ]));
  await validateFoundationArtifacts(sources);
  await validateFoundationArtifacts(migrationSources);

  const resourceRoot = path.resolve(resourcesDir);
  const staged = [];
  for (const target of targets) {
    const sourcePath = sources[target];
    const destinationPath = path.join(resourceRoot, "native", target, foundationBinaryName(target));
    await publishFoundationArtifact(sourcePath, destinationPath, target);
    const migrationPreflightPath = path.join(resourceRoot, "native", target, migrationPreflightBinaryName(target));
    await publishFoundationArtifact(migrationSources[target], migrationPreflightPath, target);
    staged.push({ target, path: destinationPath, migrationPreflightPath });
  }
  return staged;
}

export async function checkPackagedFoundationArtifacts({ resourcesDir, targets = Object.keys(FOUNDATION_TARGETS) }) {
  const resourceRoot = path.resolve(resourcesDir);
  const sources = Object.fromEntries(targets.map((target) => [
    target,
    path.join(resourceRoot, "native", target, foundationBinaryName(target)),
  ]));
  const migrationSources = Object.fromEntries(targets.map((target) => [
    target, path.join(resourceRoot, "native", target, migrationPreflightBinaryName(target)),
  ]));
  await validateFoundationArtifacts(sources, { requireExecutable: true });
  await validateFoundationArtifacts(migrationSources, { requireExecutable: true });
  return targets.map((target) => ({ target, path: sources[target], migrationPreflightPath: migrationSources[target] }));
}

export function resolveCargoFoundationExecutable(output, binaryName = "rudder-server-foundation") {
  const executables = [];
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      message.reason === "compiler-artifact"
      && message.target?.name === binaryName
      && message.target.kind?.includes("bin")
      && typeof message.executable === "string"
    ) {
      executables.push(message.executable);
    }
  }
  if (executables.length !== 1) {
    throw new Error(`Cargo reported ${executables.length} ${binaryName} executables; expected exactly one`);
  }
  return executables[0];
}

function buildCargoFoundation(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["inherit", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) return reject(new Error(`${command} exited with signal ${signal}`));
      if (code !== 0) return reject(new Error(`${command} exited with code ${code ?? 1}`));
      try {
        resolve(["rudder-server-foundation", "migration-preflight"].map((name) => resolveCargoFoundationExecutable(stdout, name)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseArgs(args) {
  const parsed = {
    artifactDir: process.env.RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR,
    release: false,
    checkPackaged: false,
    prepack: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--artifact-dir" && args[index + 1]) {
      parsed.artifactDir = args[index + 1];
      index += 1;
    } else if (args[index] === "--release") {
      parsed.release = true;
    } else if (args[index] === "--check-packaged") {
      parsed.checkPackaged = true;
    } else if (args[index] === "--prepack") {
      parsed.prepack = true;
    } else {
      throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    }
  }
  if (parsed.checkPackaged && (parsed.artifactDir || parsed.release || parsed.prepack)) {
    throw new Error("--check-packaged cannot be combined with artifact input, --release, or --prepack");
  }
  if (parsed.prepack && parsed.release) throw new Error("--prepack cannot be combined with --release");
  return parsed;
}

async function main() {
  const { artifactDir, release, checkPackaged, prepack } = parseArgs(process.argv.slice(2));
  const resourcesDir = path.join(serverRoot, "resources");
  if (checkPackaged) {
    const checked = await checkPackagedFoundationArtifacts({ resourcesDir });
    console.log(`[server:stage-native] verified all ${checked.length} packaged target artifacts`);
    return;
  }
  if (prepack) {
    if (!artifactDir) throw new Error("--prepack requires RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR with all six target artifacts");
    const staged = await stageFoundationArtifacts({ artifactDir: path.resolve(artifactDir), resourcesDir });
    const checked = await checkPackagedFoundationArtifacts({ resourcesDir });
    console.log(`[server:stage-native] staged and verified all ${checked.length} package artifacts`);
    return staged;
  }
  if (artifactDir) {
    const staged = await stageFoundationArtifacts({ artifactDir: path.resolve(artifactDir), resourcesDir });
    console.log(`[server:stage-native] staged ${staged.length} target artifacts under resources/native`);
    return;
  }

  const target = resolveFoundationTarget(process.platform, process.arch);
  if (!target) throw new Error(`Unsupported server foundation host: ${process.platform}/${process.arch}`);
  const binaryName = foundationBinaryName(target);
  const cargoBuildTarget = process.env.CARGO_BUILD_TARGET;
  if (cargoBuildTarget && cargoBuildTarget !== target) {
    throw new Error(`Cannot stage ${cargoBuildTarget} as the current host target ${target}`);
  }
  const cargoArgs = ["build", "--manifest-path", path.join(nativeRoot, "Cargo.toml"), "-p", "rudder-server-foundation", "--bin", "rudder-server-foundation", "-p", "rudder-migration-service", "--bin", "migration-preflight", "--message-format=json-render-diagnostics"];
  if (release) cargoArgs.push("--release");
  const [sourcePath, migrationSourcePath] = await buildCargoFoundation(process.platform === "win32" ? "cargo.exe" : "cargo", cargoArgs);
  await inspectSource(sourcePath, target);
  await inspectSource(migrationSourcePath, target);
  const destinationPath = path.join(resourcesDir, "native", target, binaryName);
  await publishFoundationArtifact(sourcePath, destinationPath, target);
  await publishFoundationArtifact(migrationSourcePath, path.join(resourcesDir, "native", target, migrationPreflightBinaryName(target)), target);
  console.log(`[server:stage-native] staged ${target}/${binaryName} and migration-preflight`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error("[server:stage-native] failed", error);
    process.exit(1);
  });
}
