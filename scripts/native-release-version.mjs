import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const CARGO_MEMBER_RE = /^\s*"([^"]+)"\s*,?\s*$/gmu;
const CARGO_FIELD_RE = /^([a-z_]+)\s*=\s*"([^"]+)"\s*$/mu;

const JS_VERSION_PATHS = [
  "desktop/package.json",
  "server/package.json",
  "cli/package.json",
  "packages/shared/package.json",
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function readWorkspaceVersion(cargoPath) {
  const source = readFileSync(cargoPath, "utf8");
  const section = source.split(/^\[/mu).find((part) => part.startsWith("workspace.package]")) ?? "";
  const version = section.match(CARGO_FIELD_RE)?.[2];
  if (!version) throw new Error(`native workspace version missing: ${cargoPath}`);
  return version;
}

function readWorkspaceMembers(cargoPath) {
  const source = readFileSync(cargoPath, "utf8");
  const section = source.match(/^members\s*=\s*\[([\s\S]*?)\]/mu)?.[1] ?? "";
  return [...section.matchAll(CARGO_MEMBER_RE)].map((match) => match[1]);
}

function assertWorkspacePackages(repoRoot, cargoPath, expectedVersion) {
  const memberPaths = readWorkspaceMembers(cargoPath);
  if (memberPaths.length === 0) throw new Error(`native workspace has no members: ${cargoPath}`);
  const packageNames = [];
  for (const member of memberPaths) {
    const memberCargoPath = path.join(path.dirname(cargoPath), member, "Cargo.toml");
    if (!existsSync(memberCargoPath)) throw new Error(`native workspace member missing: ${memberCargoPath}`);
    const source = readFileSync(memberCargoPath, "utf8");
    const name = source.match(/^name\s*=\s*"([^"]+)"\s*$/mu)?.[1];
    if (!name) throw new Error(`native workspace member name missing: ${memberCargoPath}`);
    if (!/^version\.workspace\s*=\s*true\s*$/mu.test(source)) {
      throw new Error(`native workspace member ${name} must inherit version.workspace`);
    }
    packageNames.push(name);
  }

  const lockPath = path.join(path.dirname(cargoPath), "Cargo.lock");
  if (!existsSync(lockPath)) throw new Error(`native Cargo.lock missing: ${lockPath}`);
  const lockSource = readFileSync(lockPath, "utf8");
  const lockVersions = new Map();
  for (const block of lockSource.split(/^\[\[package\]\]\s*$/mu).slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"\s*$/mu)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"\s*$/mu)?.[1];
    if (name && version) lockVersions.set(name, version);
  }
  for (const name of packageNames) {
    if (lockVersions.get(name) !== expectedVersion) {
      throw new Error(`native Cargo.lock ${name} version ${lockVersions.get(name) ?? "<missing>"} does not match ${expectedVersion}`);
    }
  }
  return { cargoPath, lockPath, packageNames };
}

function assertJavaScriptVersions(repoRoot, expectedVersion) {
  const checked = [];
  for (const relativePath of JS_VERSION_PATHS) {
    const filePath = path.join(repoRoot, relativePath);
    if (!existsSync(filePath)) throw new Error(`release version manifest missing: ${filePath}`);
    const version = readJson(filePath).version;
    if (version !== expectedVersion) {
      throw new Error(`${relativePath} version ${version ?? "<missing>"} does not match ${expectedVersion}`);
    }
    checked.push({ path: relativePath, version });
  }
  return checked;
}

function verifyBinaryVersion(binaryPath, expectedVersion) {
  const result = spawnSync(binaryPath, ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (result.error) throw new Error(`${binaryPath} --version failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${binaryPath} --version exited ${result.status}: ${result.stderr?.trim() ?? ""}`);
  const output = String(result.stdout ?? "").trim();
  const binaryName = path.basename(binaryPath).replace(/\.exe$/u, "");
  const expected = binaryName === "rudder-update-helper"
    ? `rudder-update-helper ${expectedVersion} protocol=1`
    : `${binaryName} ${expectedVersion}`;
  if (output !== expected) throw new Error(`${binaryPath} reported ${JSON.stringify(output)}, expected ${JSON.stringify(expected)}`);
  return { path: binaryPath, version: output };
}

export function verifyNativeReleaseVersion({ repoRoot, expectedVersion, binaryPaths = [] }) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)) {
    throw new Error(`invalid expected release version: ${expectedVersion}`);
  }
  const cargoPath = path.join(repoRoot, "native", "Cargo.toml");
  if (readWorkspaceVersion(cargoPath) !== expectedVersion) {
    throw new Error(`native workspace version does not match ${expectedVersion}`);
  }
  const cargo = assertWorkspacePackages(repoRoot, cargoPath, expectedVersion);
  const javascript = assertJavaScriptVersions(repoRoot, expectedVersion);
  const binaries = binaryPaths.map((binaryPath) => verifyBinaryVersion(binaryPath, expectedVersion));
  return {
    productVersion: expectedVersion,
    versionSources: {
      cargoWorkspace: path.relative(repoRoot, cargoPath),
      cargoLock: path.relative(repoRoot, cargo.lockPath),
      nativePackages: cargo.packageNames,
      javascript,
      stagedBinaries: binaries,
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repoRoot = path.resolve(process.argv.find((arg) => arg.startsWith("--repo-root="))?.slice(12) ?? path.join(scriptDir, ".."));
  const expectedVersion = process.argv.find((arg) => arg.startsWith("--expected-version="))?.slice(19);
  if (!expectedVersion) {
    console.error("Usage: node scripts/native-release-version.mjs --expected-version X.Y.Z [--repo-root PATH]");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(verifyNativeReleaseVersion({ repoRoot, expectedVersion }), null, 2));
  } catch (error) {
    console.error(`[native-release-version] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
