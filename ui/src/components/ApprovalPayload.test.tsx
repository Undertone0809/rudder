// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, IssueLabel, Project } from "@rudderhq/shared";
import { ThemeProvider } from "../context/ThemeContext";
import {
  ApprovalPayloadRenderer,
  ChatIssueApprovalLabelPicker,
  approvalPayloadWithChatIssueLabelIds,
  chatIssueApprovalNeedsLabelSelection,
} from "./ApprovalPayload";

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

    expect(html).toContain("Agent proposed a new issue from chat");
    expect(html).toContain("Messenger intake");
    expect(html).toContain('href="/messenger/chat/chat-1"');
    expect(html).toContain("Project Atlas");
    expect(html).toContain("Wesley");
    expect(html).toContain("CTO");
    expect(html).toContain("<h2");
    expect(html).toContain("Review Summary");
    expect(html).toContain("<strong>markdown</strong>");
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
