import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RELEASE_SET_SCHEMA,
  SIGNED_RELEASE_SET_SCHEMA,
  ReleaseSetProtocolError,
  advanceReleaseSetTransition,
  canonicalizeReleaseSet,
  compareSemver,
  createReleaseSetTransition,
  releaseSetDigest,
  validateReleaseSetManifest,
  validateTransitionCompatibility,
  verifySignedReleaseSet,
} from "./release-set-protocol.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverRequire = createRequire(join(repoRoot, "server/package.json"));
const Ajv2020 = serverRequire("ajv/dist/2020").default;
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

function manifest(overrides = {}) {
  const version = overrides.version ?? "0.7.16";
  return {
    schema: RELEASE_SET_SCHEMA,
    releaseId: `stable:${version}:0123456789ab`,
    version,
    channel: "stable",
    sourceSha: "0123456789abcdef0123456789abcdef01234567",
    compatibility: {
      releaseEpoch: 2,
      databaseEpoch: 2,
      bootstrapFromEpochs: [1, 2],
      readableDatabaseEpochs: [1, 2],
      rollbackToEpochs: [1, 2],
    },
    minimumUpdaterVersion: "0.7.15",
    artifacts: [
      {
        id: "@rudderhq/cli",
        kind: "npm",
        version,
        sha256: "1".repeat(64),
        bytes: 1024,
        platform: null,
        arch: null,
      },
      {
        id: "desktop/macos-arm64-portable",
        kind: "desktop-portable",
        version,
        sha256: "2".repeat(64),
        bytes: 2048,
        platform: "darwin",
        arch: "arm64",
      },
    ],
    bootstrap: {
      maxStageAttempts: 2,
      maxProbeAttempts: 2,
      probeTimeoutMs: 30_000,
      drainTimeoutMs: 300_000,
    },
    electronHandoff: {
      shellAuthority: "electron",
      admissionAuthority: "electron",
      destructiveAuthority: "rudder-update-helper/v1",
      rollbackAuthority: "rudder-update-helper/lkg-v1",
    },
    ...overrides,
  };
}

function signedEnvelope(payload = manifest()) {
  return {
    schema: SIGNED_RELEASE_SET_SCHEMA,
    keyId: "release-test",
    payload,
    signature: sign(null, Buffer.from(canonicalizeReleaseSet(payload), "utf8"), privateKey).toString("base64url"),
  };
}

function expectCode(callback, code) {
  expect(callback).toThrowError(ReleaseSetProtocolError);
  try {
    callback();
  } catch (error) {
    expect(error.code).toBe(code);
  }
}

describe("signed release-set protocol", () => {
  it("verifies an exact signed manifest and returns a stable canonical digest", () => {
    const payload = manifest();
    const result = verifySignedReleaseSet(signedEnvelope(payload), {
      keys: { "release-test": publicKey },
      updaterVersion: "0.7.16",
      expectedChannel: "stable",
      expectedVersion: "0.7.16",
      expectedArtifactIds: ["@rudderhq/cli", "desktop/macos-arm64-portable"],
    });

    expect(result.manifest).toEqual(payload);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.digest).toBe(releaseSetDigest(JSON.parse(JSON.stringify(payload))));
    expect(releaseSetDigest({ ...payload, artifacts: [...payload.artifacts] })).toBe(result.digest);
  });

  it("rejects missing, unknown-key, and invalid signatures before accepting payload data", () => {
    const envelope = signedEnvelope();
    const { signature: _signature, ...unsigned } = envelope;
    expectCode(() => verifySignedReleaseSet(unsigned, { keys: { "release-test": publicKey } }), "missing_release_set_signature");
    expectCode(() => verifySignedReleaseSet(envelope, { keys: {} }), "unknown_release_set_key");
    expectCode(() => verifySignedReleaseSet({ ...envelope, keyId: "k".repeat(161) }, { keys: {} }), "unknown_release_set_key");
    expectCode(() => verifySignedReleaseSet({ ...envelope, signature: "AA" }, { keys: { "release-test": publicKey } }), "invalid_release_set_signature");
    expectCode(
      () => verifySignedReleaseSet({ ...envelope, signature: `${envelope.signature}!` }, { keys: { "release-test": publicKey } }),
      "invalid_release_set_signature",
    );
    const { publicKey: rsaPublicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expectCode(() => verifySignedReleaseSet(envelope, { keys: { "release-test": rsaPublicKey } }), "invalid_release_set_key");
  });

  it("uses SemVer precedence and rejects non-canonical versions", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemver("1.0.0-beta.11", "1.0.0-rc.1")).toBeLessThan(0);
    expect(compareSemver("9007199254740992.0.0", "9007199254740993.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-9007199254740992", "1.0.0-9007199254740993")).toBeLessThan(0);
    expectCode(() => validateReleaseSetManifest(manifest({ version: "01.0.0" })), "invalid_release_set_manifest");
    expectCode(() => validateReleaseSetManifest(manifest({ version: "1.0.0+build.1" })), "invalid_release_set_manifest");
  });

  it("rejects unknown schemas and extra manifest fields", () => {
    expectCode(() => validateReleaseSetManifest(manifest({ schema: "rudder.release-set/v2" })), "unknown_release_set_manifest");
    expectCode(() => validateReleaseSetManifest({ ...manifest(), surprise: true }), "unknown_release_set_manifest");
  });

  it("rejects mixed artifact versions and unexpected artifact sets", () => {
    const mixed = manifest();
    mixed.artifacts[1].version = "0.7.15";
    expectCode(() => validateReleaseSetManifest(mixed), "mixed_release_set_versions");
    expectCode(
      () => validateReleaseSetManifest(manifest(), { expectedArtifactIds: ["@rudderhq/cli"] }),
      "release_set_artifact_mismatch",
    );
  });

  it("rejects stale updaters against the signed minimum", () => {
    expectCode(
      () => verifySignedReleaseSet(signedEnvelope(), { keys: { "release-test": publicKey }, updaterVersion: "0.7.14" }),
      "stale_release_set_updater",
    );
    for (const [updaterVersion, minimumUpdaterVersion] of [
      ["9007199254740992.0.0", "9007199254740993.0.0"],
      ["1.0.0-9007199254740992", "1.0.0-9007199254740993"],
    ]) {
      const payload = manifest({ version: minimumUpdaterVersion, minimumUpdaterVersion });
      expectCode(
        () => verifySignedReleaseSet(signedEnvelope(payload), { keys: { "release-test": publicKey }, updaterVersion }),
        "stale_release_set_updater",
      );
    }
  });

  it("rejects incompatible forward and rollback epochs", () => {
    const installed = manifest({
      version: "0.7.15",
      releaseId: "stable:0.7.15:fedcba987654",
      compatibility: {
        releaseEpoch: 1,
        databaseEpoch: 1,
        bootstrapFromEpochs: [1],
        readableDatabaseEpochs: [1],
        rollbackToEpochs: [1],
      },
    });
    installed.artifacts = installed.artifacts.map((artifact) => ({ ...artifact, version: "0.7.15" }));

    const cannotBootstrap = manifest();
    cannotBootstrap.compatibility.bootstrapFromEpochs = [2];
    expectCode(() => validateTransitionCompatibility(installed, cannotBootstrap), "incompatible_release_epoch");

    const cannotRollback = manifest();
    cannotRollback.compatibility.databaseEpoch = 2;
    cannotRollback.compatibility.readableDatabaseEpochs = [1, 2];
    expectCode(() => validateTransitionCompatibility(installed, cannotRollback), "rollback_boundary_rejected");
  });

  it("keeps Electron, admission, destructive exchange, and LKG authority fixed", () => {
    const payload = manifest();
    payload.electronHandoff.destructiveAuthority = "rust-core";
    expectCode(() => validateReleaseSetManifest(payload), "invalid_electron_handoff");
  });

  it("rejects unbounded bootstrap limits", () => {
    const payload = manifest();
    payload.bootstrap.maxProbeAttempts = 100;
    expectCode(() => validateReleaseSetManifest(payload), "unbounded_release_set_bootstrap");
  });

  it("commits only after stage, zero-run drain, atomic switch, and a successful probe", () => {
    const installed = manifest({ version: "0.7.15", releaseId: "stable:0.7.15:fedcba987654" });
    installed.artifacts = installed.artifacts.map((artifact) => ({ ...artifact, version: "0.7.15" }));
    let state = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    const digest = state.manifestDigest;
    state = advanceReleaseSetTransition(state, { type: "stage_pass", manifestDigest: digest, nowMs: 2_000 });
    state = advanceReleaseSetTransition(state, { type: "drain_closed", manifestDigest: digest, nowMs: 3_000, activeRuns: 0, drainToken: "drain-token-1" });
    state = advanceReleaseSetTransition(state, { type: "switch_atomic", manifestDigest: digest, nowMs: 4_000, drainToken: "drain-token-1" });
    state = advanceReleaseSetTransition(state, { type: "probe_pass", manifestDigest: digest, nowMs: 5_000 });
    expect(state.phase).toBe("committed");
    expect(state.stageAttempts).toBe(1);
    expect(state.probeAttempts).toBe(1);
  });

  it("rejects switch while active runs remain or when the drain token changes", () => {
    const installed = manifest({ version: "0.7.15", releaseId: "stable:0.7.15:fedcba987654" });
    installed.artifacts = installed.artifacts.map((artifact) => ({ ...artifact, version: "0.7.15" }));
    let state = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    const digest = state.manifestDigest;
    state = advanceReleaseSetTransition(state, { type: "stage_pass", manifestDigest: digest, nowMs: 2_000 });
    expectCode(
      () => advanceReleaseSetTransition(state, { type: "drain_closed", manifestDigest: digest, nowMs: 3_000, activeRuns: 1, drainToken: "drain-token-1" }),
      "release_set_drain_rejected",
    );
    state = advanceReleaseSetTransition(state, { type: "drain_closed", manifestDigest: digest, nowMs: 3_000, activeRuns: 0, drainToken: "drain-token-1" });
    expectCode(
      () => advanceReleaseSetTransition(state, { type: "switch_atomic", manifestDigest: digest, nowMs: 4_000, drainToken: "different-token" }),
      "invalid_release_set_transition",
    );
  });

  it("bounds stage retries and rolls back after bounded failed probes", () => {
    const installed = manifest({ version: "0.7.15", releaseId: "stable:0.7.15:fedcba987654" });
    installed.artifacts = installed.artifacts.map((artifact) => ({ ...artifact, version: "0.7.15" }));
    let stageState = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    const digest = stageState.manifestDigest;
    stageState = advanceReleaseSetTransition(stageState, { type: "stage_fail", manifestDigest: digest, nowMs: 2_000 });
    expect(stageState.phase).toBe("pending");
    stageState = advanceReleaseSetTransition(stageState, { type: "stage_fail", manifestDigest: digest, nowMs: 3_000 });
    expect(stageState.phase).toBe("failed");

    let state = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    state = advanceReleaseSetTransition(state, { type: "stage_pass", manifestDigest: digest, nowMs: 2_000 });
    state = advanceReleaseSetTransition(state, { type: "drain_closed", manifestDigest: digest, nowMs: 3_000, activeRuns: 0, drainToken: "drain-token-1" });
    state = advanceReleaseSetTransition(state, { type: "switch_atomic", manifestDigest: digest, nowMs: 4_000, drainToken: "drain-token-1" });
    state = advanceReleaseSetTransition(state, { type: "probe_fail", manifestDigest: digest, nowMs: 5_000 });
    expect(state.phase).toBe("switched");
    state = advanceReleaseSetTransition(state, { type: "probe_fail", manifestDigest: digest, nowMs: 6_000 });
    expect(state.phase).toBe("rollback_required");
    state = advanceReleaseSetTransition(state, { type: "rollback_pass", manifestDigest: digest, nowMs: 7_000 });
    expect(state.phase).toBe("rolled_back");
  });

  it("surfaces recovery_required when LKG rollback fails", () => {
    const installed = manifest({ version: "0.7.15", releaseId: "stable:0.7.15:fedcba987654" });
    installed.artifacts = installed.artifacts.map((artifact) => ({ ...artifact, version: "0.7.15" }));
    let state = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    const digest = state.manifestDigest;
    for (const event of [
      { type: "stage_pass", manifestDigest: digest, nowMs: 2_000 },
      { type: "drain_closed", manifestDigest: digest, nowMs: 3_000, activeRuns: 0, drainToken: "drain-token-1" },
      { type: "switch_atomic", manifestDigest: digest, nowMs: 4_000, drainToken: "drain-token-1" },
      { type: "probe_fail", manifestDigest: digest, nowMs: 5_000 },
      { type: "probe_fail", manifestDigest: digest, nowMs: 6_000 },
      { type: "rollback_fail", manifestDigest: digest, nowMs: 7_000 },
    ]) state = advanceReleaseSetTransition(state, event);
    expect(state.phase).toBe("recovery_required");
  });

  it("rejects stale transition events bound to another manifest", () => {
    const installed = manifest({ version: "0.7.15", releaseId: "stable:0.7.15:fedcba987654" });
    installed.artifacts = installed.artifacts.map((artifact) => ({ ...artifact, version: "0.7.15" }));
    const state = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    expectCode(
      () => advanceReleaseSetTransition(state, { type: "stage_pass", manifestDigest: "0".repeat(64), nowMs: 2_000 }),
      "release_set_transaction_mismatch",
    );
  });

  it("fails closed when drain or probe deadlines expire", () => {
    const installed = manifest({ version: "0.7.15", releaseId: "stable:0.7.15:fedcba987654" });
    installed.artifacts = installed.artifacts.map((artifact) => ({ ...artifact, version: "0.7.15" }));
    let state = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    const digest = state.manifestDigest;
    state = advanceReleaseSetTransition(state, { type: "stage_pass", manifestDigest: digest, nowMs: 2_000 });
    expect(state.drainDeadlineMs).toBe(302_000);
    state = advanceReleaseSetTransition(state, { type: "drain_expired", manifestDigest: digest, nowMs: 302_000 });
    expect(state.phase).toBe("failed");

    state = createReleaseSetTransition(installed, manifest(), { nowMs: 1_000 });
    state = advanceReleaseSetTransition(state, { type: "stage_pass", manifestDigest: digest, nowMs: 2_000 });
    state = advanceReleaseSetTransition(state, { type: "drain_closed", manifestDigest: digest, nowMs: 3_000, activeRuns: 0, drainToken: "drain-token-1" });
    state = advanceReleaseSetTransition(state, { type: "switch_atomic", manifestDigest: digest, nowMs: 4_000, drainToken: "drain-token-1" });
    expect(state.probeDeadlineMs).toBe(34_000);
    state = advanceReleaseSetTransition(state, { type: "probe_expired", manifestDigest: digest, nowMs: 34_000 });
    expect(state.phase).toBe("rollback_required");
  });

  it("keeps the checked-in JSON schema aligned with the protocol identity", () => {
    const schema = JSON.parse(readFileSync(join(repoRoot, "contracts/rudder-release-set/v1.schema.json"), "utf8"));
    const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    const envelope = signedEnvelope();
    expect(validateSchema(envelope), JSON.stringify(validateSchema.errors)).toBe(true);
    expect(schema.properties.schema.const).toBe(SIGNED_RELEASE_SET_SCHEMA);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.manifest.properties.schema.const).toBe(RELEASE_SET_SCHEMA);
    expect(schema.$defs.compatibility.additionalProperties).toBe(false);
    expect(schema.$defs.electronHandoff.properties.destructiveAuthority.const).toBe("rudder-update-helper/v1");

    const structurallyInvalid = [
      { ...envelope, extra: true },
      { ...envelope, signature: "AA" },
      { ...envelope, payload: { ...envelope.payload, sourceSha: "not-a-sha" } },
      { ...envelope, payload: { ...envelope.payload, bootstrap: { ...envelope.payload.bootstrap, probeTimeoutMs: 999 } } },
      { ...envelope, payload: { ...envelope.payload, artifacts: [{ ...envelope.payload.artifacts[0], platform: "" }] } },
    ];
    for (const candidate of structurallyInvalid) expect(validateSchema(candidate)).toBe(false);

    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    const numericDomainInvalid = [
      { ...envelope.payload, compatibility: { ...envelope.payload.compatibility, releaseEpoch: unsafeInteger } },
      {
        ...envelope.payload,
        artifacts: envelope.payload.artifacts.map((artifact, index) => index === 0 ? { ...artifact, bytes: unsafeInteger } : artifact),
      },
    ];
    for (const payload of numericDomainInvalid) {
      expect(validateSchema({ ...envelope, payload })).toBe(false);
      expect(() => validateReleaseSetManifest(payload)).toThrowError(ReleaseSetProtocolError);
    }

    const semanticOnlyInvalid = [
      { ...envelope.payload, artifacts: [...envelope.payload.artifacts].reverse() },
      { ...envelope.payload, artifacts: envelope.payload.artifacts.map((artifact, index) => index === 0 ? { ...artifact, version: "0.7.15" } : artifact) },
      { ...envelope.payload, compatibility: { ...envelope.payload.compatibility, readableDatabaseEpochs: [1] } },
    ];
    for (const payload of semanticOnlyInvalid) {
      expect(validateSchema({ ...envelope, payload })).toBe(true);
      expect(() => validateReleaseSetManifest(payload)).toThrowError(ReleaseSetProtocolError);
    }
  });
});
