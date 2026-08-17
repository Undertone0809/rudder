import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assessDogfoodLedger,
  createDogfoodLedger,
  runPackagedDogfood,
} from "./local-app-dogfood-ledger.mjs";

const sourceSha = "a".repeat(40);
const artifactSha256 = "b".repeat(64);
const runtimeId = "macOS-arm64-packaged-Rudder-0.7.4";

async function executable(root: string, name: string, body: string): Promise<string> {
  const file = path.join(root, name);
  await writeFile(file, body, { mode: 0o700 });
  await chmod(file, 0o700);
  return file;
}

function acceptedCycle(cycleIndex: number, completedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    cycleIndex,
    status: "accepted",
    phase: "start_stop",
    sourceSha,
    artifactSha256,
    runtimeId,
    startedAt: completedAt,
    completedAt,
    evidence: {
      kind: "rudder_local_app_dogfood_cycle",
      cycleIndex,
      packaged: true,
      activation: "packaged",
      phase: "start_stop",
      accepted: true,
      ownershipVerified: true,
      cleanupProven: true,
      listenerLeak: false,
      descendantLeak: false,
      unresolvedP1: [],
      sourceSha,
      artifactSha256,
      runtimeId,
      ...overrides,
    },
  };
}

describe("Local App packaged dogfood ledger", () => {
  it("stays pending until the cycle and consecutive UTC-date gates are both satisfied", () => {
    const ledger = createDogfoodLedger({
      identity: { sourceSha, artifactSha256, runtimeId },
      target: { requiredCycles: 2, requiredDates: 2 },
      packagedExecutable: "/tmp/Rudder.app/Contents/MacOS/Rudder",
      packagedExecutableSha256: artifactSha256,
      packagedCommand: "/tmp/run-packaged-local-app-cycle",
      packagedCommandSha256: artifactSha256,
      environmentKeys: ["RUDDER_DOGFOOD_PACKAGED"],
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    ledger.cycles.push(acceptedCycle(0, "2026-08-13T12:01:00.000Z"));
    expect(assessDogfoodLedger(ledger)).toMatchObject({
      status: "pending",
      acceptedCycles: 1,
      distinctUtcDates: 1,
      contiguousUtcDates: true,
    });
    ledger.cycles.push(acceptedCycle(1, "2026-08-15T12:01:00.000Z"));
    expect(assessDogfoodLedger(ledger)).toMatchObject({
      status: "pending",
      acceptedCycles: 2,
      distinctUtcDates: 2,
      contiguousUtcDates: false,
    });
    ledger.cycles[1] = acceptedCycle(1, "2026-08-14T12:01:00.000Z");
    expect(assessDogfoodLedger(ledger)).toMatchObject({
      status: "passed",
      acceptedCycles: 2,
      distinctUtcDates: 2,
      contiguousUtcDates: true,
    });
  });

  it("fails closed for failed, duplicate, missing, and identity-mismatched cycles", () => {
    const ledger = createDogfoodLedger({
      identity: { sourceSha, artifactSha256, runtimeId },
      target: { requiredCycles: 2, requiredDates: 1 },
      packagedExecutable: "/tmp/Rudder.app/Contents/MacOS/Rudder",
      packagedExecutableSha256: artifactSha256,
      packagedCommand: "/tmp/run-packaged-local-app-cycle",
      packagedCommandSha256: artifactSha256,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    ledger.cycles.push(acceptedCycle(0, "2026-08-13T12:01:00.000Z"));
    ledger.cycles.push({
      cycleIndex: 2,
      status: "failed",
      sourceSha: "c".repeat(40),
      artifactSha256,
      runtimeId,
      startedAt: "2026-08-13T12:02:00.000Z",
      completedAt: "2026-08-13T12:03:00.000Z",
      failure: { code: "DOGFOOD_CYCLE_NOT_ACCEPTED" },
    });
    ledger.cycles.push(acceptedCycle(3, "2026-08-13T12:04:00.000Z"));
    expect(assessDogfoodLedger(ledger)).toMatchObject({
      status: "failed",
      acceptedCycles: 2,
      failures: [{ cycleIndex: 2, reason: "DOGFOOD_CYCLE_NOT_ACCEPTED" }],
      identityFailures: [2],
      missingIndexes: [1, 2],
    });
  });

  it("does not trust an accepted row whose packaged evidence was edited", () => {
    const ledger = createDogfoodLedger({
      identity: { sourceSha, artifactSha256, runtimeId },
      target: { requiredCycles: 1, requiredDates: 1 },
      packagedExecutable: "/tmp/Rudder.app/Contents/MacOS/Rudder",
      packagedExecutableSha256: artifactSha256,
      packagedCommand: "/tmp/run-packaged-local-app-cycle",
      packagedCommandSha256: artifactSha256,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    const cycle = acceptedCycle(0, "2026-08-13T12:01:00.000Z");
    cycle.evidence.cleanupProven = false;
    ledger.cycles.push(cycle);
    expect(assessDogfoodLedger(ledger)).toMatchObject({
      status: "failed",
      acceptedCycles: 0,
      failures: [{ cycleIndex: 0, reason: "DOGFOOD_CYCLE_NOT_ACCEPTED" }],
    });
  });

  it("requires explicit packaged activation and records a real cycle result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-local-app-dogfood-test-"));
    const ledgerPath = path.join(root, "ledger.json");
    const runner = await executable(root, "cycle-runner.mjs", `#!/usr/bin/env node
const index = Number(process.env.RUDDER_LOCAL_APP_DOGFOOD_CYCLE_INDEX);
process.stdout.write("RUDDER_LOCAL_APP_DOGFOOD_RESULT=" + JSON.stringify({
  kind: "rudder_local_app_dogfood_cycle",
  cycleIndex: index,
  packaged: true,
  activation: "packaged",
  phase: "start_stop",
  accepted: true,
  ownershipVerified: true,
  cleanupProven: true,
  listenerLeak: false,
  descendantLeak: false,
  unresolvedP1: [],
  sourceSha: process.env.RUDDER_LOCAL_APP_DOGFOOD_SOURCE_SHA,
  artifactSha256: process.env.RUDDER_LOCAL_APP_DOGFOOD_ARTIFACT_SHA256,
  runtimeId: process.env.RUDDER_LOCAL_APP_DOGFOOD_RUNTIME_ID
}) + "\\n");
`);
    const packagedExecutable = await executable(root, "Rudder", "#!/bin/sh\nexit 0\n");
    try {
      const first = await runPackagedDogfood({
        ledgerPath,
        command: runner,
        packagedExecutable,
        args: [],
        cycles: 1,
        target: { requiredCycles: 2, requiredDates: 2 },
        identity: { sourceSha, artifactSha256, runtimeId },
        explicitEnv: {
          RUDDER_DOGFOOD_PACKAGED: "1",
          RUDDER_DESKTOP_SMOKE_MODE: "packaged",
          RUDDER_DOGFOOD_PACKAGED_EXECUTABLE: packagedExecutable,
        },
        now: () => new Date("2026-08-13T12:01:00.000Z"),
      });
      expect(first.assessment).toMatchObject({ status: "pending", acceptedCycles: 1 });
      const second = await runPackagedDogfood({
        ledgerPath,
        command: runner,
        packagedExecutable,
        cycles: 1,
        target: { requiredCycles: 2, requiredDates: 2 },
        identity: { sourceSha, artifactSha256, runtimeId },
        explicitEnv: {
          RUDDER_DOGFOOD_PACKAGED: "1",
          RUDDER_DESKTOP_SMOKE_MODE: "packaged",
          RUDDER_DOGFOOD_PACKAGED_EXECUTABLE: packagedExecutable,
        },
        now: () => new Date("2026-08-14T12:01:00.000Z"),
      });
      expect(second.assessment).toMatchObject({
        status: "passed",
        acceptedCycles: 2,
        distinctUtcDates: 2,
        contiguousUtcDates: true,
      });
      expect(second.ledger.cycles).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a run that is not explicitly bound to packaged mode", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rudder-local-app-dogfood-test-"));
    const runner = await executable(root, "cycle-runner.mjs", "#!/bin/sh\nexit 0\n");
    const packagedExecutable = await executable(root, "Rudder", "#!/bin/sh\nexit 0\n");
    try {
      await expect(runPackagedDogfood({
        ledgerPath: path.join(root, "ledger.json"),
        command: runner,
        packagedExecutable,
        identity: { sourceSha, artifactSha256, runtimeId },
        explicitEnv: { RUDDER_DESKTOP_SMOKE_MODE: "dev" },
      })).rejects.toThrow(/requires RUDDER_DOGFOOD_PACKAGED=1/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("revalidates persisted accepted evidence before counting a cycle", () => {
    const ledger = createDogfoodLedger({
      identity: { sourceSha, artifactSha256, runtimeId },
      target: { requiredCycles: 1, requiredDates: 1 },
      packagedExecutable: "/tmp/Rudder.app/Contents/MacOS/Rudder",
      packagedExecutableSha256: artifactSha256,
      packagedCommand: "/tmp/run-packaged-local-app-cycle",
      packagedCommandSha256: artifactSha256,
      now: new Date("2026-08-13T12:00:00.000Z"),
    });
    ledger.cycles.push(acceptedCycle(0, "2026-08-13T12:01:00.000Z", { cleanupProven: false }));
    expect(assessDogfoodLedger(ledger)).toMatchObject({
      status: "failed",
      acceptedCycles: 0,
      failures: [{ cycleIndex: 0, reason: "DOGFOOD_CYCLE_NOT_ACCEPTED" }],
    });
  });
});
