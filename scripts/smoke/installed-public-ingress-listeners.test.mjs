import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertLoopbackListener,
  assertProcessObservation,
  ListenerObservationUnavailable,
  observeOwnedPrivateListener,
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

test("owned private listener is observed from the exact supervised PID socket inventory", async () => {
  const controller = new AbortController();
  const publicLog = "Server listening on 127.0.0.1:32001";
  const loggedPort = Number(publicLog.match(/:(\d+)$/u)?.[1]);
  const observation = await observeOwnedPrivateListener(32001, 123, async (command, args, options) => {
    assert.equal(command, "lsof");
    assert.deepEqual(args, ["-nP", "-a", "-p", "123", "-iTCP", "-sTCP:LISTEN", "-Fpn"]);
    assert.deepEqual(options, {
      encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024, signal: controller.signal,
    });
    assert.equal(Object.hasOwn(options, "env"), false);
    assert.equal(Object.hasOwn(options, "argv"), false);
    return { stdout: "p123\nf8\nn127.0.0.1:32002\n", stderr: "" };
  }, controller.signal);

  assert.deepEqual(observation, { port: 32002, pid: 123, address: "127.0.0.1:32002" });
  assert.notEqual(observation.port, loggedPort, "public startup log is not private socket evidence");
});

test("public listen address alone cannot prove an owned private listener", async () => {
  await assert.rejects(
    observeOwnedPrivateListener(32001, 123, async () => ({
      stdout: "p123\nf8\nn127.0.0.1:32001\n", stderr: "",
    })),
    (error) => error instanceof assert.AssertionError
      && !(error instanceof ListenerObservationUnavailable),
  );
});

test("only a clean empty lsof exit 1 is a retryable no-listener result", async () => {
  const result = await observeOwnedPrivateListener(32001, 123, async () => {
    throw Object.assign(new Error("no matching listener"), {
      code: 1, killed: false, signal: null, stdout: "", stderr: "",
    });
  });
  assert.equal(result, null);
});

test("wrong owner, wildcard, public port, multiple ports and incomplete records fail closed", async () => {
  for (const stdout of [
    "p124\nf8\nn127.0.0.1:32002\n",
    "p123\nf8\nn*:32002\n",
    "p123\nf8\nn0.0.0.0:32002\n",
    "p123\nf8\nn127.0.0.1:32001\n",
    "p123\nf8\nn127.0.0.1:32002\nf9\nn127.0.0.1:32003\n",
    "p123\n",
    "p123\nf8\n",
    "f8\nn127.0.0.1:32002\n",
    "p123\nxunexpected\n",
  ]) {
    await assert.rejects(
      observeOwnedPrivateListener(32001, 123, async () => ({ stdout, stderr: "" })),
      (error) => error instanceof assert.AssertionError
        && !(error instanceof ListenerObservationUnavailable),
      stdout,
    );
  }
});

test("observer launch, timeout, permission and diagnostic failures stay unavailable", async () => {
  for (const detail of [
    { code: "ENOENT", killed: false, signal: null, stdout: "", stderr: "" },
    { code: "EACCES", killed: false, signal: null, stdout: "", stderr: "" },
    { code: 1, killed: true, signal: "SIGTERM", stdout: "", stderr: "" },
    { code: 1, signal: null, stdout: "", stderr: "" },
    { code: 1, killed: false, signal: "", stdout: "", stderr: "" },
    { code: 1, killed: false, signal: null, stdout: "", stderr: "permission denied" },
    { code: 2, killed: false, signal: null, stdout: "", stderr: "" },
  ]) {
    await assert.rejects(
      observeOwnedPrivateListener(32001, 123, async () => {
        throw Object.assign(new Error("listener observation failed"), detail);
      }),
      ListenerObservationUnavailable,
    );
  }

  await assert.rejects(
    observeOwnedPrivateListener(32001, 123, async () => ({
      stdout: "p123\nf8\nn127.0.0.1:32002\n", stderr: "lsof diagnostic",
    })),
    ListenerObservationUnavailable,
  );
});

test("non-empty failed and successful-empty lsof results are not retryable", async () => {
  await assert.rejects(
    observeOwnedPrivateListener(32001, 123, async () => {
      throw Object.assign(new Error("partial output"), {
        code: 1, killed: false, signal: null, stdout: "p123\nf8\n", stderr: "",
      });
    }),
    (error) => error instanceof assert.AssertionError
      && !(error instanceof ListenerObservationUnavailable),
  );
  await assert.rejects(
    observeOwnedPrivateListener(32001, 123, async () => ({ stdout: "", stderr: "" })),
    (error) => error instanceof assert.AssertionError
      && !(error instanceof ListenerObservationUnavailable),
  );
});

test("owned-listener identities reject before invoking lsof", async () => {
  let calls = 0;
  for (const [publicPort, nodePid] of [[0, 123], [65_536, 123], [32001, 0], [32001, -1]]) {
    await assert.rejects(observeOwnedPrivateListener(publicPort, nodePid, async () => { calls += 1; }));
  }
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
