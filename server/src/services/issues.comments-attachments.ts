import type { Db } from "@rudderhq/db";
import {
  agents,
  assets,
  issueAttachments,
  issueComments,
  issues,
  projects
} from "@rudderhq/db";
import {
  buildAgentMentionHref,
  extractAgentWakeMentionIds,
  extractProjectMentionIds,
  isUuidLike,
  parseAgentMentionHref,
  parseShortRef,
  shortRefFor
} from "@rudderhq/shared";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { redactCurrentUserText } from "../log-redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import { normalizeLocalLibraryPathMarkdown } from "./library-path-markdown.js";

import { MAX_ISSUE_COMMENT_PAGE_LIMIT } from "./issues.helpers.js";

type IssueCommentAttachmentMethodContext = {
  db: Db;
  instanceSettings: ReturnType<typeof instanceSettingsService>;
  redactIssueComment: <T extends { body: string }>(comment: T, censorUsernameInLogs: boolean) => T;
};

export function createIssueCommentAttachmentMethods(ctx: IssueCommentAttachmentMethodContext) {
  const { db, instanceSettings, redactIssueComment } = ctx;
  function serializeCommentForResponse<T extends { id?: string; body: string; deletedAt?: Date | string | null }>(
    comment: T,
    censorUsernameInLogs: boolean,
  ): T & { shortRef?: string } {
    const redacted = redactIssueComment(comment, censorUsernameInLogs);
    const withShortRef = "id" in redacted && typeof redacted.id === "string"
      ? { ...redacted, shortRef: shortRefFor("issue_comment", redacted.id) }
      : redacted;
    if (!withShortRef.deletedAt) return withShortRef;
    return { ...withShortRef, body: "" };
  }

  async function getMutableUserComment(issueId: string, commentId: string, userId: string) {
    const issue = await db
      .select({ id: issues.id, orgId: issues.orgId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const comment = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.id, commentId),
          eq(issueComments.issueId, issue.id),
          eq(issueComments.orgId, issue.orgId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!comment) throw notFound("Comment not found");
    if (comment.deletedAt) throw forbidden("Deleted comments cannot be modified");
    if (comment.authorAgentId || !comment.authorUserId || comment.authorUserId !== userId) {
      throw forbidden("Only the comment author can modify this comment");
    }

    return { issue, comment };
  }

  async function getDeletableComment(
    issueId: string,
    commentId: string,
    actor: { userId: string; allowAgentAuthored?: boolean },
  ) {
    const issue = await db
      .select({ id: issues.id, orgId: issues.orgId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!issue) throw notFound("Issue not found");

    const comment = await db
      .select()
      .from(issueComments)
      .where(
        and(
          eq(issueComments.id, commentId),
          eq(issueComments.issueId, issue.id),
          eq(issueComments.orgId, issue.orgId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!comment) throw notFound("Comment not found");
    if (comment.deletedAt) throw forbidden("Deleted comments cannot be modified");

    const ownsUserComment = !comment.authorAgentId && !!comment.authorUserId && comment.authorUserId === actor.userId;
    const canDeleteAgentComment = actor.allowAgentAuthored === true && !!comment.authorAgentId;
    if (!ownsUserComment && !canDeleteAgentComment) {
      throw forbidden("Only the comment author or a board user deleting an agent comment can delete this comment");
    }

    return { issue, comment };
  }

  function replaceOutsideMarkdownCode(
    body: string,
    replace: (segment: string) => string,
  ): string {
    return body
      .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
      .map((segment) => segment.startsWith("`") ? segment : replace(segment))
      .join("");
  }

  function resolveAgentShortRefInRows(
    rows: Array<{ id: string }>,
    agentRef: string,
  ): string | null {
    const shortRef = parseShortRef(agentRef);
    if (shortRef?.kind !== "agent") return null;
    const matches = rows.filter((agent) =>
      agent.id.replace(/-/g, "").toLowerCase().startsWith(shortRef.prefix));
    if (matches.length > 1) {
      throw conflict("Agent short ref is ambiguous in this organization. Use the agent ID.");
    }
    return matches[0]?.id ?? null;
  }

  async function canonicalizeAgentWakeMentions(orgId: string, body: string): Promise<string> {
    const wakeRefs = extractAgentWakeMentionIds(body);
    if (!wakeRefs.some((ref) => parseShortRef(ref)?.kind === "agent")) return body;

    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.orgId, orgId));
    const resolved = new Map<string, string>();
    for (const ref of wakeRefs) {
      const parsed = parseShortRef(ref);
      if (parsed?.kind !== "agent") continue;
      const agentId = resolveAgentShortRefInRows(rows, ref);
      if (!agentId) throw notFound("Agent short ref not found in this organization");
      resolved.set(parsed.ref, agentId);
    }

    return replaceOutsideMarkdownCode(body, (segment) =>
      segment.replace(/(\[[^\]]*]\()(agent:\/\/[^)\s]+)(\))/gi, (match, open: string, href: string, close: string) => {
        const parsed = parseAgentMentionHref(href);
        if (parsed?.intent !== "wake") return match;
        const shortRef = parseShortRef(parsed.agentId);
        const agentId = shortRef ? resolved.get(shortRef.ref) : null;
        if (!agentId) return match;
        return `${open}${buildAgentMentionHref(agentId, null, "wake")}${close}`;
      }),
    );
  }

  async function resolveCommentReference(issueId: string, commentRef: string): Promise<string> {
    const trimmed = commentRef.trim();
    if (isUuidLike(trimmed)) {
      const comment = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(and(eq(issueComments.id, trimmed), eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)))
        .then((rows) => rows[0] ?? null);
      if (!comment) throw notFound("Issue comment not found");
      return comment.id;
    }

    const shortRef = parseShortRef(trimmed);
    if (shortRef?.kind !== "issue_comment") return trimmed;

    const rows = await db
      .select({ id: issueComments.id })
      .from(issueComments)
      .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)));
    const matches = rows.filter((comment) =>
      comment.id.replace(/-/g, "").toLowerCase().startsWith(shortRef.prefix));
    if (matches.length > 1) {
      throw conflict("Issue comment short ref is ambiguous for this issue. Use the comment ID.");
    }
    const match = matches[0];
    if (!match) throw notFound("Issue comment not found");
    return match.id;
  }

  return {
    findMentionedAgents: async (orgId: string, body: string) => {
      const explicitAgentMentionRefs = extractAgentWakeMentionIds(body);
      if (explicitAgentMentionRefs.length === 0) return [];

      const rows = await db.select({ id: agents.id, name: agents.name })
        .from(agents).where(eq(agents.orgId, orgId));
      const orgAgentIds = new Set(rows.map((agent) => agent.id));
      const resolved = new Set<string>();
      for (const agentRef of explicitAgentMentionRefs) {
        if (isUuidLike(agentRef)) {
          if (orgAgentIds.has(agentRef)) resolved.add(agentRef);
          continue;
        }
        const agentId = resolveAgentShortRefInRows(rows, agentRef);
        if (agentId) resolved.add(agentId);
      }
      return [...resolved];
    },

    findMentionedProjectIds: async (issueId: string) => {
      const issue = await db
        .select({
          orgId: issues.orgId,
          title: issues.title,
          description: issues.description,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) return [];

      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)));

      const mentionedIds = new Set<string>();
      for (const source of [
        issue.title,
        issue.description ?? "",
        ...comments.map((comment) => comment.body),
      ]) {
        for (const projectId of extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }
      if (mentionedIds.size === 0) return [];

      const validMentionedIds = [...mentionedIds].filter(isUuidLike);
      if (validMentionedIds.length === 0) return [];

      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, issue.orgId),
            inArray(projects.id, validMentionedIds),
          ),
        );
      const valid = new Set(rows.map((row) => row.id));
      return validMentionedIds.filter((projectId) => valid.has(projectId));
    },
    listComments: async (
      issueId: string,
      opts?: {
        afterCommentId?: string | null;
        order?: "asc" | "desc";
        limit?: number | null;
      },
    ) => {
      const order = opts?.order === "asc" ? "asc" : "desc";
      const afterCommentId = opts?.afterCommentId?.trim() || null;
      const limit =
        opts?.limit && opts.limit > 0
          ? Math.min(Math.floor(opts.limit), MAX_ISSUE_COMMENT_PAGE_LIMIT)
          : null;

      const conditions = [eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)];
      if (afterCommentId) {
        const resolvedAfterCommentId = isUuidLike(afterCommentId)
          ? afterCommentId
          : await resolveCommentReference(issueId, afterCommentId);
        const anchor = await db
          .select({
            id: issueComments.id,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(
            and(
              eq(issueComments.issueId, issueId),
              eq(issueComments.id, resolvedAfterCommentId),
              isNull(issueComments.deletedAt),
            ),
          )
          .then((rows) => rows[0] ?? null);

        if (!anchor) return [];
        const anchorCreatedAt = anchor.createdAt instanceof Date
          ? anchor.createdAt.toISOString()
          : new Date(anchor.createdAt).toISOString();
        conditions.push(
          order === "asc"
            ? sql<boolean>`(
                ${issueComments.createdAt} > ${anchorCreatedAt}
                OR (${issueComments.createdAt} = ${anchorCreatedAt} AND ${issueComments.id} > ${anchor.id})
              )`
            : sql<boolean>`(
                ${issueComments.createdAt} < ${anchorCreatedAt}
                OR (${issueComments.createdAt} = ${anchorCreatedAt} AND ${issueComments.id} < ${anchor.id})
              )`,
        );
      }

      const query = db
        .select()
        .from(issueComments)
        .where(and(...conditions))
        .orderBy(
          order === "asc" ? asc(issueComments.createdAt) : desc(issueComments.createdAt),
          order === "asc" ? asc(issueComments.id) : desc(issueComments.id),
        );

      const comments = limit ? await query.limit(limit) : await query;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return comments.map((comment) => serializeCommentForResponse(comment, censorUsernameInLogs));
    },

    getCommentCursor: async (issueId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: issueComments.id,
            latestCommentAt: issueComments.createdAt,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)))
          .orderBy(desc(issueComments.createdAt), desc(issueComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: sql<number>`count(*)::int`,
          })
          .from(issueComments)
          .where(and(eq(issueComments.issueId, issueId), isNull(issueComments.deletedAt)))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },

    resolveCommentReference,

    getComment: (commentId: string) =>
      instanceSettings.getGeneral().then(({ censorUsernameInLogs }) =>
        db
        .select()
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .then((rows) => {
          const comment = rows[0] ?? null;
          return comment ? serializeCommentForResponse(comment, censorUsernameInLogs) : null;
        })),

    addComment: async (issueId: string, body: string, actor: { agentId?: string; userId?: string }) => {
      const issue = await db
        .select({ orgId: issues.orgId })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);

      if (!issue) throw notFound("Issue not found");

      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const durableBody = actor.agentId
        ? await normalizeLocalLibraryPathMarkdown(body, issue.orgId)
        : body;
      const canonicalBody = await canonicalizeAgentWakeMentions(issue.orgId, durableBody);
      const redactedBody = redactCurrentUserText(canonicalBody, currentUserRedactionOptions);
      const [comment] = await db
        .insert(issueComments)
        .values({
          orgId: issue.orgId,
          issueId,
          authorAgentId: actor.agentId ?? null,
          authorUserId: actor.userId ?? null,
          body: redactedBody,
        })
        .returning();

      // Update issue's updatedAt so comment activity is reflected in recency sorting
      await db
        .update(issues)
        .set({ updatedAt: new Date() })
        .where(eq(issues.id, issueId));

      return serializeCommentForResponse(comment, currentUserRedactionOptions.enabled);
    },

    updateComment: async (issueId: string, commentId: string, body: string, actor: { userId: string }) => {
      const { issue } = await getMutableUserComment(issueId, commentId, actor.userId);
      const currentUserRedactionOptions = {
        enabled: (await instanceSettings.getGeneral()).censorUsernameInLogs,
      };
      const canonicalBody = await canonicalizeAgentWakeMentions(issue.orgId, body);
      const redactedBody = redactCurrentUserText(canonicalBody, currentUserRedactionOptions);
      const now = new Date();
      const [comment] = await db
        .update(issueComments)
        .set({
          body: redactedBody,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueComments.id, commentId),
            eq(issueComments.issueId, issue.id),
            eq(issueComments.orgId, issue.orgId),
            isNull(issueComments.deletedAt),
          ),
        )
        .returning();

      if (!comment) throw notFound("Comment not found");

      await db
        .update(issues)
        .set({ updatedAt: now })
        .where(eq(issues.id, issueId));

      return serializeCommentForResponse(comment, currentUserRedactionOptions.enabled);
    },

    deleteComment: async (
      issueId: string,
      commentId: string,
      actor: { userId: string; allowAgentAuthored?: boolean },
    ) => {
      const { issue } = await getDeletableComment(issueId, commentId, actor);
      const now = new Date();
      const [comment] = await db
        .update(issueComments)
        .set({
          deletedAt: now,
          deletedByUserId: actor.userId,
          updatedAt: now,
        })
        .where(
          and(
            eq(issueComments.id, commentId),
            eq(issueComments.issueId, issue.id),
            eq(issueComments.orgId, issue.orgId),
            isNull(issueComments.deletedAt),
          ),
        )
        .returning();

      if (!comment) throw notFound("Comment not found");

      await db
        .update(issues)
        .set({ updatedAt: now })
        .where(eq(issues.id, issueId));

      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      return serializeCommentForResponse(comment, censorUsernameInLogs);
    },

    createAttachment: async (input: {
      issueId: string;
      issueCommentId?: string | null;
      usage?: string;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const issue = await db
        .select({ id: issues.id, orgId: issues.orgId })
        .from(issues)
        .where(eq(issues.id, input.issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");

      if (input.issueCommentId) {
        const comment = await db
          .select({ id: issueComments.id, orgId: issueComments.orgId, issueId: issueComments.issueId })
          .from(issueComments)
          .where(eq(issueComments.id, input.issueCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw notFound("Issue comment not found");
        if (comment.orgId !== issue.orgId || comment.issueId !== issue.id) {
          throw unprocessable("Attachment comment must belong to same issue and organization");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(assets)
          .values({
            orgId: issue.orgId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(issueAttachments)
          .values({
            orgId: issue.orgId,
            issueId: issue.id,
            assetId: asset.id,
            issueCommentId: input.issueCommentId ?? null,
            usage: input.usage ?? "issue",
          })
          .returning();

        return {
          id: attachment.id,
          orgId: attachment.orgId,
          issueId: attachment.issueId,
          issueCommentId: attachment.issueCommentId,
          assetId: attachment.assetId,
          usage: attachment.usage,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },

    listAttachments: async (issueId: string) =>
      db
        .select({
          id: issueAttachments.id,
          orgId: issueAttachments.orgId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          usage: issueAttachments.usage,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(and(eq(issueAttachments.issueId, issueId), eq(issueAttachments.usage, "issue")))
        .orderBy(desc(issueAttachments.createdAt)),

    getAttachmentById: async (id: string) =>
      db
        .select({
          id: issueAttachments.id,
          orgId: issueAttachments.orgId,
          issueId: issueAttachments.issueId,
          issueCommentId: issueAttachments.issueCommentId,
          assetId: issueAttachments.assetId,
          usage: issueAttachments.usage,
          provider: assets.provider,
          objectKey: assets.objectKey,
          contentType: assets.contentType,
          byteSize: assets.byteSize,
          sha256: assets.sha256,
          originalFilename: assets.originalFilename,
          createdByAgentId: assets.createdByAgentId,
          createdByUserId: assets.createdByUserId,
          createdAt: issueAttachments.createdAt,
          updatedAt: issueAttachments.updatedAt,
        })
        .from(issueAttachments)
        .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
        .where(eq(issueAttachments.id, id))
        .then((rows) => rows[0] ?? null),

    removeAttachment: async (id: string) =>
      db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: issueAttachments.id,
            orgId: issueAttachments.orgId,
            issueId: issueAttachments.issueId,
            issueCommentId: issueAttachments.issueCommentId,
            assetId: issueAttachments.assetId,
            usage: issueAttachments.usage,
            provider: assets.provider,
            objectKey: assets.objectKey,
            contentType: assets.contentType,
            byteSize: assets.byteSize,
            sha256: assets.sha256,
            originalFilename: assets.originalFilename,
            createdByAgentId: assets.createdByAgentId,
            createdByUserId: assets.createdByUserId,
            createdAt: issueAttachments.createdAt,
            updatedAt: issueAttachments.updatedAt,
          })
          .from(issueAttachments)
          .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
          .where(eq(issueAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(issueAttachments).where(eq(issueAttachments.id, id));
        await tx.delete(assets).where(eq(assets.id, existing.assetId));
        return existing;
      }),
  };
}
