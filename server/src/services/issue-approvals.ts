import type { Db } from "@rudderhq/db";
import { approvals, issueApprovals, issueLabels, issues, labels } from "@rudderhq/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";

interface LinkActor {
  agentId?: string | null;
  userId?: string | null;
}

export function issueApprovalService(db: Db) {
  async function getIssue(issueId: string) {
    return db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function getApproval(approvalId: string) {
    return db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .then((rows) => rows[0] ?? null);
  }

  async function assertIssueAndApprovalSameCompany(issueId: string, approvalId: string) {
    const issue = await getIssue(issueId);
    if (!issue) throw notFound("Issue not found");

    const approval = await getApproval(approvalId);
    if (!approval) throw notFound("Approval not found");

    if (issue.orgId !== approval.orgId) {
      throw unprocessable("Issue and approval must belong to the same organization");
    }

    return { issue, approval };
  }

  async function labelsByIssueId(issueIds: string[]) {
    const result = new Map<string, Array<typeof labels.$inferSelect>>();
    if (issueIds.length === 0) return result;
    const labelRows = await db
      .select({
        issueId: issueLabels.issueId,
        label: labels,
      })
      .from(issueLabels)
      .innerJoin(labels, eq(issueLabels.labelId, labels.id))
      .where(inArray(issueLabels.issueId, issueIds))
      .orderBy(asc(labels.name), asc(labels.id));
    for (const row of labelRows) {
      const existing = result.get(row.issueId) ?? [];
      existing.push(row.label);
      result.set(row.issueId, existing);
    }
    return result;
  }

  return {
    listApprovalsForIssue: async (issueId: string) => {
      const issue = await getIssue(issueId);
      if (!issue) throw notFound("Issue not found");

      const result = await db
        .select({
          id: approvals.id,
          orgId: approvals.orgId,
          type: approvals.type,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          status: approvals.status,
          payload: approvals.payload,
          decisionNote: approvals.decisionNote,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          createdAt: approvals.createdAt,
          updatedAt: approvals.updatedAt,
          linkIssueId: issueApprovals.issueId,
          linkApprovalId: issueApprovals.approvalId,
          linkLinkedByAgentId: issueApprovals.linkedByAgentId,
          linkLinkedByUserId: issueApprovals.linkedByUserId,
          linkCreatedAt: issueApprovals.createdAt,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(eq(issueApprovals.issueId, issueId))
        .orderBy(desc(issueApprovals.createdAt));
      return result.map((approval) => ({
        id: approval.id,
        orgId: approval.orgId,
        type: approval.type,
        requestedByAgentId: approval.requestedByAgentId,
        requestedByUserId: approval.requestedByUserId,
        status: approval.status,
        payload: redactEventPayload(approval.payload) ?? {},
        decisionNote: approval.decisionNote,
        decidedByUserId: approval.decidedByUserId,
        decidedAt: approval.decidedAt,
        createdAt: approval.createdAt,
        updatedAt: approval.updatedAt,
        link: {
          issueId: approval.linkIssueId,
          approvalId: approval.linkApprovalId,
          linkedByAgentId: approval.linkLinkedByAgentId,
          linkedByUserId: approval.linkLinkedByUserId,
          createdAt: approval.linkCreatedAt,
        },
      }));
    },

    listIssuesForApproval: async (approvalId: string) => {
      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      const result = await db
        .select({
          id: issues.id,
          orgId: issues.orgId,
          projectId: issues.projectId,
          goalId: issues.goalId,
          parentId: issues.parentId,
          title: issues.title,
          description: issues.description,
          status: issues.status,
          priority: issues.priority,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
          issueNumber: issues.issueNumber,
          identifier: issues.identifier,
          requestDepth: issues.requestDepth,
          billingCode: issues.billingCode,
          startedAt: issues.startedAt,
          completedAt: issues.completedAt,
          cancelledAt: issues.cancelledAt,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issueApprovals)
        .innerJoin(issues, eq(issueApprovals.issueId, issues.id))
        .where(eq(issueApprovals.approvalId, approvalId))
        .orderBy(desc(issueApprovals.createdAt));
      const labelsForIssues = await labelsByIssueId(result.map((issue) => issue.id));
      return result.map((issue) => {
        const issueLabels = labelsForIssues.get(issue.id) ?? [];
        return {
          ...issue,
          labels: issueLabels,
          labelIds: issueLabels.map((label) => label.id),
        };
      });
    },

    link: async (issueId: string, approvalId: string, actor?: LinkActor) => {
      const { issue } = await assertIssueAndApprovalSameCompany(issueId, approvalId);

      await db
        .insert(issueApprovals)
        .values({
          orgId: issue.orgId,
          issueId,
          approvalId,
          linkedByAgentId: actor?.agentId ?? null,
          linkedByUserId: actor?.userId ?? null,
        })
        .onConflictDoNothing();

      return db
        .select()
        .from(issueApprovals)
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)))
        .then((rows) => rows[0] ?? null);
    },

    unlink: async (issueId: string, approvalId: string) => {
      await assertIssueAndApprovalSameCompany(issueId, approvalId);
      await db
        .delete(issueApprovals)
        .where(and(eq(issueApprovals.issueId, issueId), eq(issueApprovals.approvalId, approvalId)));
    },

    linkManyForApproval: async (approvalId: string, issueIds: string[], actor?: LinkActor) => {
      if (issueIds.length === 0) return [];

      const approval = await getApproval(approvalId);
      if (!approval) throw notFound("Approval not found");

      const uniqueIssueIds = Array.from(new Set(issueIds));
      const rows = await db
        .select({
          id: issues.id,
          orgId: issues.orgId,
        })
        .from(issues)
        .where(inArray(issues.id, uniqueIssueIds));

      if (rows.length !== uniqueIssueIds.length) {
        throw notFound("One or more issues not found");
      }

      for (const row of rows) {
        if (row.orgId !== approval.orgId) {
          throw unprocessable("Issue and approval must belong to the same organization");
        }
      }

      return db
        .insert(issueApprovals)
        .values(
          uniqueIssueIds.map((issueId) => ({
            orgId: approval.orgId,
            issueId,
            approvalId,
            linkedByAgentId: actor?.agentId ?? null,
            linkedByUserId: actor?.userId ?? null,
          })),
        )
        .onConflictDoNothing()
        .returning();
    },
  };
}
