#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROBE_NAME = "real-native-chat-runtime";
const DEFAULT_TIMEOUT_MS = 180_000;
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed_out"]);

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
    super("chat_submission_outcome_unknown");
    this.name = "UnknownSubmissionError";
    this.code = "chat_submission_outcome_unknown";
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
  const indexes = reader.rows.map((row) => row?.index);
  if (rowIds.some((id) => !id) || new Set(rowIds).size !== rowIds.length) {
    throw new ProbeError("reader_stable_ids_invalid");
  }
  if (sourceEntryIds.some((id) => !id)) throw new ProbeError("reader_source_entry_ids_missing");
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
    bindingId,
    segmentId,
    spanId,
    attemptId,
    rowToSpanJoin: "not_exposed_by_public_reader_projection",
  };
}

export function assertNativeRunContinuity(first, second) {
  if (!first?.runId || !second?.runId || first.runId === second.runId) {
    throw new ProbeError("run_identity_not_distinct");
  }
  if (!first.bindingId || first.bindingId !== second.bindingId) {
    throw new ProbeError("native_binding_continuity_mismatch");
  }
  if (!first.sessionIdAfter || second.sessionIdBefore !== first.sessionIdAfter) {
    throw new ProbeError("native_session_continuity_mismatch");
  }
  if (first.readerRunId !== first.runId || second.readerRunId !== second.runId) {
    throw new ProbeError("reader_run_boundary_mismatch");
  }
  return {
    distinctRuns: true,
    stableBindingId: first.bindingId,
    firstRunSessionIdAfter: first.sessionIdAfter,
    secondRunSessionIdBefore: second.sessionIdBefore,
    readersBoundToExactRuns: true,
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

async function verifyPersistedTurn({ apiBase, conversationId, agentId, runId, userMessageId, assistantMessage, userBody, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  let messages = [];
  let run = null;
  while (Date.now() < deadline) {
    messages = await requestJson(apiBase, "GET", `/api/chats/${conversationId}/messages?includeTranscript=true`);
    run = await requestJson(apiBase, "GET", `/api/heartbeat-runs/${runId}`);
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
  const invocationEvent = Array.isArray(events)
    ? events.find((event) => event.eventType === "adapter.invoke" && isRecord(event.payload))
    : null;
  const invocation = invocationEvent?.payload ? {
    runtimeType: invocationEvent.payload.agentRuntimeType,
    spanId: invocationEvent.payload.invocationSpanId,
    attemptId: invocationEvent.payload.invocationAttemptId,
  } : null;
  return assertNativeReaderBoundary({ runId, run, reader, invocation });
}

async function runProbe(config) {
  const evidenceDir = await createEvidenceDir();
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
    turns: { first: { status: "not_run" }, second: { status: "not_run" }, sideChat: { status: "not_run" } },
    mutationLedger: [],
    notCovered: [
      "full tool manifest or shell-fallback audit",
      "Fork, retention recovery, cleanup, process-loss recovery, other runtimes, and the full provider matrix",
      "per-Reader-row span-to-binding join; the public Reader projection does not expose it",
      "UI rendering, screenshots, cross-runtime controls, and full W11/W12 acceptance",
    ],
    cleanup: { performed: false, retainedDisposableData: true },
    replayPolicy: "Each chat stream is sent once. Unknown submission outcomes are never resubmitted.",
    startedAt: new Date().toISOString(),
  };
  await checkpoint(evidenceDir, receipt);

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
    const org = await requestJson(config.apiBase, "POST", "/api/orgs", {
      name: `Native Chat Probe ${marker}`,
      description: "Disposable local Hermes native Chat probe data. Retain with this receipt.",
    });
    if (!nonEmptyString(org?.id)) throw new ProbeError("organization_create_missing_id");
    receipt.identities.organizationId = org.id;
    receipt.mutationLedger.push({ kind: "organization_create", id: org.id });
    criteriaStatus(receipt, "disposableOrganization", "pass", { organizationId: org.id });
    await checkpoint(evidenceDir, receipt);

    const runtimeConfig = {
      hermesConnectionMode: "local",
      ...(config.model ? { model: config.model } : {}),
    };
    const agent = await requestJson(config.apiBase, "POST", `/api/orgs/${org.id}/agents`, {
      name: `Native Chat Probe ${marker}`,
      role: "engineer",
      agentRuntimeType: config.runtime,
      agentRuntimeConfig: runtimeConfig,
    });
    if (!nonEmptyString(agent?.id)) throw new ProbeError("agent_create_missing_id");
    receipt.identities.agentId = agent.id;
    receipt.mutationLedger.push({ kind: "agent_create", id: agent.id, runtime: config.runtime, connectionMode: "local", configOverrides: config.model ? ["model"] : [] });
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
    });
    const secondNative = await readNativeEvidence(config.apiBase, secondReadback.run);
    const continuity = assertNativeRunContinuity({
      runId: firstReadback.run.id,
      bindingId: firstNative.bindingId,
      sessionIdAfter: firstReadback.run.sessionIdAfter,
      readerRunId: firstNative.runId,
    }, {
      runId: secondReadback.run.id,
      bindingId: secondNative.bindingId,
      sessionIdBefore: secondReadback.run.sessionIdBefore,
      readerRunId: secondNative.runId,
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
      const sideChat = await requestJson(config.apiBase, "POST", sideChatRoute, {
        sourceMessageId: secondReadback.assistantMessage.id,
        clientMutationId: sideChatMutationId,
      });
      if (!nonEmptyString(sideChat?.id)) throw new ProbeError("side_chat_create_missing_id");
      receipt.identities.sideChatId = sideChat.id;
      receipt.mutationLedger.push({
        kind: "side_chat_create",
        id: sideChat.id,
        clientMutationId: sideChatMutationId,
        sourceConversationId: first.conversationId,
        sourceMessageId: secondReadback.assistantMessage.id,
      });
      await checkpoint(evidenceDir, receipt);
      if (sideChat.conversationKind !== "side_chat"
        || sideChat.forkedFromConversationId !== first.conversationId
        || sideChat.forkedFromMessageId !== secondReadback.assistantMessage.id) {
        throw new ProbeError("side_chat_source_binding_mismatch");
      }

      const sideBody = `Reply briefly to this Side Chat marker: ${marker}_SIDE.`;
      const side = await sendTurn({
        receipt,
        evidenceDir,
        apiBase: config.apiBase,
        route: `/api/chats/${sideChat.id}/messages/stream`,
        body: { body: sideBody, clientMutationId: randomUUID() },
        timeoutMs: config.timeoutMs,
        turnName: "sideChat",
      });
      const sideReadback = await verifyPersistedTurn({
        apiBase: config.apiBase,
        conversationId: sideChat.id,
        agentId: agent.id,
        runId: side.assistantMessage.runId,
        userMessageId: side.userMessageId,
        assistantMessage: side.assistantMessage,
        userBody: sideBody,
        timeoutMs: config.timeoutMs,
      });
      const sideNative = await readNativeEvidence(config.apiBase, sideReadback.run);
      receipt.turns.sideChat = {
        ...receipt.turns.sideChat,
        status: "passed",
        sourceConversationId: first.conversationId,
        sourceMessageId: secondReadback.assistantMessage.id,
        userMessageId: sideReadback.userMessage.id,
        assistantMessageId: sideReadback.assistantMessage.id,
        runId: sideReadback.run.id,
        runStatus: sideReadback.run.status,
        sessionIdBefore: sideReadback.run.sessionIdBefore ?? null,
        sessionIdAfter: sideReadback.run.sessionIdAfter ?? null,
        reader: sideNative,
      };
      criteriaStatus(receipt, "sideChatAnchoredNativeRun", "pass", {
        conversationId: sideChat.id,
        sourceMessageId: secondReadback.assistantMessage.id,
        runId: sideReadback.run.id,
        spanId: sideNative.spanId,
        bindingId: sideNative.bindingId,
        segmentId: sideNative.segmentId,
      });
    } catch (error) {
      if (error instanceof ProbeError && error.details?.status === 404 && !receipt.identities.sideChatId) {
        receipt.turns.sideChat = { status: "failed", replayed: false, reason: "public_side_chat_create_returned_404" };
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
