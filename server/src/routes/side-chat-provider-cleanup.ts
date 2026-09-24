import type { Db } from "@rudderhq/db";
import { Router, type Request } from "express";
import { notFound } from "../errors.js";
import { logActivity, type LogActivityInput } from "../services/activity-log.js";
import { sideChatProviderCleanupService } from "../services/side-chat-provider-cleanup.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "./authz.js";

type CleanupService = ReturnType<typeof sideChatProviderCleanupService>;

export function sideChatProviderCleanupRoutes(
  db: Db,
  dependencies: {
    service?: CleanupService;
    writeActivity?: (db: Db, input: LogActivityInput) => Promise<unknown>;
  } = {},
) {
  const router = Router();
  const service = dependencies.service ?? sideChatProviderCleanupService(db);
  const writeActivity = dependencies.writeActivity ?? logActivity;

  function assertAdminScope(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    assertInstanceAdmin(req);
  }

  router.get("/orgs/:orgId/side-chat-provider-cleanups/review-required", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertAdminScope(req, orgId);
    const rawLimit = req.query.limit;
    const parsedLimit = typeof rawLimit === "string" ? Number(rawLimit) : 50;
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(Math.floor(parsedLimit), 1), 200) : 50;
    const intents = await service.listReviewRequired(limit, orgId);
    res.json(intents.map((intent) => ({
      id: intent.id,
      conversationId: intent.conversationId,
      state: intent.state,
      stateReason: intent.stateReason,
      attemptCount: intent.attemptCount,
      createdAt: intent.createdAt,
      updatedAt: intent.updatedAt,
    })));
  });

  router.post("/orgs/:orgId/side-chat-provider-cleanups/:id/retry", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertAdminScope(req, orgId);
    const intentId = req.params.id as string;
    const actor = getActorInfo(req);
    const reopened = await service.retryReviewRequired({ orgId, intentId }, async (tx) => {
      await writeActivity(tx as unknown as Db, {
        orgId,
        ...actor,
        action: "side_chat.provider_cleanup_retry_requested",
        entityType: "side_chat_provider_cleanup_intent",
        entityId: intentId,
        details: { state: "pending" },
      });
    });
    if (!reopened) throw notFound("Side Chat Provider cleanup intent not found or not awaiting review");

    res.status(202).json({
      id: reopened.id,
      state: reopened.state,
      nextAttemptAt: reopened.nextAttemptAt,
    });
  });

  return router;
}
