import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

export const DOGFOOD_SCHEMA_VERSION = 1;
export const DOGFOOD_RESULT_PREFIX = "RUDDER_LOCAL_APP_DOGFOOD_RESULT=";
export const DEFAULT_REQUIRED_CYCLES = 100;
export const DEFAULT_REQUIRED_DATES = 7;
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024;

export class DogfoodLedgerError extends Error {
  constructor(message, code = "DOGFOOD_INVALID") {
    super(message);
    this.name = "DogfoodLedgerError";
    this.code = code;
  }
}

function fail(message, code = "DOGFOOD_INVALID") {
  throw new DogfoodLedgerError(message, code);
}

function requireNonEmptyString(value, label, maxLength = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    fail(`Invalid ${label}`);
  }
  return value;
}

function requireSha(value, label, lengths) {
  const sha = requireNonEmptyString(value, label, 128).toLowerCase();
  if (!lengths.includes(sha.length) || !/^[a-f0-9]+$/u.test(sha)) fail(`Invalid ${label}`);
  return sha;
}

function requireAbsolutePath(value, label) {
  const resolved = path.resolve(requireNonEmptyString(value, label, 4_096));
  if (!path.isAbsolute(resolved)) fail(`Invalid ${label}`);
  return resolved;
}

function isoDate(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`Invalid ${label}`);
  return date.toISOString();
}

function utcDate(value) {
  return isoDate(value, "cycle timestamp").slice(0, 10);
}

function dateOrdinal(dateString) {
  const parsed = new Date(`${dateString}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) fail(`Invalid UTC date ${dateString}`);
  return Math.floor(parsed.getTime() / 86_400_000);
}

function boundedJson(value, label, maxBytes = MAX_EVIDENCE_BYTES) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    fail(`${label} is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  return JSON.parse(serialized);
}

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function assertExecutable(filePath, label) {
  const resolved = requireAbsolutePath(filePath, label);
  let metadata;
  try {
    metadata = await stat(resolved);
    await access(resolved, fsConstants.X_OK);
  } catch (error) {
    fail(`${label} is not an executable file: ${resolved}`);
  }
  if (!metadata.isFile()) fail(`${label} is not a regular file: ${resolved}`);
  return resolved;
}

function validateIdentity(identity) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) fail("Missing dogfood candidate identity");
  return {
    sourceSha: requireSha(identity.sourceSha, "source SHA", [40, 64]),
    artifactSha256: requireSha(identity.artifactSha256, "artifact SHA-256", [64]),
    runtimeId: requireNonEmptyString(identity.runtimeId, "runtime id", 512),
  };
}

function validateTarget(target = {}) {
  const requiredCycles = target.requiredCycles ?? DEFAULT_REQUIRED_CYCLES;
  const requiredDates = target.requiredDates ?? DEFAULT_REQUIRED_DATES;
  if (!Number.isInteger(requiredCycles) || requiredCycles < 1) fail("Invalid required cycle count");
  if (!Number.isInteger(requiredDates) || requiredDates < 1) fail("Invalid required UTC date count");
  return { requiredCycles, requiredDates };
}

function validateLedgerShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Dogfood ledger must be an object");
  if (value.schemaVersion !== DOGFOOD_SCHEMA_VERSION || value.kind !== "rudder_local_app_dogfood") {
    fail("Unsupported dogfood ledger schema");
  }
  if (!Array.isArray(value.cycles)) fail("Dogfood ledger cycles must be an array");
  if (!value.identity || !value.target || !value.gate) fail("Dogfood ledger is missing identity, target, or gate");
  const identity = validateIdentity(value.identity);
  const target = validateTarget(value.target);
  if (!["pending", "passed", "failed"].includes(value.gate.status)) fail("Invalid dogfood gate status");
  return { ...value, identity, target };
}

export function createDogfoodLedger({ identity, target, packagedExecutable, packagedExecutableSha256, packagedCommand, packagedCommandSha256, environmentKeys, now = new Date() }) {
  const normalizedIdentity = validateIdentity(identity);
  const normalizedTarget = validateTarget(target);
  const startedAt = isoDate(now, "ledger start time");
  return {
    schemaVersion: DOGFOOD_SCHEMA_VERSION,
    kind: "rudder_local_app_dogfood",
    identity: normalizedIdentity,
    target: normalizedTarget,
    packaged: {
      executable: requireAbsolutePath(packagedExecutable, "packaged executable"),
      executableSha256: requireSha(packagedExecutableSha256, "packaged executable SHA-256", [64]),
      command: requireAbsolutePath(packagedCommand, "packaged launch command"),
      commandSha256: requireSha(packagedCommandSha256, "packaged launch command SHA-256", [64]),
      environmentKeys: [...new Set((environmentKeys ?? []).map((key) => requireNonEmptyString(key, "packaged environment key", 256)))].sort(),
    },
    startedAt,
    updatedAt: startedAt,
    cycles: [],
    gate: {
      status: "pending",
      acceptedCycles: 0,
      distinctUtcDates: 0,
      contiguousUtcDates: false,
      reason: "awaiting packaged Local App cycles",
    },
  };
}

export function assessDogfoodLedger(input) {
  const ledger = validateLedgerShape(input);
  const cycles = ledger.cycles;
  const indexes = new Set();
  const accepted = [];
  const failures = [];
  const identityFailures = [];
  for (const cycle of cycles) {
    if (!cycle || typeof cycle !== "object" || Array.isArray(cycle)) {
      failures.push({ cycleIndex: null, reason: "invalid_cycle_record" });
      continue;
    }
    if (!Number.isInteger(cycle.cycleIndex) || cycle.cycleIndex < 0 || indexes.has(cycle.cycleIndex)) {
      failures.push({ cycleIndex: cycle.cycleIndex ?? null, reason: "duplicate_or_invalid_cycle_index" });
      continue;
    }
    indexes.add(cycle.cycleIndex);
    if (cycle.sourceSha !== ledger.identity.sourceSha
      || cycle.artifactSha256 !== ledger.identity.artifactSha256
      || cycle.runtimeId !== ledger.identity.runtimeId) {
      identityFailures.push(cycle.cycleIndex);
    }
    if (cycle.status === "accepted") accepted.push(cycle);
    else failures.push({ cycleIndex: cycle.cycleIndex, reason: cycle.failure?.code ?? "cycle_not_accepted" });
  }
  const sortedIndexes = [...indexes].sort((left, right) => left - right);
  const missingIndexes = [];
  for (let index = 0; index < sortedIndexes.length; index += 1) {
    if (sortedIndexes[index] !== index) missingIndexes.push(index);
  }
  const acceptedDates = [...new Set(accepted.map((cycle) => utcDate(cycle.completedAt)))].sort();
  const ordinals = acceptedDates.map(dateOrdinal);
  const contiguousUtcDates = ordinals.length > 0 && ordinals.every((ordinal, index) => index === 0 || ordinal === ordinals[index - 1] + 1);
  const complete = accepted.length >= ledger.target.requiredCycles
    && failures.length === 0
    && identityFailures.length === 0
    && missingIndexes.length === 0
    && acceptedDates.length >= ledger.target.requiredDates
    && contiguousUtcDates;
  const status = complete ? "passed" : failures.length > 0 || identityFailures.length > 0 || missingIndexes.length > 0 ? "failed" : "pending";
  const reason = complete
    ? "packaged Local App dogfood gate passed"
    : status === "failed"
      ? "one or more packaged Local App cycles are failed, missing, duplicated, or identity-mismatched"
      : `awaiting ${Math.max(0, ledger.target.requiredCycles - accepted.length)} accepted cycles and ${Math.max(0, ledger.target.requiredDates - acceptedDates.length)} UTC dates`;
  return {
    status,
    acceptedCycles: accepted.length,
    distinctUtcDates: acceptedDates.length,
    acceptedDates,
    contiguousUtcDates,
    failures,
    identityFailures,
    missingIndexes,
    requiredCycles: ledger.target.requiredCycles,
    requiredDates: ledger.target.requiredDates,
    reason,
  };
}

export async function readDogfoodLedger(ledgerPath) {
  const resolved = requireAbsolutePath(ledgerPath, "ledger path");
  return validateLedgerShape(JSON.parse(await readFile(resolved, "utf8")));
}

export async function writeDogfoodLedger(ledgerPath, input) {
  const resolved = requireAbsolutePath(ledgerPath, "ledger path");
  const ledger = validateLedgerShape(input);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, resolved);
    await chmod(resolved, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return ledger;
}

async function spawnCycle({ command, args, env, cwd, timeoutMs }) {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 250).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const bytes = Buffer.byteLength(chunk);
      stdoutBytes += bytes;
      if (stdoutBytes <= MAX_CHILD_OUTPUT_BYTES) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      const bytes = Buffer.byteLength(chunk);
      stderrBytes += bytes;
      if (stderrBytes <= MAX_CHILD_OUTPUT_BYTES) stderr.push(chunk);
    });
    child.once("error", (error) => finish({ exitCode: null, signal: null, error: error instanceof Error ? error.message : String(error), timedOut }));
    child.once("exit", (exitCode, signal) => finish({ exitCode, signal, error: null, timedOut }));
  });
}

function parseCycleResult(stdout) {
  const matches = stdout.split(/\r?\n/u).filter((line) => line.startsWith(DOGFOOD_RESULT_PREFIX));
  if (matches.length !== 1) fail(`Packaged cycle must emit exactly one ${DOGFOOD_RESULT_PREFIX} JSON result`, "DOGFOOD_CYCLE_RESULT_MISSING");
  let parsed;
  try {
    parsed = JSON.parse(matches[0].slice(DOGFOOD_RESULT_PREFIX.length));
  } catch (error) {
    fail(`Invalid packaged cycle JSON result: ${error instanceof Error ? error.message : String(error)}`, "DOGFOOD_CYCLE_RESULT_INVALID");
  }
  return boundedJson(parsed, "packaged cycle evidence");
}

function validateCycleResult(result, cycleIndex, identity) {
  if (!result || typeof result !== "object" || Array.isArray(result)) fail("Packaged cycle result must be an object", "DOGFOOD_CYCLE_RESULT_INVALID");
  if (result.kind !== "rudder_local_app_dogfood_cycle") fail("Packaged cycle result has the wrong kind", "DOGFOOD_CYCLE_RESULT_INVALID");
  if (result.cycleIndex !== cycleIndex) fail("Packaged cycle result index does not match the requested cycle", "DOGFOOD_CYCLE_RESULT_INVALID");
  if (result.packaged !== true || result.activation !== "packaged") fail("Packaged cycle did not prove packaged activation", "DOGFOOD_CYCLE_NOT_PACKAGED");
  if (!["start_stop", "parent_loss"].includes(result.phase)) fail("Packaged cycle has an invalid lifecycle phase", "DOGFOOD_CYCLE_RESULT_INVALID");
  if (result.accepted !== true || result.ownershipVerified !== true || result.cleanupProven !== true) fail("Packaged cycle did not prove accepted ownership and cleanup", "DOGFOOD_CYCLE_NOT_ACCEPTED");
  if (result.listenerLeak !== false || result.descendantLeak !== false) fail("Packaged cycle reported a listener or descendant leak", "DOGFOOD_CYCLE_NOT_ACCEPTED");
  if (!Array.isArray(result.unresolvedP1) || result.unresolvedP1.length !== 0) fail("Packaged cycle has unresolved P1 findings", "DOGFOOD_CYCLE_NOT_ACCEPTED");
  if (result.sourceSha !== identity.sourceSha || result.artifactSha256 !== identity.artifactSha256 || result.runtimeId !== identity.runtimeId) fail("Packaged cycle identity does not match the dogfood candidate", "DOGFOOD_IDENTITY_MISMATCH");
  return result;
}

async function initializeOrLoad(options) {
  try {
    const existing = await readDogfoodLedger(options.ledgerPath);
    if (JSON.stringify(existing.identity) !== JSON.stringify(options.identity)) fail("Dogfood ledger identity does not match the requested candidate", "DOGFOOD_IDENTITY_MISMATCH");
    if (existing.packaged.executable !== options.packagedExecutable) fail("Dogfood ledger packaged executable does not match", "DOGFOOD_IDENTITY_MISMATCH");
    if (existing.packaged.command !== options.command) fail("Dogfood ledger packaged command does not match", "DOGFOOD_IDENTITY_MISMATCH");
    if (JSON.stringify(existing.target) !== JSON.stringify(options.target)) fail("Dogfood ledger gate target does not match", "DOGFOOD_IDENTITY_MISMATCH");
    if (existing.packaged.executableSha256 !== await sha256File(options.packagedExecutable)) fail("Packaged executable changed since the dogfood ledger was created", "DOGFOOD_IDENTITY_MISMATCH");
    if (existing.packaged.commandSha256 !== await sha256File(options.command)) fail("Packaged launch command changed since the dogfood ledger was created", "DOGFOOD_IDENTITY_MISMATCH");
    return existing;
  } catch (error) {
    if (!(error instanceof Error) || !/(ENOENT|no such file)/iu.test(error.message)) throw error;
    const packagedExecutableSha256 = await sha256File(options.packagedExecutable);
    const packagedCommandSha256 = await sha256File(options.command);
    const ledger = createDogfoodLedger({
      identity: options.identity,
      target: options.target,
      packagedExecutable: options.packagedExecutable,
      packagedExecutableSha256,
      packagedCommand: options.command,
      packagedCommandSha256,
      environmentKeys: Object.keys(options.explicitEnv),
      now: options.now(),
    });
    return await writeDogfoodLedger(options.ledgerPath, ledger);
  }
}

export async function runPackagedDogfood(options) {
  if (!options || typeof options !== "object") fail("Dogfood runner options are required");
  const command = await assertExecutable(options.command, "packaged launch command");
  const packagedExecutable = await assertExecutable(options.packagedExecutable, "packaged executable");
  const explicitEnv = options.explicitEnv;
  if (!explicitEnv || typeof explicitEnv !== "object" || Array.isArray(explicitEnv)) fail("Explicit packaged environment is required");
  if (explicitEnv.RUDDER_DOGFOOD_PACKAGED !== "1" || explicitEnv.RUDDER_DESKTOP_SMOKE_MODE !== "packaged") {
    fail("Packaged dogfood requires RUDDER_DOGFOOD_PACKAGED=1 and RUDDER_DESKTOP_SMOKE_MODE=packaged", "DOGFOOD_NOT_PACKAGED");
  }
  if (explicitEnv.RUDDER_DOGFOOD_PACKAGED_EXECUTABLE !== packagedExecutable) fail("Explicit packaged environment must bind the packaged executable path", "DOGFOOD_IDENTITY_MISMATCH");
  const identity = validateIdentity(options.identity);
  const target = validateTarget(options.target);
  const cycles = options.cycles ?? 1;
  if (!Number.isInteger(cycles) || cycles < 1) fail("Invalid dogfood cycle count");
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) fail("Invalid dogfood cycle timeout");
  const now = options.now ?? (() => new Date());
  let ledger = await initializeOrLoad({ ...options, command, packagedExecutable, identity, target, explicitEnv, now });
  if (ledger.gate.status === "failed") fail("Dogfood ledger already contains a failed cycle; start a new candidate ledger", "DOGFOOD_ALREADY_FAILED");
  const args = Array.isArray(options.args) ? options.args.map((arg) => requireNonEmptyString(arg, "packaged launch argument", 8_192)) : [];
  for (let count = 0; count < cycles; count += 1) {
    const cycleIndex = ledger.cycles.length;
    const startedAt = isoDate(now(), "cycle start time");
    const cycleEnv = {
      ...process.env,
      ...Object.fromEntries(Object.entries(explicitEnv).map(([key, value]) => [key, String(value)])),
      RUDDER_LOCAL_APP_DOGFOOD_CYCLE_INDEX: String(cycleIndex),
      RUDDER_LOCAL_APP_DOGFOOD_LEDGER_PATH: requireAbsolutePath(options.ledgerPath, "ledger path"),
      RUDDER_LOCAL_APP_DOGFOOD_SOURCE_SHA: identity.sourceSha,
      RUDDER_LOCAL_APP_DOGFOOD_ARTIFACT_SHA256: identity.artifactSha256,
      RUDDER_LOCAL_APP_DOGFOOD_RUNTIME_ID: identity.runtimeId,
    };
    const result = await spawnCycle({ command, args, env: cycleEnv, cwd: options.cwd ?? process.cwd(), timeoutMs });
    let cycle;
    try {
      if (result.timedOut || result.exitCode !== 0 || result.signal) fail(`Packaged cycle process failed (exit=${result.exitCode ?? "null"}, signal=${result.signal ?? "none"})`, "DOGFOOD_CYCLE_PROCESS_FAILED");
      const evidence = validateCycleResult(parseCycleResult(result.stdout), cycleIndex, identity);
      cycle = {
        cycleIndex,
        status: "accepted",
        phase: evidence.phase,
        sourceSha: identity.sourceSha,
        artifactSha256: identity.artifactSha256,
        runtimeId: identity.runtimeId,
        startedAt,
        completedAt: isoDate(now(), "cycle completion time"),
        evidence,
      };
    } catch (error) {
      cycle = {
        cycleIndex,
        status: "failed",
        sourceSha: identity.sourceSha,
        artifactSha256: identity.artifactSha256,
        runtimeId: identity.runtimeId,
        startedAt,
        completedAt: isoDate(now(), "cycle failure time"),
        failure: {
          code: error?.code ?? "DOGFOOD_CYCLE_FAILED",
          message: error instanceof Error ? error.message : String(error),
          exitCode: result.exitCode,
          signal: result.signal,
          timedOut: result.timedOut,
          stderr: result.stderr.slice(0, MAX_CHILD_OUTPUT_BYTES),
        },
      };
    }
    ledger.cycles.push(cycle);
    const assessment = assessDogfoodLedger(ledger);
    ledger.gate = assessment;
    ledger.updatedAt = cycle.completedAt;
    await writeDogfoodLedger(options.ledgerPath, ledger);
    if (cycle.status === "failed") return { ledger, assessment };
  }
  return { ledger, assessment: assessDogfoodLedger(ledger) };
}

export function usage() {
  return [
    "Usage:",
    "  node scripts/perf/local-app-dogfood-ledger.mjs verify --ledger <path>",
    "  node scripts/perf/local-app-dogfood-ledger.mjs run --ledger <path> --cycles <n>",
    "    --packaged-command <absolute executable> --packaged-executable <absolute app executable>",
    "    --source-sha <40|64 hex> --artifact-sha256 <64 hex> --runtime-id <id>",
    "    --packaged-env-json '{\"RUDDER_DOGFOOD_PACKAGED\":\"1\",\"RUDDER_DESKTOP_SMOKE_MODE\":\"packaged\",\"RUDDER_DOGFOOD_PACKAGED_EXECUTABLE\":\"...\"}'",
  ].join("\n");
}

function cliValue(args, name, required = true) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) {
    if (required) throw new DogfoodLedgerError(`Missing ${name}`, "DOGFOOD_USAGE");
    return undefined;
  }
  return args[index + 1];
}

async function cli() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "verify") {
    const ledger = await readDogfoodLedger(cliValue(args, "--ledger"));
    const assessment = assessDogfoodLedger(ledger);
    process.stdout.write(`${JSON.stringify(assessment, null, 2)}\n`);
    if (assessment.status !== "passed") process.exitCode = assessment.status === "failed" ? 1 : 2;
    return;
  }
  if (mode !== "run") throw new DogfoodLedgerError(usage(), "DOGFOOD_USAGE");
  let explicitEnv;
  try {
    explicitEnv = JSON.parse(cliValue(args, "--packaged-env-json"));
  } catch (error) {
    throw new DogfoodLedgerError(`Invalid --packaged-env-json: ${error instanceof Error ? error.message : String(error)}`, "DOGFOOD_USAGE");
  }
  const result = await runPackagedDogfood({
    ledgerPath: cliValue(args, "--ledger"),
    cycles: Number.parseInt(cliValue(args, "--cycles", false) ?? "1", 10),
    command: cliValue(args, "--packaged-command"),
    args: (() => {
      const raw = cliValue(args, "--packaged-args-json", false);
      if (!raw) return [];
      return JSON.parse(raw);
    })(),
    packagedExecutable: cliValue(args, "--packaged-executable"),
    identity: {
      sourceSha: cliValue(args, "--source-sha"),
      artifactSha256: cliValue(args, "--artifact-sha256"),
      runtimeId: cliValue(args, "--runtime-id"),
    },
    target: {
      requiredCycles: Number.parseInt(cliValue(args, "--required-cycles", false) ?? String(DEFAULT_REQUIRED_CYCLES), 10),
      requiredDates: Number.parseInt(cliValue(args, "--required-dates", false) ?? String(DEFAULT_REQUIRED_DATES), 10),
    },
    explicitEnv,
  });
  process.stdout.write(`${JSON.stringify(result.assessment, null, 2)}\n`);
  if (result.assessment.status !== "passed") process.exitCode = result.assessment.status === "failed" ? 1 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await cli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error?.code === "DOGFOOD_USAGE" ? 2 : 1;
  }
}
