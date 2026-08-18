// @vitest-environment jsdom

import type { Agent, Approval, IssueLabel, Project } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { ApprovalCard } from "./ApprovalCard";
import {
  ApprovalPayloadRenderer,
  ChatIssueApprovalLabelPicker,
  approvalPayloadWithChatIssueLabelIds,
  chatIssueApprovalNeedsLabelSelection,
} from "./ApprovalPayload";

const avatarState = vi.hoisted(() => ({ value: null as string | null }));

vi.mock("../hooks/useCurrentUserAvatar", () => ({
  useCurrentUserAvatar: () => avatarState.value,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div data-testid="mock-dialog-root">{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children: ReactNode;
    showCloseButton?: boolean;
  }) => <div data-slot="dialog-content" {...props}>{children}</div>,
  DialogClose: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => <button data-slot="dialog-close" {...props}>{children}</button>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  avatarState.value = null;
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

const project = {
  id: "project-1",
  name: "Project Atlas",
} as Project;

const agent = {
  id: "agent-1",
  name: "Wesley",
  role: "engineer",
  title: "Founding Engineer",
  icon: "🛠️",
} as Agent;

const reviewerAgent = {
  id: "agent-2",
  name: "CTO",
  role: "cto",
  title: "Chief Technology Officer",
  icon: null,
} as Agent;

function makeIssueLabel(id: string, name: string, color = "#2563eb"): IssueLabel {
  const now = new Date("2026-05-19T00:00:00.000Z");
  return {
    id,
    orgId: "org-1",
    name,
    color,
    createdAt: now,
    updatedAt: now,
  };
}

function renderChatIssueApproval(payload: Record<string, unknown>, context = {}) {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ApprovalPayloadRenderer type="chat_issue_creation" payload={payload} context={context} />
    </ThemeProvider>,
  );
}

function goalChangePayload() {
  return {
    goalId: "goal-internal-id",
    proposalId: "proposal-internal-id",
    expectedContractRevision: 2,
    beforeContract: {
      outcomeStatement: "Ship a verified Goal Workspace",
      objectiveMode: "target",
      criteria: [{
        id: "workflow",
        label: "The operator workflow passes",
        evaluator: "artifact",
      }],
      autonomyEnvelope: {
        allowed: ["bounded_reversible_work", "external_publication"],
        requiresHumanApproval: ["external_publication"],
      },
      humanAuthorities: { acceptance: "board_human", externalPublication: "board_human" },
      evaluationPolicy: { terminalEvidenceRequired: true, humanAcceptanceRequired: true },
    },
    afterContract: {
      outcomeStatement: "Ship a verified Goal Workspace with restart recovery",
      objectiveMode: "maintain",
      criteria: [{
        id: "workflow",
        label: "The operator workflow passes after restart",
        evaluator: "artifact",
        evidenceRequirements: ["artifact://goal-workspace/restart-check"],
      }],
      autonomyEnvelope: { allowed: ["bounded_reversible_work"] },
      humanAuthorities: { acceptance: "board_human" },
      evaluationPolicy: { terminalEvidenceRequired: true },
      evaluationDeadline: "2026-08-22T10:00:00.000Z",
    },
    rationale: "Restart evidence makes the commitment materially stronger.",
    evidenceRefs: ["artifact://goal-workspace/restart-evidence"],
  };
}

function renderGoalChangeApproval() {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ApprovalPayloadRenderer type="goal_change" payload={goalChangePayload()} />
    </ThemeProvider>,
  );
}

function renderGoalChangeApprovalCardDom(onApprove = vi.fn(), onReject = vi.fn()) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  const approval = {
    id: "approval-1",
    orgId: "org-1",
    type: "goal_change",
    requestedByAgentId: null,
    requestedByUserId: null,
    status: "pending",
    payload: goalChangePayload(),
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    createdAt: new Date("2026-08-07T00:00:00.000Z"),
    updatedAt: new Date("2026-08-07T00:00:00.000Z"),
  } as Approval;
  act(() => {
    root.render(
      <ThemeProvider>
        <ApprovalCard
          approval={approval}
          requesterAgent={null}
          onApprove={onApprove}
          onReject={onReject}
          isPending={false}
        />
      </ThemeProvider>,
    );
  });
  return container;
}

function renderChatIssueApprovalDom(payload: Record<string, unknown>, context = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  act(() => {
    root.render(
      <ThemeProvider>
        <ApprovalPayloadRenderer type="chat_issue_creation" payload={payload} context={context} />
      </ThemeProvider>,
    );
  });
  return container;
}

function renderLabelPickerDom({
  labels,
  selectedLabelIds = [],
  onChange = vi.fn(),
  required = false,
}: {
  labels: IssueLabel[];
  selectedLabelIds?: string[];
  onChange?: (labelIds: string[]) => void;
  required?: boolean;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
  act(() => {
    root.render(
      <ThemeProvider>
        <ChatIssueApprovalLabelPicker
          labels={labels}
          selectedLabelIds={selectedLabelIds}
          onChange={onChange}
          required={required}
        />
      </ThemeProvider>,
    );
  });
  return container;
}

describe("ApprovalPayloadRenderer", () => {
  it("uses the account avatar only for the current user in approval principals", () => {
    avatarState.value = "https://example.test/me.png";
    const currentUserHtml = renderChatIssueApproval(
      { title: "Current user", assigneeUserId: "user-1" },
      { currentUserId: "user-1" },
    );
    const otherUserHtml = renderChatIssueApproval(
      { title: "Other user", assigneeUserId: "user-2" },
      { currentUserId: "user-1" },
    );

    expect(currentUserHtml).toContain('data-avatar-url="https://example.test/me.png"');
    expect(otherUserHtml).not.toContain("data-avatar-url");
  });

  it("renders Goal changes as plain-language outcome, change, and boundary summaries", () => {
    const html = renderGoalChangeApproval();

    expect(html).toContain('aria-label="Goal change summary"');
    for (const label of ["Outcome", "Change", "Boundary", "Impact", "Reason"]) {
      expect(html).toContain(`aria-label="${label} summary"`);
      expect(html).toMatch(new RegExp(`<h4[^>]*>${label}</h4>`));
    }
    expect(html).toContain("Ship a verified Goal Workspace with restart recovery");
    expect(html).toContain("Judge success by: The operator workflow passes after restart.");
    expect(html).toContain("Change how success is judged.");
    expect(html).toContain("Set the review target for");
    expect(html).toContain("This proposal changes the agent&#x27;s working limits, human approval responsibilities, and evidence and review expectations.");
    expect(html).toContain("This may require the Agent to replan around the result the Agent is working toward, how success is judged, what the Agent can do independently, which decisions need your approval, what evidence is needed before acceptance, when the work or review is expected.");
    expect(html).toContain('aria-label="Boundary changes"');
    expect(html).toContain("Current:");
    expect(html).toContain("Proposed:");
    expect(html).toContain("bounded, reversible work");
    expect(html).toContain("external publication");
    expect(html).toContain("Your acceptance before completion: required");
    expect(html).toContain("Restart evidence makes the commitment materially stronger.");
    for (const internalDetail of [
      "goal-internal-id",
      "proposal-internal-id",
      "objectiveMode",
      "evaluator",
      "autonomyEnvelope",
      "humanAuthorities",
      "evaluationPolicy",
      "evidenceRefs",
      "artifact://",
      "bounded_reversible_work",
      "board_human",
    ]) {
      expect(html).not.toContain(internalDetail);
    }
  });

  it("wraps long Goal change content without exposing contract JSON", () => {
    const longOutcome = `Ship ${"restart-safe-workspace".repeat(20)}`;
    const longReason = `Because ${"production-shaped-evidence".repeat(20)}`;
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <ApprovalPayloadRenderer
          type="goal_change"
          payload={{
            beforeContract: { outcomeStatement: "Ship the workspace" },
            afterContract: {
              outcomeStatement: longOutcome,
              criteria: [{ label: "The long-running recovery workflow passes", evaluator: "artifact" }],
            },
            rationale: longReason,
            evidenceRefs: ["artifact://internal/long-text-check"],
          }}
        />
      </ThemeProvider>,
    );

    expect(html).toContain(longOutcome);
    expect(html).toContain(longReason);
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).not.toContain("beforeContract");
    expect(html).not.toContain("afterContract");
    expect(html).not.toContain("evaluator");
    expect(html).not.toContain("artifact://");
  });

  it("keeps Goal change approval actions usable around the dedicated renderer", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    const container = renderGoalChangeApprovalCardDom(onApprove, onReject);
    const buttons = Array.from(container.querySelectorAll("button"));
    const approve = buttons.find((button) => button.textContent === "Approve");
    const reject = buttons.find((button) => button.textContent === "Reject");

    expect(container.textContent).toContain("Goal Change");
    expect(approve?.disabled).toBe(false);
    expect(reject?.disabled).toBe(false);
    act(() => approve?.click());
    act(() => reject?.click());
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("renders chat issue proposal Markdown and readable project/assignee labels", () => {
    const html = renderChatIssueApproval(
      {
        chatConversationId: "chat-1",
        proposedIssue: {
          title: "Fix issue approval UI",
          description: [
            "## Review Summary",
            "",
            "- Render **markdown** in the approval preview.",
            "- Preserve inline image assets.",
            "",
            "![](/api/assets/approval-screenshot/content)",
          ].join("\n"),
          priority: "medium",
          projectId: project.id,
          assigneeAgentId: agent.id,
          reviewerAgentId: reviewerAgent.id,
        },
      },
      { projects: [project], agents: [agent, reviewerAgent], chatConversation: { id: "chat-1", title: "Messenger intake" } },
    );

    expect(html).not.toContain("Agent proposed a new issue from chat");
    expect(html).not.toContain("Review the draft before Rudder creates it on the issue board.");
    expect(html).toContain("Messenger intake");
    expect(html).toContain('href="/messenger/chat/chat-1"');
    expect(html).toContain("Project Atlas");
    expect(html).toContain("Wesley");
    expect(html).toContain("CTO");
    expect(html).toContain("<h2");
    expect(html).toContain("Review Summary");
    expect(html).toMatch(/<strong[^>]*>markdown<\/strong>/);
    expect(html).toContain('src="/api/assets/approval-screenshot/content"');
    expect(html).not.toContain("project-1");
    expect(html).not.toContain("agent-1");
  });

  it("does not open inline image preview from issue approval descriptions", () => {
    const container = renderChatIssueApprovalDom({
      chatConversationId: "chat-1",
      proposedIssue: {
        title: "Fix issue approval UI",
        description: "![Approval screenshot](/api/assets/approval-screenshot/content)",
        priority: "medium",
      },
    });

    const image = container.querySelector("img");
    expect(image).toBeTruthy();

    act(() => {
      image?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    expect(document.body.querySelector('[data-testid="markdown-body-image-preview-dialog"]')).toBeNull();
  });

  it("does not expose raw project or agent ids while context is loading", () => {
    const html = renderChatIssueApproval({
      chatConversationId: "chat-raw-id",
      proposedIssue: {
        title: "Fix issue approval UI",
        description: "Render **markdown**.",
        priority: "medium",
        projectId: "project-raw-id",
        assigneeAgentId: "agent-raw-id",
      },
    });

    expect(html).toContain("Unknown project");
    expect(html).toContain("Unknown agent");
    expect(html).toContain("Chat conversation");
    expect(html).not.toContain("project-raw-id");
    expect(html).not.toContain("agent-raw-id");
    expect(html).not.toContain("chat-raw-id");
  });

  it("surfaces required labels for agent-proposed chat issues when the label taxonomy is mature", () => {
    const html = renderChatIssueApproval(
      {
        chatConversationId: "chat-1",
        proposedByAgentId: agent.id,
        proposedIssue: {
          title: "Fix label routing",
          description: "Needs classification before board approval.",
          priority: "medium",
        },
      },
      {
        labels: Array.from({ length: 5 }, (_, index) => ({
          id: `label-${index + 1}`,
          orgId: "org-1",
          name: `Label ${index + 1}`,
          color: "#2563eb",
          createdAt: "",
          updatedAt: "",
        })),
      },
    );

    expect(html).toContain("Labels");
    expect(html).toContain("Required before approval");
  });

  it("renders selected labels by name in chat issue approvals", () => {
    const html = renderChatIssueApproval(
      {
        chatConversationId: "chat-1",
        proposedByAgentId: agent.id,
        proposedIssue: {
          title: "Fix label routing",
          labelIds: ["label-2"],
        },
      },
      {
        labels: [
          { id: "label-1", orgId: "org-1", name: "Operations", color: "#2563eb", createdAt: "", updatedAt: "" },
          { id: "label-2", orgId: "org-1", name: "Engineering", color: "#0f766e", createdAt: "", updatedAt: "" },
        ],
      },
    );

    expect(html).toContain("Engineering");
    expect(html).not.toContain("Required before approval");
  });

  it("renders operator-selected labels for pending chat issue approvals before approval payload persistence", () => {
    const html = renderChatIssueApproval(
      {
        chatConversationId: "chat-1",
        proposedByAgentId: agent.id,
        proposedIssue: {
          title: "Fix label routing",
        },
      },
      {
        selectedLabelIds: ["label-2"],
        labels: [
          makeIssueLabel("label-1", "Operations", "#2563eb"),
          makeIssueLabel("label-2", "Engineering", "#0f766e"),
          makeIssueLabel("label-3", "Design", "#f97316"),
          makeIssueLabel("label-4", "Support", "#9333ea"),
          makeIssueLabel("label-5", "Docs", "#64748b"),
        ],
      },
    );

    expect(html).toContain("Engineering");
    expect(html).not.toContain("Required before approval");
  });

  it("opens inline label choices from the chat issue approval label row", () => {
    const labels: IssueLabel[] = [
      makeIssueLabel("11111111-1111-4111-8111-111111111111", "Operations", "#2563eb"),
      makeIssueLabel("22222222-2222-4222-8222-222222222222", "Engineering", "#0f766e"),
    ];
    const onChange = vi.fn();
    const container = renderChatIssueApprovalDom(
      {
        chatConversationId: "chat-1",
        proposedByAgentId: agent.id,
        proposedIssue: {
          title: "Fix label routing",
          labelIds: [labels[0].id],
        },
      },
      {
        labels,
        selectedLabelIds: [labels[0].id],
        onSelectedLabelIdsChange: onChange,
      },
    );

    expect(container.querySelector('[data-testid="chat-issue-approval-label-picker"]')).toBeNull();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="chat-issue-label-popover-trigger"]');
    expect(trigger).toBeTruthy();
    expect(trigger?.textContent).toContain("Operations");

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const engineeringButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Engineering"));
    expect(engineeringButton).toBeTruthy();

    act(() => {
      engineeringButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith([labels[0].id, labels[1].id]);
  });

  it("lets operators choose labels for chat issue approval payload overrides", () => {
    const labels: IssueLabel[] = [
      makeIssueLabel("11111111-1111-4111-8111-111111111111", "Operations", "#2563eb"),
      makeIssueLabel("22222222-2222-4222-8222-222222222222", "Engineering", "#0f766e"),
    ];
    const onChange = vi.fn();
    const container = renderLabelPickerDom({
      labels,
      selectedLabelIds: [labels[0].id],
      onChange,
      required: true,
    });

    expect(container.textContent).toContain("Required before approval");
    const engineeringButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Engineering"));
    expect(engineeringButton).toBeTruthy();

    act(() => {
      engineeringButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onChange).toHaveBeenCalledWith([labels[0].id, labels[1].id]);

    const payload = approvalPayloadWithChatIssueLabelIds(
      {
        chatConversationId: "chat-1",
        proposedByAgentId: agent.id,
        proposedIssue: { title: "Fix label routing" },
      },
      [labels[1].id],
    );
    expect(payload).toMatchObject({
      proposedIssue: {
        title: "Fix label routing",
        labelIds: [labels[1].id],
      },
    });
    expect(chatIssueApprovalNeedsLabelSelection(payload, [
      ...labels,
      makeIssueLabel("33333333-3333-4333-8333-333333333333", "Support", "#a21caf"),
      makeIssueLabel("44444444-4444-4444-8444-444444444444", "Growth", "#c2410c"),
      makeIssueLabel("55555555-5555-4555-8555-555555555555", "Design", "#4338ca"),
    ])).toBe(false);
  });
});
