import { verifyProductAnalyticsAssertion } from "@rudderhq/identity-core";
import { Router, type Request } from "express";
import { timingSafeEqual } from "node:crypto";
import { unauthorized } from "../errors.js";
import type { ProductAnalyticsCollector, ProductAnalyticsCollectorAuthorization, ProductAnalyticsPersistentCollector } from "../services/product-analytics-collector.js";

export type ProductAnalyticsCollectorAuthorizer = (req: Request) => ProductAnalyticsCollectorAuthorization | Promise<ProductAnalyticsCollectorAuthorization>;

function secretMatches(value: string | undefined, expected: string | null): boolean {
  if (!value || !expected) return false;
  const actual = Buffer.from(value);
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function readOptionalAnalyticsSubject(body: unknown): { value: string | null; valid: boolean } {
  if (!body || typeof body !== "object") return { value: null, valid: true };
  const value = (body as Record<string, unknown>).analyticsSubject;
  if (value === undefined || value === null) return { value: null, valid: true };
  return typeof value === "string" ? { value, valid: true } : { value: null, valid: false };
}

/** Build the central authorizer for short-lived telemetry-scoped assertions. */
export function createProductAnalyticsAssertionAuthorizer(input: {
  identityPublicKey: string | Buffer;
  expectedKeyId: string;
  expectedIssuer: string;
  anonymousAuthorization?: string | null;
  resolveInstallationId?: (req: Request) => string | null;
}) : ProductAnalyticsCollectorAuthorizer {
  return (req) => {
    const value = req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
    if (!value) throw unauthorized("Telemetry assertion required");
    const installationId = input.resolveInstallationId?.(req) ?? req.header("x-rudder-installation-id") ?? null;
    if (!installationId) throw unauthorized("Telemetry installation required");
    if (secretMatches(value, input.anonymousAuthorization ?? null)) {
      const consentVersion = req.header("x-rudder-telemetry-consent-version")?.trim() ?? "";
      const pseudonymousInstallationId = req.header("x-rudder-telemetry-pseudonymous-installation-id")?.trim() ?? "";
      const consentEpochRaw = req.header("x-rudder-telemetry-consent-epoch")?.trim() ?? "";
      const consentEpoch = Number(consentEpochRaw);
      if (!consentVersion || consentVersion.length > 80 || !/^[0-9a-f]{64}$/u.test(pseudonymousInstallationId)
        || !Number.isSafeInteger(consentEpoch) || consentEpoch < 1) {
        throw unauthorized("Anonymous telemetry authorization is missing consent state");
      }
      return {
        installationId,
        mode: "anonymous",
        consentVersion,
        consentEpoch,
        analyticsSubject: null,
        pseudonymousInstallationId,
      };
    }
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
export function productAnalyticsCollectorRoutes(
  collector: ProductAnalyticsCollector | ProductAnalyticsPersistentCollector,
  authorize: ProductAnalyticsCollectorAuthorizer,
  options: { anonymousAuthorization?: string | null; revokeSecret?: string | null; consentSyncSecret?: string | null } = {},
) {
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
      analyticsSubject: authorization.mode === "account_linked" ? authorization.analyticsSubject : null,
      consentVersion,
      consentEpoch,
      revoked: true,
    });
    res.json({ installationId: authorization.installationId, consentEpoch: state.consentEpoch, revoked: state.revoked });
  });

  // Self-hosted deployments without a signed-in Identity session may use an
  // explicitly provisioned anonymous deployment credential. This endpoint
  // establishes the installation-scoped consent state before the first batch;
  // it never accepts an account-linked subject.
  router.post("/api/analytics/v1/internal/anonymous/consent", async (req, res) => {
    if (!secretMatches(req.header("x-rudder-telemetry-anonymous-authorization"), options.anonymousAuthorization ?? null)) {
      res.status(401).json({ errorCode: "unauthorized" });
      return;
    }
    const installationId = typeof req.body?.installationId === "string" ? req.body.installationId.trim() : "";
    const pseudonymousInstallationId = typeof req.body?.pseudonymousInstallationId === "string" ? req.body.pseudonymousInstallationId.trim() : "";
    const consentVersion = typeof req.body?.consentVersion === "string" ? req.body.consentVersion.trim() : "";
    const consentEpoch = typeof req.body?.consentEpoch === "number" ? req.body.consentEpoch : NaN;
    const revoked = req.body?.revoked;
    if (!installationId || installationId.length > 256 || !/^[0-9a-f]{64}$/u.test(pseudonymousInstallationId)
      || !consentVersion || consentVersion.length > 80 || !Number.isSafeInteger(consentEpoch) || consentEpoch < 1
      || typeof revoked !== "boolean") {
      res.status(422).json({ errorCode: "invalid_request" });
      return;
    }
    const state = await collector.advanceConsent({ installationId, consentVersion, consentEpoch, revoked });
    res.json({ installationId, pseudonymousInstallationId, consentVersion: state.consentVersion, consentEpoch: state.consentEpoch, revoked: state.revoked });
  });

  router.post("/api/analytics/v1/internal/consent/revoke", async (req, res) => {
    if (!secretMatches(req.header("x-rudder-telemetry-revoke-secret"), options.revokeSecret ?? null)) {
      res.status(401).json({ errorCode: "unauthorized" });
      return;
    }
    const installationId = typeof req.body?.installationId === "string" ? req.body.installationId : "";
    const analyticsSubjectInput = readOptionalAnalyticsSubject(req.body);
    const analyticsSubject = analyticsSubjectInput.value;
    const consentVersion = typeof req.body?.consentVersion === "string" ? req.body.consentVersion : "";
    const consentEpoch = typeof req.body?.consentEpoch === "number" ? req.body.consentEpoch : NaN;
    if (!analyticsSubjectInput.valid || !installationId || installationId.length > 256 || !consentVersion || consentVersion.length > 80
      || (analyticsSubject !== null && !/^[0-9a-f]{64}$/u.test(analyticsSubject))
      || !Number.isInteger(consentEpoch) || consentEpoch < 1) {
      res.status(422).json({ errorCode: "invalid_request" });
      return;
    }
    const state = await collector.advanceConsent({ installationId, consentVersion, consentEpoch, revoked: true, analyticsSubject });
    res.json({ installationId, analyticsSubject, consentEpoch: state.consentEpoch, revoked: state.revoked });
  });

  // Identity owns the append-only consent ledger. This private hook mirrors
  // its current grant/revoke state into the collector before any assertion can
  // authorize delivery. Assertions are intentionally not allowed to bootstrap
  // a consent row from request claims.
  router.post("/api/analytics/v1/internal/consent/sync", async (req, res) => {
    if (!secretMatches(req.header("x-rudder-telemetry-consent-sync-secret"), options.consentSyncSecret ?? null)) {
      res.status(401).json({ errorCode: "unauthorized" });
      return;
    }
    const installationId = typeof req.body?.installationId === "string" ? req.body.installationId : "";
    const analyticsSubjectInput = readOptionalAnalyticsSubject(req.body);
    const analyticsSubject = analyticsSubjectInput.value;
    const consentVersion = typeof req.body?.consentVersion === "string" ? req.body.consentVersion : "";
    const consentEpoch = typeof req.body?.consentEpoch === "number" ? req.body.consentEpoch : NaN;
    const revoked = req.body?.revoked;
    if (!analyticsSubjectInput.valid || !installationId || installationId.length > 256 || !consentVersion || consentVersion.length > 80
      || (analyticsSubject !== null && !/^[0-9a-f]{64}$/u.test(analyticsSubject))
      || !Number.isSafeInteger(consentEpoch) || consentEpoch < 1 || typeof revoked !== "boolean") {
      res.status(422).json({ errorCode: "invalid_request" });
      return;
    }
    const state = await collector.advanceConsent({ installationId, analyticsSubject, consentVersion, consentEpoch, revoked });
    res.json({ installationId, analyticsSubject, consentVersion: state.consentVersion, consentEpoch: state.consentEpoch, revoked: state.revoked });
  });

  return router;
}
