import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const PARENT_OWNER = "01a0c344-c53e-7432-917a-6be5be9dbbe3";
const HANDOFF_STATE = "HELD_UNRESOLVED";
const MAX_RECORD_BYTES = 16 * 1024;
const PROCESS_OBSERVATION_TIMEOUT_MS = 2_000;
const BEARER_KEY_PATTERN = /pcp_[a-f0-9]{48}/iu;
const execFileAsync = promisify(execFile);

function assertSafeIdentifier(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u, `${label} must be a safe identifier`);
  assert.doesNotMatch(value, BEARER_KEY_PATTERN, `${label} must not contain a bearer key`);
}

function assertExecutable(value) {
  assert.equal(typeof value, "string", "child executable must be a string");
  assert.ok(value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value), "child executable is invalid");
  assert.doesNotMatch(value, BEARER_KEY_PATTERN, "child executable must not contain a bearer key");
}

function assertSourceSha(value) {
  assert.equal(typeof value, "string", "sourceSha must be a string");
  assert.match(value, /^[a-f0-9]{40}$/iu, "sourceSha must be a Git commit SHA");
}

function assertSha256(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, /^[a-f0-9]{64}$/iu, `${label} must be a SHA-256 digest`);
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

export function parseDarwinProcessWitness(output) {
  assert.equal(typeof output, "string", "process observation must be text");
  const lines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  assert.equal(lines.length, 1, "process observation must identify exactly one process");

  // Darwin ps formats lstart as a fixed 24-character field. Parse only the
  // requested pid, lstart, ppid, and comm columns; args and environment are
  // deliberately never requested.
  const match = lines[0].match(/^\s*(\d+)\s+(.{24})\s+(\d+)\s+(.+?)\s*$/u);
  assert.ok(match, "Darwin process observation is incomplete");
  const witness = {
    pid: Number(match[1]),
    startedAt: match[2].trim(),
    parentPid: Number(match[3]),
    comm: match[4].trim(),
  };
  assert.ok(Number.isSafeInteger(witness.pid) && witness.pid > 0, "observed PID is invalid");
  assert.ok(witness.startedAt.length > 0, "observed process start time is missing");
  assert.ok(Number.isSafeInteger(witness.parentPid) && witness.parentPid > 0, "observed parent PID is invalid");
  assert.ok(witness.comm.length > 0, "observed process name is missing");
  assert.doesNotMatch(witness.comm, BEARER_KEY_PATTERN, "observed process name must not contain a bearer key");
  return witness;
}

async function observeDarwinProcess(child) {
  if (process.platform !== "darwin") {
    throw new Error("Darwin process start observation is unavailable; owned-process handoff is refused");
  }
  let output;
  try {
    ({ stdout: output } = await execFileAsync("/bin/ps", [
      "-p", String(child.pid),
      "-o", "pid=",
      "-o", "lstart=",
      "-o", "ppid=",
      "-o", "comm=",
    ], {
      encoding: "utf8",
      timeout: PROCESS_OBSERVATION_TIMEOUT_MS,
      maxBuffer: 8 * 1024,
      windowsHide: true,
    }));
  } catch {
    throw new Error("bounded Darwin process observation failed; owned-process handoff is refused");
  }

  const witness = parseDarwinProcessWitness(output);
  assert.equal(witness.pid, child.pid, "observed PID differs from the exact child handle");
  assert.equal(witness.parentPid, process.pid, "observed PPID differs from the original supervisor");
  assert.equal(
    path.basename(witness.comm),
    path.basename(child.spawnfile),
    "observed executable name differs from the exact child executable",
  );
  return witness;
}

function assertLiveChild(child) {
  assert.ok(child && typeof child === "object", "child process handle is required");
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, "child PID must be a positive safe integer");
  assert.notEqual(child.pid, process.pid, "refusing to hand off the current supervisor process");
  assert.ok(child.exitCode === null || child.exitCode === undefined, "child process has already exited");
  assert.ok(child.signalCode === null || child.signalCode === undefined, "child process has already exited");
  assertExecutable(child.spawnfile);
}

function makeRecord({ child, ownerId, kind, sourceSha, supportSha256, timestamp, processWitness, recordState }) {
  const parentPid = process.pid;
  return freezeDeep({
    schema: recordState === HANDOFF_STATE ? "rudder-owned-process-handoff-v1" : "rudder-owned-process-start-v1",
    pid: child.pid,
    ownerId,
    kind,
    originalParentPid: parentPid,
    executable: child.spawnfile,
    sourceSha: sourceSha.toLowerCase(),
    supportSha256: supportSha256.toLowerCase(),
    timestamp,
    startBinding: {
      pid: child.pid,
      executable: child.spawnfile,
      originalParentPid: parentPid,
      observedAt: timestamp,
      osStartedAt: processWitness.startedAt,
      osParentPid: processWitness.parentPid,
      osComm: processWitness.comm,
    },
    parentOwner: PARENT_OWNER,
    reasonCategory: recordState === HANDOFF_STATE ? "shutdown_unverified" : "spawn_observed",
    state: recordState,
    releaseAllowed: false,
    recoveryPolicy: {
      inspectBeforeSignals: ["exactPID", "executable", "startBinding"],
      signalOnlyAfterExactIdentityMatch: true,
      maySignalUnknownProcess: false,
      maySignalOriginalParentOrSupervisor: false,
    },
  });
}

/** Persist an immutable, secret-free receipt before allowing a child to outlive its caller. */
export async function persistOwnedProcessHandoff(input) {
  return await persistOwnedProcessRecord(input, HANDOFF_STATE);
}

/** Record birth/ownership before product readiness can fail. This never permits detach. */
export async function persistOwnedProcessStart(input) {
  return await persistOwnedProcessRecord(input, "OWNED_RUNNING");
}

async function persistOwnedProcessRecord({
  directory,
  child,
  ownerId,
  kind,
  sourceSha,
  supportSha256,
  reason,
}, recordState) {
  void reason; // Never persist caller-supplied prose; the handoff uses a fixed category.
  assertLiveChild(child);
  assertSafeIdentifier(ownerId, "ownerId");
  assertSafeIdentifier(kind, "kind");
  assertSourceSha(sourceSha);
  assertSha256(supportSha256, "supportSha256");
  assert.equal(typeof directory, "string", "handoff directory must be a path string");
  assert.ok(directory.length > 0 && !directory.includes("\u0000"), "handoff directory is invalid");

  const targetDirectory = path.resolve(directory);
  const processWitness = await observeDarwinProcess(child);
  const timestamp = new Date().toISOString();
  const record = makeRecord({ child, ownerId, kind, sourceSha, supportSha256, timestamp, processWitness, recordState });
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  assert.ok(Buffer.byteLength(serialized, "utf8") <= MAX_RECORD_BYTES, "handoff record exceeds its size limit");
  assert.doesNotMatch(serialized, BEARER_KEY_PATTERN, "handoff record must not contain a bearer key");

  await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(targetDirectory);
  assert.ok(directoryStat.isDirectory() && !directoryStat.isSymbolicLink(), "handoff target must be a real directory");

  const recordKind = recordState === HANDOFF_STATE ? "handoff" : "start";
  const recordPath = path.join(targetDirectory, `owned-process-${recordKind}-${child.pid}-${randomUUID()}.json`);
  let handle;
  let created = false;
  try {
    handle = await open(recordPath, "wx", 0o600);
    created = true;
    await handle.chmod(0o600);
    await handle.writeFile(serialized, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;

    const recordStat = await lstat(recordPath);
    assert.ok(recordStat.isFile() && !recordStat.isSymbolicLink(), "handoff record must be a regular file");
    assert.equal(recordStat.mode & 0o777, 0o600, "handoff record permissions must be 0600");
    assert.ok(recordStat.size <= MAX_RECORD_BYTES, "handoff record exceeds its size limit");

    const directoryHandle = await open(targetDirectory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await unlink(recordPath).catch(() => undefined);
    throw new Error("could not durably persist the owned-process handoff; child remains attached");
  }

  return { record, path: recordPath };
}

function assertHandoffRecordMatches(child, receipt, persistedRecord) {
  assert.ok(receipt && typeof receipt === "object", "handoff receipt is required");
  assert.ok(receipt.record && typeof receipt.record === "object", "handoff receipt record is missing");
  assertLiveChild(child);
  assert.deepEqual(persistedRecord, receipt.record, "persisted handoff record differs from its receipt");
  assert.equal(persistedRecord.pid, child.pid, "handoff PID does not match the exact child");
  assert.equal(persistedRecord.executable, child.spawnfile, "handoff executable does not match the exact child");
  assert.equal(persistedRecord.originalParentPid, process.pid, "handoff parent identity does not match this supervisor");
  assert.equal(persistedRecord.ownerId, receipt.record.ownerId, "handoff owner identity is invalid");
  assert.equal(persistedRecord.state, HANDOFF_STATE, "handoff is not held unresolved");
  assert.equal(persistedRecord.releaseAllowed, false, "handoff record unexpectedly allows release");
  assert.equal(persistedRecord.parentOwner, PARENT_OWNER, "handoff parent owner is invalid");
  assert.deepEqual(
    Object.keys(persistedRecord.startBinding).sort(),
    ["pid", "executable", "originalParentPid", "observedAt", "osStartedAt", "osParentPid", "osComm"].sort(),
    "handoff start binding fields are incomplete or unexpected",
  );
  assert.equal(persistedRecord.startBinding.pid, child.pid, "handoff start PID is invalid");
  assert.equal(persistedRecord.startBinding.executable, child.spawnfile, "handoff start executable is invalid");
  assert.equal(persistedRecord.startBinding.originalParentPid, process.pid, "handoff start parent is invalid");
  assert.equal(persistedRecord.startBinding.observedAt, persistedRecord.timestamp, "handoff observation timestamp is invalid");
  assert.ok(persistedRecord.startBinding.osStartedAt, "handoff is missing its OS process-start witness");
  assert.equal(persistedRecord.startBinding.osParentPid, process.pid, "handoff OS parent binding is invalid");
  assert.equal(
    path.basename(persistedRecord.startBinding.osComm),
    path.basename(child.spawnfile),
    "handoff OS executable binding is invalid",
  );
  assert.equal(persistedRecord.recoveryPolicy?.maySignalUnknownProcess, false);
  assert.equal(persistedRecord.recoveryPolicy?.maySignalOriginalParentOrSupervisor, false);
  assert.equal(persistedRecord.recoveryPolicy?.signalOnlyAfterExactIdentityMatch, true);
}

/** Detach only after rereading and validating the durable unresolved handoff. */
export async function detachAfterRecordedHandoff(child, receipt) {
  assert.equal(typeof receipt?.path, "string", "handoff receipt path is missing");
  const receiptPath = path.resolve(receipt.path);
  const stats = await lstat(receiptPath);
  assert.ok(stats.isFile() && !stats.isSymbolicLink(), "handoff receipt must be a regular file");
  assert.equal(stats.mode & 0o777, 0o600, "handoff receipt permissions must be 0600");
  assert.ok(stats.size > 0 && stats.size <= MAX_RECORD_BYTES, "handoff receipt size is invalid");

  let persistedRecord;
  try {
    persistedRecord = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    throw new Error("persisted handoff record is unreadable; child remains attached");
  }
  assertHandoffRecordMatches(child, receipt, persistedRecord);
  assert.equal(typeof child.unref, "function", "child process cannot be detached safely");

  child.unref();
  const streams = new Set([
    child.stdin,
    child.stdout,
    child.stderr,
    ...(Array.isArray(child.stdio) ? child.stdio : []),
  ]);
  for (const stream of streams) {
    if (typeof stream?.unref === "function") stream.unref();
    else if (typeof stream?._handle?.unref === "function") stream._handle.unref();
  }
  return receipt;
}
