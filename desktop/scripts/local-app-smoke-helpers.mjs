import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const LOCAL_APP_SAVED_VIEW_TARGET_KEYS = [
  "appPublicId",
  "desktopInstallationId",
  "kind",
  "localBindingId",
  "viewInstanceId",
];
const FORBIDDEN_RUNTIME_FIELD_KEYS = new Set([
  "args",
  "arguments",
  "argv",
  "cwd",
  "env",
  "environment",
  "executable",
  "inheritedenvnames",
  "openpath",
  "pgid",
  "pid",
  "port",
  "readiness",
]);

function normalizedFieldKey(value) {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function failWithoutSensitiveValue(message) {
  assert.fail(message);
}

export function expectedLocalAppPartitionId(installationId, definitionId) {
  const digest = createHash("sha256").update(`${installationId}\0${definitionId}`).digest("hex");
  return `persist:rudder-local-app-${digest.slice(0, 32)}`;
}

export function assertStrictLoopbackAttestation(attested, definition, installationId) {
  assert.ok(attested && typeof attested === "object", "Local App attestation must be an object");
  const origin = new URL(attested.origin);
  assert.equal(origin.protocol, "http:", "Local App attestation must use HTTP");
  assert.equal(origin.hostname, "127.0.0.1", "Local App attestation must use the exact IPv4 loopback host");
  assert.equal(origin.username, "", "Local App attestation must not contain a username");
  assert.equal(origin.password, "", "Local App attestation must not contain a password");
  assert.equal(origin.pathname, "/", "Local App attestation origin must not contain a path");
  assert.equal(origin.search, "", "Local App attestation origin must not contain a query");
  assert.equal(origin.hash, "", "Local App attestation origin must not contain a fragment");
  assert.match(origin.port, /^\d+$/, "Local App attestation must contain an explicit port");
  const port = Number(origin.port);
  assert.ok(port >= 1 && port <= 65_535, "Local App attestation port must be in range");
  assert.equal(attested.origin, `http://127.0.0.1:${port}`, "Local App attestation origin must be canonical");
  assert.equal(attested.openPath, definition.openPath, "Local App attestation must use the approved open path");
  assert.equal(
    definition.desktopInstallationId,
    installationId,
    "Local App definition must belong to the isolated Desktop installation",
  );
  const expectedPartition = expectedLocalAppPartitionId(installationId, definition.id);
  assert.equal(attested.partition, expectedPartition, "Local App attestation must use its independently derived partition");
  const expectedUrl = new URL(definition.openPath, attested.origin).href;
  const parsedUrl = new URL(expectedUrl);
  assert.equal(parsedUrl.protocol, "http:");
  assert.equal(parsedUrl.hostname, "127.0.0.1");
  assert.equal(parsedUrl.username, "");
  assert.equal(parsedUrl.password, "");
  return { expectedPartition, expectedUrl, port };
}

export function assertExactLocalAppSavedViewTarget(target, expected, label) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    failWithoutSensitiveValue(`${label} must contain a Local App Saved View target object`);
  }
  const keys = Object.keys(target).sort();
  if (!isDeepStrictEqual(keys, LOCAL_APP_SAVED_VIEW_TARGET_KEYS)) {
    failWithoutSensitiveValue(`${label} Local App target must contain exactly the five public identity fields`);
  }
  for (const key of LOCAL_APP_SAVED_VIEW_TARGET_KEYS) {
    if (target[key] !== expected[key]) {
      failWithoutSensitiveValue(`${label} Local App target ${key} does not match the opened view identity`);
    }
  }
}

export function assertNoLocalAppRuntimeDetails(value, options) {
  const { definition, envNames = [], envValues = [], label } = options;
  const sensitiveExactStrings = new Set([
    definition.cwd,
    definition.executable,
    definition.openPath,
    ...envNames,
    ...envValues,
  ].filter((entry) => typeof entry === "string" && entry.length > 0));
  const visit = (current, path) => {
    if (isDeepStrictEqual(current, definition.argv) || isDeepStrictEqual(current, definition.readiness)) {
      failWithoutSensitiveValue(`${label} contains prohibited Local App runtime data at ${path}`);
    }
    if (typeof current === "string") {
      if ([...sensitiveExactStrings].some((sensitive) => (
        current === sensitive || (sensitive.length >= 8 && current.includes(sensitive))
      ))) {
        failWithoutSensitiveValue(`${label} contains prohibited Local App runtime data at ${path}`);
      }
      return;
    }
    if (!current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      const normalizedKey = normalizedFieldKey(key);
      if (FORBIDDEN_RUNTIME_FIELD_KEYS.has(normalizedKey) || envNames.some((envName) => key === envName)) {
        failWithoutSensitiveValue(`${label} contains prohibited Local App runtime data at ${path}.${normalizedKey || "field"}`);
      }
      visit(entry, `${path}.${normalizedKey || "field"}`);
    }
  };
  visit(value, "$payload");
}

export function isSafeLocalAppProcessId(value) {
  return Number.isSafeInteger(value) && value >= 2;
}

export function proveLocalAppEmergencyOwnership({ descriptor, listenerPids, processes }) {
  if (!descriptor
    || !isSafeLocalAppProcessId(descriptor.pid)
    || !isSafeLocalAppProcessId(descriptor.pgid)
    || !Number.isSafeInteger(descriptor.port)
    || descriptor.port < 1
    || descriptor.port > 65_535) return false;
  const leaderIsOwned = processes.some((processInfo) => (
    processInfo.pid === descriptor.pid && processInfo.pgid === descriptor.pgid
  ));
  const listenersAreOwned = listenerPids.length > 0 && listenerPids.every((pid) => (
    isSafeLocalAppProcessId(pid)
    && processes.some((processInfo) => processInfo.pid === pid && processInfo.pgid === descriptor.pgid)
  ));
  return leaderIsOwned && listenersAreOwned;
}

export async function terminateProvenLocalAppProcessGroup(input) {
  const {
    delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    descriptor,
    killTimeoutMs = 2_000,
    pollMs = 50,
    readListenerPids,
    readProcesses,
    signalGroup,
    termTimeoutMs = 2_000,
  } = input;
  const initialProcesses = await readProcesses();
  const initialListenerPids = await readListenerPids(descriptor.port);
  if (!proveLocalAppEmergencyOwnership({ descriptor, listenerPids: initialListenerPids, processes: initialProcesses })) {
    throw new Error("Refusing emergency cleanup without registry, ps, and lsof ownership proof");
  }
  const hasResidue = async () => {
    const [processes, listenerPids] = await Promise.all([readProcesses(), readListenerPids(descriptor.port)]);
    return listenerPids.length > 0 || processes.some((processInfo) => (
      processInfo.pid === descriptor.pid || processInfo.pgid === descriptor.pgid
    ));
  };
  const waitUntilStopped = async (timeoutMs) => {
    const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (!(await hasResidue())) return true;
      await delay(pollMs);
    }
    return !(await hasResidue());
  };
  await signalGroup(descriptor.pgid, "SIGTERM");
  if (await waitUntilStopped(termTimeoutMs)) return;
  await signalGroup(descriptor.pgid, "SIGKILL");
  if (!(await waitUntilStopped(killTimeoutMs))) {
    throw new Error("Emergency Local App cleanup left a verified process-group residue");
  }
}
