import { convertChatToIssueSchema, createChatContextLinkSchema, resolveChatOperationProposalSchema, setChatProjectContextSchema, type ChatConversation } from "@rudderhq/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { getActorInfo } from "./authz.js";
import { wakeIssueAssigneeAfterChatConversion } from "./chat-issue-assignment-wakeup.js";
import type { ChatStreamRouteContext } from "./chats.stream-support.js";

export function registerChatContextActionRoutes(ctx: ChatStreamRouteContext) {
  const { router, db, svc, assistantSvc, goalsSvc, heartbeat, assertConversationAccess,
    assertChatLocalMutationAllowed, assertSideChatMutationAllowed,
    assertContextLinksBelongToCompany, assertCanConvertIssueProposal } = ctx;

  router.post("/chats/:id/context-links", validate(createChatContextLinkSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    await assertContextLinksBelongToCompany(conversation.orgId, [req.body]);
    const linked = await svc.addContextLink(conversation.id, conversation.orgId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.context_linked",
      entityType: "chat",
      entityId: conversation.id,
      details: req.body,
    });
    res.status(201).json(linked);
  });

  router.post("/chats/:id/project-context", validate(setChatProjectContextSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const projectId = req.body.projectId ?? null;
    if (projectId) {
      await assertContextLinksBelongToCompany(conversation.orgId, [{
        entityType: "project",
        entityId: projectId,
      }]);
    }
    const messages = await svc.listMessages(conversation.id);
    if (messages.length > 0) {
      res.status(409).json({ error: "Project context is locked after conversation starts" });
      return;
    }

    const updated = await svc.setProjectContextLink(conversation.id, conversation.orgId, projectId);
    if (!updated) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.project_context_updated",
      entityType: "chat",
      entityId: conversation.id,
      details: { projectId },
    });
    res.json(updated);
  });

  router.post("/chats/:id/convert-to-issue", validate(convertChatToIssueSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const actor = getActorInfo(req);
    if (req.body.proposal?.goalId) {
      const goal = await goalsSvc.getById(req.body.proposal.goalId);
      if (!goal || goal.orgId !== conversation.orgId) {
        res.status(422).json({ error: "Goal must belong to the same organization" });
        return;
      }
    }
    await assertCanConvertIssueProposal(req, conversation as ChatConversation, {
      messageId: req.body.messageId ?? null,
      proposal: req.body.proposal ?? null,
    });
    const issue = await svc.convertToIssue(conversation.id, {
      actorUserId: actor.actorType === "user" ? actor.actorId : null,
      messageId: req.body.messageId ?? null,
      proposal: req.body.proposal ?? null,
    });
    await wakeIssueAssigneeAfterChatConversion({
      db,
      heartbeat,
      issue,
      reason: "issue_assigned",
      mutation: "chat_convert",
      contextSource: "chat.convert_to_issue",
      requestedByActorType: actor.actorType,
      requestedByActorId: actor.actorId,
    });
    const systemMessage = await svc.addMessage(conversation.id, {
      orgId: conversation.orgId,
      role: "system",
      kind: "system_event",
      body: `Created issue ${issue.identifier ?? issue.id} from this chat conversation.`,
      structuredPayload: {
        eventType: "issue_created",
        issueId: issue.id,
        issueIdentifier: issue.identifier,
      },
    });
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.issue_converted",
      entityType: "chat",
      entityId: conversation.id,
      details: {
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        messageId: req.body.messageId ?? null,
        systemMessageId: systemMessage.id,
      },
    });
    res.status(201).json({ issue, systemMessage });
  });

  router.post(
    "/chats/:id/messages/:messageId/operation-proposal/resolve",
    validate(resolveChatOperationProposalSchema),
    async (req, res) => {
      const conversation = await assertConversationAccess(req, req.params.id as string);
      if (!conversation) {
        res.status(404).json({ error: "Chat conversation not found" });
        return;
      }
      assertChatLocalMutationAllowed(conversation as ChatConversation);
      await assertSideChatMutationAllowed(req, conversation as ChatConversation);

      const actor = getActorInfo(req);
      const messageId = req.params.messageId as string;
      const resolved = await svc.resolveOperationProposal(conversation.id, messageId, {
        action: req.body.action,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
        decisionNote: req.body.decisionNote ?? null,
      });
      res.status(201).json(resolved);
    },
  );

  router.post("/chats/:id/resolve", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const actor = getActorInfo(req);
    const resolved = await svc.resolve(conversation.id, {
      actorType: actor.actorType === "user" ? "human" : actor.actorType,
      actorId: actor.actorId,
    });
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.resolved",
      entityType: "chat",
      entityId: conversation.id,
    });
    res.json(resolved ? await assistantSvc.enrichConversation(resolved as ChatConversation) : null);
  });
}
