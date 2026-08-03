import path from "node:path";
import { loadOrCreateDesktopTelemetryState, updateDesktopTelemetryState, type DesktopTelemetryMode } from "./product-analytics-telemetry.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DesktopProductAnalyticsUploaderOptions = {
  localApiUrl: string;
  orgId: string;
  installationId: string;
  installationSecret: string;
  deliveryMode: Exclude<DesktopTelemetryMode, "off">;
  statePath: string;
  collectorUrl: string;
  collectorAuthorization: string;
  localHeaders?: HeadersInit;
  fetchImpl?: FetchLike;
  now?: () => Date;
};

export type DesktopProductAnalyticsUploadResult = {
  status: "idle" | "delivered" | "retry_wait" | "failed_actionable";
  eventCount: number;
  errorCode: string | null;
};

async function readJson(response: Response) {
  try {
    return await response.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorCodeForResponse(response: Response, body: Record<string, unknown>) {
  const remoteCode = typeof body.errorCode === "string" ? body.errorCode : null;
  return remoteCode ?? `http_${response.status}`;
}

export async function uploadDesktopProductAnalyticsOnce(options: DesktopProductAnalyticsUploaderOptions): Promise<DesktopProductAnalyticsUploadResult> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const persisted = await loadOrCreateDesktopTelemetryState(path.dirname(path.dirname(options.statePath)));
  if (persisted.state.mode === "off" || persisted.state.mode !== options.deliveryMode) {
    return { status: "idle", eventCount: 0, errorCode: null };
  }
  const attemptedAt = now().toISOString();
  await updateDesktopTelemetryState(options.statePath, { lastAttemptedAt: attemptedAt, lastErrorCode: null });
  const claimUrl = `${options.localApiUrl.replace(/\/$/, "")}/api/orgs/${encodeURIComponent(options.orgId)}/analytics/product/installation/${encodeURIComponent(options.installationId)}/outbox/claim`;
  let claimResponse: Response;
  try {
    claimResponse = await fetchImpl(claimUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.localHeaders ?? {}) },
      body: JSON.stringify({ installationSecret: options.installationSecret, deliveryMode: options.deliveryMode, limit: 100 }),
    });
  } catch {
    await updateDesktopTelemetryState(options.statePath, { lastErrorCode: "local_claim_network" });
    return { status: "retry_wait", eventCount: 0, errorCode: "local_claim_network" };
  }
  const claimBody = await readJson(claimResponse);
  if (!claimResponse.ok) {
    const errorCode = errorCodeForResponse(claimResponse, claimBody);
    await updateDesktopTelemetryState(options.statePath, { lastErrorCode: errorCode });
    return { status: "failed_actionable", eventCount: 0, errorCode };
  }
  const claimToken = typeof claimBody.claimToken === "string" ? claimBody.claimToken : null;
  const events = Array.isArray(claimBody.events) ? claimBody.events.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object") : [];
  await updateDesktopTelemetryState(options.statePath, {
    lastPayloadEventIds: events.map((event) => typeof event.eventId === "string" ? event.eventId : "").filter(Boolean),
    collectorRegistration: "registered",
  });
  if (!claimToken || events.length === 0) {
    await updateDesktopTelemetryState(options.statePath, { lastSucceededAt: now().toISOString(), lastErrorCode: null });
    return { status: "idle", eventCount: 0, errorCode: null };
  }
  const eventIds = events.map((event) => event.eventId).filter((eventId): eventId is string => typeof eventId === "string");
  let collectorResponse: Response;
  let collectorBody: Record<string, unknown> = {};
  try {
    collectorResponse = await fetchImpl(`${options.collectorUrl.replace(/\/$/, "")}/api/analytics/v1/events:batch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rudder-installation-id": options.installationId,
        authorization: options.collectorAuthorization,
      },
      body: JSON.stringify({ events }),
    });
    collectorBody = await readJson(collectorResponse);
  } catch {
    collectorResponse = new Response(null, { status: 503 });
  }
  const rejected = Array.isArray(collectorBody.rejected) ? collectorBody.rejected : [];
  const delivered = collectorResponse.ok && rejected.length === 0;
  const errorCode = delivered
    ? null
    : rejected.length > 0 ? "collector_rejected" : errorCodeForResponse(collectorResponse, collectorBody);
  let ackResponse: Response;
  try {
    ackResponse = await fetchImpl(`${options.localApiUrl.replace(/\/$/, "")}/api/orgs/${encodeURIComponent(options.orgId)}/analytics/product/installation/${encodeURIComponent(options.installationId)}/outbox/ack`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(options.localHeaders ?? {}) },
      body: JSON.stringify({ installationSecret: options.installationSecret, claimToken, eventIds, delivered, errorCode }),
    });
  } catch {
    await updateDesktopTelemetryState(options.statePath, { lastErrorCode: "local_ack_network" });
    return { status: "retry_wait", eventCount: events.length, errorCode: "local_ack_network" };
  }
  if (!ackResponse.ok) {
    const ackBody = await readJson(ackResponse);
    const ackErrorCode = errorCodeForResponse(ackResponse, ackBody);
    await updateDesktopTelemetryState(options.statePath, { lastErrorCode: ackErrorCode });
    return { status: "retry_wait", eventCount: events.length, errorCode: ackErrorCode };
  }
  const ackBody = await readJson(ackResponse);
  const status = ackBody.state === "failed_actionable" ? "failed_actionable" : delivered ? "delivered" : "retry_wait";
  await updateDesktopTelemetryState(options.statePath, delivered
    ? { lastSucceededAt: now().toISOString(), lastErrorCode: null }
    : { lastErrorCode: errorCode });
  return { status, eventCount: events.length, errorCode };
}
