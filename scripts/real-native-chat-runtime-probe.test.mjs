import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProbeError,
  UnknownSubmissionError,
  assertLocalHermesConfiguration,
  assertNativeReaderBoundary,
  assertNativeRunContinuity,
  assertRuntimeLeaseHealth,
  assertRuntimeLeaseProof,
  sendChatStreamOnce,
} from "./real-native-chat-runtime-probe.mjs";

const sourceSha = "a".repeat(40);
const checkout = "/workspace/rudder-oss";
const entry = `${checkout}/server/src/index.ts`;
const runtimeLease = {
  schemaVersion: 1,
  checkout,
  immutableSha: sourceSha,
  pid: 31899,
  entry,
  instanceId: "native-real-1889-38001",
  baseUrl: "http://127.0.0.1:38001",
};

function runtimeLeaseObservations(overrides = {}) {
  return {
    lease: runtimeLease,
    expectedSourceSha: sourceSha,
    apiBase: runtimeLease.baseUrl,
    checkoutRoot: checkout,
    entryPath: entry,
    gitHead: sourceSha,
    gitStatus: "",
    processBefore: { pid: runtimeLease.pid, executable: "node", entryArgumentMatches: true, startedAt: "Sun Oct  4 12:00:00 2026" },
    processAfter: { pid: runtimeLease.pid, executable: "node", entryArgumentMatches: true, startedAt: "Sun Oct  4 12:00:00 2026" },
    processCwd: checkout,
    listenerEndpoints: ["127.0.0.1:38001"],
    ...overrides,
  };
}

test("runtime lease binds a clean exact Node checkout and health instance without requiring health.sourceSha", () => {
  const proof = assertRuntimeLeaseProof(runtimeLeaseObservations());
  assert.deepEqual({
    source: proof.source,
    immutableSha: proof.immutableSha,
    workingTree: proof.workingTree,
    pid: proof.pid,
    entry: proof.entry,
    listener: proof.listener,
    instanceId: proof.instanceId,
  }, {
    source: "captured_runtime_lease",
    immutableSha: sourceSha,
    workingTree: "clean",
    pid: 31899,
    entry,
    listener: "127.0.0.1:38001",
    instanceId: runtimeLease.instanceId,
  });
  assert.deepEqual(assertRuntimeLeaseHealth({ status: "ok", instanceId: runtimeLease.instanceId }, runtimeLease), {
    status: "ok",
    instanceId: runtimeLease.instanceId,
    sourceSha: null,
    healthSourceSha: "not_exposed",
  });
  assert.throws(() => assertRuntimeLeaseHealth({
    status: "ok", instanceId: runtimeLease.instanceId, sourceSha: "b".repeat(40),
  }, runtimeLease), (error) => error instanceof ProbeError && error.code === "runtime_lease_health_source_sha_mismatch");
});

test("runtime lease rejects a wrong live PID", () => {
  assert.throws(() => assertRuntimeLeaseProof(runtimeLeaseObservations({
    processBefore: { ...runtimeLeaseObservations().processBefore, pid: 31900 },
  })), (error) => error instanceof ProbeError && error.code === "runtime_lease_process_pid_mismatch");
});

test("runtime lease rejects a live process with the wrong server entry", () => {
  assert.throws(() => assertRuntimeLeaseProof(runtimeLeaseObservations({
    processBefore: { ...runtimeLeaseObservations().processBefore, entryArgumentMatches: false },
  })), (error) => error instanceof ProbeError && error.code === "runtime_lease_process_entry_mismatch");
});

test("runtime lease rejects a listener not owned on the exact loopback endpoint", () => {
  assert.throws(() => assertRuntimeLeaseProof(runtimeLeaseObservations({
    listenerEndpoints: ["0.0.0.0:38001"],
  })), (error) => error instanceof ProbeError && error.code === "runtime_lease_listener_mismatch");
});

test("runtime lease rejects a health instance mismatch", () => {
  assert.throws(() => assertRuntimeLeaseHealth({ status: "ok", instanceId: "other-instance" }, runtimeLease), (error) => (
    error instanceof ProbeError && error.code === "runtime_lease_health_instance_mismatch"
  ));
});

test("runtime lease rejects dirty or mismatching source checkouts", () => {
  assert.throws(() => assertRuntimeLeaseProof(runtimeLeaseObservations({ gitStatus: " M server/src/index.ts" })), (error) => (
    error instanceof ProbeError && error.code === "runtime_lease_checkout_dirty"
  ));
  assert.throws(() => assertRuntimeLeaseProof(runtimeLeaseObservations({ gitHead: "b".repeat(40) })), (error) => (
    error instanceof ProbeError && error.code === "runtime_lease_git_head_mismatch"
  ));
});

test("Hermes is configured through the local profile without URL, credential, or backend overrides", () => {
  assert.deepEqual(assertLocalHermesConfiguration({
    agentRuntimeType: "hermes_gateway",
    agentRuntimeConfig: { hermesConnectionMode: "local", model: "local-model" },
  }, "local-model"), {
    runtimeType: "hermes_gateway",
    connectionMode: "local",
    modelSelection: "explicit_non_secret_identifier",
    customConnectionOverrides: [],
  });
  assert.equal(assertLocalHermesConfiguration({
    agentRuntimeType: "hermes_gateway",
    agentRuntimeConfig: { hermesConnectionMode: "local" },
  }).modelSelection, "installed_local_profile_default");

  for (const field of ["url", "apiKey", "hermesChatBackend"]) {
    assert.throws(() => assertLocalHermesConfiguration({
      agentRuntimeType: "hermes_gateway",
      agentRuntimeConfig: { hermesConnectionMode: "local", [field]: "must-not-be-reported" },
    }), (error) => error instanceof ProbeError
      && error.code === "hermes_local_custom_override_present"
      && error.details.field === field
      && !error.message.includes("must-not-be-reported"));
  }
});

test("a timed-out dispatched Chat stream is unknown and is never automatically resent", async () => {
  let fetchCount = 0;
  await assert.rejects(sendChatStreamOnce({
    url: "http://127.0.0.1:3100/api/chats/chat/messages/stream",
    body: { body: "bounded probe", clientMutationId: "mutation-once" },
    timeoutMs: 20,
    fetchImpl: (_url, options) => {
      fetchCount += 1;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  }), (error) => error instanceof UnknownSubmissionError
    && error.code === "chat_submission_outcome_unknown"
    && error.details.dispatched === true
    && error.details.timedOut === true);
  assert.equal(fetchCount, 1);
});

test("a post-dispatch HTTP 5xx is unknown and is never automatically resent", async () => {
  let fetchCount = 0;
  await assert.rejects(sendChatStreamOnce({
    url: "http://127.0.0.1:3100/api/chats/chat/messages/stream",
    body: { body: "bounded probe", clientMutationId: "mutation-once" },
    timeoutMs: 1_000,
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      assert.equal(options.redirect, "manual");
      return new Response(null, { status: 503 });
    },
  }), (error) => error instanceof UnknownSubmissionError
    && error.code === "chat_submission_outcome_unknown"
    && error.details.dispatched === true
    && error.details.headersReceived === true
    && error.details.httpStatus === 503);
  assert.equal(fetchCount, 1);
});

test("native Reader evidence stays bound to the exact Run and exposes stable row IDs", () => {
  const evidence = assertNativeReaderBoundary({
    runId: "run-1",
    run: {
      id: "run-1",
      contextSnapshot: { runtimeBindingId: "binding-1", runtimeSegmentId: "segment-1" },
    },
    invocation: { runtimeType: "hermes_gateway", spanId: "span-1", attemptId: "attempt-1" },
    reader: {
      run: { id: "run-1" },
      source: "native",
      availability: "available",
      completeness: "complete",
      revision: "reader-revision-1",
      page: { hasMore: false },
      rows: [
        { id: "step-1", index: 1, sourceEntryId: "entry-1" },
        { id: "step-2", index: 2, sourceEntryId: "entry-2" },
      ],
    },
  });
  assert.equal(evidence.runId, "run-1");
  assert.equal(evidence.spanId, "span-1");
  assert.equal(evidence.runtimeType, "hermes_gateway");
  assert.equal(evidence.bindingId, "binding-1");
  assert.equal(evidence.segmentId, "segment-1");
  assert.equal(evidence.rowToSpanJoin, "not_exposed_by_public_reader_projection");
  assert.throws(() => assertNativeReaderBoundary({
    runId: "run-1",
    run: { id: "run-1", contextSnapshot: { runtimeBindingId: "binding-1", runtimeSegmentId: "segment-1" } },
    invocation: { runtimeType: "hermes_gateway", spanId: "span-1", attemptId: "attempt-1" },
    reader: { run: { id: "run-2" }, source: "native", availability: "available", completeness: "complete", page: { hasMore: false }, rows: [{ id: "step-1", index: 1, sourceEntryId: "entry-1" }] },
  }), (error) => error instanceof ProbeError && error.code === "reader_run_boundary_mismatch");
});

test("two-turn continuity requires distinct exact Runs on one binding and the prior native session", () => {
  assert.deepEqual(assertNativeRunContinuity({
    runId: "run-1", bindingId: "binding-1", sessionIdAfter: "session-1", readerRunId: "run-1",
  }, {
    runId: "run-2", bindingId: "binding-1", sessionIdBefore: "session-1", readerRunId: "run-2",
  }), {
    distinctRuns: true,
    stableBindingId: "binding-1",
    firstRunSessionIdAfter: "session-1",
    secondRunSessionIdBefore: "session-1",
    readersBoundToExactRuns: true,
  });
  assert.throws(() => assertNativeRunContinuity({
    runId: "run-1", bindingId: "binding-1", sessionIdAfter: "session-1", readerRunId: "run-1",
  }, {
    runId: "run-2", bindingId: "binding-2", sessionIdBefore: "session-1", readerRunId: "run-2",
  }), (error) => error instanceof ProbeError && error.code === "native_binding_continuity_mismatch");
});
