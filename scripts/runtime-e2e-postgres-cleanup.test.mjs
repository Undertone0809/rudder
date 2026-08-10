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
let postgresPid = null;

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

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isPidRunning(pid)) throw new Error(`Timed out waiting for process ${pid} exit`);
}

afterEach(async () => {
  if (postgresPid !== null && isPidRunning(postgresPid)) {
    process.kill(postgresPid, "SIGKILL");
    await waitForPidExit(postgresPid).catch(() => undefined);
  }
  postgresPid = null;
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

  it.skipIf(process.platform === "win32")("reclaims a server discovered through its owned PostgreSQL child", async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-e2e-cleanup-"));
    const instanceRoot = path.join(testRoot, "instances", "test");
    const dataDirectory = path.join(instanceRoot, "db");
    const readyPath = path.join(testRoot, "server-ready");
    await fs.mkdir(dataDirectory, { recursive: true });
    await fs.writeFile(path.join(instanceRoot, "config.json"), JSON.stringify({ server: {} }), "utf8");

    const serverScript = [
      "const fs = require('node:fs');",
      "const { spawn } = require('node:child_process');",
      "const dataDirectory = process.argv[1];",
      "const readyPath = process.argv[2];",
      "const postgresProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'postgres', '-D', dataDirectory], { stdio: 'ignore' });",
      "if (!postgresProcess.pid) throw new Error('PostgreSQL process did not expose a PID');",
      "fs.writeFileSync(readyPath, String(postgresProcess.pid));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    serverProcess = spawn(
      process.execPath,
      ["-e", serverScript, dataDirectory, readyPath, "--dir", path.join(repositoryRoot, "server")],
      { cwd: repositoryRoot, stdio: "ignore" },
    );
    if (!serverProcess.pid) throw new Error("Test server did not expose a PID");
    const readyDeadline = Date.now() + 5_000;
    while (Date.now() < readyDeadline) {
      try {
        await fs.access(readyPath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    await fs.access(readyPath);
    postgresPid = Number(await fs.readFile(readyPath, "utf8"));
    if (!Number.isInteger(postgresPid) || postgresPid <= 0) throw new Error("Test PostgreSQL process did not expose a valid PID");

    const stopped = await stopOwnedE2EServer({ instanceRoot, repositoryRoot });

    expect(stopped).toContain(String(serverProcess.pid));
    await waitForPidExit(postgresPid);
    await waitForExit(serverProcess);
  });
});
