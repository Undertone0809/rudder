import type { Db } from "@rudderhq/db";
import { isUuidLike } from "@rudderhq/shared";
import { Router, type Request } from "express";
import { unprocessable } from "../errors.js";
import {
  acknowledgeProductAnalyticsOutboxClaim,
  assertProductAnalyticsInstallationSecret,
  claimProductAnalyticsOutboxBatch,
  getProductAnalyticsInstallationState,
  PRODUCT_ANALYTICS_EVENT_NAMES,
  productAnalyticsService,
  reconcileProductAnalyticsInstallationMode,
  recordProductAnalyticsConsent,
  registerProductAnalyticsInstallation,
  type ProductAnalyticsEventName,
} from "../services/product-analytics.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

function parseDateQuery(req: Request, name: "from" | "to") {
  const value = req.query[name];
  if (typeof value !== "string" || value.length === 0) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw unprocessable(`Product analytics ${name} is invalid`);
  return date;
}

function parseWindowDays(req: Request) {
  const value = req.query.windowDays;
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (!/^\d+$/.test(value)) throw unprocessable("Product analytics windowDays is invalid");
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseEventName(req: Request): ProductAnalyticsEventName | undefined {
  const value = req.query.eventName;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !PRODUCT_ANALYTICS_EVENT_NAMES.includes(value as ProductAnalyticsEventName)) {
    throw unprocessable("Unknown product analytics event");
  }
  return value as ProductAnalyticsEventName;
}

export function productAnalyticsRoutes(db: Db) {
  const router = Router();
  const service = productAnalyticsService(db);

  router.get("/orgs/:orgId/analytics/product", async (req, res) => {
    const orgId = req.params.orgId as string;
    if (!isUuidLike(orgId)) throw unprocessable("Organization id is invalid");
    assertCompanyAccess(req, orgId);
    res.json(await service.summary(orgId, {
      from: parseDateQuery(req, "from"),
      to: parseDateQuery(req, "to"),
      windowDays: parseWindowDays(req),
    }));
  });

  router.get("/orgs/:orgId/analytics/product/events", async (req, res) => {
    const orgId = req.params.orgId as string;
    if (!isUuidLike(orgId)) throw unprocessable("Organization id is invalid");
    assertCompanyAccess(req, orgId);
    const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    if (typeof req.query.limit === "string" && !/^\d+$/.test(req.query.limit)) {
      throw unprocessable("Product analytics limit is invalid");
    }
    res.json(await service.listEvents(orgId, {
      from: parseDateQuery(req, "from"),
      to: parseDateQuery(req, "to"),
      eventName: parseEventName(req),
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
    }));
  });

  router.post("/orgs/:orgId/analytics/product/installation", async (req, res) => {
    const orgId = req.params.orgId as string;
    if (!isUuidLike(orgId)) throw unprocessable("Organization id is invalid");
    assertCompanyAccess(req, orgId);
    const installationId = typeof req.body?.installationId === "string" ? req.body.installationId.trim() : "";
    if (!installationId) throw unprocessable("Product analytics installation id is required");
    const mode = req.body?.mode;
    if (mode !== undefined && mode !== "off" && mode !== "anonymous" && mode !== "account_linked") {
      throw unprocessable("Product analytics mode is invalid");
    }
    const result = await registerProductAnalyticsInstallation(db, {
      installationId,
      installationSecret: typeof req.body?.installationSecret === "string" ? req.body.installationSecret : undefined,
      mode,
    });
    res.status(201).json({ installationId, mode: result.installation?.mode ?? mode ?? "off" });
  });

  router.get("/orgs/:orgId/analytics/product/installation/:installationId", async (req, res) => {
    const orgId = req.params.orgId as string;
    if (!isUuidLike(orgId)) throw unprocessable("Organization id is invalid");
    assertCompanyAccess(req, orgId);
    const state = await getProductAnalyticsInstallationState(db, req.params.installationId as string);
    if (!state) {
      res.status(404).json({ error: "Product analytics installation not found" });
      return;
    }
    res.json({ installation: { id: state.installation.installationId, mode: state.installation.mode, state: state.installation.state }, consent: state.consent, pendingCount: state.pendingCount });
  });

  router.post("/orgs/:orgId/analytics/product/installation/:installationId/outbox/claim", async (req, res) => {
    const orgId = req.params.orgId as string;
    if (!isUuidLike(orgId)) throw unprocessable("Organization id is invalid");
    assertCompanyAccess(req, orgId);
    const installationId = req.params.installationId as string;
    const installationSecret = typeof req.body?.installationSecret === "string" ? req.body.installationSecret : "";
    const deliveryMode = req.body?.deliveryMode;
    if (deliveryMode !== "anonymous" && deliveryMode !== "account_linked") {
      throw unprocessable("Product analytics delivery mode is invalid");
    }
    const result = await claimProductAnalyticsOutboxBatch(db, {
      installationId,
      installationSecret,
      deliveryMode,
      limit: typeof req.body?.limit === "number" ? req.body.limit : undefined,
      leaseSeconds: typeof req.body?.leaseSeconds === "number" ? req.body.leaseSeconds : undefined,
    });
    res.json(result ?? { claimToken: null, events: [] });
  });

  router.post("/orgs/:orgId/analytics/product/installation/:installationId/outbox/ack", async (req, res) => {
    const orgId = req.params.orgId as string;
    if (!isUuidLike(orgId)) throw unprocessable("Organization id is invalid");
    assertCompanyAccess(req, orgId);
    const installationId = req.params.installationId as string;
    const installationSecret = typeof req.body?.installationSecret === "string" ? req.body.installationSecret : "";
    const eventIds = req.body?.eventIds;
    const claimToken = typeof req.body?.claimToken === "string" ? req.body.claimToken : "";
    if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 100 || !eventIds.every((id) => typeof id === "string" && isUuidLike(id))) {
      throw unprocessable("Product analytics event ids are invalid");
    }
    if (!claimToken) throw unprocessable("Product analytics claim token is required");
    const result = await acknowledgeProductAnalyticsOutboxClaim(db, {
      installationId,
      installationSecret,
      eventIds,
      claimToken,
      delivered: req.body?.delivered !== false,
      errorCode: typeof req.body?.errorCode === "string" ? req.body.errorCode : undefined,
    });
    res.json(result);
  });

  router.post("/orgs/:orgId/analytics/product/installation/:installationId/consent", async (req, res) => {
    const orgId = req.params.orgId as string;
    if (!isUuidLike(orgId)) throw unprocessable("Organization id is invalid");
    assertCompanyAccess(req, orgId);
    const scope = req.body?.scope;
    const decision = req.body?.decision;
    if (scope !== "anonymous_installation" && scope !== "account_linked_user") throw unprocessable("Product analytics consent scope is invalid");
    if (decision !== "granted" && decision !== "revoked") throw unprocessable("Product analytics consent decision is invalid");
    const installationSecret = typeof req.body?.installationSecret === "string" ? req.body.installationSecret : "";
    await assertProductAnalyticsInstallationSecret(db, req.params.installationId as string, installationSecret);
    const actor = getActorInfo(req);
    const localUserId = scope === "account_linked_user" ? (actor.actorType === "user" ? actor.actorId : null) : null;
    if (scope === "account_linked_user" && !localUserId) throw unprocessable("Account-linked consent requires a human user");
    const consent = await recordProductAnalyticsConsent(db, {
      installationId: req.params.installationId as string,
      scope,
      localUserId,
      decision,
      policyVersion: typeof req.body?.policyVersion === "string" ? req.body.policyVersion : "v1",
      decidedByLocalUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await reconcileProductAnalyticsInstallationMode(db, req.params.installationId as string);
    res.status(201).json(consent);
  });

  return router;
}
