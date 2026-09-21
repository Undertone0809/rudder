import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRustFoundationBridge,
  type RustFoundationBridge,
} from "./rust-foundation-bridge.js";

type FixtureMode = "invalid" | "not-ready" | "ready" | "ignore-term";

type Fixture = {
  binaryPath: string;
  modePath: string;
  pidPath: string;
  setMode(mode: FixtureMode): Promise<void>;
  readPid(): Promise<number>;
  remove(): Promise<void>;
};

const activeBridges = new Set<RustFoundationBridge>();
const activeFixtures = new Set<Fixture>();

function fixtureSource(modePath: string, pidPath: string) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
let server = null;
const shutdown = () => {
  if (!server) {
    process.exit(0);
    return;
  }
  server.closeAllConnections?.();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", () => {
  if (mode !== "ignore-term") shutdown();
});
if (mode === "invalid") {
  process.stdout.write("not-json\\n");
} else {
  server = http.createServer((req, res) => {
    if (req.url === "/readyz") {
      res.statusCode = mode === "not-ready" ? 503 : 200;
      res.end(mode === "not-ready" ? "not ready" : "ready");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") process.exit(2);
    process.stdout.write(JSON.stringify({
      boundAddr: "127.0.0.1:" + address.port,
      publicListener: false,
      productWriteAuthority: false,
    }) + "\\n");
  });
}
setInterval(() => {}, 1000);
`;
}

async function createFixture(initialMode: FixtureMode, executable = true): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rudder-rust-foundation-bridge-"));
  const binaryPath = join(root, "fixture-server-foundation");
  const modePath = join(root, "mode");
  const pidPath = join(root, "pid");
  await writeFile(modePath, `${initialMode}\n`, "utf8");
  await writeFile(binaryPath, fixtureSource(modePath, pidPath), "utf8");
  await chmod(binaryPath, executable ? 0o755 : 0o644);
  const fixture: Fixture = {
    binaryPath,
    modePath,
    pidPath,
    setMode: (mode) => writeFile(modePath, `${mode}\n`, "utf8"),
    readPid: async () => Number((await readFile(pidPath, "utf8")).trim()),
    remove: () => rm(root, { recursive: true, force: true }),
  };
  activeFixtures.add(fixture);
  return fixture;
}

function createBridge(fixture: Fixture) {
  const bridge = createRustFoundationBridge({
    databaseUrl: "postgres://bridge-test",
    mode: "required",
    binaryPath: fixture.binaryPath,
    actorEnvelopeKey: "bridge-test-secret",
    requestTimeoutMs: 25,
  });
  activeBridges.add(bridge);
  return bridge;
}

async function waitForProcessExit(pid: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

afterEach(async () => {
  await Promise.allSettled([...activeBridges].map((bridge) => bridge.close()));
  activeBridges.clear();
  await Promise.all([...activeFixtures].map((fixture) => fixture.remove()));
  activeFixtures.clear();
});

describe("rust foundation bridge lifecycle", () => {
  it("cleans up an invalid receipt and allows the same bridge to retry", async () => {
    const fixture = await createFixture("invalid");
    const bridge = createBridge(fixture);

    await expect(bridge.start()).rejects.toMatchObject({ code: "startup_failed" });
    const failedPid = await fixture.readPid();
    await waitForProcessExit(failedPid);

    await fixture.setMode("ready");
    await expect(bridge.start()).resolves.toBeUndefined();
    const readyPid = await fixture.readPid();
    expect(readyPid).not.toBe(failedPid);
    await bridge.close();
    await waitForProcessExit(readyPid);
  });

  it("cleans up after a ready timeout and allows a retry", async () => {
    const fixture = await createFixture("not-ready");
    const bridge = createBridge(fixture);

    await expect(bridge.start()).rejects.toMatchObject({ code: "not_ready" });
    const failedPid = await fixture.readPid();
    await waitForProcessExit(failedPid);

    await fixture.setMode("ready");
    await expect(bridge.start()).resolves.toBeUndefined();
    const readyPid = await fixture.readPid();
    await bridge.close();
    await waitForProcessExit(readyPid);
  }, 15_000);

  it("cleans up a spawn error and allows a retry", async () => {
    const fixture = await createFixture("ready", false);
    const bridge = createBridge(fixture);

    await expect(bridge.start()).rejects.toMatchObject({ code: "startup_failed" });

    await chmod(fixture.binaryPath, 0o755);
    await expect(bridge.start()).resolves.toBeUndefined();
    const readyPid = await fixture.readPid();
    await bridge.close();
    await waitForProcessExit(readyPid);
  });

  it("serializes close behind start and waits for SIGKILL exit", async () => {
    const fixture = await createFixture("ignore-term");
    const bridge = createBridge(fixture);

    const startPromise = bridge.start();
    const closePromise = bridge.close();
    await expect(startPromise).resolves.toBeUndefined();
    const pid = await fixture.readPid();

    const closeResult = await Promise.race([
      closePromise.then(() => "closed"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    expect(closeResult).toBe("pending");
    await expect(closePromise).resolves.toBeUndefined();
    await waitForProcessExit(pid);
  }, 10_000);
});
