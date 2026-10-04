import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ProbeError,
  UnknownSubmissionError,
  assertLocalHermesConfiguration,
  assertNativeReaderBoundary,
  assertNativeRunContinuity,
  assertRuntimeLeaseHealth,
  assertRuntimeLeaseProof,
  markTerminalAssistantPersisted,
  publicReaderExecutionLineageGap,
  runProbe,
  sendChatStreamOnce,
  sendResourcePostOnce,
  verifyPersistedTurn,
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

function exactReaderEvidence(runId, spanId, attemptId, bindingId) {
  return {
    runId,
    spanId,
    attemptId,
    bindingId,
    rowCount: 1,
    rowToSpanJoin: "exact_per_row_run_attempt_span_identity",
    rowExecutionBindingsSha256: "c".repeat(64),
  };
}

test("terminal assistant criteria pass only after the persisted message and succeeded Run are read back", () => {
  const receipt = { criteria: { firstTerminalAssistant: {
    status: "pending",
    assistantMessageId: "assistant-1",
    runId: "run-1",
  } } };
  markTerminalAssistantPersisted(receipt, "first", {
    id: "assistant-1",
    role: "assistant",
    status: "completed",
    runId: "run-1",
    body: "Persisted response",
  }, { id: "run-1", status: "succeeded" });
  assert.deepEqual(receipt.criteria.firstTerminalAssistant, {
    status: "pass",
    assistantMessageId: "assistant-1",
    assistantStatus: "completed",
    runId: "run-1",
    runStatus: "succeeded",
    persisted: true,
  });

  for (const [assistant, run] of [
    [{ id: "assistant-1", status: "completed", runId: "run-1", body: "Response" }, { id: "run-1", status: "running" }],
    [{ id: "assistant-1", status: "completed", runId: "run-other", body: "Response" }, { id: "run-1", status: "succeeded" }],
    [{ id: "assistant-1", status: "completed", runId: "run-1", body: " " }, { id: "run-1", status: "succeeded" }],
  ]) {
    const pendingReceipt = structuredClone({ criteria: { firstTerminalAssistant: {
      status: "pending", assistantMessageId: "assistant-1", runId: "run-1",
    } } });
    assert.throws(() => markTerminalAssistantPersisted(pendingReceipt, "first", assistant, run), (error) => (
      error instanceof ProbeError && error.code === "terminal_assistant_persistence_mismatch"
    ));
    assert.equal(pendingReceipt.criteria.firstTerminalAssistant.status, "pending");
  }
});

test("persisted readback failures leave terminal-assistant criteria pending", async () => {
  const user = { id: "user-1", role: "user", status: "completed", body: "Question" };
  const assistant = {
    id: "assistant-1",
    role: "assistant",
    status: "completed",
    runId: "run-1",
    body: "Persisted response",
  };
  const pendingReceipt = () => ({ criteria: { firstTerminalAssistant: {
    status: "pending",
    assistantMessageId: assistant.id,
    runId: "run-1",
  } } });
  const baseInput = {
    apiBase: "http://127.0.0.1:4101",
    conversationId: "conversation-1",
    agentId: "agent-1",
    runId: "run-1",
    userMessageId: user.id,
    assistantMessage: assistant,
    userBody: user.body,
    timeoutMs: 100,
    evidenceDir: "/tmp/native-chat-probe-readback-test",
    turnName: "first",
  };

  for (const scenario of [
    { messages: [user], run: { id: "run-1", agentId: "agent-1", chatConversationId: "conversation-1", status: "succeeded" }, code: "persisted_chat_messages_missing" },
    { messages: [user, { ...assistant, runId: "run-other" }], run: { id: "run-1", agentId: "agent-1", chatConversationId: "conversation-1", status: "succeeded" }, code: "persisted_assistant_message_mismatch" },
    { messages: [user, assistant], run: { id: "run-1", agentId: "agent-1", chatConversationId: "conversation-1", status: "failed" }, code: "run_not_succeeded" },
  ]) {
    const receipt = pendingReceipt();
    let checkpointCount = 0;
    await assert.rejects(verifyPersistedTurn({
      ...baseInput,
      receipt,
      readJson: async (_apiBase, _method, route) => route.includes("/messages?") ? scenario.messages : scenario.run,
      saveCheckpoint: async () => { checkpointCount += 1; },
    }), (error) => error instanceof ProbeError && error.code === scenario.code);
    assert.equal(receipt.criteria.firstTerminalAssistant.status, "pending");
    assert.equal(checkpointCount, 0);
  }
});

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

test("native Reader evidence binds every source entry to the exact Run, Attempt, and Span", () => {
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
        { id: "step-1", index: 1, sourceEntryId: "entry-1", runId: "run-1", spanId: "span-1", attemptId: "attempt-1" },
        { id: "step-2", index: 2, sourceEntryId: "entry-2", runId: "run-1", spanId: "span-1", attemptId: "attempt-1" },
      ],
    },
  });
  assert.equal(evidence.runId, "run-1");
  assert.equal(evidence.spanId, "span-1");
  assert.equal(evidence.runtimeType, "hermes_gateway");
  assert.equal(evidence.bindingId, "binding-1");
  assert.equal(evidence.segmentId, "segment-1");
  assert.equal(evidence.rowToSpanJoin, "exact_per_row_run_attempt_span_identity");
  assert.match(evidence.rowExecutionBindingsSha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => assertNativeReaderBoundary({
    runId: "run-1",
    run: { id: "run-1", contextSnapshot: { runtimeBindingId: "binding-1", runtimeSegmentId: "segment-1" } },
    invocation: { runtimeType: "hermes_gateway", spanId: "span-1", attemptId: "attempt-1" },
    reader: { run: { id: "run-2" }, source: "native", availability: "available", completeness: "complete", page: { hasMore: false }, rows: [{ id: "step-1", index: 1, sourceEntryId: "entry-1", runId: "run-1", spanId: "span-1", attemptId: "attempt-1" }] },
  }), (error) => error instanceof ProbeError && error.code === "reader_run_boundary_mismatch");
  assert.throws(() => assertNativeReaderBoundary({
    runId: "run-1",
    run: { id: "run-1", contextSnapshot: { runtimeBindingId: "binding-1", runtimeSegmentId: "segment-1" } },
    invocation: { runtimeType: "hermes_gateway", spanId: "span-1", attemptId: "attempt-1" },
    reader: {
      run: { id: "run-1" }, source: "native", availability: "available", completeness: "complete",
      page: { hasMore: false }, rows: [{ id: "step-1", index: 1, sourceEntryId: "entry-1" }],
    },
  }), (error) => error instanceof ProbeError && error.code === "reader_execution_lineage_unavailable");
  assert.throws(() => assertNativeReaderBoundary({
    runId: "run-1",
    run: { id: "run-1", contextSnapshot: { runtimeBindingId: "binding-1", runtimeSegmentId: "segment-1" } },
    invocation: { runtimeType: "hermes_gateway", spanId: "span-1", attemptId: "attempt-1" },
    reader: {
      run: { id: "run-1" }, source: "native", availability: "available", completeness: "complete",
      page: { hasMore: false }, rows: [{ id: "step-1", index: 1, sourceEntryId: "entry-1", runId: "run-1", spanId: "span-other", attemptId: "attempt-1" }],
    },
  }), (error) => error instanceof ProbeError && error.code === "reader_execution_lineage_mismatch");
});

test("two consecutive Side Chat sends retain one logical session and own distinct exact executions", () => {
  assert.deepEqual(assertNativeRunContinuity({
    conversationId: "side-chat-1",
    runId: "run-1",
    bindingId: "binding-1",
    sessionIdBefore: null,
    sessionIdAfter: "session-1",
    reader: exactReaderEvidence("run-1", "span-1", "attempt-1", "binding-1"),
  }, {
    conversationId: "side-chat-1",
    runId: "run-2",
    bindingId: "binding-1",
    sessionIdBefore: "session-1",
    sessionIdAfter: "session-1",
    reader: exactReaderEvidence("run-2", "span-2", "attempt-2", "binding-1"),
  }), {
    distinctRuns: true,
    sameConversation: true,
    stableBindingId: "binding-1",
    distinctExecutionSpans: true,
    firstExecution: { runId: "run-1", spanId: "span-1", attemptId: "attempt-1" },
    secondExecution: { runId: "run-2", spanId: "span-2", attemptId: "attempt-2" },
    firstRunSessionIdAfter: "session-1",
    secondRunSessionIdBefore: "session-1",
    secondRunSessionIdAfter: "session-1",
    readersBoundToExactRunAttemptSpans: true,
  });
  assert.throws(() => assertNativeRunContinuity({
    conversationId: "side-chat-1", runId: "run-1", bindingId: "binding-1",
    sessionIdAfter: "session-1", reader: exactReaderEvidence("run-1", "span-1", "attempt-1", "binding-1"),
  }, {
    conversationId: "side-chat-1", runId: "run-2", bindingId: "binding-2",
    sessionIdBefore: "session-1", sessionIdAfter: "session-1",
    reader: exactReaderEvidence("run-2", "span-2", "attempt-2", "binding-2"),
  }), (error) => error instanceof ProbeError && error.code === "native_binding_continuity_mismatch");
  assert.throws(() => assertNativeRunContinuity({
    conversationId: "side-chat-1", runId: "run-1", bindingId: "binding-1",
    sessionIdAfter: "session-1", reader: exactReaderEvidence("run-1", "span-1", "attempt-1", "binding-1"),
  }, {
    conversationId: "side-chat-1", runId: "run-2", bindingId: "binding-1",
    sessionIdBefore: "session-1", sessionIdAfter: "session-2",
    reader: exactReaderEvidence("run-2", "span-2", "attempt-2", "binding-1"),
  }), (error) => error instanceof ProbeError && error.code === "native_session_continuity_mismatch");
  assert.throws(() => assertNativeRunContinuity({
    conversationId: "side-chat-1", runId: "run-1", bindingId: "binding-1",
    sessionIdAfter: "session-1", reader: { runId: "run-1", spanId: "span-1", attemptId: "attempt-1" },
  }, {
    conversationId: "side-chat-1", runId: "run-2", bindingId: "binding-1",
    sessionIdBefore: "session-1", sessionIdAfter: "session-1",
    reader: exactReaderEvidence("run-2", "span-2", "attempt-2", "binding-1"),
  }), (error) => error instanceof ProbeError && error.code === "native_execution_identity_incomplete");
});

test("the current public Reader route proves org-scoped Run/Attempt/Span projection on compact and full output", () => {
  assert.equal(publicReaderExecutionLineageGap(), null);
});

test("the source preflight rejects a lineage lookup missing its own organization predicate", () => {
  const routePath = new URL("../server/src/routes/run-intelligence.ts", import.meta.url);
  const source = readFileSync(routePath, "utf8");
  const lookupStart = source.indexOf("async function readTranscriptStoredLineage(");
  const lookupEnd = source.indexOf("\nfunction buildRunErrors", lookupStart);
  assert.ok(lookupStart >= 0 && lookupEnd > lookupStart, "stored lineage lookup should exist");

  const lookup = source.slice(lookupStart, lookupEnd);
  const unscopedLookup = lookup.replace("      eq(runRuntimeSpans.orgId, orgId),\n", "");
  assert.notEqual(unscopedLookup, lookup, "fixture must remove only the lineage lookup organization predicate");
  const unscopedRoute = `${source.slice(0, lookupStart)}${unscopedLookup}${source.slice(lookupEnd)}`;
  assert.deepEqual(publicReaderExecutionLineageGap(unscopedRoute)?.missingRowIdentityFields, [
    "runId",
    "attemptId",
    "spanId",
  ]);
});

test("the source preflight reports a concrete gap when Reader rows lack stored execution lineage", () => {
  assert.deepEqual(publicReaderExecutionLineageGap("router.get('/runs/:runId/transcript', ...);"), {
    endpoint: "GET /api/run-intelligence/runs/:runId/transcript",
    source: "server/src/routes/run-intelligence.ts",
    projectedRowIdentityFields: ["id", "index", "sourceEntryId"],
    requiredRowIdentityFields: ["runId", "attemptId", "spanId"],
    reason: "The route source does not prove that each public Reader row receives its exact stored Run/Attempt/Span lineage.",
    smallestProductApiProjection: "Resolve Reader span IDs through organization- and Run-scoped stored spans, then project runId, attemptId, and spanId onto compact rows and full entries.",
    missingRowIdentityFields: ["runId", "attemptId", "spanId"],
  });
});

test("the Reader lineage blocker returns QUESTION before any API or runtime work", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const checkpoints = [];
  const missingLineage = publicReaderExecutionLineageGap("router.get('/runs/:runId/transcript', ...);");
  globalThis.fetch = async () => {
    fetchCount += 1;
    throw new Error("API calls must not be reached while projection lineage is missing");
  };
  try {
    const receipt = await runProbe({
      runtime: "hermes_gateway",
      model: null,
      apiBase: "http://127.0.0.1:3100",
      expectedSourceSha: sourceSha,
      timeoutMs: 10_000,
    }, {
      createEvidenceDirectory: async () => "/tmp/native-chat-lineage-gate-test",
      saveCheckpoint: async (_directory, value) => { checkpoints.push(structuredClone(value)); },
      inspectReaderLineage: () => missingLineage,
    });
    assert.equal(receipt.verdict, "QUESTION");
    assert.equal(receipt.failure.code, "public_reader_execution_lineage_unavailable");
    assert.equal(receipt.runtimeLease, null);
    assert.equal(receipt.health, null);
    assert.equal(receipt.mutationLedger.length, 0);
    assert.deepEqual(receipt.identities, {
      organizationId: null,
      agentId: null,
      mainConversationId: null,
      sideChatId: null,
    });
    assert.deepEqual(receipt.cleanup, {
      performed: false,
      retainedDisposableData: false,
      note: "No disposable resource or native runtime was created.",
    });
    assert.equal(fetchCount, 0);
    assert.equal(checkpoints.length, 2);
    assert.equal(checkpoints[1].verdict, "QUESTION");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("resource POST redirects are unknown submissions and never retried", async () => {
  let fetchCount = 0;
  const checkpoints = [];
  await assert.rejects(sendResourcePostOnce({
    url: "http://127.0.0.1:3100/api/orgs",
    endpoint: "/api/orgs",
    kind: "organization_create",
    body: { name: "redacted organization payload" },
    timeoutMs: 1_000,
    onCheckpoint: async (entry) => { checkpoints.push(entry); },
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      assert.equal(checkpoints[0]?.status, "intent_checkpointed");
      assert.equal(options.redirect, "manual");
      assert.equal(options.method, "POST");
      return new Response(null, { status: 302, headers: { location: "/redirected" } });
    },
  }), (error) => error instanceof UnknownSubmissionError
    && error.code === "resource_post_outcome_unknown"
    && error.details.status === "unknown_submission"
    && error.details.httpStatus === 302
    && error.details.replayed === false);
  assert.equal(fetchCount, 1);
  assert.deepEqual(checkpoints.map((entry) => entry.status), ["intent_checkpointed", "unknown_submission"]);
  assert.equal(checkpoints[0].body, undefined);
  assert.match(checkpoints[0].bodySha256, /^[a-f0-9]{64}$/u);
  assert.ok(checkpoints[0].intentId);
  assert.equal(checkpoints[1].intentId, checkpoints[0].intentId);
  assert.equal(checkpoints[0].endpoint, "/api/orgs");
});

test("resource POSTs with no response are unknown and never retried", async () => {
  let fetchCount = 0;
  const checkpoints = [];
  await assert.rejects(sendResourcePostOnce({
    url: "http://127.0.0.1:3100/api/orgs/organization-1/agents",
    endpoint: "/api/orgs/organization-1/agents",
    kind: "agent_create",
    intentIdentifiers: { organizationId: "organization-1" },
    body: { name: "redacted agent payload" },
    timeoutMs: 1_000,
    onCheckpoint: async (entry) => { checkpoints.push(entry); },
    fetchImpl: async (_url, options) => {
      fetchCount += 1;
      assert.equal(checkpoints[0]?.status, "intent_checkpointed");
      assert.equal(options.redirect, "manual");
      throw new Error("sensitive transport details must not escape");
    },
  }), (error) => error instanceof UnknownSubmissionError
    && error.code === "resource_post_outcome_unknown"
    && error.details.status === "unknown_submission"
    && error.details.responseReceived === false
    && error.details.replayed === false
    && !error.message.includes("sensitive"));
  assert.equal(fetchCount, 1);
  assert.deepEqual(checkpoints.map((entry) => entry.status), ["intent_checkpointed", "unknown_submission"]);
  assert.equal(checkpoints[1].body, undefined);
  assert.equal(checkpoints[0].identifiers.organizationId, "organization-1");
  assert.equal(checkpoints[1].identifiers.organizationId, "organization-1");
});
