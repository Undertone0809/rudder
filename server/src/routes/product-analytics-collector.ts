import { verifyProductAnalyticsAssertion } from "@rudderhq/identity-core";
import { Router, type Request } from "express";
import { unauthorized } from "../errors.js";
import type { ProductAnalyticsCollector, ProductAnalyticsCollectorAuthorization, ProductAnalyticsPersistentCollector } from "../services/product-analytics-collector.js";

export type ProductAnalyticsCollectorAuthorizer = (req: Request) => ProductAnalyticsCollectorAuthorization | Promise<ProductAnalyticsCollectorAuthorization>;

/** Build the central authorizer for short-lived telemetry-scoped assertions. */
export function createProductAnalyticsAssertionAuthorizer(input: {
  identityPublicKey: string | Buffer;
  expectedKeyId: string;
  expectedIssuer: string;
  resolveInstallationId?: (req: Request) => string | null;
}) : ProductAnalyticsCollectorAuthorizer {
  return (req) => {
    const value = req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!value) throw unauthorized("Telemetry assertion required");
    const installationId = input.resolveInstallationId?.(req) ?? req.header("x-rudder-installation-id") ?? null;
    if (!installationId) throw unauthorized("Telemetry installation required");
    let claims;
    try {
      claims = verifyProductAnalyticsAssertion({
        assertion: value,
        identityPublicKey: input.identityPublicKey,
        expectedKeyId: input.expectedKeyId,
        expectedIssuer: input.expectedIssuer,
        expectedInstallationId: installationId,
        nowMs: Date.now(),
      });
    } catch {
      throw unauthorized("Telemetry assertion is invalid or expired");
    }
    return {
      installationId: claims.installationId,
      mode: claims.analyticsSubject ? "account_linked" : "anonymous",
      consentVersion: claims.consentVersion,
      consentEpoch: claims.consentEpoch,
      analyticsSubject: claims.analyticsSubject,
      pseudonymousInstallationId: claims.pseudonymousInstallationId,
    };
  };
}

/**
 * Private collector boundary. It is intentionally not mounted on the local
 * Rudder app; the central telemetry deployment supplies the authorizer and
 * central store when it hosts this router.
 */
export function productAnalyticsCollectorRoutes(collector: ProductAnalyticsCollector | ProductAnalyticsPersistentCollector, authorize: ProductAnalyticsCollectorAuthorizer) {
  const router = Router();

  router.post("/api/analytics/v1/events:batch", async (req, res) => {
    const authorization = await authorize(req);
    const result = await collector.ingestBatch({ authorization, events: req.body?.events, now: new Date() });
    const hasConflict = result.rejected.some((ack) => ack.errorCode === "conflict");
    res.status(hasConflict ? 409 : result.rejected.length > 0 && result.accepted === 0 && result.duplicate === 0 ? 422 : 200).json(result);
  });

  router.post("/api/analytics/v1/consent/revoke", async (req, res) => {
    const authorization = await authorize(req);
    const consentVersion = typeof req.body?.consentVersion === "string" ? req.body.consentVersion : authorization.consentVersion;
    const consentEpoch = typeof req.body?.consentEpoch === "number" ? req.body.consentEpoch : authorization.consentEpoch + 1;
    const state = await collector.advanceConsent({
      installationId: authorization.installationId,
      consentVersion,
      consentEpoch,
      revoked: true,
    });
    res.json({ installationId: authorization.installationId, consentEpoch: state.consentEpoch, revoked: state.revoked });
  });

  return router;
}
