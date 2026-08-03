import { createHash } from "node:crypto";
import { createDesktopProductAnalyticsScheduler, type DesktopProductAnalyticsScheduler } from "./product-analytics-scheduler.js";
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

export async function startDesktopProductAnalyticsScheduler(
  apiUrl: string,
  options: {
    collectorUrl: string | undefined;
    identityRuntime: DesktopAnalyticsIdentityRuntime;
    scheduler: DesktopProductAnalyticsScheduler | null;
    setScheduler: (scheduler: DesktopProductAnalyticsScheduler) => void;
  },
): Promise<void> {
  if (!options.collectorUrl || options.scheduler) return;
  const telemetry = await options.identityRuntime.telemetryStatePromise;
  if (telemetry.state.mode === "off") return;
  if (telemetry.state.mode === "account_linked") {
    try {
      await options.identityRuntime.recordProductAnalyticsConsent({
        mode: "account_linked",
        decision: "granted",
        consentVersion: telemetry.state.consentVersion,
      });
    } catch (error) {
      console.warn("[rudder-desktop] Identity telemetry consent unavailable", error);
    }
  }
  let orgId: string | null = null;
  try {
    const organizationsResponse = await fetch(new URL("/api/orgs", apiUrl));
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
    await fetch(`${localApiUrl}${registrationPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationId: telemetry.installationId, installationSecret: telemetry.installationSecret, mode: "off" }),
    });
    await fetch(`${localApiUrl}${registrationPath}/${encodeURIComponent(telemetry.installationId)}/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installationSecret: telemetry.installationSecret, scope: telemetry.state.mode === "account_linked" ? "account_linked_user" : "anonymous_installation", decision: "granted", policyVersion: telemetry.state.consentVersion }),
    });
  } catch (error) {
    console.warn("[rudder-desktop] Product analytics registration failed", error);
  }
  const deliveryMode = telemetry.state.mode === "account_linked" ? "account_linked" as const : "anonymous" as const;
  const base = {
    localApiUrl,
    orgId,
    installationId: telemetry.installationId,
    installationSecret: telemetry.installationSecret,
    statePath: telemetry.statePath,
    collectorUrl: options.collectorUrl,
    deliveryMode,
    collectorAuthorization: async () => {
      if (deliveryMode === "account_linked") {
        const pseudonymousInstallationId = createHash("sha256").update(telemetry.installationSecret).update(telemetry.installationId).digest("hex");
        return options.identityRuntime.issueProductAnalyticsAssertion({
          mode: deliveryMode,
          consentVersion: telemetry.state.consentVersion,
          consentEpoch: telemetry.state.consentEpoch,
          pseudonymousInstallationId,
        });
      }
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
