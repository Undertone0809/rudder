import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DesktopTelemetryMode = "off" | "anonymous" | "account_linked";

export type DesktopTelemetryState = {
  mode: DesktopTelemetryMode;
  consentVersion: string;
  consentEpoch: number;
  collectorRegistration: "unknown" | "registered" | "rejected";
  lastAttemptedAt: string | null;
  lastSucceededAt: string | null;
  lastErrorCode: string | null;
  lastSchemaVersion: number;
  lastPayloadEventIds: string[];
};

function defaultState(): DesktopTelemetryState {
  return {
    mode: "off",
    consentVersion: "v1",
    consentEpoch: 1,
    collectorRegistration: "unknown",
    lastAttemptedAt: null,
    lastSucceededAt: null,
    lastErrorCode: null,
    lastSchemaVersion: 1,
    lastPayloadEventIds: [],
  };
}

export async function loadOrCreateDesktopTelemetryState(userDataPath: string): Promise<{
  installationId: string;
  installationSecret: string;
  state: DesktopTelemetryState;
  statePath: string;
}> {
  const root = path.join(userDataPath, "telemetry");
  const statePath = path.join(root, "state.json");
  const installationIdPath = path.join(root, "installation-id");
  const installationSecretPath = path.join(root, "installation-secret");
  await mkdir(root, { recursive: true, mode: 0o700 });
  let installationId: string | null = null;
  let installationSecret: string | null = null;
  try {
    installationId = (await readFile(installationIdPath, "utf8")).trim() || null;
    installationSecret = (await readFile(installationSecretPath, "utf8")).trim() || null;
  } catch {
    // Files are created below on first launch or after a legacy state migration.
  }
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<DesktopTelemetryState> & { installationId?: string; installationSecret?: string };
    installationId ??= typeof parsed.installationId === "string" ? parsed.installationId : null;
    installationSecret ??= typeof parsed.installationSecret === "string" ? parsed.installationSecret : null;
    if (installationId && installationSecret) {
      await writeFile(installationIdPath, `${installationId}\n`, { mode: 0o600 });
      await writeFile(installationSecretPath, `${installationSecret}\n`, { mode: 0o600 });
      const state = { ...defaultState(), ...parsed };
      delete (state as { installationId?: string }).installationId;
      delete (state as { installationSecret?: string }).installationSecret;
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      return {
        installationId,
        installationSecret,
        state,
        statePath,
      };
    }
  } catch {
    // First launch or an interrupted write: replace with a fresh local state.
  }
  installationId = randomUUID();
  installationSecret = randomBytes(32).toString("hex");
  await writeFile(installationIdPath, `${installationId}\n`, { mode: 0o600 });
  await writeFile(installationSecretPath, `${installationSecret}\n`, { mode: 0o600 });
  await chmod(installationIdPath, 0o600);
  await chmod(installationSecretPath, 0o600);
  const next = defaultState();
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
  return { installationId, installationSecret, state: next, statePath };
}

export async function updateDesktopTelemetryState(statePath: string, patch: Partial<DesktopTelemetryState>) {
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as DesktopTelemetryState;
  const next = { ...parsed, ...patch };
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
  return next;
}
