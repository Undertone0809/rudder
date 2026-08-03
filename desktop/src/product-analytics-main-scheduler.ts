import { createHmac } from "node:crypto";
import { createDesktopProductAnalyticsScheduler, type DesktopProductAnalyticsScheduler } from "./product-analytics-scheduler.js";
import { updateDesktopTelemetryState } from "./product-analytics-telemetry.js";
import { uploadDesktopProductAnalyticsOnce } from "./product-analytics-uploader.js";

type DesktopAnalyticsIdentityRuntime = {
  telemetryStatePromise: Promise<{
    state: {
      mode: "off" | "anonymous" | "account_linked";
      consentVersion: string;
      consentEpoch: number;
    };
    installationId: string;
    installationSecret: string;
    statePath: string;
  }>;
  recordProductAnalyticsConsent(input: {
    mode: "anonymous" | "account_linked";
    decision: "granted" | "revoked";
    consentVersion: string;
  }): Promise<{ consentEpoch: number }>;
  issueProductAnalyticsAssertion(input: {
    mode: "anonymous" | "account_linked";
    consentVersion: string;
    consentEpoch: number;
    pseudonymousInstallationId: string;
  }): Promise<string>;
};

/** Must match the local exporter HMAC used for collector event payloads. */
export function deriveDesktopProductAnalyticsInstallationId(installationSecret: string, installationId: string): string {
  return createHmac("sha256", installationSecret).update(installationId).digest("hex");
}

export async function startDesktopProductAnalyticsScheduler(
  apiUrl: string,
  options: {
    collectorUrl: string | undefined;
    identityRuntime: DesktopAnalyticsIdentityRuntime;
    scheduler: DesktopProductAnalyticsScheduler | null;
    setScheduler: (scheduler: DesktopProductAnalyticsScheduler) => void;
    fetchImpl?: typeof fetch;
  },
): Promise<void> {
  if (!options.collectorUrl || options.scheduler) return;
  const fetchImpl = options.fetchImpl ?? fetch;
  const telemetry = await options.identityRuntime.telemetryStatePromise;
  let mode = telemetry.state.mode;
  let consentVersion = telemetry.state.consentVersion;
  let consentEpoch = telemetry.state.consentEpoch;
  let identityConsentAuthorized = false;
  let anonymousAuthorizationFallbackAllowed = false;
  try {
    const settingsResponse = await fetchImpl(new URL("/api/instance/settings/product-analytics", apiUrl));
    if (!settingsResponse.ok) {
      console.warn(`[rudder-desktop] Product analytics settings unavailable (${settingsResponse.status})`);
      return;
    }
    const settings = await settingsResponse.json() as Record<string, unknown>;
    if (settings.mode !== "off" && settings.mode !== "anonymous" && settings.mode !== "account_linked") return;
    if (typeof settings.consentVersion !== "string" || settings.consentVersion.length === 0) return;
    if (!Number.isSafeInteger(settings.consentEpoch) || Number(settings.consentEpoch) < 1) return;
    mode = settings.mode;
    consentVersion = settings.consentVersion;
    consentEpoch = Number(settings.consentEpoch);
    await updateDesktopTelemetryState(telemetry.statePath, { mode, consentVersion, consentEpoch });
  } catch (error) {
    console.warn("[rudder-desktop] Unable to read local telemetry settings", error);
    return;
  }
  if (mode === "off") return;
  try {
    const consent = await options.identityRuntime.recordProductAnalyticsConsent({
      mode,
      decision: "granted",
      consentVersion,
    });
    consentEpoch = consent.consentEpoch;
    identityConsentAuthorized = true;
    await updateDesktopTelemetryState(telemetry.statePath, { consentEpoch });
  } catch (error) {
    console.warn("[rudder-desktop] Identity telemetry consent unavailable", error);
    if (mode === "account_linked") return;
    if ((error as { code?: unknown }).code !== "IDENTITY_NOT_SIGNED_IN") return;
    anonymousAuthorizationFallbackAllowed = true;
  }
  let orgId: string | null = null;
  try {
    const organizationsResponse = await fetchImpl(new URL("/api/orgs", apiUrl));
    if (organizationsResponse.ok) {
      const payload = await organizationsResponse.json() as unknown;
      const first = Array.isArray(payload) ? payload[0] : (payload && typeof payload === "object" && Array.isArray((payload as { organizations?: unknown }).organizations) ? (payload as { organizations: unknown[] }).organizations[0] : null);
      orgId = first && typeof first === "object" && typeof (first as { id?: unknown }).id === "string" ? (first as { id: string }).id : null;
    }
  } catch (error) {
    console.warn("[rudder-desktop] Unable to resolve an organization for telemetry upload", error);
  }
  if (!orgId) return;
  const localApiUrl = apiUrl.replace(/\/$/, "");
  const registrationPath = `/api/orgs/${encodeURIComponent(orgId)}/analytics/product/installation`;
  try {
    await fetchImpl(`${localApiUrl}${registrationPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: telemetry.installationId, installationSecret: telemetry.installationSecret, mode: "off" }),
    });
    await fetchImpl(`${localApiUrl}${registrationPath}/${encodeURIComponent(telemetry.installationId)}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationSecret: telemetry.installationSecret, scope: mode === "account_linked" ? "account_linked_user" : "anonymous_installation", decision: "granted", policyVersion: consentVersion }),
    });
  } catch (error) {
    console.warn("[rudder-desktop] Product analytics registration failed", error);
  }
  const deliveryMode = mode === "account_linked" ? "account_linked" as const : "anonymous" as const;
  const base = {
    localApiUrl,
    orgId,
    installationId: telemetry.installationId,
    installationSecret: telemetry.installationSecret,
    statePath: telemetry.statePath,
    collectorUrl: options.collectorUrl,
    fetchImpl,
    deliveryMode,
    collectorAuthorization: async () => {
      if (deliveryMode === "account_linked") {
        const pseudonymousInstallationId = deriveDesktopProductAnalyticsInstallationId(telemetry.installationSecret, telemetry.installationId);
        return options.identityRuntime.issueProductAnalyticsAssertion({
          mode: deliveryMode,
          consentVersion,
          consentEpoch,
          pseudonymousInstallationId,
        });
      }
      if (identityConsentAuthorized) {
        return options.identityRuntime.issueProductAnalyticsAssertion({
          mode: deliveryMode,
          consentVersion,
          consentEpoch,
          pseudonymousInstallationId: deriveDesktopProductAnalyticsInstallationId(telemetry.installationSecret, telemetry.installationId),
        });
      }
      if (!anonymousAuthorizationFallbackAllowed) return "";
      const authorization = process.env.RUDDER_TELEMETRY_ANONYMOUS_AUTHORIZATION?.trim();
      return authorization ? (authorization.startsWith("Bearer ") ? authorization : `Bearer ${authorization}`) : "";
    },
  };
  const scheduler = createDesktopProductAnalyticsScheduler({
    upload: () => uploadDesktopProductAnalyticsOnce(base),
  });
  options.setScheduler(scheduler);
  scheduler.start();
}
