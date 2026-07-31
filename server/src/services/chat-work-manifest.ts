import {
  agents,
  assets,
  automations,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  chatMessages,
  chatWorkManifestItems,
  heartbeatRuns,
  issueComments,
  issues,
  organizationResources,
  projectResourceAttachments,
  type Db,
} from "@rudderhq/db";
import {
  chatInlineAnnotationsFromStructuredPayload,
  chatInlineVisualMappingsFromStructuredPayload,
  collectChatSubagentInspections,
  extractVisibleChatWorkTargets,
  isUuidLike,
  mergeChatSubagentSummaries,
  normalizeChatWorkExternalUrl,
  parseShortRef,
  preferChatWorkManifestCategory,
  rudderInlineVisualMappingsFromStructuredPayload,
  type ChatStreamTranscriptEntry,
  type ChatWorkManifestCategory,
  type ChatWorkManifestItem,
  type ChatWorkManifestResponse,
  type ChatWorkManifestSubagentSummary,
  type ChatWorkManifestTargetType,
} from "@rudderhq/shared";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";

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

function normalizeIssueAlias(value: string) {
  return value.trim().toLowerCase();
}

type ResolvedManifestIssue = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
};

function resolvedIssueMetadata(
  issue: ResolvedManifestIssue,
  metadata: Record<string, unknown> | null,
  commentId?: string,
) {
  const issueRef = issue.identifier ?? issue.id;
  return {
    ...(metadata ?? {}),
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    ref: issueRef,
    issueStatus: issue.status,
    ...(commentId ? { commentId } : {}),
  };
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

function legacyTranscriptFromPayload(
  payload: Record<string, unknown> | null,
): ChatStreamTranscriptEntry[] {
  const transcript = payload?.__chatTranscript;
  return Array.isArray(transcript) ? transcript as ChatStreamTranscriptEntry[] : [];
}

const ACTIVE_GENERATION_STATUSES = new Set([
  "starting",
  "active",
  "running",
  "tool_busy",
  "closing",
  "stop_requested",
  "stopping",
]);

export function chatWorkManifestService(db: Db) {
  async function getConversationSubagents(
    conversation: { id: string; orgId: string },
  ): Promise<ChatWorkManifestResponse["subagents"]> {
    const messages = await db
      .select({
        id: chatMessages.id,
        runId: chatMessages.runId,
        status: chatMessages.status,
        structuredPayload: chatMessages.structuredPayload,
        createdAt: chatMessages.createdAt,
        senderLabel: agents.name,
      })
      .from(chatMessages)
      .leftJoin(agents, and(
        eq(chatMessages.replyingAgentId, agents.id),
        eq(agents.orgId, conversation.orgId),
      ))
      .where(and(
        eq(chatMessages.orgId, conversation.orgId),
        eq(chatMessages.conversationId, conversation.id),
        eq(chatMessages.role, "assistant"),
        isNull(chatMessages.supersededAt),
      ))
      .orderBy(asc(chatMessages.createdAt));
    if (messages.length === 0) {
      return { active: [], done: [], totalCount: 0 };
    }

    const messageIds = messages.map((message) => message.id);
    const eventRows = await db
      .select({
        messageId: chatGenerationEvents.assistantMessageId,
        generationId: chatGenerationEvents.generationId,
        generationSeq: chatGenerationEvents.generationSeq,
        payload: chatGenerationEvents.payload,
        eventRunId: chatGenerationEvents.runId,
        generationStatus: chatGenerations.status,
        generationStartedAt: chatGenerations.startedAt,
      })
      .from(chatGenerationEvents)
      .innerJoin(chatGenerations, eq(chatGenerationEvents.generationId, chatGenerations.id))
      .where(and(
        eq(chatGenerationEvents.orgId, conversation.orgId),
        eq(chatGenerations.orgId, conversation.orgId),
        eq(chatGenerations.conversationId, conversation.id),
        inArray(chatGenerationEvents.assistantMessageId, messageIds),
        eq(chatGenerationEvents.eventKind, "transcript"),
        or(
          isNull(chatGenerations.acceptedThroughSeq),
          lte(chatGenerationEvents.generationSeq, chatGenerations.acceptedThroughSeq),
        ),
      ))
      .orderBy(
        asc(chatGenerations.startedAt),
        asc(chatGenerationEvents.generationSeq),
      );

    const nativeByMessageId = new Map<string, {
      generationId: string;
      generationStartedAt: Date;
      generationStatus: string;
      runId: string | null;
      entries: ChatStreamTranscriptEntry[];
    }>();
    for (const row of eventRows) {
      if (!row.messageId) continue;
      const entry = row.payload.entry;
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const current = nativeByMessageId.get(row.messageId);
      const belongsToNewerGeneration = !current
        || row.generationStartedAt.getTime() > current.generationStartedAt.getTime();
      if (belongsToNewerGeneration) {
        nativeByMessageId.set(row.messageId, {
          generationId: row.generationId,
          generationStartedAt: row.generationStartedAt,
          generationStatus: row.generationStatus,
          runId: row.eventRunId,
          entries: [entry as ChatStreamTranscriptEntry],
        });
        continue;
      }
      if (current.generationId !== row.generationId) continue;
      current.entries.push(entry as ChatStreamTranscriptEntry);
      current.runId = row.eventRunId ?? current.runId;
      current.generationStatus = row.generationStatus;
    }

    const summaries: ChatWorkManifestSubagentSummary[] = [];
    for (const message of messages) {
      const native = nativeByMessageId.get(message.id);
      const entries = native?.entries?.length
        ? native.entries
        : legacyTranscriptFromPayload(message.structuredPayload);
      if (entries.length === 0) continue;
      const sourceActive = native
        ? ACTIVE_GENERATION_STATUSES.has(native.generationStatus)
        : message.status === "streaming";
      const sourceTerminalStatus = native && !sourceActive
        ? native.generationStatus === "completed"
          ? "completed" as const
          : "stopped" as const
        : null;
      for (const inspection of collectChatSubagentInspections(entries, {
        sourceMessageId: message.id,
        runId: message.runId ?? native?.runId ?? null,
        sourceActive,
        sourceTerminalStatus,
        senderLabel: message.senderLabel,
      })) {
        const { response: _response, entries: _entries, ...summary } = inspection;
        summaries.push(summary);
      }
    }

    const merged = mergeChatSubagentSummaries(summaries);
    const byRecentUpdate = (left: ChatWorkManifestSubagentSummary, right: ChatWorkManifestSubagentSummary) =>
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    const active = merged.filter((item) => item.state === "active").sort(byRecentUpdate);
    const done = merged.filter((item) => item.state === "done").sort(byRecentUpdate);
    return { active, done, totalCount: active.length + done.length };
  }

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
    const visibleMessagesById = new Map(visibleMessages.map((message) => [message.id, message]));
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
    const primaryIssueAliases = new Set<string>();
    if (conversation.primaryIssueId) {
      const issue = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
        })
        .from(issues)
        .where(and(
          eq(issues.id, conversation.primaryIssueId),
          eq(issues.orgId, conversation.orgId),
        ))
        .then((rows) => rows[0] ?? null);
      if (issue) {
        primaryIssueAliases.add(normalizeIssueAlias(issue.id));
        if (issue.identifier) primaryIssueAliases.add(normalizeIssueAlias(issue.identifier));
        const issueContextLink = await db
          .select({ metadata: chatContextLinks.metadata })
          .from(chatContextLinks)
          .where(and(
            eq(chatContextLinks.orgId, conversation.orgId),
            eq(chatContextLinks.conversationId, conversationId),
            eq(chatContextLinks.entityType, "issue"),
            eq(chatContextLinks.entityId, issue.id),
          ))
          .then((rows) => rows[0] ?? null);
        const rawSourceMessageId = issueContextLink?.metadata?.sourceMessageId;
        const sourceMessage = typeof rawSourceMessageId === "string"
          ? visibleMessagesById.get(rawSourceMessageId) ?? null
          : null;
        const issueRef = issue.identifier ?? issue.id;
        mergeCandidate(candidates, {
          orgId: conversation.orgId,
          conversationId,
          projectId,
          messageId: sourceMessage?.id ?? null,
          runId: sourceMessage?.runId ?? null,
          category: "reference",
          targetType: "issue",
          targetKey: `issue:${issue.id}`,
          title: `${issueRef} · ${issue.title}`,
          url: null,
          status: "ready",
          sourceRole: sourceMessage?.role === "user" ? "user" : "assistant",
          createdByAgentId: issue.createdByAgentId,
          createdByUserId: issue.createdByUserId,
          metadata: resolvedIssueMetadata(issue, null),
        });
      }
    }
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
        const targetIssueId = typeof target.metadata.issueId === "string" ? target.metadata.issueId : null;
        const targetKey = target.targetType === "issue" && targetIssueId &&
          primaryIssueAliases.has(normalizeIssueAlias(targetIssueId))
          ? `issue:${conversation.primaryIssueId}`
          : target.targetKey;
        mergeCandidate(candidates, {
          orgId: conversation.orgId,
          conversationId,
          projectId,
          messageId: message.id,
          runId: message.runId,
          category: output ? "output" : rudderReference ? "reference" : role === "user" ? "source" : "reference",
          targetType: target.targetType,
          targetKey,
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

    const referencedIssueAliases = [...new Set(
      [...candidates.values()]
        .filter((candidate) => candidate.targetType === "issue" || candidate.targetType === "issue_comment")
        .map((candidate) => typeof candidate.metadata?.issueId === "string"
          ? candidate.metadata.issueId.trim()
          : "")
        .filter(Boolean),
    )];
    const referencedIssueIds = referencedIssueAliases.filter((alias) => isUuidLike(alias));
    const referencedIssueIdentifiers = referencedIssueAliases
      .filter((alias) => !isUuidLike(alias))
      .map((alias) => alias.toUpperCase());
    const issueSelection = {
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    };
    const [referencedIssuesById, referencedIssuesByIdentifier] = await Promise.all([
      referencedIssueIds.length > 0
        ? db
          .select(issueSelection)
          .from(issues)
          .where(and(
            eq(issues.orgId, conversation.orgId),
            inArray(issues.id, referencedIssueIds),
          ))
        : Promise.resolve([]),
      referencedIssueIdentifiers.length > 0
        ? db
          .select(issueSelection)
          .from(issues)
          .where(and(
            eq(issues.orgId, conversation.orgId),
            inArray(issues.identifier, referencedIssueIdentifiers),
          ))
        : Promise.resolve([]),
    ]);
    const issueByAlias = new Map<string, ResolvedManifestIssue>();
    for (const issue of [...referencedIssuesById, ...referencedIssuesByIdentifier]) {
      issueByAlias.set(normalizeIssueAlias(issue.id), issue);
      if (issue.identifier) issueByAlias.set(normalizeIssueAlias(issue.identifier), issue);
    }

    const issueCommentCandidates = [...candidates.values()]
      .filter((candidate) => candidate.targetType === "issue_comment")
      .map((candidate) => {
        const issueAlias = typeof candidate.metadata?.issueId === "string"
          ? candidate.metadata.issueId.trim()
          : "";
        const commentRef = typeof candidate.metadata?.commentId === "string"
          ? candidate.metadata.commentId.trim()
          : "";
        return {
          issue: issueByAlias.get(normalizeIssueAlias(issueAlias)) ?? null,
          commentRef,
          shortRef: parseShortRef(commentRef),
        };
      });
    const exactCommentIds = [...new Set(
      issueCommentCandidates
        .map(({ commentRef }) => commentRef)
        .filter((commentRef) => isUuidLike(commentRef)),
    )];
    const shortCommentPrefixes = [...new Set(
      issueCommentCandidates
        .map(({ shortRef }) => shortRef?.kind === "issue_comment" ? shortRef.prefix : "")
        .filter(Boolean),
    )];
    const candidateIssueIds = [...new Set(
      issueCommentCandidates
        .map(({ issue }) => issue?.id ?? "")
        .filter(Boolean),
    )];
    const commentReferenceConditions = [
      ...(exactCommentIds.length > 0 ? [inArray(issueComments.id, exactCommentIds)] : []),
      ...shortCommentPrefixes.map((prefix) =>
        sql<boolean>`lower(replace(cast(${issueComments.id} as text), '-', '')) like ${`${prefix}%`}`
      ),
    ];
    const referencedComments = candidateIssueIds.length > 0 && commentReferenceConditions.length > 0
      ? await db
        .select({ id: issueComments.id, issueId: issueComments.issueId })
        .from(issueComments)
        .where(and(
          eq(issueComments.orgId, conversation.orgId),
          inArray(issueComments.issueId, candidateIssueIds),
          isNull(issueComments.deletedAt),
          or(...commentReferenceConditions),
        ))
      : [];

    const hydratedCandidates = new Map<string, ManifestCandidate>();
    for (const candidate of candidates.values()) {
      if (candidate.targetType !== "issue" && candidate.targetType !== "issue_comment") {
        mergeCandidate(hydratedCandidates, candidate);
        continue;
      }
      const issueAlias = typeof candidate.metadata?.issueId === "string"
        ? candidate.metadata.issueId.trim()
        : "";
      const issue = issueByAlias.get(normalizeIssueAlias(issueAlias));
      if (!issue) {
        mergeCandidate(hydratedCandidates, candidate);
        continue;
      }
      const issueRef = issue.identifier ?? issue.id;
      if (candidate.targetType === "issue") {
        mergeCandidate(hydratedCandidates, {
          ...candidate,
          targetKey: `issue:${issue.id}`,
          title: `${issueRef} · ${issue.title}`,
          metadata: resolvedIssueMetadata(issue, candidate.metadata),
        });
        continue;
      }
      const commentRef = typeof candidate.metadata?.commentId === "string"
        ? candidate.metadata.commentId.trim()
        : "";
      const normalizedCommentRef = commentRef.toLowerCase();
      const shortRef = parseShortRef(commentRef);
      const commentMatches = referencedComments.filter((comment) =>
        comment.issueId === issue.id && (
          comment.id.toLowerCase() === normalizedCommentRef ||
          (shortRef?.kind === "issue_comment" &&
            comment.id.replaceAll("-", "").toLowerCase().startsWith(shortRef.prefix))
        )
      );
      if (commentMatches.length !== 1) {
        mergeCandidate(hydratedCandidates, candidate);
        continue;
      }
      const commentId = commentMatches[0]!.id;
      mergeCandidate(hydratedCandidates, {
        ...candidate,
        targetKey: `issue-comment:${issue.id}:${commentId}`,
        title: `${issueRef} · ${issue.title}`,
        metadata: resolvedIssueMetadata(issue, candidate.metadata, commentId),
      });
    }
    candidates.clear();
    for (const [targetKey, candidate] of hydratedCandidates) candidates.set(targetKey, candidate);

    const referencedAutomationIds = [...new Set(
      [...candidates.values()]
        .filter((candidate) => candidate.targetType === "automation")
        .map((candidate) => typeof candidate.metadata?.automationId === "string"
          ? candidate.metadata.automationId.trim()
          : "")
        .filter((automationId) => isUuidLike(automationId)),
    )];
    if (referencedAutomationIds.length > 0) {
      const referencedAutomations = await db
        .select({ id: automations.id, title: automations.title })
        .from(automations)
        .where(and(
          eq(automations.orgId, conversation.orgId),
          inArray(automations.id, referencedAutomationIds),
        ));
      const referencedAutomationTitles = new Map(
        referencedAutomations.map((automation) => [automation.id, automation.title]),
      );
      for (const candidate of candidates.values()) {
        if (candidate.targetType !== "automation") continue;
        const referencedAutomationId = typeof candidate.metadata?.automationId === "string"
          ? candidate.metadata.automationId.trim()
          : "";
        const referencedAutomationTitle = referencedAutomationTitles.get(referencedAutomationId);
        if (referencedAutomationTitle?.trim()) candidate.title = referencedAutomationTitle;
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

    const referencedConversationIds = [...new Set(
      [...candidates.values()]
        .filter((candidate) => candidate.targetType === "chat_conversation")
        .map((candidate) => typeof candidate.metadata?.conversationId === "string"
          ? candidate.metadata.conversationId.trim()
          : "")
        .filter((referencedConversationId) => isUuidLike(referencedConversationId)),
    )];
    if (referencedConversationIds.length > 0) {
      const referencedConversations = await db
        .select({ id: chatConversations.id, title: chatConversations.title })
        .from(chatConversations)
        .where(and(
          eq(chatConversations.orgId, conversation.orgId),
          ne(chatConversations.conversationKind, "side_chat"),
          inArray(chatConversations.id, referencedConversationIds),
        ));
      const referencedConversationTitles = new Map(
        referencedConversations.map((referencedConversation) => [
          referencedConversation.id,
          referencedConversation.title,
        ]),
      );
      for (const candidate of candidates.values()) {
        if (candidate.targetType !== "chat_conversation") continue;
        const referencedConversationId = typeof candidate.metadata?.conversationId === "string"
          ? candidate.metadata.conversationId.trim()
          : "";
        const referencedConversationTitle = referencedConversationTitles.get(referencedConversationId);
        if (referencedConversationTitle?.trim()) candidate.title = referencedConversationTitle;
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
      return {
        conversationId,
        totalCount: 0,
        outputs: [],
        sources: [],
        references: [],
        subagents: { active: [], done: [], totalCount: 0 },
        project: null,
      };
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
    const subagents = await getConversationSubagents(conversation);
    return {
      conversationId,
      totalCount: items.length,
      outputs: items.filter((item) => item.category === "output"),
      sources: items.filter((item) => item.category === "source"),
      references: items.filter((item) => item.category === "reference"),
      subagents,
      project: projectId ? { id: projectId, totalCount: projectTotal } : null,
    };
  }

  return { reconcileConversation, getConversationManifest };
}
