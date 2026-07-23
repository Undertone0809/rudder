import {
  assets,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatMessages,
  chatWorkManifestItems,
  heartbeatRuns,
  organizationResources,
  projectResourceAttachments,
  type Db,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  chatInlineVisualMappingsFromStructuredPayload,
  extractVisibleChatWorkTargets,
  normalizeChatWorkExternalUrl,
  preferChatWorkManifestCategory,
  rudderInlineVisualMappingsFromStructuredPayload,
  type ChatWorkManifestCategory,
  type ChatWorkManifestItem,
  type ChatWorkManifestResponse,
  type ChatWorkManifestTargetType,
} from "@rudderhq/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";

type ManifestCandidate = {
  orgId: string;
  conversationId: string;
  projectId: string | null;
  messageId: string | null;
  runId: string | null;
  category: ChatWorkManifestCategory;
  targetType: ChatWorkManifestTargetType;
  targetKey: string;
  title: string;
  url: string | null;
  status: "ready";
  sourceRole: "user" | "assistant" | "project";
  createdByAgentId: string | null;
  createdByUserId: string | null;
  metadata: Record<string, unknown> | null;
};

function artifactPath(metadata: Record<string, unknown>) {
  const path = typeof metadata.filePath === "string" ? metadata.filePath : "";
  return path.replace(/^\/+/, "").startsWith("artifacts/");
}

function mergeCandidate(targets: Map<string, ManifestCandidate>, candidate: ManifestCandidate) {
  const current = targets.get(candidate.targetKey);
  if (!current) {
    targets.set(candidate.targetKey, candidate);
    return;
  }
  const preferred = preferChatWorkManifestCategory(current.category, candidate.category);
  if (preferred === candidate.category && preferred !== current.category) {
    targets.set(candidate.targetKey, candidate);
  }
}

function asManifestItem(row: typeof chatWorkManifestItems.$inferSelect): ChatWorkManifestItem {
  return row as ChatWorkManifestItem;
}

export function chatWorkManifestService(db: Db) {
  async function reconcileConversation(conversationId: string) {
    const conversation = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.id, conversationId))
      .then((rows) => rows[0] ?? null);
    if (!conversation) return;

    const projectId = await db
      .select({ entityId: chatContextLinks.entityId })
      .from(chatContextLinks)
      .where(and(
        eq(chatContextLinks.orgId, conversation.orgId),
        eq(chatContextLinks.conversationId, conversationId),
        eq(chatContextLinks.entityType, "project"),
      ))
      .then((rows) => rows[0]?.entityId ?? null);

    const messages = await db
      .select()
      .from(chatMessages)
      .where(and(
        eq(chatMessages.orgId, conversation.orgId),
        eq(chatMessages.conversationId, conversationId),
        isNull(chatMessages.supersededAt),
        inArray(chatMessages.role, ["user", "assistant"]),
      ));
    const visibleMessages = messages.filter((message) =>
      message.role === "user" || message.status === "completed",
    );
    const messageIds = visibleMessages.map((message) => message.id);
    const attachmentRows = messageIds.length === 0 ? [] : await db
      .select({
        messageId: chatAttachments.messageId,
        attachmentId: chatAttachments.id,
        assetId: assets.id,
        originalFilename: assets.originalFilename,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        sha256: assets.sha256,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
      })
      .from(chatAttachments)
      .innerJoin(assets, eq(chatAttachments.assetId, assets.id))
      .where(and(
        eq(chatAttachments.orgId, conversation.orgId),
        eq(chatAttachments.conversationId, conversationId),
        inArray(chatAttachments.messageId, messageIds),
      ));
    const attachmentsByMessage = new Map<string, typeof attachmentRows>();
    for (const attachment of attachmentRows) {
      const list = attachmentsByMessage.get(attachment.messageId) ?? [];
      list.push(attachment);
      attachmentsByMessage.set(attachment.messageId, list);
    }
    const inlineVisualTargetKeys = new Set<string>();
    for (const message of visibleMessages) {
      const messageAttachments = attachmentsByMessage.get(message.id) ?? [];
      for (const mapping of chatInlineVisualMappingsFromStructuredPayload(message.structuredPayload)) {
        if (mapping.status !== "ready") continue;
        const attachment = messageAttachments.find((candidate) =>
          candidate.attachmentId === mapping.attachmentId
          && candidate.contentType === "text/html"
          && candidate.originalFilename === mapping.file
          && Boolean(candidate.createdByAgentId)
          && !candidate.createdByUserId
          && candidate.byteSize > 0
          && candidate.byteSize <= 2 * 1024 * 1024
        );
        if (attachment) inlineVisualTargetKeys.add(`asset:${attachment.assetId}`);
      }
      for (const mapping of rudderInlineVisualMappingsFromStructuredPayload(message.structuredPayload)) {
        if (mapping.status !== "ready") continue;
        const attachment = messageAttachments.find((candidate) =>
          candidate.attachmentId === mapping.attachmentId
          && candidate.contentType === mapping.contentType
          && candidate.originalFilename === mapping.file
          && candidate.byteSize === mapping.byteSize
          && candidate.sha256.toLowerCase() === mapping.sha256
          && Boolean(candidate.createdByAgentId)
          && !candidate.createdByUserId
        );
        if (attachment) inlineVisualTargetKeys.add(`asset:${attachment.assetId}`);
      }
    }

    const candidates = new Map<string, ManifestCandidate>();
    for (const message of visibleMessages) {
      const role = message.role as "user" | "assistant";
      const annotationAttachmentIds = new Set(
        chatInlineAnnotationsFromStructuredPayload(message.structuredPayload)
          .flatMap((annotation) => annotation.attachmentIds),
      );
      for (const target of extractVisibleChatWorkTargets(message.body)) {
        const output = role === "assistant" && Boolean(message.runId) &&
          (target.targetType === "library_entry" || target.targetType === "library_file") &&
          artifactPath(target.metadata);
        const rudderReference = target.targetType === "issue" ||
          target.targetType === "issue_comment" ||
          target.targetType === "automation" ||
          target.targetType === "chat_conversation";
        mergeCandidate(candidates, {
          orgId: conversation.orgId,
          conversationId,
          projectId,
          messageId: message.id,
          runId: message.runId,
          category: output ? "output" : rudderReference ? "reference" : role === "user" ? "source" : "reference",
          targetType: target.targetType,
          targetKey: target.targetKey,
          title: target.title,
          url: target.url,
          status: "ready",
          sourceRole: role,
          createdByAgentId: role === "assistant" ? message.replyingAgentId : null,
          createdByUserId: role === "user" ? conversation.createdByUserId : null,
          metadata: target.metadata,
        });
      }
      for (const attachment of attachmentsByMessage.get(message.id) ?? []) {
        if (annotationAttachmentIds.has(attachment.attachmentId)) continue;
        if (inlineVisualTargetKeys.has(`asset:${attachment.assetId}`)) continue;
        const output = role === "assistant" && Boolean(attachment.createdByAgentId);
        mergeCandidate(candidates, {
          orgId: conversation.orgId,
          conversationId,
          projectId,
          messageId: message.id,
          runId: message.runId,
          category: output ? "output" : "source",
          targetType: "attachment",
          targetKey: `asset:${attachment.assetId}`,
          title: attachment.originalFilename ?? "Attachment",
          url: null,
          status: "ready",
          sourceRole: role,
          createdByAgentId: attachment.createdByAgentId,
          createdByUserId: attachment.createdByUserId,
          metadata: { assetId: attachment.assetId, contentType: attachment.contentType },
        });
      }
    }

    if (projectId) {
      const projectRuns = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.orgId, conversation.orgId),
          eq(heartbeatRuns.chatConversationId, conversationId),
        ));
      const projectWasEligible = projectRuns.some((run) => run.contextSnapshot?.projectId === projectId);
      if (projectWasEligible) {
        const resources = await db
          .select({
            id: organizationResources.id,
            name: organizationResources.name,
            kind: organizationResources.kind,
            sourceType: organizationResources.sourceType,
            locator: organizationResources.locator,
            description: organizationResources.description,
          })
          .from(projectResourceAttachments)
          .innerJoin(organizationResources, eq(projectResourceAttachments.resourceId, organizationResources.id))
          .where(and(
            eq(projectResourceAttachments.orgId, conversation.orgId),
            eq(projectResourceAttachments.projectId, projectId),
          ));
        for (const resource of resources) {
          mergeCandidate(candidates, {
            orgId: conversation.orgId,
            conversationId,
            projectId,
            messageId: null,
            runId: null,
            category: "source",
            targetType: "project_resource",
            targetKey: `project-resource:${resource.id}`,
            title: resource.name,
            url: normalizeChatWorkExternalUrl(resource.locator),
            status: "ready",
            sourceRole: "project",
            createdByAgentId: null,
            createdByUserId: null,
            metadata: {
              resourceId: resource.id,
              kind: resource.kind,
              sourceType: resource.sourceType,
              locator: resource.locator,
              description: resource.description,
            },
          });
        }
      }
    }

    await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(chatWorkManifestItems)
        .where(and(
          eq(chatWorkManifestItems.orgId, conversation.orgId),
          eq(chatWorkManifestItems.conversationId, conversationId),
        ));
      const existingByKey = new Map(existing.map((row) => [row.targetKey, row]));
      for (const row of existing) {
        const candidate = candidates.get(row.targetKey);
        if (
          row.category === "output"
          && !inlineVisualTargetKeys.has(row.targetKey)
          && (!candidate || candidate.category !== "output")
        ) {
          candidates.set(row.targetKey, {
            orgId: row.orgId,
            conversationId: row.conversationId,
            projectId: row.projectId,
            messageId: row.messageId,
            runId: row.runId,
            category: "output",
            targetType: row.targetType as ChatWorkManifestTargetType,
            targetKey: row.targetKey,
            title: row.title,
            url: row.url,
            status: "ready",
            sourceRole: (row.sourceRole ?? "assistant") as "user" | "assistant" | "project",
            createdByAgentId: row.createdByAgentId,
            createdByUserId: row.createdByUserId,
            metadata: row.metadata,
          });
        }
      }
      const staleIds = existing
        .filter((row) => !candidates.has(row.targetKey))
        .map((row) => row.id);
      if (staleIds.length > 0) {
        await tx.delete(chatWorkManifestItems).where(inArray(chatWorkManifestItems.id, staleIds));
      }
      const now = new Date();
      for (const candidate of candidates.values()) {
        const row = existingByKey.get(candidate.targetKey);
        if (row) {
          await tx.update(chatWorkManifestItems).set({ ...candidate, updatedAt: now }).where(eq(chatWorkManifestItems.id, row.id));
        } else {
          await tx.insert(chatWorkManifestItems).values(candidate);
        }
      }
    });
  }

  async function getConversationManifest(conversationId: string): Promise<ChatWorkManifestResponse> {
    const conversation = await db
      .select({ id: chatConversations.id, orgId: chatConversations.orgId })
      .from(chatConversations)
      .where(eq(chatConversations.id, conversationId))
      .then((rows) => rows[0] ?? null);
    if (!conversation) {
      return { conversationId, totalCount: 0, outputs: [], sources: [], references: [], project: null };
    }
    const rows = await db
      .select()
      .from(chatWorkManifestItems)
      .where(and(
        eq(chatWorkManifestItems.orgId, conversation.orgId),
        eq(chatWorkManifestItems.conversationId, conversationId),
      ))
      .orderBy(chatWorkManifestItems.createdAt);
    const current = rows.filter((row) => row.sourceRole !== "project");
    const projectId = await db
      .select({ entityId: chatContextLinks.entityId })
      .from(chatContextLinks)
      .where(and(
        eq(chatContextLinks.orgId, conversation.orgId),
        eq(chatContextLinks.conversationId, conversationId),
        eq(chatContextLinks.entityType, "project"),
      ))
      .then((links) => links[0]?.entityId ?? rows.find((row) => row.projectId)?.projectId ?? null);
    const projectTotal = projectId ? await db
      .select({ targetKey: chatWorkManifestItems.targetKey })
      .from(chatWorkManifestItems)
      .where(and(
        eq(chatWorkManifestItems.orgId, conversation.orgId),
        eq(chatWorkManifestItems.projectId, projectId),
      ))
      .then((projectRows) => new Set(projectRows.map((row) => row.targetKey)).size) : 0;
    const items = current.map(asManifestItem);
    return {
      conversationId,
      totalCount: items.length,
      outputs: items.filter((item) => item.category === "output"),
      sources: items.filter((item) => item.category === "source"),
      references: items.filter((item) => item.category === "reference"),
      project: projectId ? { id: projectId, totalCount: projectTotal } : null,
    };
  }

  return { reconcileConversation, getConversationManifest };
}
