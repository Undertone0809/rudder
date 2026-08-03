import type { Db } from "@rudderhq/db";
import { isUuidLike } from "@rudderhq/shared";
import { Router, type Request } from "express";
import { unprocessable } from "../errors.js";
import { PRODUCT_ANALYTICS_EVENT_NAMES, productAnalyticsService, type ProductAnalyticsEventName } from "../services/product-analytics.js";
import { assertCompanyAccess } from "./authz.js";

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

  return router;
}
