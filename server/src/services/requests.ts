import { createHash } from "node:crypto";
import type { Db } from "@rudderhq/db";
import {
  activityLog,
  agentWakeupRequests,
  approvals,
  heartbeatRuns,
  issueApprovals,
  issueBlockAuditAttempts,
  issues,
  requests,
} from "@rudderhq/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { notFound, unprocessable } from "../errors.js";
import { redactSensitiveText } from "../redaction.js";
import { appendHeartbeatRunEvent } from "./run-events.js";

const BLOCK_AUDIT_REQUIRED_ATTEMPTS = 3 as const;

function normalizeBlockerText(value: string) {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<uuid>")
    .replace(/\b(attempt|retry)\s*#?\d+\b/g, "$1 <counter>")
    .replace(/\b\d{10,}\b/g, "<long-number>")
    .replace(/\s+/g, " ")
    .trim();
}

export function blockerFingerprint(
  reason: string,
  requestedAction: string,
  scope: { issueId?: string; failureClass?: string; governedStopClass?: string } = {},
) {
  return createHash("sha256")
    .update([
      scope.issueId ?? "",
      scope.failureClass ?? "",
      scope.governedStopClass ?? "",
      normalizeBlockerText(reason),
      normalizeBlockerText(requestedAction),
    ].join("\n"))
    .digest("hex");
}

function approvalRequestStatus(status: string) {
  if (status === "cancelled") return "cancelled" as const;
  if (status === "approved" || status === "rejected") return "resolved" as const;
  return "open" as const;
}

export function requestService(db: Db) {
  return {
    list: async (orgId: string, filters: { status?: string; kind?: string } = {}) => {
      const result: Array<Record<string, unknown>> = [];
      if (!filters.kind || filters.kind === "assistance") {
        const conditions = [eq(requests.orgId, orgId)];
        if (filters.status) conditions.push(eq(requests.status, filters.status));
        result.push(...await db.select().from(requests).where(and(...conditions)).orderBy(desc(requests.updatedAt)));
      }
      if (!filters.kind || filters.kind === "approval") {
        const approvalRows = await db.select().from(approvals).where(eq(approvals.orgId, orgId));
        result.push(...approvalRows
          .map((approval) => ({
            ...approval,
            kind: "approval" as const,
            subtype: approval.type,
            requestStatus: approvalRequestStatus(approval.status),
          }))
          .filter((approval) => !filters.status || approval.requestStatus === filters.status));
      }
      return result.sort((left, right) =>
        new Date(String(right.updatedAt)).getTime() - new Date(String(left.updatedAt)).getTime());
    },

    getById: async (id: string) => {
      const assistance = await db.select().from(requests).where(eq(requests.id, id)).then((rows) => rows[0] ?? null);
      if (assistance) return assistance;
      const approval = await db.select().from(approvals).where(eq(approvals.id, id)).then((rows) => rows[0] ?? null);
      return approval
        ? { ...approval, kind: "approval" as const, subtype: approval.type, requestStatus: approvalRequestStatus(approval.status) }
        : null;
    },

    claimIssueBlock: async (input: {
      orgId: string;
      issueId: string;
      runId: string;
      agentId: string;
      reason: string;
      requestedAction: string;
    }) => db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${input.issueId} and org_id = ${input.orgId} for update`);
      const issue = await tx.select().from(issues)
        .where(and(eq(issues.id, input.issueId), eq(issues.orgId, input.orgId)))
        .then((rows) => rows[0] ?? null);
      if (!issue) throw notFound("Issue not found");
      if (issue.assigneeAgentId !== input.agentId) throw unprocessable("Only the current assignee can claim an issue blocker");
      if (
        issue.status !== "in_progress" ||
        (issue.checkoutRunId !== input.runId && issue.executionRunId !== input.runId)
      ) {
        throw unprocessable("Block Audit requires the current checked-out Issue execution Run");
      }

      const pendingApproval = await tx.select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.orgId, input.orgId),
          eq(issueApprovals.issueId, input.issueId),
          inArray(approvals.status, ["pending", "revision_requested", "rejected"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (pendingApproval) {
        throw unprocessable("A pending or denied Approval already owns this governed stop; Assistance must not be nested");
      }

      const run = await tx.select().from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.id, input.runId),
          eq(heartbeatRuns.orgId, input.orgId),
          eq(heartbeatRuns.agentId, input.agentId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!run) throw unprocessable("Block Audit requires the current eligible Issue execution Run");
      const runContext = run.contextSnapshot && typeof run.contextSnapshot === "object"
        ? run.contextSnapshot as Record<string, unknown>
        : {};
      if (
        run.status !== "running" ||
        runContext.issueId !== input.issueId ||
        run.invocationSource === "review" ||
        runContext.role === "reviewer" ||
        runContext.wakeSource === "review"
      ) {
        throw unprocessable("Block Audit requires a running assignee Issue execution Run");
      }
      const governedStopClass = typeof runContext.governedStopClass === "string"
        ? runContext.governedStopClass.trim()
        : "";
      if (governedStopClass) {
        throw unprocessable(`The ${governedStopClass} policy already owns this governed stop; Assistance must not be nested`);
      }

      const safeReason = redactSensitiveText(input.reason);
      const safeRequestedAction = redactSensitiveText(input.requestedAction);
      const failureClass = typeof runContext.operationClass === "string" && runContext.operationClass.trim()
        ? runContext.operationClass.trim()
        : typeof runContext.failureKind === "string" && runContext.failureKind.trim()
          ? runContext.failureKind.trim()
          : "issue_execution";
      const fingerprint = blockerFingerprint(safeReason, safeRequestedAction, {
        issueId: input.issueId,
        failureClass,
        governedStopClass: "assistance",
      });
      const duplicate = await tx.select().from(issueBlockAuditAttempts).where(and(
        eq(issueBlockAuditAttempts.orgId, input.orgId),
        eq(issueBlockAuditAttempts.issueId, input.issueId),
        eq(issueBlockAuditAttempts.runId, input.runId),
      )).then((rows) => rows[0] ?? null);
      if (duplicate) {
        if (duplicate.blockerFingerprint !== fingerprint) {
          throw unprocessable("One Agent Run cannot claim two materially different blockers");
        }
        const duplicateRequest = await tx.select().from(requests).where(and(
          eq(requests.id, duplicate.requestId),
          eq(requests.orgId, input.orgId),
        )).then((rows) => rows[0] ?? null);
        if (!duplicateRequest) throw unprocessable("Block Audit request is no longer available");
        return {
          request: duplicateRequest,
          attempt: duplicate.attemptNumber,
          requiredAttempts: BLOCK_AUDIT_REQUIRED_ATTEMPTS,
          blocked: duplicate.statusAfter === "blocked",
          fingerprint: duplicate.blockerFingerprint,
          applied: false,
        };
      }
      const staleOpen = await tx.select().from(requests).where(and(
        eq(requests.orgId, input.orgId),
        eq(requests.issueId, input.issueId),
        eq(requests.kind, "assistance"),
        eq(requests.status, "open"),
      ));
      let request = await tx.select().from(requests).where(and(
        eq(requests.orgId, input.orgId),
        eq(requests.issueId, input.issueId),
        eq(requests.kind, "assistance"),
        eq(requests.status, "open"),
        eq(requests.blockerFingerprint, fingerprint),
      )).then((rows) => rows[0] ?? null);
      if (!request) {
        request = await tx.insert(requests).values({
          orgId: input.orgId,
          kind: "assistance",
          subtype: "issue_blocker",
          status: "open",
          issueId: input.issueId,
          requestedByAgentId: input.agentId,
          originRunId: input.runId,
          assigneeAgentId: input.agentId,
          blockerFingerprint: fingerprint,
          title: `Input needed for ${issue.identifier ?? issue.title}`,
          prompt: safeRequestedAction,
          metadata: { blockerReason: safeReason, requiredAttempts: BLOCK_AUDIT_REQUIRED_ATTEMPTS },
        }).returning().then((rows) => rows[0]);
      }
      const supersededRequests = staleOpen.filter((stale) => stale.id !== request.id);
      for (const stale of supersededRequests) {
        const [superseded] = await tx.update(requests).set({
          status: "superseded",
          supersededByRequestId: request.id,
          metadata: sql`${requests.metadata} || ${JSON.stringify({ supersededReason: "blocker_changed" })}::jsonb`,
          updatedAt: new Date(),
        }).where(and(
          eq(requests.id, stale.id),
          eq(requests.orgId, input.orgId),
          eq(requests.status, "open"),
        )).returning();
        if (!superseded) continue;
        await tx.insert(activityLog).values({
          orgId: input.orgId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId: input.runId,
          action: "request.superseded",
          entityType: "request",
          entityId: stale.id,
          idempotencyKey: `request-superseded:${stale.id}:${request.id}`,
          details: {
            issueId: input.issueId,
            reason: "blocker_changed",
            supersededByRequestId: request.id,
            previousBlockerFingerprint: stale.blockerFingerprint,
            blockerFingerprint: fingerprint,
          },
        }).onConflictDoNothing();
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          orgId: input.orgId,
          runId: input.runId,
          agentId: input.agentId,
          eventType: "request.superseded",
          stream: "system",
          level: "info",
          message: "Assistance Request superseded after blocker changed",
          idempotencyKey: `request-superseded:${stale.id}:${request.id}`,
          payload: {
            requestId: stale.id,
            issueId: input.issueId,
            reason: "blocker_changed",
            supersededByRequestId: request.id,
            previousBlockerFingerprint: stale.blockerFingerprint,
            blockerFingerprint: fingerprint,
          },
        });
      }
      await tx.execute(sql`select id from requests where id = ${request.id} and org_id = ${input.orgId} for update`);
      request = await tx.select().from(requests).where(and(
        eq(requests.id, request.id),
        eq(requests.orgId, input.orgId),
        eq(requests.status, "open"),
      )).then((rows) => rows[0] ?? null);
      if (!request) throw unprocessable("The Assistance Request changed before the Block Audit could be recorded");

      const previous = await tx.select().from(issueBlockAuditAttempts).where(and(
        eq(issueBlockAuditAttempts.orgId, input.orgId),
        eq(issueBlockAuditAttempts.issueId, input.issueId),
        eq(issueBlockAuditAttempts.requestId, request.id),
        eq(issueBlockAuditAttempts.blockerFingerprint, fingerprint),
      )).orderBy(asc(issueBlockAuditAttempts.attemptNumber));
      const attempt = previous.length + 1;
      const passiveFollowup = runContext.passiveFollowup && typeof runContext.passiveFollowup === "object"
        ? runContext.passiveFollowup as Record<string, unknown>
        : null;
      const latestAttempt = previous.at(-1) ?? null;
      const rootRunId = latestAttempt?.rootRunId ?? input.runId;
      const continuationKind = latestAttempt ? "passive_issue_followup" : "initial";
      const previousRunId = latestAttempt?.runId ?? null;
      const resetReason = supersededRequests.length > 0
        ? "reset_after_blocker_change"
        : null;
      if (latestAttempt) {
        const validContinuation =
          runContext.wakeReason === "issue_passive_followup" &&
          passiveFollowup?.originRunId === rootRunId &&
          passiveFollowup?.previousRunId === previousRunId &&
          passiveFollowup?.attempt === latestAttempt.attemptNumber;
        if (!validContinuation) {
          throw unprocessable("Block Audit attempts after the first require the next passive Issue follow-up Run");
        }
      } else if (passiveFollowup && !resetReason) {
        throw unprocessable("Block Audit cannot start from a passive follow-up without its originating attempt");
      }
      await tx.insert(issueBlockAuditAttempts).values({
        orgId: input.orgId,
        issueId: input.issueId,
        requestId: request.id,
        runId: input.runId,
        rootRunId,
        previousRunId,
        agentId: input.agentId,
        continuationKind,
        eligible: true,
        failureClass,
        blockerFingerprint: fingerprint,
        attemptNumber: attempt,
        requiredAttempts: BLOCK_AUDIT_REQUIRED_ATTEMPTS,
        statusBefore: issue.status,
        statusAfter: attempt >= BLOCK_AUDIT_REQUIRED_ATTEMPTS ? "blocked" : issue.status,
        resetReason,
        blockerReason: safeReason,
        requestedAction: safeRequestedAction,
      });

      const blocked = attempt >= BLOCK_AUDIT_REQUIRED_ATTEMPTS;
      if (blocked) {
        await tx.update(issues).set({
          status: "blocked",
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: new Date(),
        }).where(and(eq(issues.id, issue.id), eq(issues.orgId, input.orgId)));
      }
      await tx.update(requests).set({
        prompt: safeRequestedAction,
        metadata: { blockerReason: safeReason, requiredAttempts: BLOCK_AUDIT_REQUIRED_ATTEMPTS, attempt },
        updatedAt: new Date(),
      }).where(and(
        eq(requests.id, request.id),
        eq(requests.orgId, input.orgId),
        eq(requests.status, "open"),
      ));
      request = await tx.select().from(requests).where(and(
        eq(requests.id, request.id),
        eq(requests.orgId, input.orgId),
      )).then((rows) => rows[0]);

      await tx.insert(activityLog).values({
        orgId: input.orgId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        runId: input.runId,
        action: "issue.block_audit_attempted",
        entityType: "issue",
        entityId: input.issueId,
        idempotencyKey: `issue-block-audit:${input.issueId}:${input.runId}`,
        details: {
          requestId: request.id,
          attempt,
          requiredAttempts: BLOCK_AUDIT_REQUIRED_ATTEMPTS,
          blockerFingerprint: fingerprint,
          blocked,
          rootRunId,
          previousRunId,
          continuationKind,
          eligible: true,
          failureClass,
          statusBefore: issue.status,
          statusAfter: blocked ? "blocked" : issue.status,
          resetReason,
        },
      }).onConflictDoNothing();
      await appendHeartbeatRunEvent(tx as unknown as Db, {
        orgId: input.orgId,
        runId: input.runId,
        agentId: input.agentId,
        eventType: "issue.block_audit_attempted",
        stream: "system",
        level: "info",
        message: `Block Audit attempt ${attempt}/${BLOCK_AUDIT_REQUIRED_ATTEMPTS}`,
        idempotencyKey: `issue-block-audit:${input.issueId}:${input.runId}`,
        payload: {
          requestId: request.id,
          issueId: input.issueId,
          attempt,
          requiredAttempts: BLOCK_AUDIT_REQUIRED_ATTEMPTS,
          blocked,
          blockerFingerprint: fingerprint,
          rootRunId,
          previousRunId,
          continuationKind,
          eligible: true,
          failureClass,
          statusBefore: issue.status,
          statusAfter: blocked ? "blocked" : issue.status,
          resetReason,
        },
      });

      return {
        request,
        attempt,
        requiredAttempts: BLOCK_AUDIT_REQUIRED_ATTEMPTS,
        blocked,
        fingerprint,
        applied: true,
      };
    }),

    resolveAssistance: async (input: {
      id: string;
      resolution: "answered" | "action_completed" | "cannot_help";
      response: string;
      resolvedByUserId: string;
    }) => db.transaction(async (tx) => {
      const preliminary = await tx.select().from(requests).where(eq(requests.id, input.id)).then((rows) => rows[0] ?? null);
      if (!preliminary) throw notFound("Request not found");
      if (preliminary.issueId) {
        await tx.execute(sql`select id from issues where id = ${preliminary.issueId} and org_id = ${preliminary.orgId} for update`);
      }
      await tx.execute(sql`select id from requests where id = ${input.id} for update`);
      const request = await tx.select().from(requests).where(eq(requests.id, input.id)).then((rows) => rows[0] ?? null);
      if (!request) throw notFound("Request not found");
      if (request.kind !== "assistance") throw unprocessable("Approval Requests must use the Approval decision actions");
      if (request.status !== "open") {
        if (request.status === "superseded") {
          return { request, wakeAgentId: null, wakeupRequestId: null, issue: null, applied: false };
        }
        if (request.status === "resolved" && request.resolution === input.resolution) {
          const wakeupRequest = request.assigneeAgentId
            ? await tx.select().from(agentWakeupRequests).where(and(
                eq(agentWakeupRequests.orgId, request.orgId),
                eq(agentWakeupRequests.agentId, request.assigneeAgentId),
                eq(agentWakeupRequests.idempotencyKey, `assistance-request:${request.id}:resolved`),
              )).then((rows) => rows[0] ?? null)
            : null;
          return { request, wakeAgentId: request.assigneeAgentId, wakeupRequestId: wakeupRequest?.id ?? null, issue: null, applied: false };
        }
        throw unprocessable("Only an open Assistance Request can be resolved");
      }

      const now = new Date();
      const [updated] = await tx.update(requests).set({
        status: "resolved",
        resolution: input.resolution,
        response: redactSensitiveText(input.response),
        resolvedByUserId: input.resolvedByUserId,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(eq(requests.id, input.id), eq(requests.status, "open"))).returning();
      if (!updated) throw unprocessable("The Assistance Request changed before it could be resolved");

      await tx.insert(activityLog).values({
        orgId: request.orgId,
        actorType: "user",
        actorId: input.resolvedByUserId,
        action: "request.resolved",
        entityType: "request",
        entityId: request.id,
        idempotencyKey: `request-resolved:${request.id}`,
        details: {
          kind: "assistance",
          resolution: input.resolution,
          issueId: request.issueId,
        },
      }).onConflictDoNothing();
      let linkedIssue = request.issueId
        ? await tx.select().from(issues).where(and(
            eq(issues.id, request.issueId),
            eq(issues.orgId, request.orgId),
          )).then((rows) => rows[0] ?? null)
        : null;
      let wakeAgentId: string | null = null;
      let wakeupRequestId: string | null = null;
      if (
        input.resolution !== "cannot_help" &&
        linkedIssue &&
        linkedIssue.assigneeAgentId &&
        linkedIssue.assigneeAgentId === request.assigneeAgentId
      ) {
        if (linkedIssue.status === "blocked") {
          [linkedIssue] = await tx.update(issues).set({ status: "in_progress", updatedAt: now })
            .where(and(eq(issues.id, linkedIssue.id), eq(issues.orgId, request.orgId))).returning();
        }
        if (linkedIssue.status === "in_progress" || linkedIssue.status === "todo") {
          const eligibleAgentId = linkedIssue.assigneeAgentId!;
          wakeAgentId = eligibleAgentId;
          const idempotencyKey = `assistance-request:${request.id}:resolved`;
          const [wakeupRequest] = await tx.insert(agentWakeupRequests).values({
            orgId: request.orgId,
            agentId: eligibleAgentId,
            source: "assignment",
            triggerDetail: "user",
            reason: "assistance_request_resolved",
            payload: {
              requestId: request.id,
              issueId: linkedIssue.id,
              resolution: input.resolution,
              response: redactSensitiveText(input.response),
              expectedAssigneeAgentId: eligibleAgentId,
              expectedIssueStatus: linkedIssue.status,
            },
            status: "queued",
            requestedByActorType: "user",
            requestedByActorId: input.resolvedByUserId,
            idempotencyKey,
          }).onConflictDoNothing().returning();
          wakeupRequestId = wakeupRequest?.id ?? await tx.select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(and(
              eq(agentWakeupRequests.orgId, request.orgId),
              eq(agentWakeupRequests.agentId, eligibleAgentId),
              eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
            ))
            .then((rows) => rows[0]?.id ?? null);
        }
      }
      if (request.originRunId && request.assigneeAgentId) {
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          orgId: request.orgId,
          runId: request.originRunId,
          agentId: request.assigneeAgentId,
          eventType: "request.resolved",
          stream: "system",
          level: "info",
          message: "Assistance Request resolved",
          idempotencyKey: `request-resolved:${request.id}`,
          payload: {
            requestId: request.id,
            issueId: request.issueId,
            resolution: input.resolution,
            resolutionLatencyMs: Math.max(0, now.getTime() - request.createdAt.getTime()),
            wakeIntentQueued: Boolean(wakeupRequestId),
          },
        });
      }
      return { request: updated, wakeAgentId, wakeupRequestId, issue: linkedIssue, applied: true };
    }),

    cancelAssistance: async (input: {
      id: string;
      reason?: string;
      cancelledByUserId: string;
    }) => db.transaction(async (tx) => {
      const preliminary = await tx.select().from(requests).where(eq(requests.id, input.id))
        .then((rows) => rows[0] ?? null);
      if (!preliminary) throw notFound("Request not found");
      if (preliminary.issueId) {
        await tx.execute(sql`select id from issues where id = ${preliminary.issueId} and org_id = ${preliminary.orgId} for update`);
      }
      await tx.execute(sql`select id from requests where id = ${input.id} for update`);
      const request = await tx.select().from(requests).where(eq(requests.id, input.id))
        .then((rows) => rows[0] ?? null);
      if (!request) throw notFound("Request not found");
      if (request.kind !== "assistance") throw unprocessable("Approval Requests must use the Approval cancellation actions");
      if (request.status === "cancelled") return { request, applied: false };
      if (request.status !== "open") return { request, applied: false };
      const now = new Date();
      const [cancelled] = await tx.update(requests).set({
        status: "cancelled",
        response: input.reason ? redactSensitiveText(input.reason) : null,
        resolvedByUserId: input.cancelledByUserId,
        resolvedAt: now,
        updatedAt: now,
      }).where(and(eq(requests.id, input.id), eq(requests.status, "open"))).returning();
      if (!cancelled) throw unprocessable("The Assistance Request changed before it could be cancelled");
      await tx.insert(activityLog).values({
        orgId: request.orgId,
        actorType: "user",
        actorId: input.cancelledByUserId,
        action: "request.cancelled",
        entityType: "request",
        entityId: request.id,
        idempotencyKey: `request-cancelled:${request.id}`,
        details: { kind: "assistance", issueId: request.issueId },
      }).onConflictDoNothing();
      if (request.originRunId && request.assigneeAgentId) {
        await appendHeartbeatRunEvent(tx as unknown as Db, {
          orgId: request.orgId,
          runId: request.originRunId,
          agentId: request.assigneeAgentId,
          eventType: "request.cancelled",
          stream: "system",
          level: "info",
          message: "Assistance Request cancelled",
          idempotencyKey: `request-cancelled:${request.id}`,
          payload: {
            requestId: request.id,
            issueId: request.issueId,
            resolutionLatencyMs: Math.max(0, now.getTime() - request.createdAt.getTime()),
          },
        });
      }
      return { request: cancelled, applied: true };
    }),

    attemptsForRequest: (orgId: string, requestId: string) => db.select().from(issueBlockAuditAttempts)
      .where(and(
        eq(issueBlockAuditAttempts.orgId, orgId),
        eq(issueBlockAuditAttempts.requestId, requestId),
      ))
      .orderBy(asc(issueBlockAuditAttempts.attemptNumber)),

    supersedeOpenAssistance: async (orgId: string, issueId: string, reason: string) => db.transaction(async (tx) => {
      const superseded = await tx.update(requests).set({
        status: "superseded",
        metadata: sql`${requests.metadata} || ${JSON.stringify({ supersededReason: reason })}::jsonb`,
        updatedAt: new Date(),
      }).where(and(
        eq(requests.orgId, orgId),
        eq(requests.issueId, issueId),
        eq(requests.kind, "assistance"),
        eq(requests.status, "open"),
      )).returning();
      for (const request of superseded) {
        await tx.insert(activityLog).values({
          orgId,
          actorType: "system",
          actorId: "request-lifecycle",
          action: "request.superseded",
          entityType: "request",
          entityId: request.id,
          idempotencyKey: `request-superseded:${request.id}:${reason}`,
          details: { issueId, reason },
        }).onConflictDoNothing();
      }
      return superseded;
    }),
  };
}
