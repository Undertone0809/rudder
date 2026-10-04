import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLoopbackListener,
  assertProcessObservation,
  ListenerObservationUnavailable,
  observeListener,
} from "./installed-public-ingress-listeners.mjs";

test("OS listener proof binds exact loopback port to expected PID", () => {
  assert.deepEqual(assertLoopbackListener("p123\nf8\nn127.0.0.1:32001\n", { port: 32001, pid: 123 }),
    { port: 32001, pid: 123, address: "127.0.0.1:32001" });
});

test("process proof binds executable text path and exact parent without reading argv", () => {
  const expected = { pid: 123, parentPid: 122, executable: "/isolated/install/rust" };
  assert.deepEqual(assertProcessObservation("p123\nn/isolated/install/rust\nn/system/library", " 122\n", expected), expected);
  assert.throws(() => assertProcessObservation("p123\nn/other/rust", "122", expected));
  assert.throws(() => assertProcessObservation("p124\nn/isolated/install/rust", "122", expected));
  assert.throws(() => assertProcessObservation("p123\nn/isolated/install/rust", "999", expected));
});
test("wrong process, duplicate owner, public bind and absent evidence reject", () => {
  for (const output of [
    "p124\nn127.0.0.1:32001\n",
    "p123\nn127.0.0.1:32001\np124\nn127.0.0.1:32001\n",
    "p123\nn*:32001\n",
    "p123\nn127.0.0.1:32001\nn*:32001\n",
    "p123\nn127.0.0.1:32002\n",
    "p123\n",
    "",
  ]) assert.throws(() => assertLoopbackListener(output, { port: 32001, pid: 123 }));
});

test("launch, permission, timeout and diagnostic failures are unavailable observations", async () => {
  for (const detail of [
    { code: "ENOENT" },
    { code: "EACCES" },
    { killed: true, signal: "SIGTERM" },
    { code: 1, stdout: "", stderr: "cannot observe process" },
    { code: 2, stdout: "", stderr: "" },
  ]) {
    await assert.rejects(
      observeListener(32001, 123, async () => { throw Object.assign(new Error("observer failed"), detail); }),
      ListenerObservationUnavailable,
    );
  }
});

test("valid no-listener and wrong-owner observations remain failures, not QUESTION", async () => {
  for (const execute of [
    async () => { throw Object.assign(new Error("no matches"), { code: 1, stdout: "", stderr: "" }); },
    async () => ({ stdout: "p124\nn127.0.0.1:32001\n" }),
  ]) {
    await assert.rejects(observeListener(32001, 123, execute), (error) =>
      error instanceof assert.AssertionError && !(error instanceof ListenerObservationUnavailable));
  }
});

test("invalid identities reject before calling the observer", async () => {
  let calls = 0;
  await assert.rejects(observeListener(0, 123, async () => { calls += 1; }));
  await assert.rejects(observeListener(32001, 0, async () => { calls += 1; }));
  assert.equal(calls, 0);
});

test("successful observation requests only the exact listening port", async () => {
  const observation = await observeListener(32001, 123, async (command, args, options) => {
    assert.equal(command, "lsof");
    assert.deepEqual(args, ["-nP", "-a", "-iTCP:32001", "-sTCP:LISTEN", "-Fpn"]);
    assert.equal(options.timeout, 10000);
    return { stdout: "p123\nn127.0.0.1:32001\n" };
  });
  assert.equal(observation.pid, 123);
});
test("invalid process and port identities reject before accepting a record", () => {
  assert.throws(() => assertLoopbackListener("p123\nn127.0.0.1:32001", { port: 0, pid: 123 }));
  assert.throws(() => assertLoopbackListener("p123\nn127.0.0.1:32001", { port: 32001, pid: 0 }));
});
