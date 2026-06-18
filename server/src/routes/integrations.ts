import type { Db } from "@rudderhq/db";
import { mockFeishuInboundEventSchema } from "@rudderhq/shared";
import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { createFeishuInboundDispatcherDbDeps } from "../services/integrations/feishu/inbound-dispatcher-db.js";
import { dispatchFeishuInboundMessage } from "../services/integrations/feishu/inbound-dispatcher.js";
import { normalizeMockFeishuInboundEvent } from "../services/integrations/feishu/inbound-normalizer.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function integrationRoutes(db: Db) {
  const router = Router();

  router.post("/orgs/:orgId/integrations/feishu/mock-inbound", validate(mockFeishuInboundEventSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const event = normalizeMockFeishuInboundEvent(req.body);
    const result = await dispatchFeishuInboundMessage(event, createFeishuInboundDispatcherDbDeps(db, { orgId }));

    res.status(result.status === "accepted" ? 201 : 200).json({
      result,
      normalized: {
        eventId: event.eventId,
        messageId: event.messageId,
        chatId: event.chatId,
        chatType: event.chatType,
        messageType: event.messageType,
        addressedToBot: event.addressedToBot,
      },
    });
  });

  return router;
}
