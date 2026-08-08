import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stopOwnedE2EServer } from "../tests/e2e/support/e2e-postgres-cleanup.ts";

const repositoryRoot = process.cwd();
let testRoot = null;
let serverProcess = null;

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    probe.close();
    throw new Error("Could not allocate a test port");
  }
  const port = address.port;
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForListening(port) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for test server on port ${port}`);
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for test server exit")), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

afterEach(async () => {
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    serverProcess.kill("SIGKILL");
    await waitForExit(serverProcess).catch(() => undefined);
  }
  serverProcess = null;
  if (testRoot) await fs.rm(testRoot, { recursive: true, force: true });
  testRoot = null;
});

describe("stopOwnedE2EServer", () => {
  it.skipIf(process.platform === "win32")("reclaims a server from runtime descriptor when server.pid is absent", async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-e2e-cleanup-"));
    const instanceRoot = path.join(testRoot, "instances", "test");
    await fs.mkdir(path.join(instanceRoot, "runtime"), { recursive: true });
    const port = await freePort();
    await fs.writeFile(path.join(instanceRoot, "config.json"), JSON.stringify({ server: { port } }), "utf8");

    serverProcess = spawn(
      process.execPath,
      [
        "-e",
        "const net = require('node:net'); const port = Number(process.argv[1]); net.createServer().listen(port, '127.0.0.1');",
        String(port),
        "--dir",
        path.join(repositoryRoot, "server"),
      ],
      { cwd: repositoryRoot, stdio: "ignore" },
    );
    if (!serverProcess.pid) throw new Error("Test server did not expose a PID");
    await waitForListening(port);
    await fs.writeFile(path.join(instanceRoot, "runtime", "server.json"), JSON.stringify({ pid: serverProcess.pid }), "utf8");

    const stopped = await stopOwnedE2EServer({ instanceRoot, repositoryRoot });

    expect(stopped).toContain(String(serverProcess.pid));
    await waitForExit(serverProcess);
  });
});
