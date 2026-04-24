import { Router } from "express";
import type { Db } from "@rudderhq/db";
import { MESSENGER_SYSTEM_THREAD_KINDS, type MessengerSystemThreadKind } from "@rudderhq/shared";
import { messengerService } from "../services/messenger.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const SYSTEM_THREAD_KIND_SET = new Set<MessengerSystemThreadKind>(MESSENGER_SYSTEM_THREAD_KINDS);

function boardUserId(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  return req.actor.userId ?? "local-board";
}

function parseThreadKey(threadKey: string) {
  if (threadKey.startsWith("chat:")) {
    return { kind: "chat" as const, conversationId: threadKey.slice("chat:".length) };
  }
  if (threadKey === "issues") return { kind: "issues" as const };
  if (threadKey === "approvals") return { kind: "approvals" as const };
  if (SYSTEM_THREAD_KIND_SET.has(threadKey as MessengerSystemThreadKind)) {
    return { kind: "system" as const, threadKind: threadKey as MessengerSystemThreadKind };
  }
  return null;
}

export function messengerRoutes(db: Db) {
  const router = Router();
  const svc = messengerService(db);

  router.get("/orgs/:orgId/messenger/threads", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    const threads = await svc.listThreadSummaries(orgId, userId);
    res.json(threads);
  });

  router.get("/orgs/:orgId/messenger/chat/:conversationId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    const thread = await svc.getChatThread(req.params.conversationId as string, userId);
    if (!thread) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertCompanyAccess(req, thread.conversation.orgId);
    if (thread.conversation.orgId !== orgId) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    res.json(thread);
  });

  router.post("/orgs/:orgId/messenger/threads/:threadKey/read", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    const threadKey = req.params.threadKey as string;
    const parsed = parseThreadKey(threadKey);
    if (!parsed) {
      res.status(404).json({ error: "Messenger thread not found" });
      return;
    }

    const requestedReadAt =
      typeof req.body?.lastReadAt === "string" && !Number.isNaN(new Date(req.body.lastReadAt).getTime())
        ? new Date(req.body.lastReadAt)
        : null;

    if (parsed.kind === "chat") {
      const thread = await svc.getChatThread(parsed.conversationId, userId);
      if (!thread || thread.conversation.orgId !== orgId) {
        res.status(404).json({ error: "Chat conversation not found" });
        return;
      }
      const state = await svc.setThreadRead(orgId, userId, threadKey, thread.conversation.lastMessageAt ?? new Date());
      if (!state) {
        res.status(404).json({ error: "Messenger thread not found" });
        return;
      }
      res.json({ threadKey, lastReadAt: state.lastReadAt });
      return;
    }

    const state = await svc.setThreadRead(orgId, userId, threadKey, requestedReadAt ?? new Date());
    if (!state) {
      res.status(404).json({ error: "Messenger thread not found" });
      return;
    }
    res.json({ threadKey, lastReadAt: state.lastReadAt });
  });

  router.get("/orgs/:orgId/messenger/issues", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    res.json(await svc.getIssuesThread(orgId, userId));
  });

  router.get("/orgs/:orgId/messenger/approvals", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    res.json(await svc.getApprovalsThread(orgId, userId));
  });

  router.get("/orgs/:orgId/messenger/system/:threadKind", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    const threadKind = req.params.threadKind as MessengerSystemThreadKind;
    if (!SYSTEM_THREAD_KIND_SET.has(threadKind)) {
      res.status(404).json({ error: "Messenger system thread not found" });
      return;
    }
    res.json(await svc.getSystemThread(orgId, userId, threadKind));
  });

  return router;
}
