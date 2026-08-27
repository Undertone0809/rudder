// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptToolCard } from "./RunTranscriptView.blocks";
import { TranscriptChatToolActionRow } from "./RunTranscriptView.chat";
import type { TranscriptAgentDirectoryEntry, TranscriptToolCardEntry } from "./RunTranscriptView.common";
import {
  type CoveredRudderMcpToolName,
  getRudderMcpPresenterDefinition,
  parseRudderMcpResult,
  RUDDER_MCP_PRESENTER_REGISTRY,
  RudderMcpPresenterProvider,
  RudderMcpSemanticPresenter,
} from "./RunTranscriptView.rudder-mcp";

const toolFixtures = {
  rudder_goal_list: { result: [{ id: "goal-1", title: "Launch", lifecycle: "active" }], expected: "Launch" },
  rudder_goal_context: { result: { id: "goal-1", title: "Launch", lifecycle: "active" }, expected: "Launch" },
  rudder_goal_progress: { result: { id: "activity-1", goalId: "goal-1", summary: "Validated demand" }, expected: "Progress recorded" },
  rudder_goal_checkpoint: { result: { id: "checkpoint-1", goalId: "goal-1", planRevisionAfter: 2 }, expected: "Checkpoint saved at plan revision 2" },
  rudder_goal_change_propose: { result: { id: "proposal-1", goalId: "goal-1", status: "pending" }, expected: "Proposed / awaiting review" },
  rudder_goal_result_propose: { result: { id: "proposal-2", goalId: "goal-1", status: "ready" }, expected: "Proposed / awaiting review" },

  rudder_issue_list: { result: [{ id: "issue-1", identifier: "RUD-1", title: "Fix cards" }], expected: "Fix cards" },
  rudder_issue_search: { result: [{ id: "issue-1", identifier: "RUD-1", title: "Fix cards" }], expected: "Fix cards" },
  rudder_issue_comments_list: { result: [{ id: "comment-1", issueId: "RUD-1", body: "Looks good" }], expected: "Looks good" },
  rudder_issue_get: { result: { id: "issue-1", identifier: "RUD-1", title: "Fix cards" }, expected: "Fix cards" },
  rudder_issue_context: { result: { id: "issue-1", identifier: "RUD-1", title: "Fix cards" }, expected: "Fix cards" },
  rudder_issue_comments_get: { result: { id: "comment-1", issueId: "RUD-1", body: "Looks good" }, expected: "Looks good" },
  rudder_issue_checkout: { result: { id: "issue-1", identifier: "RUD-1", title: "Fix cards" }, expected: "Issue checked out" },
  rudder_issue_comment: { result: { id: "comment-1", issueId: "RUD-1", body: "Looks good" }, expected: "Comment added" },
  rudder_issue_update: { result: { id: "issue-1", identifier: "RUD-1", title: "Fix cards" }, expected: "Issue updated" },
  rudder_issue_review: { result: { id: "issue-1", identifier: "RUD-1", decision: "approved" }, expected: "Review decision recorded" },
  rudder_issue_commit: { result: { id: "issue-1", identifier: "RUD-1", title: "Fix cards" }, expected: "Commit recorded" },
  rudder_issue_done: { result: { id: "issue-1", identifier: "RUD-1", status: "done" }, expected: "Issue completed" },
  rudder_issue_block: { result: { id: "issue-1", identifier: "RUD-1", blockAudit: { blocked: false } }, expected: "Assistance claim recorded" },
  rudder_issue_create: { result: { id: "issue-2", identifier: "RUD-2", title: "Created issue" }, expected: "Issue created" },

  rudder_project_list: { result: [{ id: "project-1", name: "Cards" }], expected: "Cards" },
  rudder_project_get: { result: { id: "project-1", name: "Cards" }, expected: "Cards" },
  rudder_project_create: { result: { id: "project-1", name: "Cards" }, expected: "Project created" },
  rudder_project_update: { result: { id: "project-1", name: "Cards" }, expected: "Project updated" },

  rudder_approval_issues: { result: [{ id: "issue-1", identifier: "RUD-1", title: "Needs approval" }], expected: "Needs approval" },
  rudder_approval_get: { result: { id: "approval-1", type: "approve_strategy", status: "pending" }, expected: "pending" },
  rudder_approval_comment: { result: { id: "comment-1", approvalId: "approval-1", body: "Approved context" }, expected: "Approval comment added" },

  rudder_automation_list: { result: [{ id: "automation-1", name: "Daily digest" }], expected: "Daily digest" },
  rudder_automation_runs: { result: [{ id: "run-1", automationId: "automation-1", status: "succeeded" }], expected: "succeeded" },
  rudder_automation_triggers_list: { result: [{ id: "trigger-1", automationId: "automation-1", kind: "webhook" }], expected: "webhook" },
  rudder_automation_get: { result: { id: "automation-1", name: "Daily digest" }, expected: "Daily digest" },
  rudder_automation_triggers_create: { result: { trigger: { id: "trigger-1", automationId: "automation-1", kind: "webhook" } }, expected: "Trigger created" },
  rudder_automation_triggers_update: { result: { trigger: { id: "trigger-1", automationId: "automation-1", kind: "webhook" } }, expected: "Trigger updated" },
  rudder_automation_triggers_delete: { result: { id: "trigger-1", deleted: true }, expected: "Trigger deleted" },
  rudder_automation_triggers_rotate_secret: { result: { trigger: { id: "trigger-1", automationId: "automation-1", lastRotatedAt: "2026-08-26T08:00:00.000Z" } }, expected: "Webhook secret rotated" },
  rudder_automation_create: { result: { id: "automation-1", name: "Daily digest" }, expected: "Automation created" },
  rudder_automation_update: { result: { id: "automation-1", name: "Daily digest" }, expected: "Automation updated" },
  rudder_automation_enable: { result: { id: "automation-1", name: "Daily digest", status: "enabled" }, expected: "Automation enabled" },
  rudder_automation_disable: { result: { id: "automation-1", name: "Daily digest", status: "disabled" }, expected: "Automation disabled" },
  rudder_automation_run: { result: { id: "run-1", automationId: "automation-1", status: "queued" }, expected: "Automation run queued" },
} satisfies Record<CoveredRudderMcpToolName, { result: unknown; expected: string }>;

function block(
  tool: string,
  result: unknown,
  input: Record<string, unknown> = {},
  status: TranscriptToolCardEntry["status"] = "completed",
): TranscriptToolCardEntry {
  return {
    ts: "2026-08-26T08:00:00.000Z",
    name: `mcp__rudder-tools__${tool}`,
    toolUseId: `${tool}-1`,
    input,
    result: typeof result === "string" ? result : JSON.stringify(result),
    status,
    isError: status === "error",
  };
}

function renderPresenter(entry: TranscriptToolCardEntry, agents: TranscriptAgentDirectoryEntry[] = []) {
  return renderToStaticMarkup(
    <RudderMcpPresenterProvider agents={agents}>
      <RudderMcpSemanticPresenter block={entry} />
    </RudderMcpPresenterProvider>,
  );
}

describe("Rudder MCP semantic presenter registry", () => {
  it("maps the exact first-batch 40 tools to one of three shared presenter families", () => {
    const entries = Object.entries(RUDDER_MCP_PRESENTER_REGISTRY);
    expect(entries).toHaveLength(40);
    expect(entries.filter(([, item]) => item.kind === "rail")).toHaveLength(9);
    expect(entries.filter(([, item]) => item.kind === "summary")).toHaveLength(7);
    expect(entries.filter(([, item]) => item.kind === "receipt")).toHaveLength(24);
    expect(new Set(entries.map(([name]) => name)).size).toBe(40);
    for (const [name, definition] of entries) {
      expect(getRudderMcpPresenterDefinition(name)).toEqual({ toolName: name, ...definition });
      expect(getRudderMcpPresenterDefinition(`mcp__rudder-tools__${name}`, {})).toEqual({ toolName: name, ...definition });
    }
    expect(getRudderMcpPresenterDefinition("rudder_chat_list")).toBeNull();
    expect(getRudderMcpPresenterDefinition("mcp__external__rudder_issue_list", {})).toBeNull();
    expect(getRudderMcpPresenterDefinition("mcp", {
      server: "external",
      tool: "rudder_issue_list",
    })).toBeNull();
  });

  it("keeps one renderable contract fixture for every covered tool", () => {
    expect(Object.keys(toolFixtures).sort()).toEqual(Object.keys(RUDDER_MCP_PRESENTER_REGISTRY).sort());
    for (const [toolName, fixture] of Object.entries(toolFixtures) as Array<[
      CoveredRudderMcpToolName,
      { result: unknown; expected: string },
    ]>) {
      const html = renderPresenter(block(toolName, fixture.result));
      expect(html, toolName).toContain(fixture.expected);
      expect(html, toolName).not.toContain("Result unavailable");
      expect(html, toolName).not.toContain(">Input<");
      expect(html, toolName).not.toContain(">Response<");
    }
  });

  it("unwraps direct values, structuredContent, structuredContent.result, and text content", () => {
    expect(parseRudderMcpResult(JSON.stringify([{ id: "issue-1" }]))).toEqual([{ id: "issue-1" }]);
    expect(parseRudderMcpResult(JSON.stringify({ structuredContent: [{ id: "issue-2" }] }))).toEqual([{ id: "issue-2" }]);
    expect(parseRudderMcpResult(JSON.stringify({ structuredContent: { result: [{ id: "issue-3" }] } }))).toEqual([{ id: "issue-3" }]);
    expect(parseRudderMcpResult(JSON.stringify({ content: [{ type: "text", text: "{\"id\":\"issue-4\"}" }] }))).toEqual({ id: "issue-4" });
    expect(parseRudderMcpResult("not-json")).toBeUndefined();
  });
});

describe("Rudder MCP semantic cards", () => {
  it.each([0, 5, 6, 7, 12, 13])("initially mounts the bounded rail batch for %i results", (count) => {
    const issues = Array.from({ length: count }, (_, index) => ({
      id: `issue-${index + 1}`,
      identifier: `RUD-${index + 1}`,
      title: `Issue ${index + 1}`,
      status: "todo",
    }));
    const html = renderPresenter(block("rudder_issue_list", { structuredContent: { result: issues } }));
    expect((html.match(/data-rudder-semantic-card-link=/g) ?? []).length).toBe(Math.min(count, 6));
    expect(html.includes("data-rudder-semantic-sentinel")).toBe(count > 6);
    expect(html).not.toContain("Showing ");
    expect(html).not.toContain("Open all");
  });

  it("renders domain empty and malformed states without a blank disclosure", () => {
    expect(renderPresenter(block("rudder_project_list", []))).toContain("No projects found");
    expect(renderPresenter(block("rudder_project_list", "malformed"))).toContain("Result unavailable");
  });

  it("uses internal structured identifiers for whole-card links and Agent directory identities", () => {
    const html = renderPresenter(block("rudder_issue_list", [{
      id: "issue-1",
      identifier: "RUD-42",
      title: "Investigate transcript cards",
      assigneeAgentId: "agent-1",
    }]), [{ id: "agent-1", name: "Ada", icon: null, role: "engineer" }]);
    expect(html).toContain('href="/issues/RUD-42"');
    expect(html).toContain("Ada");
    expect(html).not.toContain("Open");
  });

  it("renders approval issue collections as Issue cards with Issue links", () => {
    const html = renderPresenter(block("rudder_approval_issues", [{
      id: "issue-approval-1",
      identifier: "RUD-84",
      title: "Review the deployment plan",
      status: "in_review",
    }]));
    expect(html).toContain('data-rudder-semantic-rail="issue"');
    expect(html).toContain('href="/issues/RUD-84"');
    expect(html).toContain("Issue");
  });

  it("shows stable fallback identity text without inventing an Agent name", () => {
    const html = renderPresenter(block("rudder_project_get", {
      id: "project-1",
      name: "Release",
      leadAgentId: "agt_unknown",
    }));
    expect(html).toContain("agt_unknown");
  });

  it("preserves pending Goal semantics and the two Issue block outcomes", () => {
    expect(renderPresenter(block("rudder_goal_result_propose", {
      id: "proposal-1",
      goalId: "goal-1",
      status: "pending",
    }))).toContain("Proposed / awaiting review");
    expect(renderPresenter(block("rudder_issue_block", {
      id: "issue-1",
      identifier: "RUD-1",
      status: "in_progress",
      blockAudit: { blocked: false, attempt: 1, requiredAttempts: 3 },
    }))).toContain("Assistance claim recorded");
    expect(renderPresenter(block("rudder_issue_block", {
      id: "issue-1",
      identifier: "RUD-1",
      status: "blocked",
      blockAudit: { blocked: true, attempt: 3, requiredAttempts: 3 },
    }))).toContain("Issue blocked");
  });

  it("does not overstate Issue done or Automation run outcomes", () => {
    expect(renderPresenter(block("rudder_issue_done", { id: "issue-1", status: "in_review" }))).toContain("Issue update recorded");
    expect(renderPresenter(block("rudder_issue_done", { id: "issue-1", status: "done" }))).toContain("Issue completed");
    expect(renderPresenter(block("rudder_automation_run", { id: "run-1", automationId: "auto-1", status: "coalesced" }))).toContain("Automation run coalesced");
    const failedRun = renderPresenter(block("rudder_automation_run", { id: "run-2", automationId: "auto-1", status: "failed" }));
    expect(failedRun).toContain("Automation run failed");
    expect(failedRun).toContain("text-red-700");
    expect(failedRun).not.toContain("text-emerald-700");
    const cancelledRun = renderPresenter(block("rudder_automation_run", { id: "run-3", automationId: "auto-1", status: "cancelled" }));
    expect(cancelledRun).toContain("Automation run cancelled");
    expect(cancelledRun).toContain("text-red-700");
    expect(cancelledRun).not.toContain("text-emerald-700");
  });

  it("does not mistake a deleted trigger id for its parent Automation", () => {
    const html = renderPresenter(block(
      "rudder_automation_triggers_delete",
      { id: "trigger-1", deleted: true },
      { trigger: "trigger-1" },
    ));
    expect(html).toContain("Trigger deleted");
    expect(html).not.toContain('href="/automations/trigger-1"');
    expect(html).not.toContain("cursor-pointer");
  });

  it("redacts secret material from webhook rotation Nice output", () => {
    const html = renderPresenter(block("rudder_automation_triggers_rotate_secret", {
      trigger: { id: "trigger-1", automationId: "auto-1", kind: "webhook", lastRotatedAt: "2026-08-26T08:00:00.000Z" },
      secretMaterial: { webhookUrl: "https://example.test/hook", webhookSecret: "top-secret-value" },
    }));
    expect(html).toContain("Webhook secret rotated");
    expect(html).toContain("Aug 26");
    expect(html).toContain('href="/automations/auto-1"');
    expect(html).not.toContain("top-secret-value");
    expect(html).not.toContain("webhookSecret");
  });

  it("uses the persisted Goal checkpoint plan revision", () => {
    const html = renderPresenter(block("rudder_goal_checkpoint", {
      id: "checkpoint-1",
      goalId: "goal-1",
      planRevisionBefore: 3,
      planRevisionAfter: 4,
      continuation: { kind: "verification", summary: "Verify the result" },
    }));
    expect(html).toContain("Checkpoint saved at plan revision 4");
    expect(html).not.toContain("revision 3");
  });

  it("shows compact trustworthy failures and keeps running calls on the existing row", () => {
    const failure = renderPresenter(block("rudder_issue_comment", { error: "denied" }, { issueId: "RUD-1" }, "error"));
    expect(failure).toContain("Action failed");
    expect(failure).toContain('href="/issues/RUD-1"');
    expect(renderPresenter(block("rudder_issue_comment", undefined, { issueId: "RUD-1" }, "running"))).toBe("");
  });

  it("keeps covered running tools as non-expandable progress rows in both Nice surfaces", () => {
    const running = block("rudder_issue_list", undefined, { status: "in_progress" }, "running");
    const detailHtml = renderToStaticMarkup(<TranscriptToolCard block={running} density="comfortable" presentation="detail" />);
    const chatHtml = renderToStaticMarkup(<TranscriptChatToolActionRow block={running} density="comfortable" />);
    for (const html of [detailHtml, chatHtml]) {
      expect(html).toContain("Running");
      expect(html).not.toContain("Expand tool details");
      expect(html).not.toContain(">Input<");
      expect(html).not.toContain(">Response<");
      expect(html).not.toContain("Waiting for result");
    }
  });
});
