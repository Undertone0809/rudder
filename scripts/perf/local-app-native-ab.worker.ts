import { mkdir } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import process from "node:process";
import { createInterface } from "node:readline";
import { LocalAppRegistry } from "../../desktop/src/local-apps-registry.js";
import { LocalAppRuntimeManager } from "../../desktop/src/local-apps-runtime.js";
import type { LocalAppBenchmarkArm } from "./local-app-native-ab.helpers.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1]!;
}

async function waitForGo(): Promise<void> {
  process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid })}\n`);
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (line.trim() === "go") {
      lines.close();
      return;
    }
  }
  throw new Error("benchmark coordinator disconnected before go");
}

async function waitForPortClosed(origin: string): Promise<boolean> {
  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline) {
    try {
      await fetch(`${origin}/health`, { signal: AbortSignal.timeout(200) });
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function main(): Promise<void> {
  const arm = argument("--arm") as LocalAppBenchmarkArm;
  if (arm !== "node_baseline" && arm !== "rust_candidate") throw new Error("Invalid arm");
  const root = path.resolve(argument("--root"));
  const fixturePath = path.resolve(argument("--fixture"));
  const expectedBody = argument("--expected-body");
  const pressureMs = Number.parseInt(argument("--pressure-ms"), 10);
  const rustHostPath = path.resolve(argument("--rust-host"));
  await mkdir(root, { recursive: true });
  const registry = new LocalAppRegistry({
    registryPath: path.join(root, "local-apps.json"),
    installationId: `native-ab-${arm}`,
  });
  const prepared = await registry.prepareDefinition({
    title: `Local App native A/B ${arm}`,
    executable: process.execPath,
    argv: [fixturePath],
    cwd: root,
    inheritedEnvNames: [],
    readiness: { path: "/health", timeoutMs: 5_000 },
    openPath: "/app",
  });
  const definition = await registry.createDefinition({ ...prepared, trustFingerprint: prepared.trustFingerprint });
  await registry.approveDefinition(definition.id, definition.trustFingerprint);
  const events: Array<{ type: string; monotonicNs: bigint }> = [];
  const manager = new LocalAppRuntimeManager({
    registry,
    useNativeProcessHost: arm === "rust_candidate",
    nativeProcessHostPath: rustHostPath,
    nativeRuntimeRoot: path.join(root, "native-runtime"),
    observeLifecycleEvent: (event) => events.push({ type: event.type, monotonicNs: event.monotonicNs }),
  });
  await waitForGo();
  const heapBefore = process.memoryUsage().heapUsed;
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  try {
    const startEpochMs = Date.now();
    const startNs = process.hrtime.bigint();
    const running = await manager.start(definition.id);
    const readyNs = process.hrtime.bigint();
    if (!running.origin) throw new Error(`${arm} did not expose a verified origin`);
    const response = await fetch(`${running.origin}/app`);
    const content = await response.text();
    if (pressureMs > 0) await new Promise((resolve) => setTimeout(resolve, pressureMs));
    const logs = await manager.logs(definition.id);
    const stopStartNs = process.hrtime.bigint();
    const stopped = await manager.stop(definition.id);
    const terminalNs = process.hrtime.bigint();
    const stopAccepted = events.find((event) => event.type === "stop-accepted"
      && event.monotonicNs >= stopStartNs);
    const descriptorCleared = await registry.getRuntimeDescriptor(definition.id) === null;
    const portClosed = await waitForPortClosed(running.origin);
    const correctnessPassed = response.status === 200
      && content === expectedBody
      && stopped.status === "stopped"
      && descriptorCleared
      && portClosed
      && Boolean(stopAccepted);
    eventLoopDelay.disable();
    process.stdout.write(`${JSON.stringify({
      type: "result",
      startEpochMs,
      readyMs: Number(readyNs - startNs) / 1e6,
      stopAdmissionMs: stopAccepted ? Number(stopAccepted.monotonicNs - stopStartNs) / 1e6 : null,
      terminalCleanupMs: Number(terminalNs - stopStartNs) / 1e6,
      eventLoopDelayP95Ms: Number(eventLoopDelay.percentile(95)) / 1e6,
      responseBytes: Buffer.byteLength(content),
      logBytes: Buffer.byteLength(logs.join("\n")),
      heapUsedBeforeBytes: heapBefore,
      heapUsedAfterBytes: process.memoryUsage().heapUsed,
      httpStatus: response.status,
      descriptorCleared,
      portClosed,
      correctnessPassed,
    })}\n`);
    if (!correctnessPassed) process.exitCode = 2;
  } finally {
    eventLoopDelay.disable();
    await manager.shutdown().catch(() => undefined);
  }
}

await main();
