import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export class ListenerObservationUnavailable extends Error {}

function assertValidIdentity(port, pid) {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "invalid owned port");
  assert.ok(Number.isSafeInteger(pid) && pid > 0, "invalid expected owner PID");
}

export function assertLoopbackListener(output, { port, pid }) {
  assertValidIdentity(port, pid);
  const owners = [];
  let current = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      current = { pid: Number(line.slice(1)), addresses: [] };
      owners.push(current);
    } else if (line.startsWith("n") && current) {
      current.addresses.push(line.slice(1));
    }
  }
  assert.equal(owners.length, 1, "listener must have exactly one OS process owner");
  assert.equal(owners[0].pid, pid, "OS listener owner differs from supervised process");
  assert.ok(owners[0].addresses.length > 0, "listener has no observed address");
  assert.ok(
    owners[0].addresses.every((address) => address === `127.0.0.1:${port}`),
    "disposable listener is not exclusively on the expected loopback address",
  );
  return { port, pid, address: `127.0.0.1:${port}` };
}

export async function observeListener(port, pid, execute = execFileAsync, signal) {
  assertValidIdentity(port, pid);
  let result;
  try {
    result = await execute(
      "lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, signal },
    );
  } catch (error) {
    // lsof exit 1 with empty output is a valid negative socket observation.
    // Timeout, permission, launch, and diagnostic failures cannot prove absence.
    if (error.code === 1 && !error.killed && !error.signal
      && !(error.stdout ?? "").trim() && !(error.stderr ?? "").trim()) {
      assert.fail("no OS listener observed on the expected owned port");
    }
    throw new ListenerObservationUnavailable("OS listener observation failed or unavailable", { cause: error });
  }
  return assertLoopbackListener(result.stdout, { port, pid });
}

export function assertProcessObservation(textFiles, parentOutput, { pid, parentPid, executable }) {
  assert.equal(parentOutput.trim(), String(parentPid), "OS process ancestry differs from supervised parent");
  const lines = textFiles.trim().split("\n");
  assert.ok(lines.includes(`p${pid}`), "OS executable observation is missing its expected PID");
  assert.ok(lines.includes(`n${executable}`), "OS executable does not match the receipt-bound executable path");
  return { pid, parentPid, executable };
}

async function observeProcess(pid, parentPid, executable, signal) {
  const canonicalExecutable = await realpath(executable);
  let textFiles;
  let parent;
  try {
    textFiles = await execFileAsync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fpn"],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, signal });
    parent = await execFileAsync("ps", ["-p", String(pid), "-o", "ppid="],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, signal });
  } catch (error) {
    if (error.code === 1 && !error.killed && !error.signal
      && !(error.stdout ?? "").trim() && !(error.stderr ?? "").trim()) {
      assert.fail("no OS executable or parent observed for the expected owned PID");
    }
    throw new ListenerObservationUnavailable("OS executable/ancestry observation failed or unavailable", { cause: error });
  }
  return assertProcessObservation(textFiles.stdout, parent.stdout,
    { pid, parentPid, executable: canonicalExecutable });
}

export async function assertInstalledListenerOwnership({
  publicPort, privatePort, rustPid, nodePid, rustExecutable, nodeExecutable, nodeParentPid,
}, { signal } = {}) {
  assert.notEqual(publicPort, privatePort, "public and private sockets must be distinct");
  assert.notEqual(rustPid, nodePid, "Rust and Node process identities must be distinct");
  return {
    public: await observeListener(publicPort, rustPid, execFileAsync, signal),
    private: await observeListener(privatePort, nodePid, execFileAsync, signal),
    rustProcess: await observeProcess(rustPid, nodePid, rustExecutable, signal),
    nodeProcess: await observeProcess(nodePid, nodeParentPid, nodeExecutable, signal),
  };
}
