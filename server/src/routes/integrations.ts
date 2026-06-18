import type { Db } from "@rudderhq/db";
import { mockFeishuInboundEventSchema } from "@rudderhq/shared";
import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { feishuCallbackCredentialService } from "../services/integrations/feishu/callback-credentials.js";
import {
  hasFeishuCallbackVerificationSignal,
  verifyFeishuEventCallback,
} from "../services/integrations/feishu/event-verifier.js";
import { createFeishuInboundDispatcherDbDeps } from "../services/integrations/feishu/inbound-dispatcher-db.js";
import { dispatchFeishuInboundMessage } from "../services/integrations/feishu/inbound-dispatcher.js";
import { normalizeMockFeishuInboundEvent } from "../services/integrations/feishu/inbound-normalizer.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function integrationRoutes(db: Db) {
  const router = Router();
  const feishuCallbackCredentials = feishuCallbackCredentialService(db);

  router.post("/orgs/:orgId/integrations/feishu/mock-inbound", validate(mockFeishuInboundEventSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    if (hasFeishuCallbackVerificationSignal(req.body, req.headers)) {
      const credentials = await feishuCallbackCredentials.resolveForCallback(orgId, req.body)
        ?? {
          verificationToken: req.body.mockVerificationToken,
          encryptKey: req.body.mockEncryptKey,
        };
      const verification = verifyFeishuEventCallback({
        body: req.body,
        headers: req.headers,
        rawBody: req.rawBody,
        verificationToken: credentials.verificationToken,
        encryptKey: credentials.encryptKey,
      });
      if (verification.kind === "challenge") {
        res.status(200).json({ challenge: verification.challenge });
        return;
      }
    }

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
