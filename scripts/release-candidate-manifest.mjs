#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export const CANDIDATE_MANIFEST_VERSION = 1;
export const EXPECTED_NPM_ARTIFACT_COUNT = 15;
export const EXPECTED_WORKFLOW_PATH = ".github/workflows/release.yml";
export const EXPECTED_DESKTOP_IDENTITIES = Object.freeze([
  "macos/x64/portable",
  "macos/x64/shell",
  "macos/arm64/portable",
  "macos/arm64/shell",
  "windows/x64/portable",
  "windows/x64/shell",
  "linux/x64/portable",
]);
export const EXPECTED_DESKTOP_ARTIFACT_COUNT = EXPECTED_DESKTOP_IDENTITIES.length;
export const EXPECTED_RUNTIME = Object.freeze({
  nodeMajor: 24,
  pnpm: "pnpm@9.15.4",
  rust: "dtolnay/rust-toolchain@stable",
  packaging: "electron-builder via pnpm desktop:dist",
});

const FULL_SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[0-9]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function requireValue(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function requireSha(value, label) {
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be a full lowercase commit SHA`);
  return value;
}

function requireRunId(value, label) {
  if (!RUN_ID.test(String(value))) throw new Error(`${label} must be a numeric GitHub Actions run ID`);
  return String(value);
}

function requireVersion(value) {
  if (!VERSION.test(value)) throw new Error(`version must be a semver value: ${value}`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateRuntime(runtime, label = "runtime") {
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error(`${label} must be a JSON object`);
  }
  if (typeof runtime.node !== "string" || !/^v24\./.test(runtime.node)) {
    throw new Error(`${label} must use Node 24`);
  }
  if (runtime.nodeMajor !== EXPECTED_RUNTIME.nodeMajor) {
    throw new Error(`${label} nodeMajor does not match the expected runtime`);
  }
  for (const [key, expected] of Object.entries(EXPECTED_RUNTIME)) {
    if (runtime[key] !== expected) throw new Error(`${label} ${key} does not match the expected runtime`);
  }
  if (typeof runtime.electron !== "string" || runtime.electron.length === 0) {
    throw new Error(`${label} electron identity is required`);
  }
  return runtime;
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function artifactPath(directory, filename) {
  const root = resolve(directory);
  const path = resolve(root, filename);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error(`Artifact filename escapes its directory: ${filename}`);
  }
  return path;
}

function describeFile(directory, filename) {
  const path = artifactPath(directory, filename);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Missing candidate artifact: ${path}`);
  return {
    filename,
    size: statSync(path).size,
    sha256: sha256(path),
  };
}

function parseNpmManifest(npmDir) {
  const manifestPath = artifactPath(npmDir, "manifest.tsv");
  if (!existsSync(manifestPath)) throw new Error(`Missing npm candidate manifest: ${manifestPath}`);
  const rows = readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const fields = line.split("\t");
      if (fields.length !== 4 || fields.some((field) => field.length === 0)) {
        throw new Error(`Invalid npm candidate manifest row ${index + 1}`);
      }
      const [name, version, filename, digest] = fields;
      if (!/^@?[A-Za-z0-9._/-]+$/.test(name)) throw new Error(`Invalid npm package name: ${name}`);
      if (!VERSION.test(version)) throw new Error(`Invalid npm package version: ${version}`);
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid npm artifact digest: ${filename}`);
      if (basename(filename) !== filename) throw new Error(`npm artifact must be a flat file: ${filename}`);
      const artifact = describeFile(npmDir, filename);
      if (artifact.sha256 !== digest) throw new Error(`npm artifact digest mismatch: ${filename}`);
      return { name, version, ...artifact };
    });

  if (rows.length !== EXPECTED_NPM_ARTIFACT_COUNT) {
    throw new Error(`Expected ${EXPECTED_NPM_ARTIFACT_COUNT} npm artifacts, found ${rows.length}`);
  }
  if (new Set(rows.map((row) => row.filename)).size !== rows.length) {
    throw new Error("npm candidate manifest contains duplicate filenames");
  }
  return rows;
}

function parseDesktopVersion(filename) {
  const match = filename.match(/^Rudder-(.+)-(macos|windows|linux)-(x64|arm64)(?:-(portable|shell))?\.(zip|AppImage)$/);
  if (!match) throw new Error(`Unexpected Desktop candidate filename: ${filename}`);
  return { version: match[1], platform: match[2], arch: match[3], kind: match[4] ?? "portable" };
}

function writeChecksumFile(desktopDir, files) {
  const checksumPath = artifactPath(desktopDir, "SHASUMS256.txt");
  const contents = files
    .map((file) => `${file.sha256}  ${file.filename}`)
    .sort((a, b) => a.localeCompare(b))
    .join("\n") + "\n";
  writeFileSync(checksumPath, contents);
  return describeFile(desktopDir, "SHASUMS256.txt");
}

function parseDesktopManifest(desktopDir, version) {
  const filenames = readdirSync(desktopDir)
    .filter((filename) => filename.startsWith("Rudder-") && filename !== "SHASUMS256.txt")
    .sort();
  if (filenames.length !== EXPECTED_DESKTOP_ARTIFACT_COUNT) {
    throw new Error(`Expected ${EXPECTED_DESKTOP_ARTIFACT_COUNT} Desktop artifacts, found ${filenames.length}`);
  }

  const files = filenames.map((filename) => {
    const details = parseDesktopVersion(filename);
    if (details.version !== version) throw new Error(`Desktop artifact version mismatch: ${filename}`);
    if (details.platform === "linux" && details.kind !== "portable") {
      throw new Error(`Linux Desktop candidate must be portable: ${filename}`);
    }
    return { ...details, ...describeFile(desktopDir, filename) };
  });
  const identities = new Set(files.map((file) => `${file.platform}/${file.arch}/${file.kind}`));
  if (identities.size !== files.length) throw new Error("Desktop candidate contains duplicate platform identities");
  const expectedIdentities = [...EXPECTED_DESKTOP_IDENTITIES].sort((a, b) => a.localeCompare(b));
  const actualIdentities = [...identities].sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(actualIdentities) !== JSON.stringify(expectedIdentities)) {
    throw new Error(`Desktop candidate identities do not match the expected set: ${actualIdentities.join(", ")}`);
  }
  return files;
}

function assertChecksumFile(desktopDir, desktop, checksum) {
  const lines = readFileSync(artifactPath(desktopDir, checksum.filename), "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  const expected = desktop
    .map((file) => `${file.sha256}  ${file.filename}`)
    .sort((a, b) => a.localeCompare(b));
  if (JSON.stringify(lines) !== JSON.stringify(expected)) {
    throw new Error("Desktop checksum file does not match candidate artifact digests");
  }
}

export function createCandidateManifest({
  sourceSha,
  sourceTreeSha,
  version,
  qualificationRunId,
  qualificationConclusion = "success",
  candidateRunId,
  workflowPath = EXPECTED_WORKFLOW_PATH,
  workflowSourceSha,
  workflowRef = "main",
  runtime = {},
  npmDir,
  desktopDir,
  retentionDays = 7,
  now = new Date(),
}) {
  requireSha(sourceSha, "sourceSha");
  requireSha(sourceTreeSha, "sourceTreeSha");
  requireVersion(version);
  requireRunId(qualificationRunId, "qualificationRunId");
  requireRunId(candidateRunId, "candidateRunId");
  requireSha(workflowSourceSha, "workflowSourceSha");
  requireValue(npmDir, "npmDir");
  requireValue(desktopDir, "desktopDir");
  if (workflowPath !== EXPECTED_WORKFLOW_PATH) throw new Error(`Unexpected workflow path: ${workflowPath}`);
  if (workflowRef !== "main") throw new Error(`Candidate workflow must run from main: ${workflowRef}`);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) {
    throw new Error("retentionDays must be an integer between 1 and 90");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");

  validateRuntime(runtime);
  const npm = parseNpmManifest(npmDir);
  const desktop = parseDesktopManifest(desktopDir, version);
  const checksum = writeChecksumFile(desktopDir, desktop);
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000).toISOString();

  return {
    schemaVersion: CANDIDATE_MANIFEST_VERSION,
    source: { commitSha: sourceSha, treeSha: sourceTreeSha },
    release: { version },
    qualification: { runId: String(qualificationRunId), conclusion: qualificationConclusion },
    candidate: {
      runId: String(candidateRunId),
      workflow: { path: workflowPath, sourceSha: workflowSourceSha, ref: workflowRef },
      createdAt,
      expiresAt,
      retentionDays,
    },
    runtime: { ...runtime },
    artifacts: {
      npm,
      desktop,
      checksum,
    },
  };
}

function assertArtifactEqual(expected, actual, label) {
  if (actual.filename !== expected.filename || actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    throw new Error(`${label} does not match candidate manifest: ${expected.filename}`);
  }
}

function verifyNpmArtifacts(manifest, npmDir) {
  const actual = parseNpmManifest(npmDir);
  if (actual.length !== manifest.artifacts.npm.length) throw new Error("npm artifact count changed after candidate creation");
  for (const expected of manifest.artifacts.npm) {
    const found = actual.find((artifact) => artifact.filename === expected.filename && artifact.name === expected.name && artifact.version === expected.version);
    if (!found) throw new Error(`npm candidate artifact is missing or changed: ${expected.filename}`);
    assertArtifactEqual(expected, found, "npm artifact");
  }
}

function verifyDesktopArtifacts(manifest, desktopDir) {
  const actual = parseDesktopManifest(desktopDir, manifest.release.version);
  if (actual.length !== manifest.artifacts.desktop.length) throw new Error("Desktop artifact count changed after candidate creation");
  for (const expected of manifest.artifacts.desktop) {
    const found = actual.find((artifact) => artifact.filename === expected.filename && artifact.platform === expected.platform && artifact.arch === expected.arch && artifact.kind === expected.kind);
    if (!found) throw new Error(`Desktop candidate artifact is missing or changed: ${expected.filename}`);
    assertArtifactEqual(expected, found, "Desktop artifact");
  }
  const checksum = describeFile(desktopDir, manifest.artifacts.checksum.filename);
  assertArtifactEqual(manifest.artifacts.checksum, checksum, "Desktop checksum");
  assertChecksumFile(desktopDir, actual, checksum);
}

export function verifyCandidateManifest({
  manifest,
  sourceSha,
  version,
  candidateRunId,
  qualificationRunId,
  npmDir,
  desktopDir,
  runtimeFile,
  sourceTreeSha: expectedSourceTreeSha,
  workflowSourceSha: expectedWorkflowSourceSha,
  now = new Date(),
}) {
  if (!manifest || manifest.schemaVersion !== CANDIDATE_MANIFEST_VERSION) throw new Error("Unsupported candidate manifest schema");
  requireSha(manifest.source?.commitSha, "manifest source commit");
  requireSha(manifest.source?.treeSha, "manifest source tree");
  requireVersion(manifest.release?.version);
  requireRunId(manifest.qualification?.runId, "manifest qualification run");
  requireRunId(manifest.candidate?.runId, "manifest candidate run");
  requireSha(manifest.candidate?.workflow?.sourceSha, "manifest workflow source");
  if (manifest.candidate.workflow.path !== EXPECTED_WORKFLOW_PATH || manifest.candidate.workflow.ref !== "main") {
    throw new Error("Candidate manifest workflow identity is not trusted");
  }
  if (manifest.qualification.conclusion !== "success") throw new Error("Candidate qualification did not succeed");
  if (sourceSha && manifest.source.commitSha !== sourceSha) throw new Error("Candidate source SHA does not match requested source");
  if (expectedSourceTreeSha) {
    requireSha(expectedSourceTreeSha, "requested source tree");
    if (manifest.source.treeSha !== expectedSourceTreeSha) throw new Error("Candidate source tree SHA does not match requested source");
  }
  if (version && manifest.release.version !== version) throw new Error("Candidate version does not match requested version");
  if (candidateRunId && manifest.candidate.runId !== String(candidateRunId)) throw new Error("Candidate run ID does not match requested run");
  if (qualificationRunId && manifest.qualification.runId !== String(qualificationRunId)) throw new Error("Qualification run ID does not match requested run");
  if (expectedWorkflowSourceSha && manifest.candidate.workflow.sourceSha !== expectedWorkflowSourceSha) {
    throw new Error("Candidate workflow source SHA does not match the trusted workflow");
  }
  validateRuntime(manifest.runtime, "manifest runtime");
  if (!existsSync(npmDir) || !existsSync(desktopDir)) throw new Error("Candidate artifact directories are required");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("now must be a valid Date");
  if (!Number.isInteger(manifest.candidate.retentionDays) || manifest.candidate.retentionDays < 1 || manifest.candidate.retentionDays > 90) {
    throw new Error("Candidate retention period is invalid");
  }
  const createdAt = new Date(manifest.candidate.createdAt);
  const expiresAt = new Date(manifest.candidate.expiresAt);
  if (!Number.isFinite(createdAt.getTime()) || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= createdAt.getTime()) {
    throw new Error("Candidate expiration is invalid");
  }
  if (expiresAt.getTime() <= now.getTime()) throw new Error("Candidate artifacts have expired");

  if (!runtimeFile || !existsSync(runtimeFile)) throw new Error("Candidate runtime identity file is required");
  let runtime;
  try {
    runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
  } catch (error) {
    throw new Error(`Candidate runtime identity file is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateRuntime(runtime, "candidate runtime");
  if (canonicalJson(runtime) !== canonicalJson(manifest.runtime)) {
    throw new Error("Candidate runtime identity does not match candidate manifest");
  }

  verifyNpmArtifacts(manifest, npmDir);
  verifyDesktopArtifacts(manifest, desktopDir);
  return manifest;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) throw new Error(`Unknown argument: ${arg ?? ""}`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function gitTreeSha(sourceSha) {
  return execFileSync("git", ["rev-parse", `${sourceSha}^{tree}`], { encoding: "utf8" }).trim();
}

function main() {
  const [command, ...argv] = process.argv.slice(2);
  const args = parseArgs(argv);
  if (command === "create") {
    const sourceSha = requireSha(requireValue(args["source-sha"], "--source-sha"), "source-sha");
    const runtime = args["runtime-file"] ? JSON.parse(readFileSync(args["runtime-file"], "utf8")) : {};
    const manifest = createCandidateManifest({
      sourceSha,
      sourceTreeSha: args["source-tree-sha"] || gitTreeSha(sourceSha),
      version: requireVersion(requireValue(args.version, "--version")),
      qualificationRunId: requireRunId(requireValue(args["qualification-run-id"], "--qualification-run-id"), "qualification-run-id"),
      candidateRunId: requireRunId(requireValue(args["candidate-run-id"], "--candidate-run-id"), "candidate-run-id"),
      workflowSourceSha: requireSha(args["workflow-source-sha"] || sourceSha, "workflow-source-sha"),
      workflowRef: args["workflow-ref"] || "main",
      runtime,
      npmDir: requireValue(args["npm-dir"], "--npm-dir"),
      desktopDir: requireValue(args["desktop-dir"], "--desktop-dir"),
      retentionDays: Number(args["retention-days"] || 7),
    });
    const output = requireValue(args.out, "--out");
    writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${output}\n`);
    return;
  }

  if (command === "verify") {
    const manifestPath = requireValue(args.manifest, "--manifest");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    verifyCandidateManifest({
      manifest,
      sourceSha: args["source-sha"],
      version: args.version,
      candidateRunId: args["candidate-run-id"],
      qualificationRunId: args["qualification-run-id"],
      sourceTreeSha: args["source-tree-sha"],
      expectedWorkflowSourceSha: args["workflow-source-sha"],
      npmDir: requireValue(args["npm-dir"], "--npm-dir"),
      desktopDir: requireValue(args["desktop-dir"], "--desktop-dir"),
      runtimeFile: requireValue(args["runtime-file"], "--runtime-file"),
    });
    process.stdout.write(`verified\t${manifest.source.commitSha}\t${manifest.release.version}\t${manifest.candidate.runId}\n`);
    return;
  }

  throw new Error("Usage: node scripts/release-candidate-manifest.mjs <create|verify> ...");
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
