export type IdentityProductAnalyticsConsentSync = {
  collectorUrl: string;
  syncSecret: string;
};

export type ProductAnalyticsConsentSyncInput = {
  installationId: string;
  analyticsSubject: string | null;
  consentVersion: string;
  consentEpoch: number;
  revoked: boolean;
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Mirror the Identity-owned consent decision into the private collector.
 * The request contains only collector-scoped pseudonyms and consent state.
 */
export async function syncProductAnalyticsConsent(input: {
  config: IdentityProductAnalyticsConsentSync;
  consent: ProductAnalyticsConsentSyncInput;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? ((request, init) => fetch(request, init));
  const endpoint = new URL("/api/analytics/v1/internal/consent/sync", input.config.collectorUrl).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 5_000);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-rudder-telemetry-consent-sync-secret": input.config.syncSecret,
      },
      body: JSON.stringify(input.consent),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("telemetry_consent_sync_failed");
  } finally {
    clearTimeout(timeout);
  }
}
