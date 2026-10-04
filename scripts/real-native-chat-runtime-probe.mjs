#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROBE_NAME = "real-native-chat-runtime";
const DEFAULT_TIMEOUT_MS = 180_000;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);
const PUBLIC_READER_EXECUTION_LINEAGE_GAP = Object.freeze({
  endpoint: "GET /api/run-intelligence/runs/:runId/transcript",
  source: "server/src/routes/run-intelligence.ts",
  projectedRowIdentityFields: ["id", "index", "sourceEntryId"],
  requiredRowIdentityFields: ["runId", "attemptId", "spanId"],
  reason: "The route source does not prove that each public Reader row receives its exact stored Run/Attempt/Span lineage.",
  smallestProductApiProjection: "Resolve Reader span IDs through organization- and Run-scoped stored spans, then project runId, attemptId, and spanId onto compact rows and full entries.",
});

export class ProbeError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = "ProbeError";
    this.code = code;
    this.details = details;
  }
}

export class UnknownSubmissionError extends Error {
  constructor(details) {
    super(details?.submissionKind === "resource_post"
      ? "resource_post_outcome_unknown"
      : "chat_submission_outcome_unknown");
    this.name = "UnknownSubmissionError";
    this.code = details?.submissionKind === "resource_post"
      ? "resource_post_outcome_unknown"
      : "chat_submission_outcome_unknown";
    this.details = details;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeLoopbackApiBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeError("runtime_lease_api_base_invalid");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ProbeError("runtime_lease_api_base_not_exact_loopback_origin");
  }
  return url.origin;
}

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function assertRuntimeLeaseProof(input) {
  const {
    lease,
    expectedSourceSha,
    apiBase,
    checkoutRoot,
    entryPath,
    gitHead,
    gitStatus,
    processBefore,
    processAfter,
    processCwd,
    listenerEndpoints,
  } = input;
  if (!/^[0-9a-f]{40}$/i.test(expectedSourceSha ?? "")) {
    throw new ProbeError("expected_source_sha_invalid");
  }
  if (!isRecord(lease) || lease.schemaVersion !== 1) {
    throw new ProbeError("runtime_lease_schema_invalid");
  }
  if (!/^[0-9a-f]{40}$/i.test(lease.immutableSha ?? "")) {
    throw new ProbeError("runtime_lease_source_sha_invalid");
  }
  const expectedSha = expectedSourceSha.toLowerCase();
  const leaseSha = lease.immutableSha.toLowerCase();
  if (leaseSha !== expectedSha) throw new ProbeError("runtime_lease_expected_sha_mismatch");
  if (typeof gitHead !== "string" || gitHead.toLowerCase() !== expectedSha) {
    throw new ProbeError("runtime_lease_git_head_mismatch");
  }
  if (typeof gitStatus !== "string" || gitStatus.length > 0) {
    throw new ProbeError("runtime_lease_checkout_dirty");
  }

  const leaseCheckout = nonEmptyString(lease.checkout);
  const leaseEntry = nonEmptyString(lease.entry);
  const instanceId = nonEmptyString(lease.instanceId);
  if (!leaseCheckout || !path.isAbsolute(leaseCheckout) || leaseCheckout !== checkoutRoot) {
    throw new ProbeError("runtime_lease_checkout_mismatch");
  }
  if (!leaseEntry || !path.isAbsolute(leaseEntry) || leaseEntry !== entryPath) {
    throw new ProbeError("runtime_lease_entry_mismatch");
  }
  if (!instanceId) throw new ProbeError("runtime_lease_instance_id_missing");
  if (!Number.isSafeInteger(lease.pid) || lease.pid < 2) {
    throw new ProbeError("runtime_lease_pid_invalid");
  }

  const leaseApiBase = normalizeLoopbackApiBase(lease.baseUrl);
  const requestedApiBase = normalizeLoopbackApiBase(apiBase);
  if (leaseApiBase !== requestedApiBase) throw new ProbeError("runtime_lease_api_base_mismatch");
  const port = Number(new URL(leaseApiBase).port);
  const expectedListener = `127.0.0.1:${port}`;

  for (const processSnapshot of [processBefore, processAfter]) {
    if (!processSnapshot || processSnapshot.pid !== lease.pid) {
      throw new ProbeError("runtime_lease_process_pid_mismatch");
    }
    if (processSnapshot.executable !== "node") {
      throw new ProbeError("runtime_lease_process_executable_mismatch");
    }
    if (processSnapshot.entryArgumentMatches !== true) {
      throw new ProbeError("runtime_lease_process_entry_mismatch");
    }
  }
  if (!processBefore.startedAt || processBefore.startedAt !== processAfter.startedAt) {
    throw new ProbeError("runtime_lease_process_identity_changed");
  }
  if (typeof processCwd !== "string" || !isInsideDirectory(checkoutRoot, processCwd)) {
    throw new ProbeError("runtime_lease_process_cwd_outside_checkout");
  }
  if (!Array.isArray(listenerEndpoints) || !listenerEndpoints.includes(expectedListener)) {
    throw new ProbeError("runtime_lease_listener_mismatch");
  }

  return {
    source: "captured_runtime_lease",
    checkout: checkoutRoot,
    immutableSha: expectedSha,
    workingTree: "clean",
    pid: lease.pid,
    processStartedAt: processBefore.startedAt,
    entry: entryPath,
    cwd: processCwd,
    cwdWithinCheckout: true,
    listener: expectedListener,
    baseUrl: leaseApiBase,
    instanceId,
  };
}

export function assertRuntimeLeaseHealth(health, lease) {
  if (!isRecord(health) || health.status !== "ok") {
    throw new ProbeError("runtime_lease_health_not_healthy");
  }
  const instanceId = nonEmptyString(health.instanceId);
  if (!instanceId || instanceId !== lease.instanceId) {
    throw new ProbeError("runtime_lease_health_instance_mismatch");
  }
  let sourceSha = null;
  if (Object.hasOwn(health, "sourceSha")) {
    sourceSha = nonEmptyString(health.sourceSha);
    if (!sourceSha || !/^[0-9a-f]{40}$/i.test(sourceSha)) {
      throw new ProbeError("runtime_lease_health_source_sha_invalid");
    }
    if (sourceSha.toLowerCase() !== lease.immutableSha.toLowerCase()) {
      throw new ProbeError("runtime_lease_health_source_sha_mismatch");
    }
    sourceSha = sourceSha.toLowerCase();
  }
  return {
    status: health.status,
    instanceId,
    sourceSha,
    healthSourceSha: sourceSha ? "matched_lease" : "not_exposed",
  };
}

function runReadOnly(command, args, failureCode, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new ProbeError(failureCode);
  }
}

function parseLsofNames(output) {
  return output.split(/\r?\n/).filter((line) => line.startsWith("n")).map((line) => line.slice(1));
}

function commandHasEntryArgument(commandLine, processCwd, entryPath) {
  const tokens = commandLine.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s]+/g) ?? [];
  return tokens.some((rawToken) => {
    const token = rawToken.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted);
    if (token === entryPath) return true;
    if (path.isAbsolute(token)) return false;
    return path.resolve(processCwd, token) === entryPath;
  });
}

function readProcessSnapshot(pid, processCwd, entryPath) {
  const identity = runReadOnly("ps", ["-p", String(pid), "-o", "pid=", "-o", "comm="], "runtime_lease_process_unavailable").trim();
  const [pidText, executableText] = identity.split(/\s+/, 2);
  const observedPid = Number(pidText);
  const executable = path.basename(executableText ?? "").replace(/\s+$/, "");
  const commandLine = runReadOnly("ps", ["-ww", "-p", String(pid), "-o", "args="], "runtime_lease_process_unavailable").trim();
  const startedAt = runReadOnly("ps", ["-p", String(pid), "-o", "lstart="], "runtime_lease_process_unavailable").trim();
  return {
    pid: observedPid,
    executable,
    entryArgumentMatches: commandHasEntryArgument(commandLine, processCwd, entryPath),
    startedAt,
  };
}

async function readCapturedRuntimeLease(config) {
  // schemaVersion 1: checkout, immutableSha, pid, entry, instanceId, and baseUrl.
  let lease;
  try {
    const leaseStat = await fs.lstat(config.runtimeLeasePath);
    if (!leaseStat.isFile() || leaseStat.isSymbolicLink()) throw new Error("invalid lease file");
    lease = JSON.parse(await fs.readFile(config.runtimeLeasePath, "utf8"));
  } catch {
    throw new ProbeError("runtime_lease_unreadable");
  }

  if (!isRecord(lease) || lease.schemaVersion !== 1) throw new ProbeError("runtime_lease_schema_invalid");
  if (!/^[0-9a-f]{40}$/i.test(lease.immutableSha ?? "")) throw new ProbeError("runtime_lease_source_sha_invalid");
  if (!Number.isSafeInteger(lease.pid) || lease.pid < 2) throw new ProbeError("runtime_lease_pid_invalid");
  if (!nonEmptyString(lease.instanceId)) throw new ProbeError("runtime_lease_instance_id_missing");
  if (!nonEmptyString(lease.checkout) || !path.isAbsolute(lease.checkout)) throw new ProbeError("runtime_lease_checkout_mismatch");
  if (!nonEmptyString(lease.entry) || !path.isAbsolute(lease.entry)) throw new ProbeError("runtime_lease_entry_mismatch");
  normalizeLoopbackApiBase(lease.baseUrl);

  const checkoutRoot = await fs.realpath(lease.checkout).catch(() => {
    throw new ProbeError("runtime_lease_checkout_unavailable");
  });
  if (checkoutRoot !== lease.checkout) throw new ProbeError("runtime_lease_checkout_not_canonical");
  const entryPath = await fs.realpath(path.join(checkoutRoot, "server/src/index.ts")).catch(() => {
    throw new ProbeError("runtime_lease_entry_unavailable");
  });
  const leaseEntryPath = typeof lease?.entry === "string" && path.isAbsolute(lease.entry)
    ? await fs.realpath(lease.entry).catch(() => null)
    : null;
  if (leaseEntryPath !== entryPath || lease.entry !== entryPath) throw new ProbeError("runtime_lease_entry_mismatch");

  const gitHead = runReadOnly("git", ["rev-parse", "--verify", "HEAD"], "runtime_lease_git_unavailable", checkoutRoot).trim();
  const gitStatus = runReadOnly("git", ["status", "--porcelain", "--untracked-files=all"], "runtime_lease_git_unavailable", checkoutRoot);
  const processCwdNames = parseLsofNames(runReadOnly("lsof", ["-nP", "-a", "-p", String(lease?.pid), "-d", "cwd", "-Fn"], "runtime_lease_process_cwd_unavailable"));
  const processCwd = processCwdNames.length === 1
    ? await fs.realpath(processCwdNames[0]).catch(() => null)
    : null;
  if (!processCwd) throw new ProbeError("runtime_lease_process_cwd_unavailable");

  const processBefore = readProcessSnapshot(lease.pid, processCwd, entryPath);
  const port = Number(new URL(normalizeLoopbackApiBase(lease.baseUrl)).port);
  const listenerEndpoints = parseLsofNames(runReadOnly(
    "lsof",
    ["-nP", "-a", "-p", String(lease.pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"],
    "runtime_lease_listener_unavailable",
  ));
  const processCwdAfterNames = parseLsofNames(runReadOnly("lsof", ["-nP", "-a", "-p", String(lease.pid), "-d", "cwd", "-Fn"], "runtime_lease_process_cwd_unavailable"));
  const processCwdAfter = processCwdAfterNames.length === 1
    ? await fs.realpath(processCwdAfterNames[0]).catch(() => null)
    : null;
  const processAfter = readProcessSnapshot(lease.pid, processCwdAfter ?? "", entryPath);
  if (processCwdAfter !== processCwd) throw new ProbeError("runtime_lease_process_identity_changed");

  const proof = assertRuntimeLeaseProof({
    lease,
    expectedSourceSha: config.expectedSourceSha,
    apiBase: config.apiBase,
    checkoutRoot,
    entryPath,
    gitHead,
    gitStatus,
    processBefore,
    processAfter,
    processCwd,
    listenerEndpoints,
  });
  return { lease, proof: { leaseFile: config.runtimeLeasePath, ...proof } };
}

export function assertLocalHermesConfiguration(agent, expectedModel = null) {
  if (agent?.agentRuntimeType !== "hermes_gateway") {
    throw new ProbeError("agent_runtime_type_mismatch");
  }
  const config = isRecord(agent.agentRuntimeConfig) ? agent.agentRuntimeConfig : null;
  if (!config || config.hermesConnectionMode !== "local") {
    throw new ProbeError("hermes_local_connection_mode_mismatch");
  }

  const forbiddenFields = ["url", "apiKey", "authToken", "token", "hermesChatBackend", "hermesAuthEnvVar", "authEnvVar", "apiKeyEnvVar"];
  const override = forbiddenFields.find((field) => nonEmptyString(config[field]));
  if (override) throw new ProbeError("hermes_local_custom_override_present", { field: override });
  const headers = isRecord(config.headers) ? config.headers : {};
  if (Object.keys(headers).some((key) => /authorization|api[-_]?key|token/i.test(key))) {
    throw new ProbeError("hermes_local_custom_override_present", { field: "headers" });
  }
  const env = isRecord(config.env) ? config.env : {};
  if (Object.keys(env).some((key) => /api[-_]?key|auth(?:orization)?|token|secret/i.test(key))) {
    throw new ProbeError("hermes_local_custom_override_present", { field: "env" });
  }
  if (expectedModel && nonEmptyString(config.model) !== expectedModel) {
    throw new ProbeError("hermes_model_selection_mismatch");
  }

  return {
    runtimeType: "hermes_gateway",
    connectionMode: "local",
    modelSelection: expectedModel ? "explicit_non_secret_identifier" : "installed_local_profile_default",
    customConnectionOverrides: [],
  };
}

export function assertNativeReaderBoundary(input) {
  const { runId, run, reader, invocation } = input;
  if (!runId || run?.id !== runId || reader?.run?.id !== runId) {
    throw new ProbeError("reader_run_boundary_mismatch");
  }

  const context = isRecord(run.contextSnapshot) ? run.contextSnapshot : {};
  const bindingId = nonEmptyString(context.runtimeBindingId);
  const segmentId = nonEmptyString(context.runtimeSegmentId);
  const runtimeType = nonEmptyString(invocation?.runtimeType);
  const spanId = nonEmptyString(invocation?.spanId);
  const attemptId = nonEmptyString(invocation?.attemptId);
  if (runtimeType !== "hermes_gateway") {
    throw new ProbeError("run_runtime_type_mismatch", { runtimeType });
  }
  if (!bindingId || !segmentId || !spanId || !attemptId) {
    throw new ProbeError("native_identity_incomplete", {
      hasBindingId: Boolean(bindingId),
      hasSegmentId: Boolean(segmentId),
      hasRuntimeType: Boolean(runtimeType),
      hasSpanId: Boolean(spanId),
      hasAttemptId: Boolean(attemptId),
    });
  }
  if (reader.source !== "native") throw new ProbeError("reader_source_not_native", { source: reader.source ?? null });
  if (reader.availability !== "available") {
    throw new ProbeError("reader_not_available", { availability: reader.availability ?? null });
  }
  if (reader.completeness !== "complete") {
    throw new ProbeError("reader_not_complete", { completeness: reader.completeness ?? null });
  }
  if (reader.page?.hasMore !== false || !Array.isArray(reader.rows) || reader.rows.length === 0) {
    throw new ProbeError("reader_boundary_incomplete");
  }

  const rowIds = reader.rows.map((row) => nonEmptyString(row?.id));
  const sourceEntryIds = reader.rows.map((row) => nonEmptyString(row?.sourceEntryId));
  const rowLineage = reader.rows.map((row) => ({
    runId: nonEmptyString(row?.runId),
    spanId: nonEmptyString(row?.spanId),
    attemptId: nonEmptyString(row?.attemptId),
  }));
  const indexes = reader.rows.map((row) => row?.index);
  if (rowIds.some((id) => !id) || new Set(rowIds).size !== rowIds.length) {
    throw new ProbeError("reader_stable_ids_invalid");
  }
  if (sourceEntryIds.some((id) => !id)) throw new ProbeError("reader_source_entry_ids_missing");
  if (rowLineage.some((lineage) => !lineage.runId || !lineage.spanId || !lineage.attemptId)) {
    throw new ProbeError("reader_execution_lineage_unavailable", {
      requiredRowIdentityFields: ["runId", "attemptId", "spanId"],
      missingRowCount: rowLineage.filter((lineage) => !lineage.runId || !lineage.spanId || !lineage.attemptId).length,
    });
  }
  if (rowLineage.some((lineage) => lineage.runId !== runId
    || lineage.spanId !== spanId || lineage.attemptId !== attemptId)) {
    throw new ProbeError("reader_execution_lineage_mismatch");
  }
  if (indexes.some((index, position) => !Number.isSafeInteger(index) || (position > 0 && index <= indexes[position - 1]))) {
    throw new ProbeError("reader_order_invalid");
  }

  return {
    runId,
    source: reader.source,
    availability: reader.availability,
    completeness: reader.completeness,
    revision: nonEmptyString(reader.revision),
    runtimeType,
    rowCount: reader.rows.length,
    stableRowIdsSha256: sha256(JSON.stringify(rowIds)),
    sourceEntryIdsSha256: sha256(JSON.stringify(sourceEntryIds)),
    rowExecutionBindingsSha256: sha256(JSON.stringify(reader.rows.map((row, index) => ({
      sourceEntryId: sourceEntryIds[index],
      runId: rowLineage[index].runId,
      spanId: rowLineage[index].spanId,
      attemptId: rowLineage[index].attemptId,
    })))),
    bindingId,
    segmentId,
    spanId,
    attemptId,
    rowToSpanJoin: "exact_per_row_run_attempt_span_identity",
  };
}

export function assertNativeRunContinuity(first, second) {
  if (!first?.runId || !second?.runId || first.runId === second.runId) {
    throw new ProbeError("run_identity_not_distinct");
  }
  if (!first.conversationId || first.conversationId !== second.conversationId) {
    throw new ProbeError("native_conversation_continuity_mismatch");
  }
  if (!first.bindingId || first.bindingId !== second.bindingId) {
    throw new ProbeError("native_binding_continuity_mismatch");
  }
  const firstReader = first.reader;
  const secondReader = second.reader;
  if (firstReader?.runId !== first.runId || secondReader?.runId !== second.runId
    || !firstReader?.spanId || !firstReader?.attemptId
    || !secondReader?.spanId || !secondReader?.attemptId
    || firstReader.bindingId !== first.bindingId || secondReader.bindingId !== second.bindingId
    || firstReader.rowToSpanJoin !== "exact_per_row_run_attempt_span_identity"
    || secondReader.rowToSpanJoin !== "exact_per_row_run_attempt_span_identity"
    || !Number.isSafeInteger(firstReader.rowCount) || firstReader.rowCount < 1
    || !Number.isSafeInteger(secondReader.rowCount) || secondReader.rowCount < 1
    || !/^[a-f0-9]{64}$/u.test(firstReader.rowExecutionBindingsSha256 ?? "")
    || !/^[a-f0-9]{64}$/u.test(secondReader.rowExecutionBindingsSha256 ?? "")) {
    throw new ProbeError("native_execution_identity_incomplete");
  }
  if (firstReader.spanId === secondReader.spanId || firstReader.attemptId === secondReader.attemptId) {
    throw new ProbeError("native_execution_identity_not_distinct");
  }
  if (!first.sessionIdAfter || second.sessionIdBefore !== first.sessionIdAfter
    || second.sessionIdAfter !== first.sessionIdAfter) {
    throw new ProbeError("native_session_continuity_mismatch");
  }
  return {
    distinctRuns: true,
    sameConversation: true,
    stableBindingId: first.bindingId,
    distinctExecutionSpans: true,
    firstExecution: {
      runId: first.runId,
      spanId: firstReader.spanId,
      attemptId: firstReader.attemptId,
    },
    secondExecution: {
      runId: second.runId,
      spanId: secondReader.spanId,
      attemptId: secondReader.attemptId,
    },
    firstRunSessionIdAfter: first.sessionIdAfter,
    secondRunSessionIdBefore: second.sessionIdBefore,
    secondRunSessionIdAfter: second.sessionIdAfter,
    readersBoundToExactRunAttemptSpans: true,
  };
}

export function publicReaderExecutionLineageGap(sourceText = readFileSync(
  path.join(REPO_ROOT, PUBLIC_READER_EXECUTION_LINEAGE_GAP.source),
  "utf8",
)) {
  const hasStoredLineageShape = /type TranscriptStoredLineage\s*=\s*\{\s*runId:\s*string;\s*attemptId:\s*string\s*\|\s*null;\s*spanId:\s*string;\s*\}/u.test(sourceText);
  const lookupStart = sourceText.indexOf("async function readTranscriptStoredLineage(");
  const lookupEnd = sourceText.indexOf("\nfunction buildRunErrors", lookupStart);
  const storedLookup = lookupStart >= 0 && lookupEnd > lookupStart
    ? sourceText.slice(lookupStart, lookupEnd)
    : "";
  const hasOrgRunScopedSpanLookup = storedLookup.includes("eq(runRuntimeSpans.orgId, orgId)")
    && storedLookup.includes("eq(runRuntimeSpans.runId, runId)")
    && storedLookup.includes("inArray(runRuntimeSpans.id, spanIds)");
  const lineageStart = sourceText.indexOf("const lineageForItem = (item: TranscriptItem)");
  const lineageEnd = sourceText.indexOf("const chronologicalTrace", lineageStart);
  const lineageProjection = lineageStart >= 0 && lineageEnd > lineageStart
    ? sourceText.slice(lineageStart, lineageEnd)
    : "";
  const hasFailClosedReaderLineage = lineageProjection.includes("item.runId !== null && item.runId !== stored.runId")
    && lineageProjection.includes("return { runId: null, attemptId: null, spanId: null };");
  const compactRowsStart = sourceText.indexOf("const allRows = paged.rows.map");
  const compactRowsEnd = sourceText.indexOf("const rows = outputMode", compactRowsStart);
  const compactRowsProjection = compactRowsStart >= 0 && compactRowsEnd > compactRowsStart
    ? sourceText.slice(compactRowsStart, compactRowsEnd)
    : "";
  const fullEntriesStart = sourceText.indexOf("entries: responseItems.map");
  const fullEntriesEnd = sourceText.indexOf("output: includeOutputs", fullEntriesStart);
  const fullEntriesProjection = fullEntriesStart >= 0 && fullEntriesEnd > fullEntriesStart
    ? sourceText.slice(fullEntriesStart, fullEntriesEnd)
    : "";
  const hasCompactAndFullProjection = compactRowsProjection.includes("...lineageForItem(item)")
    && fullEntriesProjection.includes("...lineageForItem(item)");
  const hasExactReaderLineageProjection = hasStoredLineageShape
    && hasOrgRunScopedSpanLookup
    && hasFailClosedReaderLineage
    && hasCompactAndFullProjection;
  if (hasExactReaderLineageProjection) return null;

  const missingRowIdentityFields = [...PUBLIC_READER_EXECUTION_LINEAGE_GAP.requiredRowIdentityFields];
  return {
    ...PUBLIC_READER_EXECUTION_LINEAGE_GAP,
    projectedRowIdentityFields: [...PUBLIC_READER_EXECUTION_LINEAGE_GAP.projectedRowIdentityFields],
    requiredRowIdentityFields: [...PUBLIC_READER_EXECUTION_LINEAGE_GAP.requiredRowIdentityFields],
    missingRowIdentityFields,
  };
}

function summarizeAck(event) {
  return {
    userMessageId: nonEmptyString(event?.userMessage?.id),
    conversationId: nonEmptyString(event?.conversation?.id),
    generationId: nonEmptyString(event?.generationId),
  };
}

function summarizeFinal(event) {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  return messages.map((message) => ({
    id: nonEmptyString(message?.id),
    role: nonEmptyString(message?.role),
    status: nonEmptyString(message?.status),
    runId: nonEmptyString(message?.runId),
    bodyLength: typeof message?.body === "string" ? message.body.length : null,
    bodySha256: typeof message?.body === "string" ? sha256(message.body) : null,
  }));
}

/** Send exactly once. Any interrupted response after dispatch is an unknown submission. */
export async function sendChatStreamOnce({
  fetchImpl = fetch,
  url,
  body,
  timeoutMs,
  onCheckpoint = () => {},
}) {
  const controller = new AbortController();
  let dispatched = false;
  let headersReceived = false;
  let ack = null;
  let finalMessages = null;
  let streamErrorCode = null;
  let eventCount = 0;
  const eventKinds = {};
  let timer;
  let timedOut = false;

  const operation = (async () => {
    dispatched = true;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    headersReceived = true;
    if (!response.ok) {
      if (response.status >= 500 || (response.status >= 300 && response.status < 400)) {
        throw new UnknownSubmissionError({
          dispatched,
          headersReceived,
          timedOut: false,
          httpStatus: response.status,
          ack,
          eventCount,
          eventKinds,
          failureCode: "http_response_after_dispatch",
        });
      }
      return {
        outcome: "http_rejected",
        httpStatus: response.status,
        dispatched,
        ack,
        finalMessages,
        eventCount,
        eventKinds,
      };
    }
    if (!response.body) throw new ProbeError("chat_stream_body_missing");

    const decoder = new TextDecoder();
    let buffer = "";
    const acceptLine = async (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        throw new ProbeError("chat_stream_invalid_json");
      }
      if (!isRecord(event) || typeof event.type !== "string") return;
      eventCount += 1;
      eventKinds[event.type] = (eventKinds[event.type] ?? 0) + 1;
      if (event.type === "ack") {
        ack = summarizeAck(event);
        await onCheckpoint({ ack, eventCount, eventKinds });
      } else if (event.type === "final") {
        finalMessages = summarizeFinal(event);
        await onCheckpoint({ ack, finalMessages, eventCount, eventKinds });
      } else if (event.type === "error") {
        streamErrorCode = nonEmptyString(event.errorCode) ?? "chat_stream_error";
      }
    };

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) await acceptLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) await acceptLine(buffer);
    if (streamErrorCode) {
      return {
        outcome: "stream_error",
        streamErrorCode,
        dispatched,
        ack,
        finalMessages,
        eventCount,
        eventKinds,
      };
    }
    if (!ack || !finalMessages) {
      throw new ProbeError("chat_stream_terminal_receipt_missing");
    }
    return { outcome: "completed", dispatched, ack, finalMessages, eventCount, eventKinds };
  })();

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new ProbeError("chat_stream_timeout"));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof UnknownSubmissionError) throw error;
    if (dispatched && (timedOut || !headersReceived || !ack || !finalMessages)) {
      throw new UnknownSubmissionError({
        dispatched,
        headersReceived,
        timedOut,
        ack,
        eventCount,
        eventKinds,
        failureCode: error instanceof ProbeError ? error.code : "stream_transport_error",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (const arg of argv) {
    const match = /^(--[a-z-]+)=(.*)$/.exec(arg);
    if (!match) throw new ProbeError("invalid_argument", { argument: arg.split("=", 1)[0] });
    const [, key, value] = match;
    if (values.has(key)) throw new ProbeError("duplicate_argument", { argument: key });
    values.set(key, value);
  }

  const apiBaseValue = values.get("--api-base");
  const runtime = values.get("--runtime");
  const expectedSourceSha = values.get("--expected-source-sha");
  const runtimeLeasePath = values.get("--runtime-lease");
  if (!apiBaseValue || !runtime || !expectedSourceSha || !runtimeLeasePath) {
    throw new ProbeError("required_arguments_missing", {
      required: ["--api-base", "--runtime", "--expected-source-sha", "--runtime-lease"],
    });
  }
  if (runtime !== "hermes_gateway") {
    throw new ProbeError("runtime_not_supported_by_this_probe", { supportedRuntime: "hermes_gateway" });
  }
  let apiUrl;
  try {
    apiUrl = new URL(apiBaseValue);
  } catch {
    throw new ProbeError("api_base_invalid");
  }
  if (!(["http:", "https:"].includes(apiUrl.protocol))
    || apiUrl.username || apiUrl.password || apiUrl.search || apiUrl.hash || apiUrl.pathname !== "/") {
    throw new ProbeError("api_base_must_be_an_origin_without_credentials");
  }

  if (!/^[0-9a-f]{40}$/i.test(expectedSourceSha)) throw new ProbeError("expected_source_sha_invalid");
  if (!path.isAbsolute(runtimeLeasePath)) throw new ProbeError("runtime_lease_path_must_be_absolute");
  const apiBase = normalizeLoopbackApiBase(apiBaseValue);

  const model = values.get("--model")?.trim() || null;
  if (model && model.length > 120) throw new ProbeError("model_identifier_too_long");
  const timeoutValue = values.get("--timeout-ms");
  const timeoutMs = timeoutValue === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutValue);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new ProbeError("timeout_ms_out_of_range");
  }
  const unknown = [...values.keys()].filter((key) => !new Set([
    "--api-base", "--runtime", "--expected-source-sha", "--runtime-lease", "--model", "--timeout-ms",
  ]).has(key));
  if (unknown.length) throw new ProbeError("unknown_argument", { argument: unknown[0] });

  return {
    apiBase,
    runtime,
    expectedSourceSha: expectedSourceSha.toLowerCase(),
    runtimeLeasePath,
    model,
    timeoutMs,
  };
}

async function createEvidenceDir() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-native-chat-probe-"));
  const realDirectory = await fs.realpath(directory);
  const realRepoRoot = await fs.realpath(REPO_ROOT);
  const relative = path.relative(realRepoRoot, realDirectory);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new ProbeError("evidence_directory_inside_repository");
  }
  return realDirectory;
}

async function saveReceipt(directory, receipt) {
  const target = path.join(directory, "receipt.json");
  const temporary = path.join(directory, `.receipt-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, target);
}

function apiUrl(apiBase, route) {
  return new URL(route.replace(/^\//, ""), `${apiBase}/`).toString();
}

async function requestJson(apiBase, method, route, body, timeoutMs = 15_000) {
  let response;
  try {
    response = await fetch(apiUrl(apiBase, route), {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
  } catch {
    throw new ProbeError("api_transport_error", { method, route });
  }
  const text = await response.text().catch(() => "");
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ProbeError("api_response_not_json", { method, route, status: response.status });
    }
  }
  if (!response.ok) {
    throw new ProbeError("api_http_error", { method, route, status: response.status });
  }
  return payload;
}

/** Send one non-idempotent resource POST after its redacted intent is durable. */
export async function sendResourcePostOnce({
  fetchImpl = fetch,
  url,
  endpoint,
  kind,
  body,
  intentIdentifiers = {},
  intentId = randomUUID(),
  timeoutMs = 15_000,
  onCheckpoint = async () => {},
}) {
  const intent = {
    submissionKind: "resource_post",
    kind,
    intentId,
    endpoint,
    clientMutationId: nonEmptyString(body?.clientMutationId),
    bodySha256: sha256(JSON.stringify(body)),
    identifiers: Object.fromEntries(["organizationId", "conversationId", "sourceConversationId", "sourceMessageId"]
      .flatMap((key) => {
        const value = nonEmptyString(intentIdentifiers[key]);
        return value ? [[key, value]] : [];
      })),
    replayed: false,
  };
  await onCheckpoint({ ...intent, status: "intent_checkpointed" });

  const unknown = async (failureCode, httpStatus = null, responseReceived = false) => {
    const details = {
      ...intent,
      status: "unknown_submission",
      dispatched: true,
      responseReceived,
      httpStatus,
      failureCode,
    };
    await onCheckpoint(details);
    throw new UnknownSubmissionError(details);
  };

  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
  } catch {
    return unknown("resource_post_no_response");
  }

  if ((response.status >= 300 && response.status < 400) || response.status >= 500) {
    return unknown("resource_post_ambiguous_http_response", response.status, true);
  }
  if (!response.ok) {
    await onCheckpoint({
      ...intent,
      status: "rejected",
      dispatched: true,
      responseReceived: true,
      httpStatus: response.status,
    });
    throw new ProbeError("resource_post_rejected", {
      kind,
      intentId,
      httpStatus: response.status,
    });
  }

  let payload;
  try {
    const text = await response.text();
    if (!text.trim()) throw new Error("empty resource response");
    payload = JSON.parse(text);
  } catch {
    return unknown("resource_post_success_response_unreadable", response.status, true);
  }
  if (!isRecord(payload) || !nonEmptyString(payload.id)) {
    return unknown("resource_post_resource_id_missing", response.status, true);
  }

  await onCheckpoint({
    ...intent,
    status: "confirmed",
    dispatched: true,
    responseReceived: true,
    httpStatus: response.status,
    resourceId: payload.id,
  });
  return payload;
}

async function createResourceOnce({ receipt, evidenceDir, apiBase, route, body, timeoutMs, kind, intentIdentifiers }) {
  const intentId = randomUUID();
  const payload = await sendResourcePostOnce({
    url: apiUrl(apiBase, route),
    endpoint: route,
    kind,
    body,
    intentIdentifiers,
    intentId,
    timeoutMs,
    onCheckpoint: async (update) => {
      const existing = receipt.mutationLedger.find((entry) => entry.intentId === intentId);
      if (existing) Object.assign(existing, update);
      else receipt.mutationLedger.push(update);
      await checkpoint(evidenceDir, receipt);
    },
  });
  const entry = receipt.mutationLedger.find((item) => item.intentId === intentId);
  if (entry) Object.assign(entry, {
    id: payload.id,
    runtime: kind === "agent_create" ? body.agentRuntimeType : undefined,
    connectionMode: kind === "agent_create" ? body.agentRuntimeConfig?.hermesConnectionMode : undefined,
    configOverrides: kind === "agent_create" && body.agentRuntimeConfig?.model ? ["model"] : undefined,
  });
  await checkpoint(evidenceDir, receipt);
  return payload;
}

function statusFromError(error) {
  if (error instanceof UnknownSubmissionError) return "unknown_submission";
  if (error instanceof ProbeError) {
    if (error.code.startsWith("runtime_lease_") || error.code === "expected_source_sha_invalid") return "source_gate_blocked";
    const httpStatus = error.details?.status ?? error.details?.httpStatus;
    if (error.code === "api_transport_error"
      || httpStatus === 401 || httpStatus === 403 || httpStatus === 503
      || (typeof httpStatus === "number" && httpStatus >= 500)) {
      return "blocked_provider_or_availability";
    }
    return "failed";
  }
  return "failed";
}

function criteriaStatus(receipt, name, status, detail = {}) {
  receipt.criteria[name] = { status, ...detail };
}

export function markTerminalAssistantPersisted(receipt, turnName, assistant, run) {
  const criterionName = `${turnName}TerminalAssistant`;
  const pending = receipt.criteria[criterionName];
  if (!pending || pending.status !== "pending"
    || assistant?.status !== "completed"
    || !assistant.body?.trim()
    || !nonEmptyString(assistant.id)
    || !nonEmptyString(run?.id)
    || assistant.runId !== run.id
    || pending.assistantMessageId !== assistant.id
    || pending.runId !== run.id
    || run.status !== "succeeded") {
    throw new ProbeError("terminal_assistant_persistence_mismatch");
  }
  criteriaStatus(receipt, criterionName, "pass", {
    assistantMessageId: assistant.id,
    assistantStatus: assistant.status,
    runId: run.id,
    runStatus: run.status,
    persisted: true,
  });
}

async function checkpoint(directory, receipt) {
  await saveReceipt(directory, receipt);
}

async function sendTurn({ receipt, evidenceDir, apiBase, route, body, timeoutMs, turnName }) {
  const mutation = {
    kind: "chat_message_stream",
    endpoint: route,
    clientMutationId: body.clientMutationId,
    bodySha256: sha256(body.body),
  };
  receipt.mutationLedger.push(mutation);
  receipt.turns[turnName] = { status: "submitted_once", clientMutationId: body.clientMutationId };
  await checkpoint(evidenceDir, receipt);

  let result;
  try {
    result = await sendChatStreamOnce({
      url: apiUrl(apiBase, route),
      body,
      timeoutMs,
      onCheckpoint: async (stream) => {
        receipt.turns[turnName].stream = stream;
        await checkpoint(evidenceDir, receipt);
      },
    });
  } catch (error) {
    if (error instanceof UnknownSubmissionError) {
      receipt.turns[turnName] = {
        ...receipt.turns[turnName],
        status: "unknown_submission",
        unknown: error.details,
        replayed: false,
      };
      criteriaStatus(receipt, `${turnName}Submission`, "unknown", { replayed: false });
      await checkpoint(evidenceDir, receipt);
      throw error;
    }
    throw error;
  }

  receipt.turns[turnName] = { ...receipt.turns[turnName], ...result };
  if (result.outcome !== "completed") {
    criteriaStatus(receipt, `${turnName}Submission`, result.outcome === "unknown" ? "unknown" : "fail", {
      httpStatus: result.httpStatus ?? null,
      streamErrorCode: result.streamErrorCode ?? null,
      replayed: false,
    });
    await checkpoint(evidenceDir, receipt);
    throw new ProbeError(`chat_submission_${result.outcome}`, { httpStatus: result.httpStatus ?? null });
  }

  const assistantMessages = result.finalMessages.filter((message) => message.role === "assistant");
  const assistant = assistantMessages.at(-1);
  if (!assistant?.id || assistant.status !== "completed" || !assistant.runId) {
    criteriaStatus(receipt, `${turnName}TerminalAssistant`, "fail", { assistantMessageCount: assistantMessages.length });
    await checkpoint(evidenceDir, receipt);
    throw new ProbeError("assistant_terminal_message_missing");
  }
  const conversationId = result.ack?.conversationId ?? receipt.identities.mainConversationId;
  if (!conversationId) throw new ProbeError("chat_conversation_id_missing_after_ack");
  receipt.identities.mainConversationId ??= conversationId;
  receipt.turns[turnName] = {
    ...receipt.turns[turnName],
    status: "stream_completed",
    userMessageId: result.ack.userMessageId,
    assistantMessageId: assistant.id,
    runId: assistant.runId,
    assistantBodySha256: assistant.bodySha256,
    assistantBodyLength: assistant.bodyLength,
    eventCount: result.eventCount,
    eventKinds: result.eventKinds,
  };
  criteriaStatus(receipt, `${turnName}Submission`, "pass", { replayed: false });
  criteriaStatus(receipt, `${turnName}TerminalAssistant`, "pending", { assistantMessageId: assistant.id, runId: assistant.runId });
  await checkpoint(evidenceDir, receipt);
  return { conversationId, assistantMessage: assistant, userMessageId: result.ack.userMessageId };
}

export async function verifyPersistedTurn({
  apiBase,
  conversationId,
  agentId,
  runId,
  userMessageId,
  assistantMessage,
  userBody,
  timeoutMs,
  receipt,
  evidenceDir,
  turnName,
  readJson = requestJson,
  saveCheckpoint = checkpoint,
}) {
  const deadline = Date.now() + timeoutMs;
  let messages = [];
  let run = null;
  while (Date.now() < deadline) {
    messages = await readJson(apiBase, "GET", `/api/chats/${conversationId}/messages?includeTranscript=true`);
    run = await readJson(apiBase, "GET", `/api/heartbeat-runs/${runId}`);
    const persistedUser = Array.isArray(messages) ? messages.find((message) => message.id === userMessageId) : null;
    const persistedAssistant = Array.isArray(messages) ? messages.find((message) => message.id === assistantMessage.id) : null;
    if (persistedUser && persistedAssistant && TERMINAL_RUN_STATUSES.has(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const persistedUser = Array.isArray(messages) ? messages.find((message) => message.id === userMessageId) : null;
  const persistedAssistant = Array.isArray(messages) ? messages.find((message) => message.id === assistantMessage.id) : null;
  if (!persistedUser || !persistedAssistant) throw new ProbeError("persisted_chat_messages_missing");
  if (persistedUser.body !== userBody || persistedUser.role !== "user") throw new ProbeError("persisted_user_message_mismatch");
  if (persistedAssistant.role !== "assistant" || persistedAssistant.status !== "completed"
    || persistedAssistant.runId !== runId || !persistedAssistant.body?.trim()) {
    throw new ProbeError("persisted_assistant_message_mismatch");
  }
  if (!run || run.id !== runId || run.chatConversationId !== conversationId || run.agentId !== agentId) {
    throw new ProbeError("run_product_identity_mismatch");
  }
  if (run.status !== "succeeded") {
    throw new ProbeError("run_not_succeeded", { status: run.status ?? null, errorCode: run.errorCode ?? null });
  }
  markTerminalAssistantPersisted(receipt, turnName, persistedAssistant, run);
  await saveCheckpoint(evidenceDir, receipt);
  return {
    run,
    userMessage: { id: persistedUser.id, bodySha256: sha256(persistedUser.body), status: persistedUser.status },
    assistantMessage: {
      id: persistedAssistant.id,
      runId: persistedAssistant.runId,
      bodySha256: sha256(persistedAssistant.body),
      bodyLength: persistedAssistant.body.length,
      status: persistedAssistant.status,
    },
  };
}

async function readNativeEvidence(apiBase, run) {
  const runId = run.id;
  const [events, reader] = await Promise.all([
    requestJson(apiBase, "GET", `/api/heartbeat-runs/${runId}/events?limit=200`),
    requestJson(apiBase, "GET", `/api/run-intelligence/runs/${runId}/transcript?order=oldest&limit=200&includeOutputs=false`),
  ]);
  const invocationEvents = Array.isArray(events)
    ? events.filter((event) => event.eventType === "adapter.invoke" && isRecord(event.payload))
    : [];
  if (invocationEvents.length !== 1) {
    throw new ProbeError("native_invocation_identity_ambiguous", {
      invocationEventCount: invocationEvents.length,
    });
  }
  const invocationEvent = invocationEvents[0];
  const invocation = invocationEvent?.payload ? {
    runtimeType: invocationEvent.payload.agentRuntimeType,
    spanId: invocationEvent.payload.invocationSpanId,
    attemptId: invocationEvent.payload.invocationAttemptId,
  } : null;
  return assertNativeReaderBoundary({ runId, run, reader, invocation });
}

export async function runProbe(config, {
  createEvidenceDirectory = createEvidenceDir,
  saveCheckpoint = checkpoint,
  inspectReaderLineage = publicReaderExecutionLineageGap,
} = {}) {
  const evidenceDir = await createEvidenceDirectory();
  const receipt = {
    schemaVersion: 1,
    probe: PROBE_NAME,
    verdict: "QUESTION",
    runtime: { type: config.runtime, model: config.model, modelSelection: config.model ? "explicit_non_secret_identifier" : "installed_local_profile_default" },
    target: { apiBase: config.apiBase, expectedSourceSha: config.expectedSourceSha },
    evidence: { directory: evidenceDir, receiptPath: path.join(evidenceDir, "receipt.json") },
    runtimeLease: null,
    health: null,
    identities: { organizationId: null, agentId: null, mainConversationId: null, sideChatId: null },
    criteria: {},
    turns: {
      first: { status: "not_run" },
      second: { status: "not_run" },
      sideChatFirst: { status: "not_run" },
      sideChatSecond: { status: "not_run" },
    },
    mutationLedger: [],
    notCovered: [
      "full tool manifest or shell-fallback audit",
      "Fork, retention recovery, cleanup, process-loss recovery, other runtimes, and the full provider matrix",
      "UI rendering, screenshots, cross-runtime controls, and full W11/W12 acceptance",
    ],
    cleanup: { performed: false, retainedDisposableData: true },
    replayPolicy: "Each chat stream is sent once. Unknown submission outcomes are never resubmitted.",
    startedAt: new Date().toISOString(),
  };
  await saveCheckpoint(evidenceDir, receipt);

  const readerLineageGap = inspectReaderLineage();
  if (readerLineageGap) {
    receipt.notCovered.push("native runtime execution and resource creation blocked because public Reader rows omit exact Run/Attempt/Span lineage");
    receipt.blockers = [{ code: "public_reader_execution_lineage_unavailable", ...readerLineageGap }];
    receipt.failure = {
      code: "public_reader_execution_lineage_unavailable",
      status: "question",
      details: readerLineageGap,
    };
    criteriaStatus(receipt, "publicReaderExecutionLineage", "question", readerLineageGap);
    receipt.cleanup = { performed: false, retainedDisposableData: false, note: "No disposable resource or native runtime was created." };
    receipt.finishedAt = new Date().toISOString();
    await saveCheckpoint(evidenceDir, receipt);
    return receipt;
  }

  try {
    const runtimeLease = await readCapturedRuntimeLease(config);
    receipt.runtimeLease = runtimeLease.proof;
    await checkpoint(evidenceDir, receipt);

    const health = await requestJson(config.apiBase, "GET", "/api/health", undefined, 10_000);
    receipt.health = {
      status: health?.status ?? null,
      version: health?.version ?? null,
      instanceId: health?.instanceId ?? null,
      localEnv: health?.localEnv ?? null,
      deploymentMode: health?.deploymentMode ?? null,
      authReady: health?.authReady ?? null,
      sourceSha: typeof health?.sourceSha === "string" ? health.sourceSha : null,
    };
    await checkpoint(evidenceDir, receipt);
    const healthIdentity = assertRuntimeLeaseHealth(health, runtimeLease.lease);
    receipt.health.sourceSha = healthIdentity.sourceSha;
    receipt.health.sourceShaEvidence = healthIdentity.healthSourceSha;
    criteriaStatus(receipt, "runtimeSourceIdentity", "pass", {
      source: runtimeLease.proof.source,
      sourceSha: runtimeLease.proof.immutableSha,
      pid: runtimeLease.proof.pid,
      entry: runtimeLease.proof.entry,
      listener: runtimeLease.proof.listener,
      instanceId: healthIdentity.instanceId,
      healthSourceSha: healthIdentity.healthSourceSha,
    });
    await checkpoint(evidenceDir, receipt);

    const marker = `NATIVE_CHAT_PROBE_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    const org = await createResourceOnce({
      receipt,
      evidenceDir,
      apiBase: config.apiBase,
      route: "/api/orgs",
      kind: "organization_create",
      timeoutMs: 15_000,
      body: {
        name: `Native Chat Probe ${marker}`,
        description: "Disposable local Hermes native Chat probe data. Retain with this receipt.",
      },
    });
    if (!nonEmptyString(org?.id)) throw new ProbeError("organization_create_missing_id");
    receipt.identities.organizationId = org.id;
    criteriaStatus(receipt, "disposableOrganization", "pass", { organizationId: org.id });
    await checkpoint(evidenceDir, receipt);

    const runtimeConfig = {
      hermesConnectionMode: "local",
      ...(config.model ? { model: config.model } : {}),
    };
    const agent = await createResourceOnce({
      receipt,
      evidenceDir,
      apiBase: config.apiBase,
      route: `/api/orgs/${org.id}/agents`,
      kind: "agent_create",
      intentIdentifiers: { organizationId: org.id },
      timeoutMs: 15_000,
      body: {
        name: `Native Chat Probe ${marker}`,
        role: "engineer",
        agentRuntimeType: config.runtime,
        agentRuntimeConfig: runtimeConfig,
      },
    });
    if (!nonEmptyString(agent?.id)) throw new ProbeError("agent_create_missing_id");
    receipt.identities.agentId = agent.id;
    const localHermesConfig = assertLocalHermesConfiguration(agent, config.model);
    criteriaStatus(receipt, "localHermesAgent", "pass", { agentId: agent.id, ...localHermesConfig });
    await checkpoint(evidenceDir, receipt);

    const firstBody = `Reply briefly to this first-turn marker: ${marker}_FIRST.`;
    const first = await sendTurn({
      receipt,
      evidenceDir,
      apiBase: config.apiBase,
      route: `/api/orgs/${org.id}/chats/messages/stream`,
      body: {
        preferredAgentId: agent.id,
        title: `Native Chat Probe ${marker}`,
        body: firstBody,
        clientMutationId: randomUUID(),
      },
      timeoutMs: config.timeoutMs,
      turnName: "first",
    });
    const firstReadback = await verifyPersistedTurn({
      apiBase: config.apiBase,
      conversationId: first.conversationId,
      agentId: agent.id,
      runId: first.assistantMessage.runId,
      userMessageId: first.userMessageId,
      assistantMessage: first.assistantMessage,
      userBody: firstBody,
      timeoutMs: config.timeoutMs,
      receipt,
      evidenceDir,
      turnName: "first",
    });
    const firstNative = await readNativeEvidence(config.apiBase, firstReadback.run);
    receipt.turns.first = {
      ...receipt.turns.first,
      status: "passed",
      userMessageId: firstReadback.userMessage.id,
      assistantMessageId: firstReadback.assistantMessage.id,
      runId: firstReadback.run.id,
      runStatus: firstReadback.run.status,
      sessionIdBefore: firstReadback.run.sessionIdBefore ?? null,
      sessionIdAfter: firstReadback.run.sessionIdAfter ?? null,
      reader: firstNative,
    };
    criteriaStatus(receipt, "firstTurnPersistenceAndNativeReader", "pass", {
      conversationId: first.conversationId,
      runId: firstReadback.run.id,
      spanId: firstNative.spanId,
      bindingId: firstNative.bindingId,
      segmentId: firstNative.segmentId,
    });
    await checkpoint(evidenceDir, receipt);

    const secondBody = `Reply briefly to this continuity marker: ${marker}_SECOND.`;
    const second = await sendTurn({
      receipt,
      evidenceDir,
      apiBase: config.apiBase,
      route: `/api/chats/${first.conversationId}/messages/stream`,
      body: { body: secondBody, clientMutationId: randomUUID() },
      timeoutMs: config.timeoutMs,
      turnName: "second",
    });
    const secondReadback = await verifyPersistedTurn({
      apiBase: config.apiBase,
      conversationId: first.conversationId,
      agentId: agent.id,
      runId: second.assistantMessage.runId,
      userMessageId: second.userMessageId,
      assistantMessage: second.assistantMessage,
      userBody: secondBody,
      timeoutMs: config.timeoutMs,
      receipt,
      evidenceDir,
      turnName: "second",
    });
    const secondNative = await readNativeEvidence(config.apiBase, secondReadback.run);
    const continuity = assertNativeRunContinuity({
      conversationId: first.conversationId,
      runId: firstReadback.run.id,
      bindingId: firstNative.bindingId,
      sessionIdBefore: firstReadback.run.sessionIdBefore,
      sessionIdAfter: firstReadback.run.sessionIdAfter,
      reader: firstNative,
    }, {
      conversationId: first.conversationId,
      runId: secondReadback.run.id,
      bindingId: secondNative.bindingId,
      sessionIdAfter: secondReadback.run.sessionIdAfter,
      sessionIdBefore: secondReadback.run.sessionIdBefore,
      reader: secondNative,
    });
    receipt.turns.second = {
      ...receipt.turns.second,
      status: "passed",
      userMessageId: secondReadback.userMessage.id,
      assistantMessageId: secondReadback.assistantMessage.id,
      runId: secondReadback.run.id,
      runStatus: secondReadback.run.status,
      sessionIdBefore: secondReadback.run.sessionIdBefore ?? null,
      sessionIdAfter: secondReadback.run.sessionIdAfter ?? null,
      reader: secondNative,
    };
    criteriaStatus(receipt, "secondTurnPersistenceAndNativeReader", "pass", {
      conversationId: first.conversationId,
      runId: secondReadback.run.id,
      spanId: secondNative.spanId,
      bindingId: secondNative.bindingId,
      segmentId: secondNative.segmentId,
    });
    criteriaStatus(receipt, "mainChatRunBoundaryAndContinuity", "pass", continuity);
    await checkpoint(evidenceDir, receipt);

    const sideChatMutationId = randomUUID();
    const sideChatRoute = `/api/chats/${first.conversationId}/side-chats`;
    try {
      const sideChat = await createResourceOnce({
        receipt,
        evidenceDir,
        apiBase: config.apiBase,
        route: sideChatRoute,
        kind: "side_chat_create",
        intentIdentifiers: {
          sourceConversationId: first.conversationId,
          sourceMessageId: secondReadback.assistantMessage.id,
        },
        timeoutMs: 15_000,
        body: {
          sourceMessageId: secondReadback.assistantMessage.id,
          clientMutationId: sideChatMutationId,
        },
      });
      if (!nonEmptyString(sideChat?.id)) throw new ProbeError("side_chat_create_missing_id");
      receipt.identities.sideChatId = sideChat.id;
      await checkpoint(evidenceDir, receipt);
      if (sideChat.conversationKind !== "side_chat"
        || sideChat.forkedFromConversationId !== first.conversationId
        || sideChat.forkedFromMessageId !== secondReadback.assistantMessage.id) {
        throw new ProbeError("side_chat_source_binding_mismatch");
      }

      const sideFirstBody = `Reply briefly to this Side Chat first-turn marker: ${marker}_SIDE_FIRST.`;
      const sideFirst = await sendTurn({
        receipt,
        evidenceDir,
        apiBase: config.apiBase,
        route: `/api/chats/${sideChat.id}/messages/stream`,
        body: { body: sideFirstBody, clientMutationId: randomUUID() },
        timeoutMs: config.timeoutMs,
        turnName: "sideChatFirst",
      });
      const sideFirstReadback = await verifyPersistedTurn({
        apiBase: config.apiBase,
        conversationId: sideChat.id,
        agentId: agent.id,
        runId: sideFirst.assistantMessage.runId,
        userMessageId: sideFirst.userMessageId,
        assistantMessage: sideFirst.assistantMessage,
        userBody: sideFirstBody,
        timeoutMs: config.timeoutMs,
        receipt,
        evidenceDir,
        turnName: "sideChatFirst",
      });
      const sideFirstNative = await readNativeEvidence(config.apiBase, sideFirstReadback.run);
      receipt.turns.sideChatFirst = {
        ...receipt.turns.sideChatFirst,
        status: "passed",
        sourceConversationId: first.conversationId,
        sourceMessageId: secondReadback.assistantMessage.id,
        conversationId: sideChat.id,
        userMessageId: sideFirstReadback.userMessage.id,
        assistantMessageId: sideFirstReadback.assistantMessage.id,
        runId: sideFirstReadback.run.id,
        runStatus: sideFirstReadback.run.status,
        sessionIdBefore: sideFirstReadback.run.sessionIdBefore ?? null,
        sessionIdAfter: sideFirstReadback.run.sessionIdAfter ?? null,
        reader: sideFirstNative,
      };
      criteriaStatus(receipt, "sideChatAnchoredNativeRun", "pass", {
        conversationId: sideChat.id,
        sourceMessageId: secondReadback.assistantMessage.id,
        runId: sideFirstReadback.run.id,
        spanId: sideFirstNative.spanId,
        attemptId: sideFirstNative.attemptId,
        bindingId: sideFirstNative.bindingId,
        segmentId: sideFirstNative.segmentId,
      });

      const sideSecondBody = `Reply briefly to this Side Chat continuity marker: ${marker}_SIDE_SECOND.`;
      const sideSecond = await sendTurn({
        receipt,
        evidenceDir,
        apiBase: config.apiBase,
        route: `/api/chats/${sideChat.id}/messages/stream`,
        body: { body: sideSecondBody, clientMutationId: randomUUID() },
        timeoutMs: config.timeoutMs,
        turnName: "sideChatSecond",
      });
      const sideSecondReadback = await verifyPersistedTurn({
        apiBase: config.apiBase,
        conversationId: sideChat.id,
        agentId: agent.id,
        runId: sideSecond.assistantMessage.runId,
        userMessageId: sideSecond.userMessageId,
        assistantMessage: sideSecond.assistantMessage,
        userBody: sideSecondBody,
        timeoutMs: config.timeoutMs,
        receipt,
        evidenceDir,
        turnName: "sideChatSecond",
      });
      const sideSecondNative = await readNativeEvidence(config.apiBase, sideSecondReadback.run);
      const sideContinuity = assertNativeRunContinuity({
        conversationId: sideChat.id,
        runId: sideFirstReadback.run.id,
        bindingId: sideFirstNative.bindingId,
        sessionIdBefore: sideFirstReadback.run.sessionIdBefore,
        sessionIdAfter: sideFirstReadback.run.sessionIdAfter,
        reader: sideFirstNative,
      }, {
        conversationId: sideChat.id,
        runId: sideSecondReadback.run.id,
        bindingId: sideSecondNative.bindingId,
        sessionIdBefore: sideSecondReadback.run.sessionIdBefore,
        sessionIdAfter: sideSecondReadback.run.sessionIdAfter,
        reader: sideSecondNative,
      });
      receipt.turns.sideChatSecond = {
        ...receipt.turns.sideChatSecond,
        status: "passed",
        sourceConversationId: first.conversationId,
        sourceMessageId: secondReadback.assistantMessage.id,
        conversationId: sideChat.id,
        userMessageId: sideSecondReadback.userMessage.id,
        assistantMessageId: sideSecondReadback.assistantMessage.id,
        runId: sideSecondReadback.run.id,
        runStatus: sideSecondReadback.run.status,
        sessionIdBefore: sideSecondReadback.run.sessionIdBefore ?? null,
        sessionIdAfter: sideSecondReadback.run.sessionIdAfter ?? null,
        reader: sideSecondNative,
      };
      criteriaStatus(receipt, "sideChatConsecutiveSendNativeSessionAndExecutionSpans", "pass", sideContinuity);
      await checkpoint(evidenceDir, receipt);
    } catch (error) {
      if (error instanceof ProbeError && error.details?.httpStatus === 404 && !receipt.identities.sideChatId) {
        receipt.turns.sideChatFirst = { status: "failed", replayed: false, reason: "public_side_chat_create_returned_404" };
        criteriaStatus(receipt, "sideChatAnchoredNativeRun", "fail", { reason: "public_side_chat_create_returned_404" });
        await checkpoint(evidenceDir, receipt);
      }
      throw error;
    }

    receipt.cleanup = { performed: false, retainedDisposableData: true };
    receipt.finishedAt = new Date().toISOString();
    receipt.verdict = "PASS";
    criteriaStatus(receipt, "disposableDataRetained", "pass", {
      organizationId: org.id,
      agentId: agent.id,
      conversationId: first.conversationId,
    });
    await checkpoint(evidenceDir, receipt);
  } catch (error) {
    const code = error instanceof ProbeError || error instanceof UnknownSubmissionError ? error.code : "unexpected_probe_error";
    const status = statusFromError(error);
    receipt.failure = {
      code,
      status,
      details: error instanceof ProbeError || error instanceof UnknownSubmissionError ? error.details : {},
    };
    receipt.verdict = status === "failed" ? "FAIL" : "QUESTION";
    receipt.finishedAt = new Date().toISOString();
    if (status === "source_gate_blocked") {
      criteriaStatus(receipt, "runtimeSourceIdentity", "question", { reason: code });
    }
    if (status === "unknown_submission") {
      receipt.cleanup = { performed: false, retainedDisposableData: true, note: "Do not replay; resolve by read-only inspection." };
    }
    await checkpoint(evidenceDir, receipt);
  }

  return receipt;
}

async function main() {
  let config;
  try {
    config = parseArguments(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof ProbeError ? error.code : "argument_parse_failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 2;
    return;
  }

  const receipt = await runProbe(config);
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.verdict !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof ProbeError ? error.code : "probe_failed_before_receipt"}\n`);
    process.exitCode = 1;
  });
}
