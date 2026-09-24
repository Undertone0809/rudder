import { approvals, chatConversations, issueApprovals, issues } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import { issueApprovalService } from "../services/issue-approvals.js";

function createDbStub(input: {
  approval: Record<string, unknown>;
  issue: { id: string; orgId: string };
  conversation: { id: string; orgId: string; primaryIssueId: string | null } | null;
}) {
  const select = vi.fn(() => {
    let table: unknown;
    const chain: any = {
      from: vi.fn((nextTable: unknown) => {
        table = nextTable;
        return chain;
      }),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(() => chain),
      orderBy: vi.fn(() => chain),
      then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => {
        const rows = table === approvals
          ? [input.approval]
          : table === issues
            ? [input.issue]
            : table === chatConversations && input.conversation
              ? [input.conversation]
              : [];
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return chain;
  });
  const insertedLink = {
    orgId: input.approval.orgId,
    issueId: input.issue.id,
    approvalId: input.approval.id,
  };
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
        returning: vi.fn(async () => [insertedLink]),
      })),
    })),
  }));

  return { select, insert } as any;
}

function approval(payloadConversationId = "conversation-1") {
  return {
    id: "approval-1",
    orgId: "org-1",
    type: "chat_issue_creation",
    requestedByAgentId: null,
    requestedByUserId: "user-1",
    status: "pending",
    payload: { chatConversationId: payloadConversationId },
  };
}

describe("issue approval conversation scope", () => {
  it.each([
    {
      name: "cross-organization conversation",
      conversation: null,
      message: "Issue approval conversation must belong to the approval organization and target issue",
    },
    {
      name: "conversation for a different primary issue",
      conversation: { id: "conversation-1", orgId: "org-1", primaryIssueId: "issue-other" },
      message: "Issue approval conversation must belong to the approval organization and target issue",
    },
    {
      name: "approval payload conversation",
      conversation: { id: "conversation-1", orgId: "org-1", primaryIssueId: "issue-1" },
      payloadConversationId: "conversation-other",
      message: "Issue approval conversation does not match its approval payload",
    },
  ])("rejects $name", async ({ conversation, payloadConversationId, message }) => {
    const approvalRow = approval(payloadConversationId ?? "conversation-1");
    const svc = issueApprovalService(createDbStub({
      approval: approvalRow,
      issue: { id: "issue-1", orgId: "org-1" },
      conversation,
    }));

    await expect(svc.linkManyForApproval(
      "approval-1",
      ["issue-1"],
      undefined,
      { orgId: "org-1", conversationId: "conversation-1" },
    )).rejects.toThrow(message);
  });

  it("allows a same-organization approval conversation linked to its primary issue", async () => {
    const db = createDbStub({
      approval: approval(),
      issue: { id: "issue-1", orgId: "org-1" },
      conversation: { id: "conversation-1", orgId: "org-1", primaryIssueId: "issue-1" },
    });
    const svc = issueApprovalService(db);

    await expect(svc.linkManyForApproval(
      "approval-1",
      ["issue-1"],
      { userId: "user-1" },
      { orgId: "org-1", conversationId: "conversation-1" },
    )).resolves.toEqual([
      { orgId: "org-1", issueId: "issue-1", approvalId: "approval-1" },
    ]);
    expect(db.insert).toHaveBeenCalledWith(issueApprovals);
  });
});
