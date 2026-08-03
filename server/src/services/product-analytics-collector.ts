import { createHash } from "node:crypto";
import { PRODUCT_ANALYTICS_EVENT_NAMES } from "./product-analytics.js";

const MAX_BATCH_EVENTS = 100;
const MAX_BATCH_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 2 * 1024;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MAX_LATE_EVENT_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY = /(prompt|transcript|title|description|body|content|url|token|secret|password|credential|email|hostname|username)/i;
const EVENT_NAMES = new Set<string>(PRODUCT_ANALYTICS_EVENT_NAMES);

export type ProductAnalyticsCollectorAuthorization = {
  installationId: string;
  mode: "anonymous" | "account_linked";
  consentVersion: string;
  consentEpoch: number;
  analyticsSubject?: string | null;
};

export type ProductAnalyticsCollectorEvent = {
  eventId: string;
  eventName: string;
  schemaVersion: 1;
  occurredAt: string;
  environment: "production" | "development" | "test";
  appVersion: string;
  releaseChannel: "development" | "preview" | "canary" | "stable";
  deploymentMode: "desktop_local" | "self_hosted" | "remote_server";
  actorKind: "user" | "agent" | "system" | "automation";
  origin: "human" | "automation" | "retry" | "recovery" | "system";
  pseudonymousInstallationId: string | null;
  pseudonymousOrgId: string | null;
  pseudonymousWorkId: string | null;
  pseudonymousWorkCycleId: string | null;
  pseudonymousRootRunId: string | null;
  pseudonymousRunId: string | null;
  completionRevision: number | null;
  properties: Record<string, string | number | boolean | null>;
  confidence: "exact" | "derived" | "unknown";
  isBackfill: boolean;
};

export type ProductAnalyticsCollectorAck = {
  eventId: string;
  status: "accepted" | "duplicate" | "rejected";
  errorCode?: "invalid_schema" | "invalid_event" | "future_event" | "revoked" | "conflict" | "too_large";
  late: boolean;
};

type StoredCollectorEvent = ProductAnalyticsCollectorEvent & {
  installationId: string;
  analyticsSubject: string | null;
  consentVersion: string;
  consentEpoch: number;
  payloadSha256: string;
  receivedAt: string;
};

type InstallationState = {
  consentVersion: string;
  consentEpoch: number;
  revoked: boolean;
};

export type ProductAnalyticsCollectorStore = {
  getInstallationState(installationId: string): InstallationState | null;
  setInstallationState(installationId: string, state: InstallationState): void;
  getEvent(eventId: string): StoredCollectorEvent | null;
  putEvent(event: StoredCollectorEvent): void;
  listEvents(): StoredCollectorEvent[];
};

export class InMemoryProductAnalyticsCollectorStore implements ProductAnalyticsCollectorStore {
  private readonly installations = new Map<string, InstallationState>();
  private readonly events = new Map<string, StoredCollectorEvent>();

  getInstallationState(installationId: string) {
    return this.installations.get(installationId) ?? null;
  }

  setInstallationState(installationId: string, state: InstallationState) {
    this.installations.set(installationId, { ...state });
  }

  getEvent(eventId: string) {
    return this.events.get(eventId) ?? null;
  }

  putEvent(event: StoredCollectorEvent) {
    this.events.set(event.eventId, event);
  }

  listEvents() {
    return [...this.events.values()];
  }
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashPayload(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function reject(code: ProductAnalyticsCollectorAck["errorCode"], eventId: string, late = false): ProductAnalyticsCollectorAck {
  return { eventId, status: "rejected", errorCode: code, late };
}

function validateEvent(value: unknown): { event: ProductAnalyticsCollectorEvent; serialized: string; late: boolean } | ProductAnalyticsCollectorAck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return reject("invalid_schema", "unknown");
  const event = value as Record<string, unknown>;
  const requiredKeys = [
    "eventId", "eventName", "schemaVersion", "occurredAt", "environment", "appVersion", "releaseChannel",
    "deploymentMode", "actorKind", "origin", "pseudonymousInstallationId", "pseudonymousOrgId", "pseudonymousWorkId",
    "pseudonymousWorkCycleId", "pseudonymousRootRunId", "pseudonymousRunId", "completionRevision", "properties", "confidence", "isBackfill",
  ];
  const actualKeys = Object.keys(event).sort();
  if (actualKeys.length !== requiredKeys.length || actualKeys.some((key, index) => key !== requiredKeys.sort()[index])) {
    return reject("invalid_schema", typeof event.eventId === "string" ? event.eventId : "unknown");
  }
  if (typeof event.eventId !== "string" || !UUID_LIKE.test(event.eventId)) return reject("invalid_schema", "unknown");
  if (typeof event.eventName !== "string" || !EVENT_NAMES.has(event.eventName) || event.schemaVersion !== 1) return reject("invalid_event", event.eventId);
  if (typeof event.occurredAt !== "string") return reject("invalid_event", event.eventId);
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) return reject("invalid_event", event.eventId);
  const now = Date.now();
  if (occurredAt.getTime() > now + MAX_FUTURE_SKEW_MS) return reject("future_event", event.eventId);
  const late = now - occurredAt.getTime() > MAX_LATE_EVENT_MS;
  if (!(["production", "development", "test"] as string[]).includes(String(event.environment))) return reject("invalid_event", event.eventId, late);
  if (!(["development", "preview", "canary", "stable"] as string[]).includes(String(event.releaseChannel))) return reject("invalid_event", event.eventId, late);
  if (!(["desktop_local", "self_hosted", "remote_server"] as string[]).includes(String(event.deploymentMode))) return reject("invalid_event", event.eventId, late);
  if (!(["user", "agent", "system", "automation"] as string[]).includes(String(event.actorKind))) return reject("invalid_event", event.eventId, late);
  if (!(["human", "automation", "retry", "recovery", "system"] as string[]).includes(String(event.origin))) return reject("invalid_event", event.eventId, late);
  if (!(["exact", "derived", "unknown"] as string[]).includes(String(event.confidence))) return reject("invalid_event", event.eventId, late);
  if (typeof event.appVersion !== "string" || event.appVersion.length > 80 || typeof event.isBackfill !== "boolean") return reject("invalid_event", event.eventId, late);
  if (event.completionRevision !== null && (!Number.isInteger(event.completionRevision) || Number(event.completionRevision) < 1)) return reject("invalid_event", event.eventId, late);
  for (const key of ["pseudonymousInstallationId", "pseudonymousOrgId", "pseudonymousWorkId", "pseudonymousWorkCycleId", "pseudonymousRootRunId", "pseudonymousRunId"]) {
    if (event[key] !== null && (typeof event[key] !== "string" || event[key].length > 128)) return reject("invalid_event", event.eventId, late);
  }
  if (!event.properties || typeof event.properties !== "object" || Array.isArray(event.properties)) return reject("invalid_event", event.eventId, late);
  for (const [key, property] of Object.entries(event.properties as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key) || !isScalar(property) || (typeof property === "string" && property.length > 80) || (typeof property === "number" && !Number.isFinite(property))) {
      return reject("invalid_event", event.eventId, late);
    }
  }
  const serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EVENT_BYTES) return reject("too_large", event.eventId, late);
  return { event: event as unknown as ProductAnalyticsCollectorEvent, serialized, late };
}

export function createProductAnalyticsCollector(store: ProductAnalyticsCollectorStore = new InMemoryProductAnalyticsCollectorStore()) {
  function ingestBatch(input: { authorization: ProductAnalyticsCollectorAuthorization; events: unknown; now?: Date }) {
    const { authorization } = input;
    const now = input.now ?? new Date();
    const events = Array.isArray(input.events) ? input.events : null;
    if (!authorization.installationId || !Number.isInteger(authorization.consentEpoch) || authorization.consentEpoch < 1) {
      return { accepted: 0, duplicate: 0, rejected: (events ?? []).map((value) => reject("invalid_schema", typeof (value as Record<string, unknown>)?.eventId === "string" ? String((value as Record<string, unknown>).eventId) : "unknown")), receivedAt: now.toISOString() };
    }
    const serializedBatch = JSON.stringify(events ?? null) ?? "";
    if (!events) {
      return { accepted: 0, duplicate: 0, rejected: [{ eventId: "batch", status: "rejected" as const, errorCode: "invalid_schema" as const, late: false }], receivedAt: now.toISOString() };
    }
    if (events.length > MAX_BATCH_EVENTS || Buffer.byteLength(serializedBatch, "utf8") > MAX_BATCH_BYTES) {
      return { accepted: 0, duplicate: 0, rejected: [{ eventId: "batch", status: "rejected" as const, errorCode: "too_large" as const, late: false }], receivedAt: now.toISOString() };
    }
    const installationState = store.getInstallationState(authorization.installationId);
    if (!installationState || installationState.revoked || installationState.consentEpoch !== authorization.consentEpoch || installationState.consentVersion !== authorization.consentVersion) {
      return { accepted: 0, duplicate: 0, rejected: events.map((value) => reject("revoked", typeof (value as Record<string, unknown>)?.eventId === "string" ? String((value as Record<string, unknown>).eventId) : "unknown")), receivedAt: now.toISOString() };
    }
    const acks: ProductAnalyticsCollectorAck[] = [];
    for (const value of events) {
      const result = validateEvent(value);
      if ("status" in result) {
        acks.push(result);
        continue;
      }
      const existing = store.getEvent(result.event.eventId);
      const payloadSha256 = hashPayload(result.event);
      if (existing) {
        acks.push(existing.payloadSha256 === payloadSha256
          ? { eventId: result.event.eventId, status: "duplicate", late: result.late }
          : { eventId: result.event.eventId, status: "rejected", errorCode: "conflict", late: result.late });
        continue;
      }
      store.putEvent({
        ...result.event,
        installationId: authorization.installationId,
        analyticsSubject: authorization.mode === "account_linked" ? authorization.analyticsSubject ?? null : null,
        consentVersion: authorization.consentVersion,
        consentEpoch: authorization.consentEpoch,
        payloadSha256,
        receivedAt: now.toISOString(),
      });
      acks.push({ eventId: result.event.eventId, status: "accepted", late: result.late });
    }
    return {
      accepted: acks.filter((ack) => ack.status === "accepted").length,
      duplicate: acks.filter((ack) => ack.status === "duplicate").length,
      rejected: acks.filter((ack) => ack.status === "rejected"),
      receivedAt: now.toISOString(),
    };
  }

  function advanceConsent(input: { installationId: string; consentVersion: string; consentEpoch: number; revoked: boolean }) {
    const current = store.getInstallationState(input.installationId);
    // Consent epochs are monotonic. Treat an equal or older epoch as already
    // applied so a replay cannot change revocation state without a new epoch.
    if (current && input.consentEpoch <= current.consentEpoch) return current;
    const next = { consentVersion: input.consentVersion, consentEpoch: input.consentEpoch, revoked: input.revoked };
    store.setInstallationState(input.installationId, next);
    return next;
  }

  return { ingestBatch, advanceConsent, store };
}

export type ProductAnalyticsCollector = ReturnType<typeof createProductAnalyticsCollector>;
