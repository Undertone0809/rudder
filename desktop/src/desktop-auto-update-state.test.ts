import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DESKTOP_AUTO_UPDATE_INITIAL_DELAY_MS,
  DESKTOP_AUTO_UPDATE_INTERVAL_MS,
  acceptAutomaticUpdatePolicySequence,
  acceptAutomaticUpdatePolicySequenceAtPath,
  claimAutomaticCandidate,
  createInitialDesktopAutoUpdateState,
  hasExactStagedAutomaticArtifact,
  markAutomaticCandidateStatus,
  markAutomaticCheckStarted,
  markAutomaticRecoveryRequired,
  readDesktopAutoUpdateState,
  scheduleNextAutomaticCheck,
  shouldRunAutomaticCheck,
  stageAutomaticCandidate,
  writeDesktopAutoUpdateState,
  type DesktopAutoUpdateCandidate,
} from "./desktop-auto-update-state.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function candidate(generation = 1): DesktopAutoUpdateCandidate {
  return {
    channel: "stable",
    version: "0.7.5",
    platform: "darwin",
    arch: "arm64",
    installId: "/Users/test/Library/Application Support/Rudder",
    profile: "prod_local",
    instanceId: "default",
    sourceReleaseDigest: "release-digest",
    updateId: "update-1",
    assetName: "Rudder-0.7.5-macos-arm64-portable.zip",
    assetChecksum: "a".repeat(64),
    stagedAt: "2026-08-13T00:00:00.000Z",
    status: "staged",
    generation,
  };
}

describe("desktop automatic update state", () => {
  it("persists atomically and survives a reload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-auto-update-"));
    temporaryRoots.push(root);
    const statePath = path.join(root, "state.json");
    const state = stageAutomaticCandidate(createInitialDesktopAutoUpdateState(), candidate());
    writeDesktopAutoUpdateState(statePath, state);
    expect(readDesktopAutoUpdateState(statePath)).toEqual(state);
  });

  it("uses a five-second first slot and one-hour subsequent slots", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const initial = scheduleNextAutomaticCheck(createInitialDesktopAutoUpdateState(), start);
    expect(Date.parse(initial.nextCheckAt!) - start.getTime()).toBe(DESKTOP_AUTO_UPDATE_INITIAL_DELAY_MS);
    const marked = markAutomaticCheckStarted(initial, new Date(initial.nextCheckAt!));
    expect(Date.parse(marked.nextCheckAt!) - Date.parse(marked.lastCheckAt!)).toBe(DESKTOP_AUTO_UPDATE_INTERVAL_MS);
  });

  it("keeps the hourly slot anchored across restart and clock rollback", () => {
    const start = new Date("2026-08-13T00:00:00.000Z");
    const initial = scheduleNextAutomaticCheck(createInitialDesktopAutoUpdateState(), start);
    const checked = markAutomaticCheckStarted(initial, new Date(initial.nextCheckAt!));
    const restarted = scheduleNextAutomaticCheck(checked, new Date("2026-08-13T00:00:10.000Z"));
    expect(restarted.nextCheckAt).toBe(checked.nextCheckAt);
    expect(shouldRunAutomaticCheck(restarted, new Date("2026-08-13T00:00:10.000Z"))).toBe(false);
    expect(shouldRunAutomaticCheck(restarted, new Date(checked.nextCheckAt!))).toBe(true);
  });

  it("persists a monotonic policy sequence and rejects replay", () => {
    const state = createInitialDesktopAutoUpdateState();
    const accepted = acceptAutomaticUpdatePolicySequence(state, 7);
    expect(accepted.acceptedPolicySequence).toBe(7);
    expect(() => acceptAutomaticUpdatePolicySequence(accepted, 7)).toThrow(/stale/);
  });

  it("accepts a policy sequence atomically at the durable state path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-auto-update-policy-cas-"));
    temporaryRoots.push(root);
    const statePath = path.join(root, "state.json");
    writeDesktopAutoUpdateState(statePath, createInitialDesktopAutoUpdateState());
    expect(acceptAutomaticUpdatePolicySequenceAtPath(statePath, 9).acceptedPolicySequence).toBe(9);
    expect(readDesktopAutoUpdateState(statePath).acceptedPolicySequence).toBe(9);
    expect(() => acceptAutomaticUpdatePolicySequenceAtPath(statePath, 9)).toThrow(/stale/);
  });

  it("rejects stale claims and preserves exact candidate identity", () => {
    const staged = stageAutomaticCandidate(createInitialDesktopAutoUpdateState(), candidate());
    expect(() => claimAutomaticCandidate(staged, "update-1", staged.generation - 1)).toThrow(/changed/);
    expect(() => stageAutomaticCandidate(staged, { ...candidate(), version: "0.7.6", updateId: "update-2" })).toThrow(/already staged/);
  });

  it("requires an exact regular staged artifact and matching digest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-auto-update-artifact-"));
    temporaryRoots.push(root);
    const artifactPath = path.join(root, "Rudder.zip");
    const contents = Buffer.from("verified staged payload\n", "utf8");
    fs.writeFileSync(artifactPath, contents, { mode: 0o600 });
    const digest = createHash("sha256").update(contents).digest("hex");

    expect(hasExactStagedAutomaticArtifact({
      ...candidate(),
      stagedArtifactPath: artifactPath,
      stagedArtifactDigest: digest,
    })).toBe(true);
    expect(hasExactStagedAutomaticArtifact({
      ...candidate(),
      stagedArtifactPath: artifactPath,
      stagedArtifactDigest: "b".repeat(64),
    })).toBe(false);
  });

  it("rejects a symlink staged artifact even when its target digest matches", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-auto-update-symlink-"));
    temporaryRoots.push(root);
    const targetPath = path.join(root, "payload.zip");
    const linkPath = path.join(root, "staged.zip");
    const contents = Buffer.from("payload\n", "utf8");
    fs.writeFileSync(targetPath, contents, { mode: 0o600 });
    fs.symlinkSync(targetPath, linkPath);
    const digest = createHash("sha256").update(contents).digest("hex");

    expect(hasExactStagedAutomaticArtifact({
      ...candidate(),
      stagedArtifactPath: linkPath,
      stagedArtifactDigest: digest,
    })).toBe(false);
  });

  it("persists quarantine and blocks future checks when recovery is required", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-auto-update-recovery-"));
    temporaryRoots.push(root);
    const statePath = path.join(root, "state.json");
    const scheduled = scheduleNextAutomaticCheck(createInitialDesktopAutoUpdateState(), new Date("2026-08-13T00:00:00.000Z"));
    const staged = stageAutomaticCandidate(scheduled, candidate());
    const quarantined = markAutomaticCandidateStatus(staged, "update-1", "quarantined");
    const recovery = markAutomaticRecoveryRequired(quarantined, "candidate_and_lkg_failed");

    writeDesktopAutoUpdateState(statePath, recovery);
    const restored = readDesktopAutoUpdateState(statePath);
    expect(restored).toMatchObject({
      recoveryRequired: true,
      recoveryCode: "candidate_and_lkg_failed",
      candidate: { updateId: "update-1", status: "quarantined" },
    });
    expect(shouldRunAutomaticCheck(restored, new Date("2026-08-13T01:00:00.000Z"))).toBe(false);
  });
});
