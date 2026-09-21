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
  envPath: string;
  setMode(mode: FixtureMode): Promise<void>;
  readEnv(): Promise<Record<string, string>>;
  readPid(): Promise<number>;
  remove(): Promise<void>;
};

const activeBridges = new Set<RustFoundationBridge>();
const activeFixtures = new Set<Fixture>();

function fixtureSource(modePath: string, pidPath: string, envPath: string) {
  return `#!${process.execPath}
const fs = require("node:fs");
const http = require("node:http");
const mode = fs.readFileSync(${JSON.stringify(modePath)}, "utf8").trim();
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify(process.env));
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
  const envPath = join(root, "env.json");
  await writeFile(modePath, `${initialMode}\n`, "utf8");
  await writeFile(binaryPath, fixtureSource(modePath, pidPath, envPath), "utf8");
  await chmod(binaryPath, executable ? 0o755 : 0o644);
  const fixture: Fixture = {
    binaryPath,
    modePath,
    pidPath,
    envPath,
    setMode: (mode) => writeFile(modePath, `${mode}\n`, "utf8"),
    readEnv: async () => JSON.parse(await readFile(envPath, "utf8")) as Record<string, string>,
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
  it("passes only the foundation startup environment to the child", async () => {
    const previousEnv = {
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      DATABASE_URL: process.env.DATABASE_URL,
      RUDDER_PRIVATE_TEST_SECRET: process.env.RUDDER_PRIVATE_TEST_SECRET,
    };
    process.env.AWS_SECRET_ACCESS_KEY = "should-not-reach-rust";
    process.env.DATABASE_URL = "postgres://unrelated-parent-secret";
    process.env.RUDDER_PRIVATE_TEST_SECRET = "should-not-reach-rust-either";

    try {
      const fixture = await createFixture("ready");
      const bridge = createBridge(fixture);

      await expect(bridge.start()).resolves.toBeUndefined();
      const childEnv = await fixture.readEnv();
      const requiredEnv = {
        RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: "bridge-test-secret",
        RUDDER_NATIVE_DATABASE_REQUIRED: "true",
        RUDDER_NATIVE_DATABASE_URL: "postgres://bridge-test",
        RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
      };
      expect(childEnv).toMatchObject(requiredEnv);
      expect(Object.keys(childEnv).filter((name) => (
        !(name in requiredEnv) && name !== "__CF_USER_TEXT_ENCODING"
      ))).toEqual([]);
      expect(childEnv).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
      expect(childEnv).not.toHaveProperty("DATABASE_URL");
      expect(childEnv).not.toHaveProperty("RUDDER_PRIVATE_TEST_SECRET");
    } finally {
      for (const [name, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

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
