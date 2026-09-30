import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, open, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FOUNDATION_TARGETS,
  checkPackagedFoundationArtifacts,
  foundationBinaryName,
  resolveCargoFoundationExecutable,
  resolveFoundationTarget,
  stageFoundationArtifacts,
  validateFoundationBinary,
} from "./stage-native.mjs";

const serverRoot = path.resolve(import.meta.dirname, "..");
const packageManifest = JSON.parse(readFileSync(path.join(serverRoot, "package.json"), "utf8"));

function fakeBinary(target) {
  const { format, machine } = FOUNDATION_TARGETS[target];
  if (format === "elf") {
    const bytes = Buffer.alloc(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
    bytes.writeUInt16LE(machine, 18);
    return bytes;
  }
  if (format === "macho") {
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(machine, 4);
    return bytes;
  }
  const bytes = Buffer.alloc(128);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x40, 0x3c);
  bytes.write("PE\0\0", 0x40, "binary");
  bytes.writeUInt16LE(machine, 0x44);
  return bytes;
}

function makeArtifactRoot(targets = Object.keys(FOUNDATION_TARGETS)) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rudder-server-foundation-artifacts-"));
  for (const target of targets) {
    const dir = path.join(root, target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, foundationBinaryName(target)), fakeBinary(target), { mode: 0o600 });
  }
  return root;
}

test("resolves all six generic server foundation target triples", () => {
  assert.deepEqual([
    resolveFoundationTarget("darwin", "arm64"),
    resolveFoundationTarget("darwin", "x64"),
    resolveFoundationTarget("linux", "arm64"),
    resolveFoundationTarget("linux", "x64"),
    resolveFoundationTarget("win32", "arm64"),
    resolveFoundationTarget("win32", "x64"),
  ], Object.keys(FOUNDATION_TARGETS));
  assert.equal(resolveFoundationTarget("linux", "ia32"), null);
  assert.equal(foundationBinaryName("aarch64-pc-windows-msvc"), "rudder-server-foundation.exe");
});

test("uses Cargo's reported host executable instead of a stale target-triple artifact", () => {
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-cargo-output-"));
  try {
    const fresh = path.join(artifactRoot, "debug", "rudder-server-foundation");
    const stale = path.join(artifactRoot, "aarch64-apple-darwin", "debug", "rudder-server-foundation");
    mkdirSync(path.dirname(fresh), { recursive: true });
    mkdirSync(path.dirname(stale), { recursive: true });
    writeFileSync(fresh, fakeBinary("aarch64-apple-darwin"));
    writeFileSync(stale, fakeBinary("aarch64-apple-darwin"));

    const output = [
      JSON.stringify({ reason: "compiler-artifact", target: { name: "another-bin", kind: ["bin"] }, executable: stale }),
      JSON.stringify({ reason: "compiler-artifact", target: { name: "rudder-server-foundation", kind: ["bin"] }, executable: fresh }),
    ].join("\n");
    assert.equal(resolveCargoFoundationExecutable(output), fresh);
  } finally {
    rmSync(artifactRoot, { recursive: true, force: true });
  }
});

test("stages six correctly typed payloads into the generic server resource path", async () => {
  const artifactDir = makeArtifactRoot();
  const resourcesDir = mkdtempSync(path.join(os.tmpdir(), "rudder-server-resources-"));
  try {
    const staged = await stageFoundationArtifacts({ artifactDir, resourcesDir });
    assert.deepEqual(staged.map(({ target }) => target), Object.keys(FOUNDATION_TARGETS));
    for (const target of Object.keys(FOUNDATION_TARGETS)) {
      const filename = foundationBinaryName(target);
      const destination = path.join(resourcesDir, "native", target, filename);
      assert.deepEqual(readFileSync(destination), fakeBinary(target));
      if (process.platform !== "win32") assert.notEqual(statSync(destination).mode & 0o111, 0);
    }
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("package verification requires all six target-correct executable payloads", async () => {
  const artifactDir = makeArtifactRoot();
  const resourcesDir = mkdtempSync(path.join(os.tmpdir(), "rudder-server-resources-"));
  try {
    await stageFoundationArtifacts({ artifactDir, resourcesDir });
    const checked = await checkPackagedFoundationArtifacts({ resourcesDir });
    assert.deepEqual(checked.map(({ target }) => target), Object.keys(FOUNDATION_TARGETS));

    const linuxPath = path.join(resourcesDir, "native", "x86_64-unknown-linux-gnu", foundationBinaryName("x86_64-unknown-linux-gnu"));
    if (process.platform !== "win32") {
      await chmod(linuxPath, 0o644);
      await assert.rejects(checkPackagedFoundationArtifacts({ resourcesDir }), /not executable/u);
      await chmod(linuxPath, 0o755);
    }
    writeFileSync(linuxPath, fakeBinary("aarch64-unknown-linux-gnu"));
    await chmod(linuxPath, 0o755);
    await assert.rejects(checkPackagedFoundationArtifacts({ resourcesDir }), /does not match x86_64-unknown-linux-gnu/u);

    await unlink(linuxPath);
    await assert.rejects(checkPackagedFoundationArtifacts({ resourcesDir }), /rudder-server-foundation/u);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("replaces a staged executable without changing bytes seen by an existing reader", async () => {
  const target = "aarch64-apple-darwin";
  const artifactDir = makeArtifactRoot([target]);
  const resourcesDir = mkdtempSync(path.join(os.tmpdir(), "rudder-foundation-replacement-"));
  const sourcePath = path.join(artifactDir, target, foundationBinaryName(target));
  const destinationPath = path.join(resourcesDir, "native", target, foundationBinaryName(target));
  let previousReader;
  try {
    await stageFoundationArtifacts({ artifactDir, resourcesDir, targets: [target] });
    const previousBytes = readFileSync(destinationPath);
    previousReader = await open(destinationPath, "r");
    const previousStat = await previousReader.stat();
    const replacementBytes = Buffer.concat([fakeBinary(target), Buffer.from("replacement")]);
    writeFileSync(sourcePath, replacementBytes);

    await stageFoundationArtifacts({ artifactDir, resourcesDir, targets: [target] });
    assert.deepEqual(readFileSync(destinationPath), replacementBytes);
    assert.deepEqual(await previousReader.readFile(), previousBytes);
    if (process.platform !== "win32") assert.notEqual(statSync(destinationPath).ino, previousStat.ino);
    assert.deepEqual(readdirSync(path.dirname(destinationPath)), [foundationBinaryName(target)]);

    writeFileSync(sourcePath, Buffer.from("invalid replacement"));
    await assert.rejects(stageFoundationArtifacts({ artifactDir, resourcesDir, targets: [target] }), /Unrecognized/u);
    assert.deepEqual(readFileSync(destinationPath), replacementBytes);
  } finally {
    await previousReader?.close();
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("validates every artifact before writing any package payload", async () => {
  const artifactDir = makeArtifactRoot(Object.keys(FOUNDATION_TARGETS).slice(0, -1));
  const resourcesDir = mkdtempSync(path.join(os.tmpdir(), "rudder-server-resources-"));
  const sentinel = path.join(resourcesDir, "native", "sentinel");
  mkdirSync(path.dirname(sentinel), { recursive: true });
  writeFileSync(sentinel, "preserve");
  try {
    await assert.rejects(stageFoundationArtifacts({ artifactDir, resourcesDir }), /rudder-server-foundation\.exe/u);
    assert.equal(readFileSync(sentinel, "utf8"), "preserve");
    assert.deepEqual(requireNativeTargets(resourcesDir), []);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("rejects wrong-target and wrong-platform payloads", async () => {
  const artifactDir = makeArtifactRoot();
  const resourcesDir = mkdtempSync(path.join(os.tmpdir(), "rudder-server-resources-"));
  try {
    writeFileSync(
      path.join(artifactDir, "x86_64-unknown-linux-gnu", foundationBinaryName("x86_64-unknown-linux-gnu")),
      fakeBinary("aarch64-unknown-linux-gnu"),
    );
    await assert.rejects(stageFoundationArtifacts({ artifactDir, resourcesDir }), /does not match x86_64-unknown-linux-gnu/u);
    assert.deepEqual(requireNativeTargets(resourcesDir), []);

    writeFileSync(
      path.join(artifactDir, "x86_64-unknown-linux-gnu", foundationBinaryName("x86_64-unknown-linux-gnu")),
      fakeBinary("x86_64-apple-darwin"),
    );
    await assert.rejects(stageFoundationArtifacts({ artifactDir, resourcesDir }), /does not match x86_64-unknown-linux-gnu/u);
    assert.deepEqual(requireNativeTargets(resourcesDir), []);

    assert.throws(() => validateFoundationBinary(Buffer.from("not a native executable"), "x86_64-pc-windows-msvc"), /Unrecognized/u);
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("keeps all six payloads in the server npm package without adding install-time Rust compilation", async () => {
  assert.ok(packageManifest.files.includes("resources"));
  assert.match(packageManifest.scripts.predev, /stage:native/u);
  assert.match(packageManifest.scripts["predev:watch"], /stage:native/u);
  assert.match(packageManifest.scripts.prebuild, /stage:native/u);
  assert.match(packageManifest.scripts.prepack, /pnpm run stage:native --prepack/u);
  assert.match(packageManifest.scripts.postinstall, /postinstall-native-mode\.mjs.*postinstall-postgres-compat\.mjs/u);
  assert.doesNotMatch(Object.values(packageManifest.scripts).join("\n"), /stage:native\s+--\s+--/u);
  assert.doesNotMatch(`${packageManifest.scripts.preinstall ?? ""} ${packageManifest.scripts.install ?? ""} ${packageManifest.scripts.postinstall ?? ""}`, /cargo|stage-native/u);

  const artifactDir = makeArtifactRoot();
  const packageDir = mkdtempSync(path.join(os.tmpdir(), "rudder-server-npm-pack-"));
  try {
    writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
      name: packageManifest.name,
      version: packageManifest.version,
      files: packageManifest.files,
    }));
    await stageFoundationArtifacts({ artifactDir, resourcesDir: path.join(packageDir, "resources") });
    for (const script of ["postinstall-native-mode.mjs", "postinstall-postgres-compat.mjs"]) {
      copyFileSync(path.join(serverRoot, "resources", script), path.join(packageDir, "resources", script));
    }
    const result = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: packageDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }))[0];
    const packagedPaths = new Set(result.files.map(({ path: filename }) => filename));
    assert.ok(packagedPaths.has("resources/postinstall-native-mode.mjs"));
    assert.ok(packagedPaths.has("resources/postinstall-postgres-compat.mjs"));
    for (const target of Object.keys(FOUNDATION_TARGETS)) {
      const filename = `resources/native/${target}/${foundationBinaryName(target)}`;
      assert.ok(packagedPaths.has(filename));
      if (process.platform !== "win32") {
        const entry = result.files.find(({ path: packagedPath }) => packagedPath === filename);
        assert.notEqual(entry.mode & 0o111, 0);
      }
    }
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("restores a normalized native mode through a real npm tarball install lifecycle", { skip: process.platform === "win32" }, () => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-server-install-lifecycle-"));
  const packageRoot = path.join(fixtureRoot, "package");
  const packDir = path.join(fixtureRoot, "packed");
  const installPrefix = path.join(fixtureRoot, "install");
  const isolatedHome = path.join(fixtureRoot, "home");
  const target = resolveFoundationTarget(process.platform, process.arch);
  assert.ok(target, `unsupported install test host ${process.platform}/${process.arch}`);
  try {
    const hostRelativePath = path.join("native", target, foundationBinaryName(target));
    const sourceBinary = path.join(packageRoot, "resources", hostRelativePath);
    mkdirSync(path.dirname(sourceBinary), { recursive: true });
    mkdirSync(packDir, { recursive: true });
    mkdirSync(isolatedHome, { recursive: true });
    writeFileSync(sourceBinary, fakeBinary(target), { mode: 0o644 });
    chmodSync(sourceBinary, 0o644);
    for (const script of ["postinstall-native-mode.mjs", "postinstall-postgres-compat.mjs"]) {
      copyFileSync(path.join(serverRoot, "resources", script), path.join(packageRoot, "resources", script));
    }
    writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
      name: packageManifest.name,
      version: packageManifest.version,
      files: ["resources"],
      scripts: { postinstall: packageManifest.scripts.postinstall },
    }));

    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", packDir], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true", NPM_CONFIG_IGNORE_SCRIPTS: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    }))[0];
    const packedBinary = packed.files.find(({ path: entry }) => entry === `resources/${hostRelativePath}`);
    assert.ok(packedBinary, `tarball omitted resources/${hostRelativePath}`);
    assert.equal(packedBinary.mode & 0o111, 0, "fixture tarball must reproduce normalized non-executable mode");

    const tarballPath = path.join(packDir, packed.filename);
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", installPrefix, tarballPath], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_ignore_scripts: "false",
        NPM_CONFIG_IGNORE_SCRIPTS: "false",
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        RUDDER_HOME: path.join(isolatedHome, ".rudder"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const installedBinary = path.join(installPrefix, "node_modules", "@rudderhq", "server", "resources", hostRelativePath);
    assert.notEqual(statSync(installedBinary).mode & 0o111, 0, "postinstall did not restore executable mode");
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("pnpm forwards the prepack option without a literal separator", () => {
  const result = spawnSync("pnpm", ["--filter", packageManifest.name, "run", "stage:native", "--prepack"], {
    cwd: path.resolve(serverRoot, ".."),
    encoding: "utf8",
    env: { ...process.env, RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR: "" },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /--prepack requires RUDDER_SERVER_FOUNDATION_ARTIFACT_DIR/u);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Unknown or incomplete argument: --(?:\s|$)/u);
});

function requireNativeTargets(resourcesDir) {
  try {
    return readdirSync(path.join(resourcesDir, "native")).filter((name) => name !== "sentinel");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
