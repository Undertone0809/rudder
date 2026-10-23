import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startPostgresOwner } from "./postgres-owner.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type FixtureMode = "normal" | "wrong-lease" | "refuse" | "premature-ack" | "abort-before-ready" | "never-ready" | "hang-stop" | "early-exit"
  | "signal-cleaned" | "signal-wrong-lease" | "signal-wrong-instance" | "signal-wrong-owner" | "signal-wrong-path" | "signal-same-chunk" | "signal-before-ready";

async function fixture(mode: FixtureMode) {
  const root = await mkdtemp(path.join(os.tmpdir(), "rudder-owner-transport-"));
  roots.push(root);
  const binary = path.join(root, "owner");
  await writeFile(binary, `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = ${JSON.stringify(mode)};
let started = false;
let startRequest;
let keepAlive;
function writeReady() {
  process.stdout.write(JSON.stringify({schema: startRequest.schema, op: 'ready', instance_id: startRequest.instance_id, lease_id: 'lease', data_dir: startRequest.data_dir,
    port: startRequest.port, postgres_version: '18.4', connection_string: 'postgres://test', bin_dir: startRequest.bin_dir,
    cluster_created: false, database_created: false, owned: false}) + '\\n');
}
function writeSignalStopped(overrides = {}) {
  const frame = {schema: startRequest.schema, op: 'signal_stopped', signal: 'SIGTERM',
    instance_id: startRequest.instance_id, lease_id: 'lease', data_dir: startRequest.data_dir,
    port: startRequest.port, owner_pid: process.pid, ...overrides};
  process.stdout.write(JSON.stringify(frame) + '\\n');
  process.exitCode = 0;
  rl.close(); process.stdin.destroy();
}
function writeStopped(lease = 'lease') {
  process.stdout.write(JSON.stringify({schema: startRequest.schema, op: 'stopped', lease_id: lease}) + '\\n');
  process.exitCode = mode === 'abort-before-ready' ? 1 : 0;
  rl.close(); process.stdin.destroy();
}
rl.on('line', line => {
  const request = JSON.parse(line);
  if (!started) {
    started = true; startRequest = request;
    if (mode === 'refuse') {
      process.stderr.write('unstructured child stderr must stay hidden: DO_NOT_FORWARD_THIS_SECRET\\n');
      process.stdout.write(JSON.stringify({schema: request.schema, op: 'error', code: 'initdb_failed',
        message: 'initdb exited unsuccessfully\\nRecent PostgreSQL startup output:\\nFATAL: password=[REDACTED]'}) + '\\n');
      process.exitCode = 1; rl.close(); process.stdin.destroy(); return;
    }
    if (mode === 'early-exit') { process.exitCode = 0; rl.close(); process.stdin.destroy(); return; }
    if (mode === 'never-ready' || mode === 'abort-before-ready') {
      keepAlive = setInterval(() => {}, 1000);
      return;
    }
    if (mode === 'premature-ack') {
      const ready = {schema: request.schema, op: 'ready', instance_id: request.instance_id, lease_id: 'lease', data_dir: request.data_dir,
        port: request.port, postgres_version: '18.4', connection_string: 'postgres://test', bin_dir: request.bin_dir,
        cluster_created: false, database_created: false, owned: false};
      const stopped = {schema: request.schema, op: 'stopped', lease_id: 'lease'};
      process.stdout.write(JSON.stringify(ready) + '\\n' + JSON.stringify(stopped) + '\\n');
      return;
    }
    if (mode === 'signal-before-ready') {
      writeSignalStopped();
      return;
    }
    if (mode === 'signal-same-chunk') {
      const ready = {schema: request.schema, op: 'ready', instance_id: request.instance_id, lease_id: 'lease', data_dir: request.data_dir,
        port: request.port, postgres_version: '18.4', connection_string: 'postgres://test', bin_dir: request.bin_dir,
        cluster_created: false, database_created: false, owned: false};
      const stopped = {schema: request.schema, op: 'signal_stopped', signal: 'SIGTERM', instance_id: request.instance_id,
        lease_id: 'lease', data_dir: request.data_dir, port: request.port, owner_pid: process.pid};
      process.stdout.write(JSON.stringify(ready) + '\\n' + JSON.stringify(stopped) + '\\n');
      process.exitCode = 0; rl.close(); process.stdin.destroy();
      return;
    }
    if (mode.startsWith('signal-')) {
      writeReady();
      setTimeout(() => {
        const overrides = mode === 'signal-wrong-lease' ? {lease_id: 'stale-lease'}
          : mode === 'signal-wrong-instance' ? {instance_id: 'other-instance'}
          : mode === 'signal-wrong-owner' ? {owner_pid: process.pid + 1}
          : mode === 'signal-wrong-path' ? {data_dir: startRequest.data_dir + '-other'}
          : {};
        writeSignalStopped(overrides);
      }, 30);
      return;
    }
    if (mode === 'hang-stop') {
      keepAlive = setInterval(() => {}, 1000);
      writeReady();
      return;
    }
    writeReady();
    return;
  }
  if (request.op === 'stop') {
    if (mode === 'hang-stop') return;
    writeStopped(mode === 'wrong-lease' ? 'other' : request.lease_id);
  }
});
rl.on('close', () => {
  if (mode === 'abort-before-ready' && started) {
    clearInterval(keepAlive);
    process.stdout.write(JSON.stringify({schema: startRequest.schema, op: 'error', code: 'protocol_start_cancelled'}) + '\\n');
    process.exitCode = 1; process.stdin.destroy(); return;
  }
  if ((mode === 'never-ready' || mode === 'hang-stop') && started) {
    clearInterval(keepAlive);
    setTimeout(() => process.exit(0), 250);
  }
  if (mode === 'premature-ack' && started) setTimeout(() => process.exit(0), 25);
});
`);
  await chmod(binary, 0o755);
  return { binaryPath: binary, binDir: root, dataDir: root, port: 55432, instanceId: "test" };
}

async function letChildExit() {
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 350));
}

describe.skipIf(process.platform === "win32")("Rust PostgreSQL owner transport", () => {
  it("waits for the matching cleanup acknowledgement and shares concurrent stop", async () => {
    const owner = await startPostgresOwner(await fixture("normal"));
    expect(owner.owned).toBe(false);
    const first = owner.stop();
    expect(owner.stop()).toBe(first);
    await first;
  });

  it("rejects a different cleanup lease even when the process exits successfully", async () => {
    const owner = await startPostgresOwner(await fixture("wrong-lease"));
    await expect(owner.stop()).rejects.toThrow("without confirmed cleanup");
  });

  it("does not accept a matching stopped acknowledgement before cleanup was requested", async () => {
    await expect(startPostgresOwner(await fixture("premature-ack"))).rejects.toThrow("Invalid PostgreSQL owner response");
  });

  it("accepts an exact SIGTERM cleanup proof and reports the unexpected exit after recording it", async () => {
    let owner: Awaited<ReturnType<typeof startPostgresOwner>> | undefined;
    let stopFromCallback: Promise<void> | undefined;
    const onUnexpectedExit = vi.fn(() => {
      if (owner) stopFromCallback = owner.stop();
    });
    owner = await startPostgresOwner({ ...(await fixture("signal-cleaned")), onUnexpectedExit });

    await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledTimes(1));
    expect(onUnexpectedExit).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("confirmed session cleanup"),
    }));
    if (!stopFromCallback) throw new Error("cleanup was not confirmed before the unexpected-exit callback");
    await expect(stopFromCallback).resolves.toBeUndefined();
    await expect(owner.stop()).resolves.toBeUndefined();
  });

  it.each(["signal-wrong-lease", "signal-wrong-instance", "signal-wrong-owner", "signal-wrong-path"] as const)(
    "rejects stale or mismatched SIGTERM cleanup proof: %s",
    async (mode) => {
      let unexpectedExit: Error | undefined;
      const owner = await startPostgresOwner({
        ...(await fixture(mode)),
        onUnexpectedExit: (error) => { unexpectedExit = error; },
      });

      await vi.waitFor(() => expect(unexpectedExit).toBeInstanceOf(Error));
      expect(unexpectedExit?.message).toBe("Invalid PostgreSQL owner response");
      await expect(owner.stop()).rejects.toThrow("Invalid PostgreSQL owner response");
    },
  );

  it("does not report ready when SIGTERM cleanup arrives in the same protocol chunk", async () => {
    const onUnexpectedExit = vi.fn();
    await expect(startPostgresOwner({
      ...(await fixture("signal-same-chunk")),
      onUnexpectedExit,
    })).rejects.toThrow("received SIGTERM and confirmed session cleanup");
    expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
  });

  it("rejects SIGTERM cleanup proof before a matching ready frame", async () => {
    await expect(startPostgresOwner(await fixture("signal-before-ready"))).rejects.toThrow("Invalid PostgreSQL owner response");
  });

  it("rejects startup promptly when aborted and accepts the exact Rust cancellation completion", async () => {
    const controller = new AbortController();
    const starting = startPostgresOwner({ ...(await fixture("abort-before-ready")), signal: controller.signal });
    controller.abort();
    await expect(starting).rejects.toThrow(/aborted/i);
  });

  it("uses the cleanup handshake when aborted after readiness", async () => {
    const controller = new AbortController();
    const owner = await startPostgresOwner({ ...(await fixture("normal")), signal: controller.signal });
    controller.abort();
    await owner.stop();
  });

  it("preserves startup timeout and reports bounded cleanup failure when the owner never closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const starting = startPostgresOwner(await fixture("never-ready"));
    const rejection = expect(starting).rejects.toMatchObject({ message: expect.stringMatching(/startup timed out; cleanup failed:.*cleanup confirmation timed out/) });
    await vi.runAllTimersAsync();
    await rejection;
    await letChildExit();
  });

  it("bounds ordinary stop confirmation when the owner omits its acknowledgement", async () => {
    const owner = await startPostgresOwner(await fixture("hang-stop"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stopping = owner.stop();
    const rejection = expect(stopping).rejects.toThrow("cleanup confirmation timed out");
    await vi.runAllTimersAsync();
    await rejection;
    await letChildExit();
  });

  it("rejects spawn errors and early exits without readiness", async () => {
    const missing = await fixture("normal");
    await expect(startPostgresOwner({ ...missing, binaryPath: path.join(path.dirname(missing.binaryPath), "missing") })).rejects.toThrow();
    await expect(startPostgresOwner(await fixture("early-exit"))).rejects.toThrow(/exited without confirmed cleanup|control pipe closed/);
  });

  it("forwards the Rust owner's safe startup diagnostic without forwarding child stderr", async () => {
    let failure: unknown;
    try { await startPostgresOwner(await fixture("refuse")); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as Error).message).toContain("initdb_failed");
    expect((failure as Error).message).toContain("FATAL: password=[REDACTED]");
    expect((failure as Error).message).not.toContain("DO_NOT_FORWARD_THIS_SECRET");
  });
});
