#!/usr/bin/env node

import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_SET_SCHEMA = "rudder.release-set/v1";
export const SIGNED_RELEASE_SET_SCHEMA = "rudder.signed-release-set/v1";

const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const SHA256_RE = /^[a-f0-9]{64}$/u;
const SOURCE_SHA_RE = /^[a-f0-9]{40}$/u;
const ARTIFACT_KINDS = new Set([
  "npm",
  "desktop-portable",
  "desktop-shell",
  "native",
  "runtime",
  "checksum",
]);

export class ReleaseSetProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseSetProtocolError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ReleaseSetProtocolError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) fail("invalid_release_set_manifest", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail("unknown_release_set_manifest", `${label} fields must be exactly ${wanted.join(", ")}`);
  }
}

function assertSemver(value, label) {
  if (typeof value !== "string" || !SEMVER_RE.test(value)) {
    fail("invalid_release_set_manifest", `${label} must be a semantic version`);
  }
}

function semverParts(value) {
  assertSemver(value, "version");
  const separator = value.indexOf("-");
  const core = separator === -1 ? value : value.slice(0, separator);
  const prerelease = separator === -1 ? [] : value.slice(separator + 1).split(".");
  return { core: core.split("."), prerelease };
}

function compareNumericIdentifier(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareSemver(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    const comparison = compareNumericIdentifier(a.core[index], b.core[index]);
    if (comparison !== 0) return comparison;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumeric = /^[0-9]+$/u.test(a.prerelease[index]);
    const bNumeric = /^[0-9]+$/u.test(b.prerelease[index]);
    if (aNumeric && bNumeric) return compareNumericIdentifier(a.prerelease[index], b.prerelease[index]);
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a.prerelease[index] < b.prerelease[index] ? -1 : 1;
  }
  return 0;
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeReleaseSet(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("invalid_release_set_manifest", "manifest numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeReleaseSet).join(",")}]`;
  if (!isRecord(value)) fail("invalid_release_set_manifest", "manifest contains a non-JSON value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalizeReleaseSet(value[key])}`).join(",")}}`;
}

export function releaseSetDigest(manifest) {
  return createHash("sha256").update(canonicalizeReleaseSet(manifest), "utf8").digest("hex");
}

function validateEpochSet(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    fail("invalid_release_set_manifest", `${label} must contain 1..16 epochs`);
  }
  if (value.some((epoch) => !Number.isSafeInteger(epoch) || epoch < 1) || new Set(value).size !== value.length) {
    fail("invalid_release_set_manifest", `${label} must contain unique positive integer epochs`);
  }
  if (value.some((epoch, index) => index > 0 && value[index - 1] >= epoch)) {
    fail("invalid_release_set_manifest", `${label} must be sorted ascending`);
  }
}

function validateArtifact(artifact, manifestVersion) {
  assertExactKeys(artifact, ["id", "kind", "version", "sha256", "bytes", "platform", "arch"], "artifact");
  if (
    typeof artifact.id !== "string"
    || artifact.id.length < 1
    || artifact.id.length > 200
    || artifact.id.startsWith("/")
    || artifact.id.includes("\\")
    || artifact.id.split("/").includes("..")
  ) {
    fail("invalid_release_set_manifest", "artifact id is unsafe");
  }
  if (!ARTIFACT_KINDS.has(artifact.kind)) fail("unknown_release_set_artifact", `unknown artifact kind ${artifact.kind}`);
  if (artifact.version !== manifestVersion) {
    fail("mixed_release_set_versions", `artifact ${artifact.id} has version ${artifact.version}, expected ${manifestVersion}`);
  }
  if (typeof artifact.sha256 !== "string" || !SHA256_RE.test(artifact.sha256)) {
    fail("invalid_release_set_manifest", `artifact ${artifact.id} has an invalid SHA-256`);
  }
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1) {
    fail("invalid_release_set_manifest", `artifact ${artifact.id} has an invalid byte length`);
  }
  for (const field of ["platform", "arch"]) {
    if (artifact[field] !== null && (typeof artifact[field] !== "string" || artifact[field].length < 1)) {
      fail("invalid_release_set_manifest", `artifact ${artifact.id} has an invalid ${field}`);
    }
  }
}

export function validateReleaseSetManifest(manifest, { expectedArtifactIds } = {}) {
  assertExactKeys(manifest, [
    "schema",
    "releaseId",
    "version",
    "channel",
    "sourceSha",
    "compatibility",
    "minimumUpdaterVersion",
    "artifacts",
    "bootstrap",
    "electronHandoff",
  ], "manifest");
  if (manifest.schema !== RELEASE_SET_SCHEMA) fail("unknown_release_set_manifest", `unsupported manifest schema ${String(manifest.schema)}`);
  if (typeof manifest.releaseId !== "string" || manifest.releaseId.length < 8 || manifest.releaseId.length > 160) {
    fail("invalid_release_set_manifest", "releaseId must be 8..160 characters");
  }
  assertSemver(manifest.version, "version");
  assertSemver(manifest.minimumUpdaterVersion, "minimumUpdaterVersion");
  if (manifest.channel !== "stable" && manifest.channel !== "canary") fail("invalid_release_set_manifest", "channel is invalid");
  if (typeof manifest.sourceSha !== "string" || !SOURCE_SHA_RE.test(manifest.sourceSha)) {
    fail("invalid_release_set_manifest", "sourceSha must be a lowercase full commit SHA");
  }

  assertExactKeys(manifest.compatibility, [
    "releaseEpoch",
    "databaseEpoch",
    "bootstrapFromEpochs",
    "readableDatabaseEpochs",
    "rollbackToEpochs",
  ], "compatibility");
  for (const field of ["releaseEpoch", "databaseEpoch"]) {
    if (!Number.isSafeInteger(manifest.compatibility[field]) || manifest.compatibility[field] < 1) {
      fail("invalid_release_set_manifest", `${field} must be a positive integer`);
    }
  }
  validateEpochSet(manifest.compatibility.bootstrapFromEpochs, "bootstrapFromEpochs");
  validateEpochSet(manifest.compatibility.readableDatabaseEpochs, "readableDatabaseEpochs");
  validateEpochSet(manifest.compatibility.rollbackToEpochs, "rollbackToEpochs");
  if (!manifest.compatibility.readableDatabaseEpochs.includes(manifest.compatibility.databaseEpoch)) {
    fail("invalid_release_set_manifest", "a release set must read its own database epoch");
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 256) {
    fail("invalid_release_set_manifest", "artifacts must contain 1..256 entries");
  }
  for (const artifact of manifest.artifacts) validateArtifact(artifact, manifest.version);
  const artifactIds = manifest.artifacts.map((artifact) => artifact.id);
  if (new Set(artifactIds).size !== artifactIds.length) fail("duplicate_release_set_artifact", "artifact ids must be unique");
  if (artifactIds.some((id, index) => index > 0 && compareCanonicalText(artifactIds[index - 1], id) >= 0)) {
    fail("invalid_release_set_manifest", "artifacts must be sorted by id");
  }
  if (expectedArtifactIds) {
    const expected = [...expectedArtifactIds].sort(compareCanonicalText);
    if (artifactIds.length !== expected.length || artifactIds.some((id, index) => id !== expected[index])) {
      fail("release_set_artifact_mismatch", `artifact set differs from expected ids: ${expected.join(", ")}`);
    }
  }

  assertExactKeys(manifest.bootstrap, ["maxStageAttempts", "maxProbeAttempts", "probeTimeoutMs", "drainTimeoutMs"], "bootstrap");
  const bounds = [
    ["maxStageAttempts", 1, 3],
    ["maxProbeAttempts", 1, 3],
    ["probeTimeoutMs", 1_000, 120_000],
    ["drainTimeoutMs", 1_000, 600_000],
  ];
  for (const [field, minimum, maximum] of bounds) {
    const value = manifest.bootstrap[field];
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      fail("unbounded_release_set_bootstrap", `${field} must be ${minimum}..${maximum}`);
    }
  }

  assertExactKeys(manifest.electronHandoff, [
    "shellAuthority",
    "admissionAuthority",
    "destructiveAuthority",
    "rollbackAuthority",
  ], "electronHandoff");
  const requiredHandoff = {
    shellAuthority: "electron",
    admissionAuthority: "electron",
    destructiveAuthority: "rudder-update-helper/v1",
    rollbackAuthority: "rudder-update-helper/lkg-v1",
  };
  for (const [field, value] of Object.entries(requiredHandoff)) {
    if (manifest.electronHandoff[field] !== value) {
      fail("invalid_electron_handoff", `${field} must remain ${value}`);
    }
  }
  return manifest;
}

export function validateTransitionCompatibility(installed, candidate) {
  validateReleaseSetManifest(installed);
  validateReleaseSetManifest(candidate);
  const installedCompatibility = installed.compatibility;
  const candidateCompatibility = candidate.compatibility;
  if (!candidateCompatibility.bootstrapFromEpochs.includes(installedCompatibility.releaseEpoch)) {
    fail("incompatible_release_epoch", `candidate cannot bootstrap from release epoch ${installedCompatibility.releaseEpoch}`);
  }
  if (!candidateCompatibility.readableDatabaseEpochs.includes(installedCompatibility.databaseEpoch)) {
    fail("incompatible_database_epoch", `candidate cannot read installed database epoch ${installedCompatibility.databaseEpoch}`);
  }
  if (!candidateCompatibility.rollbackToEpochs.includes(installedCompatibility.releaseEpoch)) {
    fail("rollback_boundary_rejected", `candidate does not declare rollback to release epoch ${installedCompatibility.releaseEpoch}`);
  }
  if (!installedCompatibility.readableDatabaseEpochs.includes(candidateCompatibility.databaseEpoch)) {
    fail("rollback_boundary_rejected", `installed release cannot read candidate database epoch ${candidateCompatibility.databaseEpoch}`);
  }
  return true;
}

function decodeSignature(value) {
  if (typeof value !== "string") fail("missing_release_set_signature", "signature is required");
  if (!/^[A-Za-z0-9_-]{86}$/u.test(value)) {
    fail("invalid_release_set_signature", "signature is not canonical unpadded base64url");
  }
  let signature;
  try {
    signature = Buffer.from(value, "base64url");
  } catch {
    fail("invalid_release_set_signature", "signature is not base64url");
  }
  if (signature.length !== 64 || signature.toString("base64url") !== value) {
    fail("invalid_release_set_signature", "signature must contain 64 canonical bytes");
  }
  return signature;
}

export function verifySignedReleaseSet(envelope, trust) {
  if (!isRecord(envelope)) fail("invalid_release_set_manifest", "signed envelope must be an object");
  if (!Object.hasOwn(envelope, "signature")) fail("missing_release_set_signature", "signature is required");
  assertExactKeys(envelope, ["schema", "keyId", "payload", "signature"], "signed envelope");
  if (envelope.schema !== SIGNED_RELEASE_SET_SCHEMA) fail("unknown_release_set_manifest", "signed envelope schema is unsupported");
  if (typeof envelope.keyId !== "string" || envelope.keyId.length < 1 || envelope.keyId.length > 160) {
    fail("unknown_release_set_key", "keyId must contain 1..160 characters");
  }
  const key = trust?.keys?.[envelope.keyId];
  if (!key) fail("unknown_release_set_key", `no trusted key for ${envelope.keyId}`);
  const signature = decodeSignature(envelope.signature);
  let publicKey;
  try {
    publicKey = key?.type === "public" && key?.asymmetricKeyType
      ? key
      : Buffer.isBuffer(key)
        ? createPublicKey({ key, format: "der", type: "spki" })
        : createPublicKey(key);
  } catch {
    fail("invalid_release_set_key", `trusted key ${envelope.keyId} is invalid`);
  }
  if (publicKey.asymmetricKeyType !== "ed25519") {
    fail("invalid_release_set_key", `trusted key ${envelope.keyId} must be Ed25519`);
  }
  if (!verify(null, Buffer.from(canonicalizeReleaseSet(envelope.payload), "utf8"), publicKey, signature)) {
    fail("invalid_release_set_signature", "release-set signature verification failed");
  }
  const manifest = validateReleaseSetManifest(envelope.payload, { expectedArtifactIds: trust.expectedArtifactIds });
  if (trust.expectedChannel && manifest.channel !== trust.expectedChannel) fail("release_set_scope_mismatch", "channel does not match updater scope");
  if (trust.expectedVersion && manifest.version !== trust.expectedVersion) fail("release_set_scope_mismatch", "version does not match updater request");
  if (trust.updaterVersion && compareSemver(trust.updaterVersion, manifest.minimumUpdaterVersion) < 0) {
    fail("stale_release_set_updater", `updater ${trust.updaterVersion} is older than required ${manifest.minimumUpdaterVersion}`);
  }
  if (trust.installedManifest) validateTransitionCompatibility(trust.installedManifest, manifest);
  return { manifest, digest: releaseSetDigest(manifest) };
}

function assertEventTime(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("invalid_release_set_transition", "transition events require a non-negative integer nowMs");
  }
}

function deadlineFrom(nowMs, timeoutMs) {
  const deadline = nowMs + timeoutMs;
  if (!Number.isSafeInteger(deadline)) {
    fail("invalid_release_set_transition", "transition deadline exceeds the safe integer range");
  }
  return deadline;
}

export function createReleaseSetTransition(installed, candidate, { nowMs } = {}) {
  validateTransitionCompatibility(installed, candidate);
  assertEventTime(nowMs);
  return {
    manifestDigest: releaseSetDigest(candidate),
    phase: "pending",
    updatedAtMs: nowMs,
    stageAttempts: 0,
    probeAttempts: 0,
    maxStageAttempts: candidate.bootstrap.maxStageAttempts,
    maxProbeAttempts: candidate.bootstrap.maxProbeAttempts,
    drainTimeoutMs: candidate.bootstrap.drainTimeoutMs,
    probeTimeoutMs: candidate.bootstrap.probeTimeoutMs,
    drainDeadlineMs: null,
    probeDeadlineMs: null,
  };
}

export function advanceReleaseSetTransition(state, event) {
  if (!isRecord(state) || !isRecord(event) || event.manifestDigest !== state.manifestDigest) {
    fail("release_set_transaction_mismatch", "transition event must match the frozen manifest digest");
  }
  assertEventTime(event.nowMs);
  if (!Number.isSafeInteger(state.updatedAtMs) || event.nowMs < state.updatedAtMs) {
    fail("release_set_clock_regression", "transition event time must not move backwards");
  }
  const next = { ...state };
  next.updatedAtMs = event.nowMs;
  switch (event.type) {
    case "stage_pass":
      if (state.phase !== "pending") fail("invalid_release_set_transition", "stage_pass requires pending");
      next.stageAttempts += 1;
      next.phase = "staged";
      next.drainDeadlineMs = deadlineFrom(event.nowMs, state.drainTimeoutMs);
      return next;
    case "stage_fail":
      if (state.phase !== "pending") fail("invalid_release_set_transition", "stage_fail requires pending");
      next.stageAttempts += 1;
      next.phase = next.stageAttempts >= state.maxStageAttempts ? "failed" : "pending";
      return next;
    case "drain_closed":
      if (state.phase !== "staged" || event.activeRuns !== 0 || typeof event.drainToken !== "string" || event.drainToken.length < 8) {
        fail("release_set_drain_rejected", "atomic switch requires closed admission, zero active runs, and a drain token");
      }
      if (event.nowMs >= state.drainDeadlineMs) {
        next.phase = "failed";
        return next;
      }
      next.phase = "admission_closed";
      next.drainToken = event.drainToken;
      return next;
    case "drain_expired":
      if (state.phase !== "staged" || event.nowMs < state.drainDeadlineMs) {
        fail("invalid_release_set_transition", "drain_expired requires a staged transition at or after its deadline");
      }
      next.phase = "failed";
      return next;
    case "switch_atomic":
      if (state.phase !== "admission_closed" || event.drainToken !== state.drainToken) {
        fail("invalid_release_set_transition", "switch requires the same closed-admission drain token");
      }
      next.phase = "switched";
      next.probeDeadlineMs = deadlineFrom(event.nowMs, state.probeTimeoutMs);
      return next;
    case "probe_pass":
      if (state.phase !== "switched") fail("invalid_release_set_transition", "probe_pass requires switched");
      if (event.nowMs >= state.probeDeadlineMs) {
        next.phase = "rollback_required";
        return next;
      }
      next.probeAttempts += 1;
      next.phase = "committed";
      return next;
    case "probe_fail":
      if (state.phase !== "switched") fail("invalid_release_set_transition", "probe_fail requires switched");
      if (event.nowMs >= state.probeDeadlineMs) {
        next.phase = "rollback_required";
        return next;
      }
      next.probeAttempts += 1;
      next.phase = next.probeAttempts >= state.maxProbeAttempts ? "rollback_required" : "switched";
      return next;
    case "probe_expired":
      if (state.phase !== "switched" || event.nowMs < state.probeDeadlineMs) {
        fail("invalid_release_set_transition", "probe_expired requires a switched transition at or after its deadline");
      }
      next.phase = "rollback_required";
      return next;
    case "rollback_pass":
      if (state.phase !== "rollback_required") fail("invalid_release_set_transition", "rollback_pass requires rollback_required");
      next.phase = "rolled_back";
      return next;
    case "rollback_fail":
      if (state.phase !== "rollback_required") fail("invalid_release_set_transition", "rollback_fail requires rollback_required");
      next.phase = "recovery_required";
      return next;
    default:
      fail("invalid_release_set_transition", `unknown transition event ${String(event.type)}`);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(resolve(filePath), "utf8"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  const envelopePath = process.argv[3];
  const publicKeyPath = process.argv[4];
  const updaterVersion = process.argv[5];
  if (command !== "verify" || !envelopePath || !publicKeyPath || !updaterVersion) {
    console.error("Usage: node scripts/release-set-protocol.mjs verify <envelope.json> <public-key.pem> <updater-version>");
    process.exit(2);
  }
  try {
    const envelope = readJson(envelopePath);
    const result = verifySignedReleaseSet(envelope, {
      keys: { [envelope.keyId]: readFileSync(resolve(publicKeyPath)) },
      updaterVersion,
    });
    console.log(JSON.stringify({ ok: true, schema: result.manifest.schema, releaseId: result.manifest.releaseId, digest: result.digest }));
  } catch (error) {
    const code = error instanceof ReleaseSetProtocolError ? error.code : "release_set_verification_failed";
    console.error(JSON.stringify({ ok: false, code, message: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}
