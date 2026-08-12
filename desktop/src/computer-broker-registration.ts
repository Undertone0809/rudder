import type { ComputerUseRuntimeIdentity } from "@rudderhq/shared/computer-use";
import { randomUUID } from "node:crypto";

export type DesktopComputerSettings = { experimentalComputerUseEnabled: boolean };
export type DesktopComputerPlatform = "darwin" | "win32" | "linux" | "unsupported";
export type DesktopComputerReadiness = {
  supported: boolean;
  platform: DesktopComputerPlatform;
  driverAvailable: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  actionReady: boolean;
  permissionPromptAvailable: boolean;
  screenRecordingSettingsAvailable: boolean;
  driverVersion: string | null;
  reason: string | null;
};

const ownerId = randomUUID();
let generation = 0;

function endpoint(apiUrl: string, path: string) {
  return new URL(path, apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`).toString();
}

async function request(apiUrl: string, path: string, init: RequestInit, fetchImpl: typeof fetch) {
  const requestUrl = endpoint(apiUrl, path);
  const response = await fetchImpl(requestUrl, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init.method && init.method !== "GET" ? { origin: new URL(requestUrl).origin } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
    const error = new Error(body.error ?? `Computer Broker request failed (${response.status}).`) as Error & { code?: string };
    error.code = body.code;
    throw error;
  }
  return response;
}

export function allocateComputerBrokerGeneration() {
  generation += 1;
  return generation;
}

export async function registerDesktopComputerBroker(
  apiUrl: string,
  broker: { endpoint: string; token: string },
  registrationGeneration: number,
  refresh = false,
  fetchImpl: typeof fetch = fetch,
) {
  await request(apiUrl, "/api/instance/computer/broker", {
    method: "PUT",
    body: JSON.stringify({ ...broker, ownerId, generation: registrationGeneration, ...(refresh ? { refresh: true } : {}) }),
  }, fetchImpl);
}

export async function unregisterDesktopComputerBroker(
  apiUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
) {
  await request(apiUrl, "/api/instance/computer/broker", {
    method: "DELETE",
    body: JSON.stringify({ token }),
  }, fetchImpl);
}

export async function readDesktopComputerSettings(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<DesktopComputerSettings> {
  const response = await request(apiUrl, "/api/instance/settings/general", { method: "GET" }, fetchImpl);
  const body = await response.json() as { experimentalComputerUseEnabled?: unknown };
  return { experimentalComputerUseEnabled: body.experimentalComputerUseEnabled === true };
}

export async function isDesktopComputerRunActive(
  apiUrl: string,
  identity: ComputerUseRuntimeIdentity,
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(endpoint(
    apiUrl,
    `/api/heartbeat-runs/${encodeURIComponent(identity.runId)}`,
  ));
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`Computer Use run status request failed (${response.status}).`);
  }
  const value = await response.json() as Record<string, unknown>;
  return value.id === identity.runId
    && value.orgId === identity.orgId
    && value.agentId === identity.agentId
    && value.status === "running";
}

export function createDesktopComputerApiClient(
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
) {
  return {
    registerBroker: (
      apiUrl: string,
      broker: { endpoint: string; token: string },
      registrationGeneration: number,
      refresh = false,
    ) => registerDesktopComputerBroker(
      apiUrl,
      broker,
      registrationGeneration,
      refresh,
      fetchImpl,
    ),
    unregisterBroker: (apiUrl: string, token: string) =>
      unregisterDesktopComputerBroker(apiUrl, token, fetchImpl),
    readSettings: (apiUrl: string) => readDesktopComputerSettings(apiUrl, fetchImpl),
    isRunActive: (apiUrl: string, identity: ComputerUseRuntimeIdentity) =>
      isDesktopComputerRunActive(apiUrl, identity, fetchImpl),
  };
}

export function isComputerRegistrationConflict(error: unknown) {
  const code = (error as { code?: unknown })?.code;
  return code === "computer_broker_stale_registration" || code === "computer_broker_revoked_registration";
}
