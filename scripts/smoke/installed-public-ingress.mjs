#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createWorkflowDeadline } from "./installed-public-ingress-deadline.mjs";
import { persistOwnedProcessHandoff, detachAfterRecordedHandoff } from "./installed-public-ingress-handoff.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { constants as fsConstants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm } from "node:fs/promises";
import http from "node:http";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  nativeBinaryName,
  SMOKE_NATIVE_TARGETS,
  targetMatchesHost,
} from "./installed-member-directory.mjs";
import {
  assertInstalledListenerOwnership,
  ListenerObservationUnavailable,
} from "./installed-public-ingress-listeners.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const SMOKE_OWNER = "installed-public-ingress-smoke";
const RECEIPT_SCHEMA = "installed-receipt-v2";
const EXPECTED_SOURCE_SHA = "755c273fe35fe28c36c37d598687d26dd09648d6";
const EXPECTED_PRODUCT_TREE = "a9c2944999151b1fa9b80ac17bd75f96b7574fa3";
const EXPECTED_NATIVE_CI_RUN = 37186766971;
const MAX_LOG_BYTES = 512 * 1024;
const closedChildren = new WeakSet();
const RECEIPT_PACKAGES = [
  "@rudderhq/agent-runtime-claude-local",
  "@rudderhq/agent-runtime-codex-local",
  "@rudderhq/agent-runtime-cursor-local",
  "@rudderhq/agent-runtime-hermes-gateway",
  "@rudderhq/agent-runtime-openclaw-gateway",
  "@rudderhq/agent-runtime-opencode-local",
  "@rudderhq/agent-runtime-pi-local",
  "@rudderhq/agent-runtime-utils",
  "@rudderhq/cli",
  "@rudderhq/db",
  "@rudderhq/identity-core",
  "@rudderhq/run-intelligence-core",
  "@rudderhq/server",
  "@rudderhq/shared",
];
const SOURCE_ONLY_OVERRIDES = [
  "RUDDER_SERVER_FOUNDATION_PATH",
  "RUDDER_NATIVE_LISTEN",
  "RUDDER_NATIVE_PUBLIC_LISTEN",
  "RUDDER_NATIVE_NODE_UPSTREAM",
  "RUDDER_NATIVE_INGRESS_AUTH_KEY",
  "RUDDER_RUST_MEMBER_DIRECTORY_MODE",
  "RUDDER_NATIVE_MIGRATION_PREFLIGHT_PATH",
  "RUDDER_MIGRATION_PREFLIGHT_PATH",
  "RUDDER_DESKTOP_RESOURCES_PATH",
  "RUDDER_NATIVE_MODE",
];

export class SmokePrerequisiteError extends Error {
  constructor(message) {
    super(message);
    this.name = "SmokePrerequisiteError";
  }
}

export class SmokeQuestionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SmokeQuestionError";
  }
}

export function parseArgs(args) {
  const options = {
    installRoot: null,
    receiptPath: null,
    receiptSha256: null,
    provenanceSha256: null,
    sourceSha: null,
    timeoutMs: 180_000,
    totalTimeoutMs: 1_200_000,
    keepTemp: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--install-root") options.installRoot = args[++index] ?? "";
    else if (arg === "--receipt") options.receiptPath = args[++index] ?? "";
    else if (arg === "--receipt-sha256") options.receiptSha256 = args[++index] ?? "";
    else if (arg === "--provenance-sha256") options.provenanceSha256 = args[++index] ?? "";
    else if (arg === "--source-sha") options.sourceSha = args[++index] ?? "";
    else if (arg === "--timeout-ms") options.timeoutMs = Number.parseInt(args[++index] ?? "", 10);
    else if (arg === "--total-timeout-ms") options.totalTimeoutMs = Number(args[++index] ?? "");
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }

  if (options.help) return options;
  const missing = [
    ["--install-root", options.installRoot],
    ["--receipt", options.receiptPath],
    ["--receipt-sha256", options.receiptSha256],
    ["--provenance-sha256", options.provenanceSha256],
    ["--source-sha", options.sourceSha],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new SmokePrerequisiteError(
      `complete installed-artifact proof is absent (${missing.join(", ")}); source binaries are never an installed-proof fallback`,
    );
  }
  if (!/^[a-f0-9]{64}$/iu.test(options.receiptSha256)) {
    throw new Error("--receipt-sha256 must be 64 hexadecimal characters");
  }
  if (!/^[a-f0-9]{64}$/iu.test(options.provenanceSha256)) {
    throw new Error("--provenance-sha256 must be 64 hexadecimal characters");
  }
  if (!/^[a-f0-9]{40}$/iu.test(options.sourceSha)) {
    throw new Error("--source-sha must be a 40-character Git commit SHA");
  }
  if (options.sourceSha.toLowerCase() !== EXPECTED_SOURCE_SHA) {
    throw new Error(`--source-sha must identify the installed candidate ${EXPECTED_SOURCE_SHA}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  if (!Number.isSafeInteger(options.totalTimeoutMs) || options.totalTimeoutMs <= 60_000 || options.totalTimeoutMs > 1_200_000) {
    throw new Error("--total-timeout-ms must be an integer greater than 60000 and at most 1200000");
  }
  return options;
}

export function buildServerEnvironment(baseEnv, input) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !key.startsWith("RUDDER_")),
  );
  Object.assign(env, {
    DATABASE_URL: "",
    HOST: "127.0.0.1",
    PORT: String(input.publicPort),
    RUDDER_HOME: input.profile,
    RUDDER_INSTANCE_ID: input.instanceId,
    RUDDER_AGENT_JWT_SECRET: input.jwtSecret,
    RUDDER_EMBEDDED_POSTGRES_PORT: String(input.databasePort),
    RUDDER_MIGRATION_AUTO_APPLY: "true",
    RUDDER_MIGRATION_PROMPT: "never",
    RUDDER_OPEN_ON_LISTEN: "false",
    RUDDER_RUST_BRIDGE_DEBUG: "true",
    RUDDER_RUST_PUBLIC_INGRESS_MODE: "required",
    RUDDER_DEPLOYMENT_MODE: input.deploymentMode,
  });

  assert.equal(env.HOME, baseEnv.HOME, "the smoke must preserve the caller HOME identity");
  assert.equal(env.USERPROFILE, baseEnv.USERPROFILE, "the smoke must preserve the caller USERPROFILE identity");
  for (const key of SOURCE_ONLY_OVERRIDES) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not select a source binary or private listener`);
  }
  assert.equal(env.RUDDER_RUST_PUBLIC_INGRESS_MODE, "required");
  return env;
}

export function buildCliEnvironment(baseEnv, profile) {
  const env = Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !key.startsWith("RUDDER_")),
  );
  env.RUDDER_HOME = profile;
  assert.equal(env.HOME, baseEnv.HOME, "the smoke must preserve the caller HOME identity");
  assert.equal(env.USERPROFILE, baseEnv.USERPROFILE, "the smoke must preserve the caller USERPROFILE identity");
  for (const key of SOURCE_ONLY_OVERRIDES) {
    assert.equal(Object.hasOwn(env, key), false, `${key} must not select a source binary or private listener`);
  }
  return env;
}

export function buildInstalledCliInvocation(cliEntry, runRoot, apiUrl, orgId, agentKey, agentName) {
  const args = [cliEntry, "org", "members", "--org-id", orgId, "--api-base", apiUrl,
    "--query", agentName, "--type", "agent", "--limit", "5", "--json"];
  assert.ok(!args.includes("--api-key") && !args.includes(agentKey), "bearer credential must never enter CLI argv");
  const env = buildCliEnvironment(process.env, path.join(runRoot, "cli-profile"));
  env.RUDDER_API_KEY = agentKey;
  return { args, env };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function receiptPathFor(prefix, relativePath) {
  return path.resolve(prefix, ...relativePath.split("/"));
}

function migrationPreflightName(target) {
  return target.endsWith("-pc-windows-msvc") ? "migration-preflight.exe" : "migration-preflight";
}

export function validateInstallReceipt(input) {
  const receiptBytes = Buffer.isBuffer(input.receiptBytes)
    ? input.receiptBytes
    : Buffer.from(input.receiptBytes);
  const receiptSha256 = sha256(receiptBytes);
  assert.equal(
    receiptSha256,
    input.expectedReceiptSha256.toLowerCase(),
    "installed-artifact receipt bytes do not match the supplied receipt SHA-256",
  );

  const provenanceBytes = Buffer.isBuffer(input.provenanceBytes)
    ? input.provenanceBytes
    : Buffer.from(input.provenanceBytes);
  assert.equal(
    sha256(provenanceBytes),
    input.expectedProvenanceSha256.toLowerCase(),
    "native provenance bytes do not match the supplied SHA-256",
  );

  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    throw new Error("installed-artifact receipt is not valid JSON", { cause: error });
  }
  assert.equal(receipt?.artifactStatus, "installed_private_candidate_preparation_only_not_workflow_PASS", "receipt does not describe a candidate-only installation");
  assert.equal(receipt.source, input.expectedSourceSha.toLowerCase(), "receipt source SHA does not match the requested candidate");
  assert.equal(receipt.productTree, EXPECTED_PRODUCT_TREE, "receipt product tree does not match the installed candidate");
  assert.equal(receipt.prefix, input.installRoot, "receipt install prefix does not match the inspected prefix");
  assert.match(receipt.productTree ?? "", /^[a-f0-9]{40}$/u, "receipt product tree is invalid");
  assert.equal(receipt.checkedPackages, 14, "receipt does not bind the complete 14-package install");

  const packages = new Map((receipt.packages ?? []).map((entry) => [entry.name, entry]));
  assert.equal(packages.size, 14, "receipt package list is incomplete or contains duplicate names");
  assert.deepEqual([...packages.keys()].sort(), [...RECEIPT_PACKAGES].sort(), "receipt package set does not match the installed 0.7.24 candidate");
  for (const entry of receipt.packages) {
    assert.equal(entry.version, "0.7.24", `${entry.name} receipt version does not match the installed candidate`);
    assert.match(entry.tarballSha256 ?? "", /^[a-f0-9]{64}$/u, `${entry.name} tarball SHA-256 is invalid`);
    assert.match(entry.installedContentSha256 ?? "", /^[a-f0-9]{64}$/u, `${entry.name} installed content SHA-256 is invalid`);
    assert.ok(Number.isInteger(entry.checkedEntries) && entry.checkedEntries > 0, `${entry.name} receipt has no checked package entries`);
    assert.equal(input.packageContentDigests?.[entry.name], entry.installedContentSha256, `${entry.name} archived entry digest does not match its receipt row`);
  }

  const packageEntries = new Map((receipt.packages ?? []).map((entry) => [entry.name, entry]));
  for (const name of ["cli", "server"]) {
    const expected = input.components[name];
    const packageName = name === "cli" ? "@rudderhq/cli" : "@rudderhq/server";
    const resolvedEntry = resolveReceiptRelativeEntry(input.installRoot, expected.entry);
    assert.ok(isPathInside(input.installRoot, resolvedEntry), `${name} entry escaped the installed prefix`);
    assert.match(expected.sha256, /^[a-f0-9]{64}$/u, `${name} installed entry SHA-256 is invalid`);
    assert.ok(packages.has(packageName), `receipt is missing ${packageName}`);
    assert.equal(input.installedPackages[packageName]?.version, packageEntries.get(packageName).version);
  }

  let provenance;
  try {
    provenance = JSON.parse(provenanceBytes.toString("utf8"));
  } catch (error) {
    throw new Error("native provenance is not valid JSON", { cause: error });
  }
  assert.equal(provenance.source, receipt.source, "native provenance source SHA does not match the install receipt");
  assert.equal(provenance.ci, EXPECTED_NATIVE_CI_RUN, "native provenance CI run does not match the installed candidate");
  assert.equal(provenance.platformChecks, 6, "native provenance does not cover all six targets");
  const provenanceBinaries = new Map((provenance.binaries ?? []).map((entry) => [`${entry.target}/${entry.name}`, entry.sha256]));
  assert.equal(provenanceBinaries.size, SMOKE_NATIVE_TARGETS.length * 2, "native provenance is incomplete or has duplicate binaries");
  for (const [target, expected] of Object.entries(input.components.native.targets)) {
    assert.ok(expected.serverFoundation && expected.migrationPreflight, `installed native target ${target} is incomplete`);
    for (const [name, file] of Object.entries(expected)) {
      const resolvedEntry = resolveReceiptRelativeEntry(input.installRoot, file.entry);
      assert.ok(isPathInside(input.installRoot, resolvedEntry), `${target} native entry escaped the installed prefix`);
      assert.match(file.sha256, /^[a-f0-9]{64}$/u, `${target} native entry SHA-256 is invalid`);
      const provenanceName = name === "serverFoundation"
        ? (target.endsWith("-pc-windows-msvc") ? "rudder-server-foundation.exe" : "rudder-server-foundation")
        : (target.endsWith("-pc-windows-msvc") ? "migration-preflight.exe" : "migration-preflight");
      assert.equal(provenanceBinaries.get(`${target}/${provenanceName}`), file.sha256, `${target} ${name} bytes do not match hash-bound native provenance`);
    }
  }
  assert.equal(input.components.native.targets && Object.keys(input.components.native.targets).length, SMOKE_NATIVE_TARGETS.length);
  assert.ok(input.components.native.targets[input.hostTarget], "host native executables are not in the installed prefix");
  const expectedRestorations = [
    `@rudderhq/server/resources/native/${input.hostTarget}/${nativeBinaryName(input.hostTarget)}`,
    `@rudderhq/server/resources/native/${input.hostTarget}/${migrationPreflightName(input.hostTarget)}`,
  ].sort();
  const restorations = receipt.declaredLifecycleModeRestoration ?? [];
  assert.deepEqual(restorations.map((entry) => `${entry.package}/${entry.path}`).sort(), expectedRestorations, "receipt lifecycle mode restoration is not limited to the host executables");
  for (const entry of restorations) {
    assert.equal(entry.tarballExecutableBits, 0, `${entry.path} archived executable mode changed`);
    assert.equal(entry.installedExecutableBits, 0o111, `${entry.path} installed executable mode is not the declared host restoration`);
  }
  return { receipt, provenance };
}

export function assertWebSocketRejection(response, expectedBody) {
  assert.equal(response.upgraded, false, "unauthorized websocket unexpectedly upgraded");
  assert.equal(response.statusCode, 403, `expected 403 websocket denial, got ${response.statusCode}`);
  assert.equal(response.body.trim(), expectedBody, "websocket denial came from an unexpected auth boundary");
}

export function assertActivityLoggedFrame(event, expected) {
  assert.equal(event?.type, "activity.logged");
  assert.equal(event.orgId, expected.orgId, "activity frame crossed its organization boundary");
  assert.equal(event.payload?.action, "issue.created");
  assert.equal(event.payload?.entityType, "issue");
  assert.equal(event.payload?.entityId, expected.issueId);
}

export function assertCreatedIssueResponse(body) {
  // POST /api/orgs/:orgId/issues responds with the Issue object itself.
  assert.ok(body && typeof body === "object", "Issue POST response must be a JSON object");
  assert.match(body.id ?? "", /^[0-9a-f-]{36}$/iu, "Issue POST response is missing the created Issue id");
  return body;
}

export function isExpectedIssueCreatedFrame(event, expected) {
  return event?.orgId === expected.orgId
    && event?.type === "activity.logged"
    && event?.payload?.action === "issue.created"
    && event?.payload?.entityType === "issue"
    && event?.payload?.details?.title === expected.title
    && typeof event?.payload?.entityId === "string"
    && /^[0-9a-f-]{36}$/iu.test(event.payload.entityId);
}

export function canRemoveSmokeProfile({ runtime, serverStarted, shutdownVerified }) {
  return runtime === null && (!serverStarted || shutdownVerified);
}

export function shouldRetainSmokeProfile({ keepTemp, runtime, serverStarted, shutdownVerified }) {
  return Boolean(keepTemp) || !canRemoveSmokeProfile({ runtime, serverStarted, shutdownVerified });
}

export function assertSupervisedRustChildExit(logs, pid) {
  assert.match(
    `${logs.stdout ?? ""}\n${logs.stderr ?? ""}`,
    new RegExp(`\\[rudder-rust-bridge\\] close completed pid=${pid}\\b`, "u"),
    "server TERM did not supervise shutdown of its owned Rust child",
  );
}

export function requestOwnedTermination(runtime, ownerId) {
  assert.equal(runtime?.owner, SMOKE_OWNER, "refusing to signal a process not spawned by this smoke");
  assert.equal(runtime.ownerId, ownerId, "refusing to signal a different smoke run's process");
  assert.ok(runtime.child && typeof runtime.child.kill === "function", "owned server process handle is missing");
  if (runtime.termRequested) return false;
  runtime.termRequested = true;
  return runtime.child.kill("SIGTERM");
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function receiptRelativePath(prefix, target) {
  const relative = path.relative(prefix, target);
  assert.ok(isPathInside(prefix, target), `installed component escaped prefix: ${target}`);
  return relative.split(path.sep).join("/");
}

export function resolveReceiptRelativeEntry(prefix, entry) {
  assert.equal(typeof entry, "string", "receipt entry path must be a string");
  assert.equal(path.isAbsolute(entry), false, "receipt entry path must be prefix-relative");
  const resolved = path.resolve(prefix, ...entry.split(/[\\/]+/u));
  assert.ok(isPathInside(prefix, resolved), `receipt entry escaped installed prefix: ${entry}`);
  return resolved;
}

function parsePaxHeader(data) {
  const fields = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("ascii"), 10);
    assert.ok(Number.isInteger(length) && length > 0 && offset + length <= data.length, "invalid PAX header record");
    const record = data.subarray(space + 1, offset + length).toString("utf8").replace(/\n$/u, "");
    const separator = record.indexOf("=");
    if (separator > 0) fields[record.slice(0, separator)] = record.slice(separator + 1);
    offset += length;
  }
  return fields;
}

// Component-wise code-point order is the same depth-first order as sorted
// readdir siblings; localeCompare would not match the receipt verifier.
function compareArchivePaths(left, right) {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const common = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < common; index += 1) {
    if (leftParts[index] === rightParts[index]) continue;
    return leftParts[index] < rightParts[index] ? -1 : 1;
  }
  return leftParts.length - rightParts.length;
}

export function parsePackageTarball(gzipBytes) {
  const tar = gunzipSync(gzipBytes);
  const entries = [];
  let pax = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/u, "");
    const headerPath = prefix ? `${prefix}/${name}` : name;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
    assert.ok(Number.isSafeInteger(size) && size >= 0, `invalid tar size for ${headerPath}`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert.ok(dataEnd <= tar.length, `truncated tar entry: ${headerPath}`);
    const type = header[156];
    if (type === 120 || type === 103) {
      pax = { ...pax, ...parsePaxHeader(tar.subarray(dataStart, dataEnd)) };
      offset = dataStart + Math.ceil(size / 512) * 512;
      continue;
    }
    const fullName = pax.path ?? headerPath;
    const linkTarget = pax.linkpath ?? header.subarray(157, 257).toString("utf8").replace(/\0.*$/u, "");
    pax = {};
    const modeText = header.subarray(100, 108).toString("ascii").replace(/\0.*$/u, "").trim();
    const mode = modeText ? Number.parseInt(modeText, 8) : 0;
    if (fullName.startsWith("package/") && fullName !== "package/") {
      const relativePath = fullName.slice("package/".length).replace(/\/$/u, "");
      assert.ok(relativePath && !relativePath.split("/").some((part) => part === ".." || part === "."), `unsafe package tar path: ${relativePath}`);
      if (type === 0 || type === 48) {
        entries.push({ path: relativePath, type: "file", mode: mode & 0o111, bytes: tar.subarray(dataStart, dataEnd) });
      } else if (type === 50 || type === 49) {
        entries.push({ path: relativePath, type: "link", target: linkTarget });
      } else if (type !== 53) {
        throw new Error(`unsupported package tar entry type ${type} for ${relativePath}`);
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  entries.sort((left, right) => compareArchivePaths(left.path, right.path));
  assert.equal(new Set(entries.map(({ path: entryPath }) => entryPath)).size, entries.length, "package tarball contains duplicate paths");
  return entries;
}

export function packageArchiveDigest(entries, installedModeOverrides = new Map()) {
  const rows = [...entries].sort((left, right) => compareArchivePaths(left.path, right.path)).map((entry) => (
    entry.type === "link"
      ? [entry.path, "link", entry.target]
      : [entry.path, sha256(entry.bytes), installedModeOverrides.get(entry.path) ?? (entry.mode & 0o111)]
  ));
  return sha256(JSON.stringify(rows));
}

export function extractTarEntry(gzipBytes, entryPath) {
  const entry = parsePackageTarball(gzipBytes).find(({ path: candidate }) => candidate === entryPath);
  if (entry?.type !== "file") throw new SmokePrerequisiteError(`hash-bound package tarball is missing ${entryPath}`);
  return entry.bytes;
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function canonicalInstalledEntry(installRoot, filePath) {
  const canonical = await realpath(filePath);
  assert.ok(isPathInside(installRoot, canonical), `installed entry resolved outside receipt prefix: ${filePath}`);
  return canonical;
}

async function verifyInstalledPackageArchive(receiptPackage, packageRoot, restorations) {
  assert.ok(receiptPackage && path.isAbsolute(receiptPackage.tarball), "receipt-bound package tarball path must be absolute");
  let tarballBytes;
  try {
    tarballBytes = await readFile(receiptPackage.tarball);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SmokePrerequisiteError(`hash-bound ${receiptPackage.name} tarball is absent`);
    }
    throw error;
  }
  assert.equal(sha256(tarballBytes), receiptPackage.tarballSha256, `${receiptPackage.name} tarball bytes do not match its receipt row`);
  const entries = parsePackageTarball(tarballBytes);
  const installedModeOverrides = new Map();
  for (const entry of entries) {
    const restoration = restorations.get(`${receiptPackage.name}/${entry.path}`);
    if (restoration) {
      assert.equal(entry.type, "file", `${receiptPackage.name}/${entry.path} mode restoration is not a regular archived file`);
      assert.equal(restoration.tarballExecutableBits, entry.mode, `${receiptPackage.name}/${entry.path} archive mode disagrees with lifecycle restoration receipt`);
      installedModeOverrides.set(entry.path, restoration.installedExecutableBits);
    }
  }
  assert.equal(packageArchiveDigest(entries, installedModeOverrides), receiptPackage.installedContentSha256, `${receiptPackage.name} archived package digest does not match its receipt row`);

  for (const entry of entries) {
    const installedPath = path.resolve(packageRoot, ...entry.path.split("/"));
    assert.ok(isPathInside(packageRoot, installedPath), `${receiptPackage.name} archived path escaped its package root`);
    let installedStat;
    try {
      installedStat = await lstat(installedPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new SmokePrerequisiteError(`${receiptPackage.name} installed archived entry is absent: ${entry.path}`);
      }
      throw error;
    }
    if (entry.type === "link") {
      assert.equal(installedStat.isSymbolicLink(), true, `${receiptPackage.name}/${entry.path} installed type differs from archived link`);
      assert.equal(await readlink(installedPath), entry.target, `${receiptPackage.name}/${entry.path} installed link target differs from archive`);
      continue;
    }
    assert.equal(installedStat.isFile(), true, `${receiptPackage.name}/${entry.path} installed type differs from archived regular file`);
    const actualPath = await realpath(installedPath);
    assert.ok(isPathInside(packageRoot, actualPath), `${receiptPackage.name}/${entry.path} resolved outside installed package`);
    assert.equal(sha256(await readFile(actualPath)), sha256(entry.bytes), `${receiptPackage.name}/${entry.path} installed bytes differ from archive`);
    const restoration = restorations.get(`${receiptPackage.name}/${entry.path}`);
    const expectedExecutableBits = restoration?.installedExecutableBits ?? entry.mode;
    assert.equal(installedStat.mode & 0o111, expectedExecutableBits, `${receiptPackage.name}/${entry.path} installed executable mode differs from receipt contract`);
  }
  return { entries, digest: packageArchiveDigest(entries, installedModeOverrides) };
}

export async function inspectReceiptFile(options) {
  let receiptBytes;
  try {
    receiptBytes = await readFile(options.receiptPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SmokePrerequisiteError(`installed-artifact receipt is absent: ${options.receiptPath}`);
    }
    throw error;
  }
  assert.equal(sha256(receiptBytes), options.receiptSha256.toLowerCase(), "installed-artifact receipt bytes do not match the supplied receipt SHA-256");

  let installRoot;
  try {
    installRoot = await realpath(options.installRoot);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SmokePrerequisiteError(`installed package prefix is absent: ${options.installRoot}`);
    }
    throw error;
  }

  let receiptDocument;
  try {
    receiptDocument = JSON.parse(receiptBytes.toString("utf8"));
  } catch (error) {
    throw new Error("installed-artifact receipt is not valid JSON", { cause: error });
  }
  if (typeof receiptDocument.provenance !== "string" || !path.isAbsolute(receiptDocument.provenance)) {
    throw new Error("installed-artifact receipt has no absolute native provenance path");
  }
  let provenanceBytes;
  try {
    provenanceBytes = await readFile(receiptDocument.provenance);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new SmokePrerequisiteError(`hash-bound native provenance is absent: ${receiptDocument.provenance}`);
    }
    throw error;
  }

  const repositoryRoot = await realpath(REPOSITORY_ROOT);
  assert.equal(isPathInside(repositoryRoot, installRoot), false, "installed prefix resolves into the checkout");
  let serverPackageRoot;
  let cliPackageRoot;
  try {
    [serverPackageRoot, cliPackageRoot] = await Promise.all([
      realpath(receiptPathFor(installRoot, "node_modules/@rudderhq/server")),
      realpath(receiptPathFor(installRoot, "node_modules/@rudderhq/cli")),
    ]);
  } catch (error) {
    if (error?.code === "ENOENT") throw new SmokePrerequisiteError("installed CLI/server packages are incomplete");
    throw error;
  }
  assert.ok(isPathInside(installRoot, serverPackageRoot), "server package escaped the receipt-bound prefix");
  assert.ok(isPathInside(installRoot, cliPackageRoot), "CLI package escaped the receipt-bound prefix");

  const serverMetadata = JSON.parse(await readFile(path.join(serverPackageRoot, "package.json"), "utf8"));
  const cliMetadata = JSON.parse(await readFile(path.join(cliPackageRoot, "package.json"), "utf8"));
  assert.equal(serverMetadata.name, "@rudderhq/server");
  assert.equal(cliMetadata.name, "@rudderhq/cli");
  assert.equal(serverMetadata.version, "0.7.24");
  assert.equal(cliMetadata.version, "0.7.24");

  const serverEntry = path.join(serverPackageRoot, "dist", "index.js");
  const cliEntry = path.join(cliPackageRoot, "dist", "index.js");
  await Promise.all([access(serverEntry, fsConstants.R_OK), access(cliEntry, fsConstants.R_OK)]);
  const canonicalServerEntry = await canonicalInstalledEntry(installRoot, serverEntry);
  const canonicalCliEntry = await canonicalInstalledEntry(installRoot, cliEntry);
  const receiptPackages = new Map((receiptDocument.packages ?? []).map((entry) => [entry.name, entry]));
  const restorations = new Map((receiptDocument.declaredLifecycleModeRestoration ?? []).map((entry) => (
    [`${entry.package}/${entry.path}`, entry]
  )));
  assert.equal(restorations.size, (receiptDocument.declaredLifecycleModeRestoration ?? []).length, "receipt contains duplicate lifecycle mode restorations");
  const archivedEntriesByPackage = new Map();
  const installedPackageMetadata = {};
  for (const receiptPackage of receiptDocument.packages ?? []) {
    assert.match(receiptPackage.name ?? "", /^@rudderhq\/[a-z0-9-]+$/u, "receipt contains an unexpected package name");
    let packageRoot;
    try {
      packageRoot = await realpath(path.join(installRoot, "node_modules", ...receiptPackage.name.split("/")));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new SmokePrerequisiteError(`installed package is absent: ${receiptPackage.name}`);
      }
      throw error;
    }
    assert.ok(isPathInside(installRoot, packageRoot), `${receiptPackage.name} escaped the receipt-bound install prefix`);
    const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.name, receiptPackage.name);
    assert.equal(metadata.version, receiptPackage.version);
    archivedEntriesByPackage.set(receiptPackage.name, await verifyInstalledPackageArchive(receiptPackage, packageRoot, restorations));
    installedPackageMetadata[receiptPackage.name] = metadata;
  }
  const archivedEntrySha256 = (packageName, relativePath) => {
    const entry = archivedEntriesByPackage.get(packageName)?.entries.find((candidate) => candidate.path === relativePath);
    assert.ok(entry?.type === "file", `receipt-bound archive is missing ${packageName}/${relativePath}`);
    return sha256(entry.bytes);
  };
  const cliEntrySha256 = archivedEntrySha256("@rudderhq/cli", "dist/index.js");
  const serverEntrySha256 = archivedEntrySha256("@rudderhq/server", "dist/index.js");
  assert.equal(cliEntrySha256, await hashFile(canonicalCliEntry), "installed CLI entry differs from receipt-bound package archive");
  assert.equal(serverEntrySha256, await hashFile(canonicalServerEntry), "installed server entry differs from receipt-bound package archive");

  const nativeRoot = path.join(serverPackageRoot, "resources", "native");
  let nativeDirectoryEntries;
  try {
    nativeDirectoryEntries = await readdir(nativeRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") throw new SmokePrerequisiteError("installed native target prefix is absent");
    throw error;
  }
  const nativeDirectories = nativeDirectoryEntries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  assert.deepEqual(nativeDirectories, [...SMOKE_NATIVE_TARGETS].sort(), "receipt-bound native package must contain exactly six target directories");
  const hostTargets = SMOKE_NATIVE_TARGETS.filter((target) => targetMatchesHost(target, process.platform, process.arch));
  assert.equal(hostTargets.length, 1, `no unique packaged native target for ${process.platform}/${process.arch}`);
  const nativeEntries = [];
  const nativeTargets = {};
  for (const target of SMOKE_NATIVE_TARGETS) {
    const targetRoot = path.join(nativeRoot, target);
    const serverFoundationPath = path.join(targetRoot, nativeBinaryName(target));
    const migrationPreflightPath = path.join(targetRoot, migrationPreflightName(target));
    for (const [label, filePath] of [["rudder-server-foundation", serverFoundationPath], ["migration-preflight", migrationPreflightPath]]) {
      try {
        await access(filePath, fsConstants.R_OK);
      } catch (error) {
        if (error?.code === "ENOENT") {
          throw new SmokePrerequisiteError(`complete installed native prefix is absent (${target}/${path.basename(filePath)})`);
        }
        throw error;
      }
    }
    if (target === hostTargets[0]) {
      await access(serverFoundationPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
      await access(migrationPreflightPath, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    }
    const canonicalFoundation = await canonicalInstalledEntry(installRoot, serverFoundationPath);
    const canonicalPreflight = await canonicalInstalledEntry(installRoot, migrationPreflightPath);
    const serverFoundation = { entry: receiptRelativePath(installRoot, canonicalFoundation), sha256: await hashFile(canonicalFoundation) };
    const migrationPreflight = { entry: receiptRelativePath(installRoot, canonicalPreflight), sha256: await hashFile(canonicalPreflight) };
    nativeTargets[target] = { serverFoundation, migrationPreflight };
    nativeEntries.push({ target, binaryPath: serverFoundationPath });
  }

  const legacyNativeRoot = path.resolve(path.dirname(serverEntry), "../../..");
  const hostBinaryName = nativeBinaryName(hostTargets[0]);
  for (const mode of ["debug", "release"]) {
    const legacyCandidate = path.join(legacyNativeRoot, "native", "target", mode, hostBinaryName);
    try {
      await access(legacyCandidate, fsConstants.F_OK);
      throw new Error(`unexpected source-layout native binary in installed prefix: ${legacyCandidate}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const installed = {
    coverageMode: "full-package",
    installRoot,
    serverPackageRoot,
    cliPackageRoot,
    serverEntry: canonicalServerEntry,
    cliEntry: canonicalCliEntry,
    nativeEntries,
    hostNativeEntry: nativeEntries.find(({ target }) => target === hostTargets[0]),
    legacyNativeRoot,
  };
  const components = {
    cli: { entry: receiptRelativePath(installRoot, canonicalCliEntry), sha256: cliEntrySha256 },
    server: { entry: receiptRelativePath(installRoot, canonicalServerEntry), sha256: serverEntrySha256 },
    native: { targets: nativeTargets },
  };
  const installedPackages = installedPackageMetadata;
  const { receipt, provenance } = validateInstallReceipt({
    receiptBytes,
    expectedReceiptSha256: options.receiptSha256,
    provenanceBytes,
    expectedProvenanceSha256: options.provenanceSha256,
    expectedSourceSha: options.sourceSha,
    installRoot,
    hostTarget: hostTargets[0],
    components,
    installedPackages,
    packageContentDigests: Object.fromEntries([...archivedEntriesByPackage].map(([name, value]) => [name, value.digest])),
  });
  return {
    ...installed,
    receiptSha256: sha256(receiptBytes),
    provenanceSha256: sha256(provenanceBytes),
    sourceSha: receipt.source,
    productTree: receipt.productTree,
    ciRunId: provenance.ci,
    components,
  };
}

function appendLog(logs, stream, chunk) {
  logs[stream] = `${logs[stream]}${chunk}`.slice(-MAX_LOG_BYTES);
}

function logTail(filename) {
  const descriptor = openSync(filename, "r");
  try {
    const size = fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(size, MAX_LOG_BYTES));
    const count = readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
    return buffer.subarray(0, count).toString("utf8");
  } finally { closeSync(descriptor); }
}

export function startServer(serverEntry, cwd, env, ownerId) {
  const safeId = ownerId.replace(/[^a-zA-Z0-9_-]/gu, "_");
  const logPaths = {
    stdout: path.join(cwd, `${safeId}.stdout.log`),
    stderr: path.join(cwd, `${safeId}.stderr.log`),
  };
  // Child-owned file descriptors survive a recorded parent handoff. Do not
  // leave pipe lifetimes attached to a runner that may finish with QUESTION.
  const stdout = openSync(logPaths.stdout, "wx", 0o600);
  let stderr;
  let child;
  try {
    stderr = openSync(logPaths.stderr, "wx", 0o600);
    child = spawn(process.execPath, [serverEntry], {
      cwd, env, stdio: ["ignore", stdout, stderr], windowsHide: true,
    });
  } finally {
    closeSync(stdout);
    if (stderr !== undefined) closeSync(stderr);
  }
  const logs = { stdout: "", stderr: "" };
  const refreshLogs = () => {
    try {
      logs.stdout = logTail(logPaths.stdout);
      logs.stderr = logTail(logPaths.stderr);
    } catch (error) {
      logs.observationError = error;
    }
  };
  const poll = setInterval(refreshLogs, 50);
  child.on("error", (error) => appendLog(logs, "stderr", `${error.stack ?? error}\n`));
  child.once("close", () => {
    clearInterval(poll);
    refreshLogs();
    closedChildren.add(child);
  });
  return { owner: SMOKE_OWNER, ownerId, child, logs, logPaths,
    refreshLogs, stopObservingLogs: () => clearInterval(poll), termRequested: false, stopPromise: null };
}

async function recordUnresolvedChild(child, runRoot, ownerId, kind) {
  const receipt = await persistOwnedProcessHandoff({
    directory: runRoot, child, ownerId, kind,
    sourceSha: EXPECTED_SOURCE_SHA, supportSha256: sha256(await readFile(SCRIPT_PATH)),
    reason: "shutdown_unverified",
  });
  console.error(`[installed-public-ingress] HELD_UNRESOLVED handoff: ${JSON.stringify(receipt)}`);
  await detachAfterRecordedHandoff(child, receipt);
  return receipt;
}

export function waitForExit(child, timeoutMs) {
  if (closedChildren.has(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const onClose = (code, signal) => {
      clearTimeout(timer);
      closedChildren.add(child);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      reject(new Error(`owned server process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("close", onClose);
  });
}

async function stopOwnedServer(runtime, timeoutMs = 20_000) {
  if (!runtime) return;
  if (runtime.stopPromise) return await runtime.stopPromise;
  requestOwnedTermination(runtime, runtime.ownerId);
  runtime.stopPromise = (async () => {
    return await waitForExit(runtime.child, timeoutMs);
  })();
  return await runtime.stopPromise;
}

function delay(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
    const onAbort = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function portIsListening(port, timeoutMs = 500) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new SmokeQuestionError("owned port observation timed out; absence is unproven"));
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new SmokeQuestionError("owned port observation unavailable", { cause: error }));
    });
  });
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await portIsListening(port, Math.max(1, Math.min(500, deadline - Date.now())))) return;
    await delay(Math.max(1, Math.min(50, deadline - Date.now())));
  }
  throw new Error(`owned listener port ${port} remained open after supervised shutdown`);
}

function safeText(value, secret) {
  return String(value)
    .replaceAll(secret ?? "\u0000", "[redacted]")
    .replace(/pcp_[a-f0-9]{48}/giu, "[redacted-api-key]");
}

async function jsonResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

export async function fetchJson(url, init = {}, { signal, timeoutMs = 30_000 } = {}) {
  signal?.throwIfAborted();
  // Keep the abort signal alive through body consumption, not only headers.
  const boundedSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  return await jsonResponse(await fetch(url, { ...init, signal: boundedSignal }));
}

function briefBody(body) {
  if (!body || typeof body !== "object") return body;
  const { token: _token, apiKey: _apiKey, secret: _secret, ...safe } = body;
  return safe;
}

function assertStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(briefBody(result.body))}`);
}

async function waitForHealth(runtime, publicUrl, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (runtime.logs.observationError) throw new SmokeQuestionError("owned runtime log observation failed", { cause: runtime.logs.observationError });
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`installed server exited before public health (${runtime.child.exitCode ?? runtime.child.signalCode})`);
    }
    try {
      const response = await fetchJson(`${publicUrl}/api/health`, {}, { signal, timeoutMs: 1_000 });
      if (response.status === 200) return response;
    } catch {
      // Public readiness can lag while embedded PostgreSQL and migrations start.
    }
    await delay(100, signal);
  }
  throw new Error(`installed public health timed out\n${safeText(runtime.logs.stderr)}`);
}

async function waitForPrivatePort(runtime, publicPort, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  const listenPattern = /Server listening on 127\.0\.0\.1:(\d+)/gu;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (runtime.logs.observationError) throw new SmokeQuestionError("owned runtime log observation failed", { cause: runtime.logs.observationError });
    const logs = `${runtime.logs.stdout}\n${runtime.logs.stderr}`;
    const matches = [...logs.matchAll(listenPattern)];
    const port = Number(matches.at(-1)?.[1]);
    if (Number.isInteger(port) && port > 0 && port !== publicPort) return port;
    if (runtime.child.exitCode !== null || runtime.child.signalCode !== null) {
      throw new Error(`installed server exited before private listener readiness (${runtime.child.exitCode ?? runtime.child.signalCode})`);
    }
    await delay(50, signal);
  }
  throw new Error(`private Node listener identity was not logged\n${safeText(runtime.logs.stdout)}\n${safeText(runtime.logs.stderr)}`);
}

async function createOrganization(apiUrl, name, issuePrefix, work) {
  const result = await fetchJson(`${apiUrl}/api/orgs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, issuePrefix, requireBoardApprovalForNewAgents: false }),
  }, work);
  assertStatus(result, 201, "create disposable organization");
  assert.match(result.body.id, /^[0-9a-f-]{36}$/iu);
  return result.body.id;
}

async function createAgent(apiUrl, orgId, name, work) {
  const result = await fetchJson(`${apiUrl}/api/orgs/${orgId}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      role: "engineer",
      agentRuntimeType: "process",
      agentRuntimeConfig: {},
    }),
  }, work);
  assertStatus(result, 201, "create disposable agent");
  assert.match(result.body.id, /^[0-9a-f-]{36}$/iu);
  return result.body.id;
}

async function createAgentKey(apiUrl, agentId, work) {
  const result = await fetchJson(`${apiUrl}/api/agents/${agentId}/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "installed-public-ingress-smoke" }),
  }, work);
  assertStatus(result, 201, "create disposable agent key");
  assert.match(result.body.token, /^pcp_[a-f0-9]{48}$/u);
  return result.body.token;
}

export async function waitForCliClose(child, timeoutMs, signal, handoff) {
  const close = new Promise((resolve, reject) => {
    child.once("close", (code, terminationSignal) => { closedChildren.add(child); resolve({ code, signal: terminationSignal }); });
    child.once("error", reject);
  });
  let cancellation;
  let cancelResolve;
  const cancelled = new Promise((resolve) => { cancelResolve = resolve; });
  const cancel = (reason) => { cancellation ??= reason; cancelResolve(); };
  const onAbort = () => cancel(signal.reason);
  const timer = setTimeout(() => cancel(new Error("installed CLI timed out")), timeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const outcome = await Promise.race([close, cancelled]);
    if (!cancellation) return outcome;
    if (!closedChildren.has(child)) child.kill("SIGTERM");
    try {
      await waitForExit(child, 2_000);
    } catch {
      // The CLI is an exact owned, short-lived read process, never the server/PG supervisor.
      if (!closedChildren.has(child)) child.kill("SIGKILL");
      try { await waitForExit(child, 2_000); }
      catch (error) {
        if (handoff) await handoff(child);
        throw new SmokeQuestionError(`owned installed CLI shutdown unverified pid=${child.pid}; retain profile and held lease`, { cause: error });
      }
    }
    throw cancellation;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function runInstalledCliMemberRead(cliEntry, runRoot, apiUrl, orgId, agentKey, agentName, timeoutMs, signal) {
  signal?.throwIfAborted();
  const invocation = buildInstalledCliInvocation(cliEntry, runRoot, apiUrl, orgId, agentKey, agentName);
  const child = spawn(process.execPath, invocation.args, {
    cwd: runRoot,
    env: invocation.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(-MAX_LOG_BYTES); });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-MAX_LOG_BYTES); });
  const result = { ...await waitForCliClose(child, timeoutMs, signal,
    (unresolved) => recordUnresolvedChild(unresolved, runRoot, `${path.basename(runRoot)}:cli`, "cli")), stdout, stderr };
  assert.equal(result.code, 0, `installed CLI member read failed: ${safeText(result.stderr, agentKey)} ${safeText(result.stdout, agentKey)}`);
  const page = JSON.parse(result.stdout);
  assert.ok(page.items.some((member) => member.name === agentName), "installed CLI did not return the disposable member through public ingress");
  return page;
}

async function websocketHandshake(url, authorization, timeoutMs, signal) {
  signal?.throwIfAborted();
  const headers = {
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": randomBytes(16).toString("base64"),
  };
  if (authorization) headers.authorization = authorization;
  const requestUrl = new URL(url);
  requestUrl.protocol = requestUrl.protocol === "wss:" ? "https:" : "http:";
  return await new Promise((resolve, reject) => {
    const request = http.request(requestUrl, { method: "GET", headers, signal });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      request.destroy(new Error(`websocket handshake timed out for ${url}`));
    }, timeoutMs);
    request.once("response", (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => finish({
        upgraded: false,
        statusCode: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      finish({ upgraded: true, statusCode: response.statusCode, body: "" });
    });
    request.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    request.end();
  });
}

function websocketUrl(baseUrl, orgId) {
  return `${baseUrl.replace(/^http:/u, "ws:")}/api/orgs/${encodeURIComponent(orgId)}/events/ws`;
}

async function openAuthenticatedWebSocket(WebSocket, url, agentKey, timeoutMs, signal) {
  signal?.throwIfAborted();
  const socket = new WebSocket(url, {
    headers: { authorization: `Bearer ${agentKey}` },
    handshakeTimeout: timeoutMs,
  });
  await new Promise((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      clear();
      socket.terminate();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      clear();
      socket.terminate();
      reject(new Error("authenticated public websocket did not open in time"));
    }, timeoutMs);
    socket.once("open", () => {
      clear();
      resolve();
    });
    socket.once("unexpected-response", (_request, response) => {
      clear();
      socket.terminate();
      reject(new Error(`authenticated public websocket rejected with ${response.statusCode}`));
    });
    socket.once("error", (error) => {
      clear();
      reject(error);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  return socket;
}

export function waitForIssueCreatedFrame(socket, expected, timeoutMs, signal) {
  let finishWait;
  let timer;
  const promise = new Promise((resolve, reject) => {
    const finish = (error, event) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(event);
    };
    const onMessage = (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch (error) {
        finish(new Error("public websocket sent a non-JSON event frame", { cause: error }));
        return;
      }
      if (event.orgId !== expected.orgId) {
        finish(new Error(`public websocket crossed organization boundary (${event.orgId})`));
        return;
      }
      if (isExpectedIssueCreatedFrame(event, expected)) {
        finish(null, event);
      }
    };
    const onClose = () => finish(new Error("public websocket closed before the activity frame arrived"));
    const onError = (error) => finish(error);
    const onAbort = () => finish(signal.reason);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
    finishWait = finish;
    timer = setTimeout(() => finish(new Error("activity.logged issue.created frame did not arrive before timeout")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  void promise.catch(() => undefined);
  return {
    promise,
    cancel() {
      finishWait?.(new Error("activity frame wait cancelled during smoke cleanup"));
    },
  };
}

async function closeWebSocket(socket, timeoutMs) {
  if (!socket || socket.readyState === socket.CLOSED) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("public websocket did not close cleanly"));
    }, timeoutMs);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close(1000, "installed smoke complete");
  });
}

export async function finishWorkflowWork(workflow, socket) {
  workflow.signal.throwIfAborted();
  await closeWebSocket(socket, workflow.stepTimeout(5_000));
  // Cancellation while the final close is pending must never produce PASS.
  workflow.signal.throwIfAborted();
  workflow.stepTimeout(1);
}

async function createIssue(apiUrl, orgId, agentKey, title, work) {
  const result = await fetchJson(`${apiUrl}/api/orgs/${orgId}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title,
      description: "Disposable installed Actix public ingress smoke issue.",
      status: "todo",
      priority: "high",
      assigneeAgentId: null,
    }),
  }, work);
  assertStatus(result, 201, "public Issue creation");
  const issue = assertCreatedIssueResponse(result.body);
  const readback = await fetchJson(`${apiUrl}/api/issues/${issue.id}`, {
    headers: { authorization: `Bearer ${agentKey}` },
  }, work);
  assertStatus(readback, 200, "public persisted Issue readback");
  assert.equal(readback.body.id, issue.id);
  assert.equal(readback.body.orgId, orgId);
  assert.equal(readback.body.title, title);
  console.log(`[installed-public-ingress] persisted Issue: ${JSON.stringify({
    postStatus: result.status, readStatus: readback.status, id: issue.id, orgId, title,
  })}`);
  return issue;
}

export function assertReconnectActivityAfter(firstEvent, secondEvent) {
  assert.notEqual(secondEvent.payload?.entityId, firstEvent.payload?.entityId, "reconnected subscription did not observe the distinct Issue");
  assert.ok(
    Number.isSafeInteger(firstEvent.id)
      && Number.isSafeInteger(secondEvent.id)
      && secondEvent.id > firstEvent.id,
    "same-process reconnect did not observe a later live-event sequence id",
  );
}

function ownedRustPid(runtime) {
  const match = `${runtime.logs.stdout}\n${runtime.logs.stderr}`
    .match(/\[rudder-rust-bridge\] started pid=(\d+)/u);
  assert.ok(match, "installed server did not report its supervised Rust child startup");
  return match[1];
}

async function recordListenerOwnership(runtime, publicPort, privatePort, rustExecutable, signal) {
  try {
    const identity = await assertInstalledListenerOwnership({
      publicPort,
      privatePort,
      rustPid: Number(ownedRustPid(runtime)),
      nodePid: runtime.child.pid,
      rustExecutable,
      nodeExecutable: process.execPath,
      nodeParentPid: process.pid,
    }, { signal });
    console.log(`[installed-public-ingress] listener ownership: ${JSON.stringify(identity)}`);
    return identity;
  } catch (error) {
    if (error instanceof ListenerObservationUnavailable) {
      throw new SmokeQuestionError(error.message, { cause: error });
    }
    throw error;
  }
}

export async function stopAndAssertRustListenerExited(runtime, ports, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pid = `${runtime.logs.stdout}\n${runtime.logs.stderr}`
    .match(/\[rudder-rust-bridge\] started pid=(\d+)/u)?.[1];
  // Always stop the exact owned supervisor, even when startup never logged Rust.
  await stopOwnedServer(runtime, Math.min(timeoutMs, 20_000));
  await Promise.all(ports.filter(Number.isInteger).map((port) =>
    waitForPortClosed(port, Math.max(1, Math.min(8_000, deadline - Date.now())))));
  if (!pid) {
    throw new SmokeQuestionError("Owned supervisor stopped but Rust startup identity was never observed; retain the disposable profile");
  }
  const logs = `${runtime.logs.stdout}\n${runtime.logs.stderr}`;
  assertSupervisedRustChildExit(runtime.logs, pid);
}

async function runSmoke(options) {
  const workflow = createWorkflowDeadline({ totalTimeoutMs: options.totalTimeoutMs });
  try {
    const installed = await inspectReceiptFile(options);
    workflow.signal.throwIfAborted();
    await runInstalledWorkflow(options, installed, workflow);
  } finally {
    workflow.dispose();
  }
}

async function runInstalledWorkflow(options, installed, workflow) {
  const signal = workflow.signal;
  const step = () => workflow.stepTimeout(options.timeoutMs);
  const work = { signal, timeoutMs: Math.min(options.timeoutMs, 30_000) };
  const runRoot = await mkdtemp(path.join(os.tmpdir(), "rudder-installed-public-ingress."));
  const runId = randomUUID();
  const publicPort = await freePort();
  const databasePort = await freePort();
  const publicUrl = `http://127.0.0.1:${publicPort}`;
  const profile = path.join(runRoot, "profile");
  await mkdir(profile, { recursive: true });
  const baseEnv = process.env;
  const baseInput = {
    profile,
    publicPort,
    databasePort,
    instanceId: `installed-public-ingress-${runId}`,
    jwtSecret: randomUUID(),
  };
  let runtime = null;
  let activeSocket = null;
  let serverStarted = false;
  let shutdownVerified = false;
  let primaryError = null;
  let cleanupError = null;
  let finalVerdict = "FAIL";

  try {
    signal.throwIfAborted();
    console.log(`[installed-public-ingress] install prefix: ${installed.installRoot}`);
    console.log(`[installed-public-ingress] source SHA: ${installed.sourceSha}; receipt SHA-256: ${installed.receiptSha256}`);
    console.log(`[installed-public-ingress] native provenance SHA-256: ${installed.provenanceSha256}; CI run: ${installed.ciRunId}`);
    console.log(`[installed-public-ingress] installed CLI/server entry SHA-256: ${installed.components.cli.sha256} ${installed.components.server.sha256}`);
    console.log(`[installed-public-ingress] host native: ${installed.hostNativeEntry.target}; profile: disposable under ${runRoot}`);

    let env = buildServerEnvironment(baseEnv, { ...baseInput, deploymentMode: "local_trusted" });
    runtime = startServer(installed.serverEntry, runRoot, env, `${runId}:bootstrap`);
    serverStarted = true;
    shutdownVerified = false;
    await waitForHealth(runtime, publicUrl, step(), signal);
    const privatePort = await waitForPrivatePort(runtime, publicPort, step(), signal);
    await recordListenerOwnership(runtime, publicPort, privatePort, installed.hostNativeEntry.binaryPath, signal);
    const orgId = await createOrganization(publicUrl, `Installed ingress ${runId.slice(0, 8)}`, "IIS", work);
    const foreignOrgId = await createOrganization(publicUrl, `Installed ingress foreign ${runId.slice(0, 8)}`, "IIF", work);
    const agentName = `Installed ingress member ${runId.slice(0, 8)}`;
    const agentId = await createAgent(publicUrl, orgId, agentName, work);
    const agentKey = await createAgentKey(publicUrl, agentId, work);
    console.log(`[installed-public-ingress] fixture identity: ${JSON.stringify({ runId, profile, publicUrl, orgId, foreignOrgId, agentId })}`);
    await stopAndAssertRustListenerExited(runtime, [publicPort, privatePort, databasePort], step());
    runtime = null;
    shutdownVerified = true;

    signal.throwIfAborted();
    env = buildServerEnvironment(baseEnv, { ...baseInput, deploymentMode: "authenticated" });
    runtime = startServer(installed.serverEntry, runRoot, env, `${runId}:authenticated`);
    shutdownVerified = false;
    const health = await waitForHealth(runtime, publicUrl, step(), signal);
    assert.equal(health.status, 200, "public Actix health did not return HTTP 200");
    const authenticatedPrivatePort = await waitForPrivatePort(runtime, publicPort, step(), signal);
    await recordListenerOwnership(runtime, publicPort, authenticatedPrivatePort, installed.hostNativeEntry.binaryPath, signal);

    const cliMembers = await runInstalledCliMemberRead(
      installed.cliEntry,
      runRoot,
      publicUrl,
      orgId,
      agentKey,
      agentName,
      step(), signal,
    );
    assert.ok(cliMembers.items.length > 0);
    const foreignMemberRead = await fetchJson(
      `${publicUrl}/api/orgs/${foreignOrgId}/members/directory?limit=1`,
      { headers: { authorization: `Bearer ${agentKey}` } },
      work,
    );
    assertStatus(foreignMemberRead, 403, "public member read across organizations");

    const publicNoAuth = await websocketHandshake(websocketUrl(publicUrl, orgId), null, step(), signal);
    assertWebSocketRejection(publicNoAuth, "upstream_websocket_rejected");
    const privateNoAuth = await websocketHandshake(
      websocketUrl(`http://127.0.0.1:${authenticatedPrivatePort}`, orgId),
      null,
      step(), signal,
    );
    assertWebSocketRejection(privateNoAuth, "forbidden");

    const requireFromInstalledServer = createRequire(installed.serverEntry);
    const { WebSocket } = requireFromInstalledServer("ws");
    const foreignPublicSocket = await websocketHandshake(
      websocketUrl(publicUrl, foreignOrgId),
      `Bearer ${agentKey}`,
      step(), signal,
    );
    assertWebSocketRejection(foreignPublicSocket, "upstream_websocket_rejected");
    const foreignPrivateSocket = await websocketHandshake(
      websocketUrl(`http://127.0.0.1:${authenticatedPrivatePort}`, foreignOrgId),
      `Bearer ${agentKey}`,
      step(), signal,
    );
    assertWebSocketRejection(foreignPrivateSocket, "forbidden");

    activeSocket = await openAuthenticatedWebSocket(
      WebSocket,
      websocketUrl(publicUrl, orgId),
      agentKey,
      step(), signal,
    );
    const firstIssueTitle = `Installed ingress event one ${runId.slice(0, 8)}`;
    const firstEventWaiter = waitForIssueCreatedFrame(
      activeSocket,
      { orgId, title: firstIssueTitle },
      step(), signal,
    );
    let firstIssue;
    let firstEvent;
    try {
      firstIssue = await createIssue(publicUrl, orgId, agentKey, firstIssueTitle, work);
      firstEvent = await firstEventWaiter.promise;
    } finally {
      firstEventWaiter.cancel();
    }
    assertActivityLoggedFrame(firstEvent, { orgId, issueId: firstIssue.id });
    assert.equal(firstEvent.payload.action, "issue.created");
    console.log(`[installed-public-ingress] first event: ${JSON.stringify(firstEvent)}`);
    await finishWorkflowWork(workflow, activeSocket);
    activeSocket = null;

    // Live events expose a fresh organization subscription on reconnect; no replay cursor is defined.
    activeSocket = await openAuthenticatedWebSocket(
      WebSocket,
      websocketUrl(publicUrl, orgId),
      agentKey,
      step(), signal,
    );
    const secondIssueTitle = `Installed ingress event two ${runId.slice(0, 8)}`;
    const secondEventWaiter = waitForIssueCreatedFrame(
      activeSocket,
      { orgId, title: secondIssueTitle },
      step(), signal,
    );
    let secondIssue;
    let secondEvent;
    try {
      secondIssue = await createIssue(publicUrl, orgId, agentKey, secondIssueTitle, work);
      secondEvent = await secondEventWaiter.promise;
    } finally {
      secondEventWaiter.cancel();
    }
    assertActivityLoggedFrame(secondEvent, { orgId, issueId: secondIssue.id });
    assertReconnectActivityAfter(firstEvent, secondEvent);
    console.log(`[installed-public-ingress] reconnect event: ${JSON.stringify(secondEvent)}`);
    await finishWorkflowWork(workflow, activeSocket);
    activeSocket = null;

    console.log("[installed-public-ingress] public health and installed CLI member read passed; foreign organization read denied");
    console.log("[installed-public-ingress] public 403 upstream_websocket_rejected and private 403 forbidden matched the Actix/Node auth boundary");
    console.log("[installed-public-ingress] public Issue POST emitted organization-scoped activity.logged across an authenticated reconnect");
    console.log("[installed-public-ingress] foreign-organization WebSocket was denied at both public and private ingress");

    signal.throwIfAborted();
    step();
    finalVerdict = "PASS";
  } catch (error) {
    primaryError = error;
  } finally {
    workflow.beginCleanup();
    const cleanupTimeout = (ms) => Math.max(1, Math.min(ms, workflow.remainingMs()));
    if (activeSocket) await closeWebSocket(activeSocket, cleanupTimeout(5_000)).catch(() => activeSocket.terminate());
    if (runtime) {
      const logs = `${runtime.logs.stdout}\n${runtime.logs.stderr}`;
      const portMatch = logs.match(/Server listening on 127\.0\.0\.1:(\d+)/u);
      try {
        await stopAndAssertRustListenerExited(
          runtime,
          [publicPort, Number(portMatch?.[1]), databasePort],
          cleanupTimeout(28_000),
        );
        runtime = null;
        shutdownVerified = true;
      } catch (error) {
        cleanupError = error;
        console.error(`[installed-public-ingress] cleanup: ${safeText(error.stack ?? error)}`);
        console.error(`[installed-public-ingress] unresolved owned supervisor PID: ${runtime.child.pid}; profile retained; do not open another runtime lease`);
        if (!closedChildren.has(runtime.child)) {
          runtime.stopObservingLogs?.();
          await recordUnresolvedChild(runtime.child, runRoot, runtime.ownerId, "server");
        }
        finalVerdict = "QUESTION";
      }
    }
    if (shouldRetainSmokeProfile({ keepTemp: options.keepTemp || primaryError instanceof SmokeQuestionError, runtime, serverStarted, shutdownVerified })) {
      console.log(`[installed-public-ingress] kept disposable profile: ${runRoot}`);
    } else {
      await rm(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
  }

  if (!canRemoveSmokeProfile({ runtime, serverStarted, shutdownVerified })) {
    throw new SmokeQuestionError(`owned server shutdown was not verified; retained profile/database at ${runRoot}`, { cause: cleanupError ?? primaryError ?? undefined });
  }
  if (cleanupError) {
    throw new SmokeQuestionError(`owned server cleanup needs review; retained profile/database at ${runRoot}`, { cause: cleanupError });
  }
  if (primaryError) throw primaryError;
  if (workflow.externalCancellationReason) throw workflow.externalCancellationReason;
  if (workflow.remainingMs() <= 0) throw new Error("total workflow deadline exceeded after owned teardown");
  assert.equal(finalVerdict, "PASS", "installed public ingress workflow did not complete cleanly");
  console.log("[installed-public-ingress] PASS: exact receipt-bound installed CLI/server/native public workflow");
}

function usage() {
  console.error(
    "Usage: node scripts/smoke/installed-public-ingress.mjs --install-root <receipt-prefix> --receipt <installed-receipt-v2.json> --receipt-sha256 <sha256> --provenance-sha256 <sha256> --source-sha <40-hex-commit> [--keep-temp] [--timeout-ms <ms>] [--total-timeout-ms <ms>]",
  );
  console.error(`Receipt contract: ${RECEIPT_SCHEMA}; native provenance independently binds both executables for all six targets.`);
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof SmokeQuestionError) {
      console.error(`[installed-public-ingress] QUESTION: ${safeText(error.message)}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof SmokePrerequisiteError) {
      console.log(`[installed-public-ingress] NOT_RUN: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    usage();
    throw error;
  }
  if (options.help) {
    usage();
    return;
  }
  try {
    await runSmoke(options);
  } catch (error) {
    if (error instanceof SmokeQuestionError) {
      console.error(`[installed-public-ingress] QUESTION: ${safeText(error.message)}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof SmokePrerequisiteError) {
      console.log(`[installed-public-ingress] NOT_RUN: ${error.message}`);
      process.exitCode = 2;
      return;
    }
    console.error(`[installed-public-ingress] FAIL: ${safeText(error?.stack ?? error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
