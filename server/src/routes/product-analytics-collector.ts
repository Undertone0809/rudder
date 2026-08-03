import { Router, type Request } from "express";
import type { ProductAnalyticsCollector, ProductAnalyticsCollectorAuthorization } from "../services/product-analytics-collector.js";

export type ProductAnalyticsCollectorAuthorizer = (req: Request) => ProductAnalyticsCollectorAuthorization | Promise<ProductAnalyticsCollectorAuthorization>;

/**
 * Private collector boundary. It is intentionally not mounted on the local
 * Rudder app; the central telemetry deployment supplies the authorizer and
 * central store when it hosts this router.
 */
export function productAnalyticsCollectorRoutes(collector: ProductAnalyticsCollector, authorize: ProductAnalyticsCollectorAuthorizer) {
  const router = Router();

  router.post("/api/analytics/v1/events:batch", async (req, res) => {
    const authorization = await authorize(req);
    const result = collector.ingestBatch({ authorization, events: req.body?.events, now: new Date() });
    res.status(result.rejected.length > 0 && result.accepted === 0 && result.duplicate === 0 ? 422 : 200).json(result);
  });

  router.post("/api/analytics/v1/consent/revoke", async (req, res) => {
    const authorization = await authorize(req);
    const consentVersion = typeof req.body?.consentVersion === "string" ? req.body.consentVersion : authorization.consentVersion;
    const consentEpoch = typeof req.body?.consentEpoch === "number" ? req.body.consentEpoch : authorization.consentEpoch + 1;
    const state = collector.advanceConsent({
      installationId: authorization.installationId,
      consentVersion,
      consentEpoch,
      revoked: true,
    });
    res.json({ installationId: authorization.installationId, consentEpoch: state.consentEpoch, revoked: state.revoked });
  });

  return router;
}
