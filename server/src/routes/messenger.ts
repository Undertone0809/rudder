import type { Db } from "@rudderhq/db";
import {
  MESSENGER_SYSTEM_THREAD_KINDS,
  assignMessengerCustomGroupEntrySchema,
  createMessengerCustomGroupSchema,
  reorderMessengerCustomGroupEntriesSchema,
  reorderMessengerCustomGroupsSchema,
  updateMessengerCustomGroupSchema,
  updateMessengerThreadUserStateSchema,
  type MessengerSystemThreadKind,
} from "@rudderhq/shared";
import { Router } from "express";
import { validate } from "../middleware/validate.js";
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
  if (threadKey.startsWith("issue:")) {
    return { kind: "issue" as const, issueId: threadKey.slice("issue:".length) };
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

  router.get("/orgs/:orgId/messenger/groups", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    res.json(await svc.listCustomGroups(orgId, userId));
  });

  router.post(
    "/orgs/:orgId/messenger/groups",
    validate(createMessengerCustomGroupSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const userId = boardUserId(req);
      res.status(201).json(await svc.createCustomGroup(orgId, userId, req.body.name, req.body.icon ?? null));
    },
  );

  router.patch(
    "/orgs/:orgId/messenger/groups/reorder",
    validate(reorderMessengerCustomGroupsSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const userId = boardUserId(req);
      res.json(await svc.reorderCustomGroups(orgId, userId, req.body.groupIds));
    },
  );

  router.patch(
    "/orgs/:orgId/messenger/groups/:groupId",
    validate(updateMessengerCustomGroupSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const userId = boardUserId(req);
      res.json(await svc.updateCustomGroup(orgId, userId, req.params.groupId as string, req.body));
    },
  );

  router.post("/orgs/:orgId/messenger/groups/:groupId/separate", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    res.json(await svc.separateCustomGroup(orgId, userId, req.params.groupId as string));
  });

  router.delete("/orgs/:orgId/messenger/groups/:groupId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    res.json(await svc.deleteCustomGroup(orgId, userId, req.params.groupId as string));
  });

  router.post(
    "/orgs/:orgId/messenger/groups/:groupId/entries",
    validate(assignMessengerCustomGroupEntrySchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const userId = boardUserId(req);
      res.status(201).json(await svc.assignThreadToCustomGroup(orgId, userId, req.params.groupId as string, req.body.threadKey));
    },
  );

  router.patch(
    "/orgs/:orgId/messenger/groups/:groupId/entries/reorder",
    validate(reorderMessengerCustomGroupEntriesSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const userId = boardUserId(req);
      res.json(await svc.reorderCustomGroupEntries(orgId, userId, req.params.groupId as string, req.body.threadKeys));
    },
  );

  router.delete("/orgs/:orgId/messenger/groups/entries/:threadKey", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    res.json(await svc.removeThreadFromCustomGroups(orgId, userId, req.params.threadKey as string));
  });

  router.get("/orgs/:orgId/messenger/threads", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    const hasPagingParams = typeof req.query.limit === "string" || typeof req.query.cursor === "string";
    const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    const splitIssues = req.query.splitIssues === "true";
    if (hasPagingParams) {
      res.json(await svc.listThreadSummaryPage(orgId, userId, {
        limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
        cursor,
        splitIssues,
      }));
      return;
    }
    const threads = await svc.listThreadSummaries(orgId, userId, { splitIssues });
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

  router.post(
    "/orgs/:orgId/messenger/threads/:threadKey/user-state",
    validate(updateMessengerThreadUserStateSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const userId = boardUserId(req);
      const threadKey = req.params.threadKey as string;
      const parsed = parseThreadKey(threadKey);
      if (!parsed) {
        res.status(404).json({ error: "Messenger thread not found" });
        return;
      }

      if (typeof req.body.pinned === "boolean") {
        const state = await svc.setThreadPinned(orgId, userId, threadKey, req.body.pinned);
        if (!state) {
          res.status(404).json({ error: "Messenger thread not found" });
          return;
        }
        res.json(state);
        return;
      }

      res.json({ threadKey });
    },
  );

  router.get("/orgs/:orgId/messenger/issues", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const userId = boardUserId(req);
    const rawLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
    res.json(await svc.getIssuesThread(orgId, userId, {
      cursor,
      limit: Number.isFinite(rawLimit) ? rawLimit : undefined,
    }));
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
