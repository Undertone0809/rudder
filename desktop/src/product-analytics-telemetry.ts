import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type DesktopTelemetryMode = "off" | "anonymous" | "account_linked";

export type DesktopTelemetryState = {
  mode: DesktopTelemetryMode;
  consentVersion: string;
  lastAttemptedAt: string | null;
  lastSucceededAt: string | null;
  lastErrorCode: string | null;
  lastSchemaVersion: number;
};

type PersistedTelemetryState = DesktopTelemetryState & {
  installationId: string;
  installationSecret: string;
};

function defaultState(): DesktopTelemetryState {
  return {
    mode: "off",
    consentVersion: "v1",
    lastAttemptedAt: null,
    lastSucceededAt: null,
    lastErrorCode: null,
    lastSchemaVersion: 1,
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
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as Partial<PersistedTelemetryState>;
    if (typeof parsed.installationId === "string" && typeof parsed.installationSecret === "string") {
      return {
        installationId: parsed.installationId,
        installationSecret: parsed.installationSecret,
        state: { ...defaultState(), ...parsed },
        statePath,
      };
    }
  } catch {
    // First launch or an interrupted write: replace with a fresh local state.
  }
  const next: PersistedTelemetryState = {
    ...defaultState(),
    installationId: randomUUID(),
    installationSecret: randomBytes(32).toString("hex"),
  };
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
  return { installationId: next.installationId, installationSecret: next.installationSecret, state: defaultState(), statePath };
}

export async function updateDesktopTelemetryState(statePath: string, patch: Partial<DesktopTelemetryState>) {
  const parsed = JSON.parse(await readFile(statePath, "utf8")) as PersistedTelemetryState;
  const next = { ...parsed, ...patch };
  await writeFile(statePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
  return next;
}
