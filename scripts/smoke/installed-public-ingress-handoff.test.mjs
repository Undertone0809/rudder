import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  detachAfterRecordedHandoff,
  parseDarwinProcessWitness,
  persistOwnedProcessHandoff,
  persistOwnedProcessStart,
} from "./installed-public-ingress-handoff.mjs";

const sourceSha = "755c273fe35fe28c36c37d598687d26dd09648d6";
const supportSha256 = "a".repeat(64);

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rudder-owned-handoff-test-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withSpawnedFixture(run) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    await once(child, "spawn");
    await run(child);
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
  }
}

function handoffInput(directory, child, overrides = {}) {
  return {
    directory,
    child,
    ownerId: "run-01:authenticated",
    kind: "server-supervisor",
    sourceSha,
    supportSha256,
    reason: "shutdown_unverified",
    ...overrides,
  };
}

describe("installed public ingress owned-process handoff", () => {
  it("records the live owner before readiness without granting detach or release", {
    skip: process.platform !== "darwin",
  }, async () => {
    await withTempDirectory(async (directory) => {
      await withSpawnedFixture(async (child) => {
        const receipt = await persistOwnedProcessStart(handoffInput(directory, child));
        assert.equal(receipt.record.schema, "rudder-owned-process-start-v1");
        assert.equal(receipt.record.state, "OWNED_RUNNING");
        assert.equal(receipt.record.pid, child.pid);
        assert.equal(receipt.record.originalParentPid, process.pid);
        assert.equal(receipt.record.releaseAllowed, false);
        assert.equal(receipt.record.reasonCategory, "spawn_observed");
        assert.ok(receipt.record.startBinding.osStartedAt);
        assert.equal((await stat(receipt.path)).mode & 0o777, 0o600);
        await assert.rejects(detachAfterRecordedHandoff(child, receipt), /not held unresolved/u);
      });
    });
  });
  it("parses only the Darwin PID, lstart, PPID, and comm witness", () => {
    assert.deepEqual(
      parseDarwinProcessWitness(" 4242 Sun Oct  4 11:12:13 2026 100 /usr/bin/node\n"),
      {
        pid: 4242,
        startedAt: "Sun Oct  4 11:12:13 2026",
        parentPid: 100,
        comm: "/usr/bin/node",
      },
    );
    assert.throws(() => parseDarwinProcessWitness(""), /exactly one process/u);
    assert.throws(
      () => parseDarwinProcessWitness("4242 Sun Oct  4 11:12:13 2026 100 node\n4243 Sun Oct  4 11:12:13 2026 100 node\n"),
      /exactly one process/u,
    );
  });

  it("persists an exclusive mode-0600 record with a secret-free OS start binding", {
    skip: process.platform !== "darwin",
  }, async () => {
    await withTempDirectory(async (directory) => {
      await withSpawnedFixture(async (child) => {
        const secret = `pcp_${"b".repeat(48)}`;
        const receipt = await persistOwnedProcessHandoff(handoffInput(directory, child, {
          reason: `untrusted detail ${secret}`,
        }));
        const persisted = JSON.parse(await readFile(receipt.path, "utf8"));
        const metadata = await stat(receipt.path);

        assert.equal(receipt.record.pid, child.pid);
        assert.equal(receipt.record.originalParentPid, process.pid);
        assert.equal(receipt.record.executable, child.spawnfile);
        assert.equal(receipt.record.ownerId, "run-01:authenticated");
        assert.equal(receipt.record.kind, "server-supervisor");
        assert.equal(receipt.record.parentOwner, "01a0c344-c53e-7432-917a-6be5be9dbbe3");
        assert.equal(receipt.record.state, "HELD_UNRESOLVED");
        assert.equal(receipt.record.releaseAllowed, false);
        assert.equal(receipt.record.reasonCategory, "shutdown_unverified");
        assert.equal(receipt.record.startBinding.pid, child.pid);
        assert.equal(receipt.record.startBinding.executable, child.spawnfile);
        assert.equal(receipt.record.startBinding.originalParentPid, process.pid);
        assert.equal(receipt.record.startBinding.osParentPid, process.pid);
        assert.ok(receipt.record.startBinding.osStartedAt.length > 0);
        assert.equal(path.basename(receipt.record.startBinding.osComm), path.basename(child.spawnfile));
        assert.equal(receipt.record.startBinding.observedAt, receipt.record.timestamp);
        assert.deepEqual(persisted, receipt.record);
        assert.equal(metadata.mode & 0o777, 0o600);
        assert.equal(Object.isFrozen(receipt.record), true);
        assert.equal(Object.hasOwn(receipt.record, "leaseExpiresAt"), false);
        assert.equal(Object.hasOwn(receipt.record, "expiresAt"), false);
        assert.equal(JSON.stringify(receipt.record).includes(secret), false);
        assert.deepEqual(receipt.record.recoveryPolicy.inspectBeforeSignals, ["exactPID", "executable", "startBinding"]);
        assert.equal(receipt.record.recoveryPolicy.maySignalUnknownProcess, false);
        assert.equal(receipt.record.recoveryPolicy.maySignalOriginalParentOrSupervisor, false);

        await assert.rejects(writeFile(receipt.path, "replacement", { flag: "wx" }), { code: "EEXIST" });
      });
    });
  });

  it("fails closed when Darwin OS identity observation is unavailable", {
    skip: process.platform === "darwin",
  }, async () => {
    await withTempDirectory(async (directory) => {
      const child = { pid: process.pid + 50_000, spawnfile: process.execPath };
      await assert.rejects(
        persistOwnedProcessHandoff(handoffInput(directory, child)),
        /Darwin process start observation is unavailable/u,
      );
    });
  });

  it("rejects invalid PID, owner, kind, digest, and executable inputs", async () => {
    await withTempDirectory(async (directory) => {
      const child = (overrides = {}) => ({
        pid: process.pid + 50_000,
        spawnfile: process.execPath,
        ...overrides,
      });
      await assert.rejects(persistOwnedProcessHandoff(handoffInput(directory, child({ pid: 0 }))), /positive safe integer/u);
      await assert.rejects(persistOwnedProcessHandoff(handoffInput(directory, child({ pid: process.pid }))), /current supervisor/u);
      await assert.rejects(persistOwnedProcessHandoff(handoffInput(directory, child({ spawnfile: "" }))), /executable is invalid/u);
      await assert.rejects(persistOwnedProcessHandoff(handoffInput(directory, child(), { ownerId: "" })), /ownerId must be a safe identifier/u);
      await assert.rejects(
        persistOwnedProcessHandoff(handoffInput(directory, child(), { kind: `pcp_${"c".repeat(48)}` })),
        /kind must not contain a bearer key/u,
      );
      await assert.rejects(
        persistOwnedProcessHandoff(handoffInput(directory, child(), { supportSha256: "not-a-digest" })),
        /supportSha256 must be a SHA-256 digest/u,
      );
      await assert.rejects(
        persistOwnedProcessHandoff(handoffInput(directory, child(), { sourceSha: "a".repeat(64) })),
        /sourceSha must be a Git commit SHA/u,
      );
    });
  });

  it("detaches only after matching the persisted child and never destroys streams or signals", {
    skip: process.platform !== "darwin",
  }, async () => {
    await withTempDirectory(async (directory) => {
      await withSpawnedFixture(async (realChild) => {
        const calls = [];
        const stream = {
          unref() { calls.push("stdio.unref"); },
          destroy() { calls.push("stdio.destroy"); },
        };
        const child = {
          pid: realChild.pid,
          spawnfile: realChild.spawnfile,
          stdin: stream,
          stdout: stream,
          stderr: stream,
          stdio: [stream],
          unref() { calls.push("child.unref"); },
          kill() { calls.push("child.kill"); throw new Error("handoff must not signal the child"); },
        };
        const receipt = await persistOwnedProcessHandoff(handoffInput(directory, child));
        assert.equal(await detachAfterRecordedHandoff(child, receipt), receipt);
        assert.equal(calls[0], "child.unref");
        assert.ok(calls.filter((call) => call === "stdio.unref").length >= 1);
        assert.equal(calls.includes("stdio.destroy"), false);
        assert.equal(calls.includes("child.kill"), false);
      });
    });
  });

  it("refuses detach when persisted identity, release state, or OS start witness differs", {
    skip: process.platform !== "darwin",
  }, async () => {
    await withTempDirectory(async (directory) => {
      await withSpawnedFixture(async (realChild) => {
        let unrefCount = 0;
        const child = {
          pid: realChild.pid,
          spawnfile: realChild.spawnfile,
          unref() { unrefCount += 1; },
        };
        const receipt = await persistOwnedProcessHandoff(handoffInput(directory, child));
        const forgedReceipt = {
          ...receipt,
          record: { ...receipt.record, releaseAllowed: true },
        };
        const changedWitness = {
          ...receipt.record,
          startBinding: { ...receipt.record.startBinding, osStartedAt: "" },
        };

        await assert.rejects(detachAfterRecordedHandoff(child, forgedReceipt), /differs from its receipt/u);
        await assert.rejects(
          detachAfterRecordedHandoff({ ...child, pid: child.pid + 1 }, receipt),
          /exact child/u,
        );
        await writeFile(receipt.path, JSON.stringify(changedWitness), { mode: 0o600 });
        await assert.rejects(detachAfterRecordedHandoff(child, { ...receipt, record: changedWitness }), /OS process-start witness/u);
        assert.equal(unrefCount, 0);
      });
    });
  });
});
