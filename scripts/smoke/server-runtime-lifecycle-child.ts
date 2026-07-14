import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";

const SUCCESS_MARKER = "SERVER_RUNTIME_LIFECYCLE_OK";

function requiredPort(name: string): number {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function assertPortBindable(port: number): Promise<void> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => {
      probe.off("error", reject);
      resolve();
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
}

async function main(): Promise<void> {
  const apiPort = requiredPort("RUDDER_LIFECYCLE_API_PORT");
  const configuredDbPort = requiredPort("RUDDER_EMBEDDED_POSTGRES_PORT");
  const instanceId = process.env.RUDDER_INSTANCE_ID ?? "runtime-lifecycle-smoke";
  const signalListenerBaseline = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };
  let stoppedSignalListenerCounts: typeof signalListenerBaseline | null = null;

  const [{ startServer }, { resolveLocalRuntimePaths }] = await Promise.all([
    import("../../server/src/index.js"),
    import("../../server/src/local-runtime.js"),
  ]);
  const descriptorPath = resolveLocalRuntimePaths(instanceId).descriptorPath;

  async function runOnce(): Promise<number> {
    const handle = await startServer({
      runtimeOwnerKind: "server",
      openOnListen: false,
      printBanner: false,
      runtimeOverrides: {
        host: "127.0.0.1",
        port: apiPort,
        serveUi: false,
        uiDevMiddleware: false,
        heartbeatSchedulerEnabled: false,
        databaseBackupEnabled: false,
      },
    });

    const health = await fetch(`${handle.apiUrl}/api/health`).then(async (response) => {
      assert.equal(response.status, 200);
      return response.json() as Promise<{ status: string }>;
    });
    assert.equal(health.status, "ok");
    assert.equal(existsSync(descriptorPath), true);

    const socket = new WebSocket(
      `ws://127.0.0.1:${handle.listenPort}/api/orgs/runtime-lifecycle-smoke/events/ws`,
    );
    await withTimeout(once(socket, "open"), 5_000, "WebSocket open");
    const socketClosed = once(socket, "close");

    await Promise.all([handle.stop(), handle.dispose(), handle.stop()]);
    await withTimeout(socketClosed, 5_000, "WebSocket close");

    assert.equal(existsSync(descriptorPath), false);
    const signalListenerCounts = {
      SIGINT: process.listenerCount("SIGINT"),
      SIGTERM: process.listenerCount("SIGTERM"),
    };
    assert.equal(
      process.listeners("SIGINT").some((listener) => listener.name === "handleSigint"),
      false,
    );
    assert.equal(
      process.listeners("SIGTERM").some((listener) => listener.name === "handleSigterm"),
      false,
    );
    if (!stoppedSignalListenerCounts) {
      assert.ok(signalListenerCounts.SIGINT <= signalListenerBaseline.SIGINT + 1);
      assert.ok(signalListenerCounts.SIGTERM <= signalListenerBaseline.SIGTERM + 1);
      stoppedSignalListenerCounts = signalListenerCounts;
    } else {
      assert.deepEqual(signalListenerCounts, stoppedSignalListenerCounts);
    }

    const databasePort = Number(new URL(handle.databaseUrl).port);
    assert.ok(Number.isInteger(databasePort) && databasePort > 0);
    await assertPortBindable(handle.listenPort);
    await assertPortBindable(databasePort);
    return databasePort;
  }

  const firstDatabasePort = await runOnce();
  assert.equal(firstDatabasePort, configuredDbPort);
  const secondDatabasePort = await runOnce();
  assert.equal(secondDatabasePort, configuredDbPort);
  await assertPortBindable(apiPort);
  await assertPortBindable(configuredDbPort);

  console.log(SUCCESS_MARKER);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
  setTimeout(() => {
    process.kill(process.pid, "SIGTERM");
  }, 0);
});
