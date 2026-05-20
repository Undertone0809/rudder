// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationDetail } from "./AutomationDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockNavigate = vi.fn();
const mockSetHeaderActions = vi.fn();
const mockConfirm = vi.fn(async () => true);
const markdownEditorProps = vi.hoisted(() => [] as Array<{ mentions?: Array<{ id: string; kind?: string; name: string }> }>);

const automation = {
  id: "auto-1",
  orgId: "org-1",
  projectId: "project-1",
  goalId: null,
  parentIssueId: null,
  title: "Daily automation review",
  description: "Check the automation detail layout and interaction affordances.",
  assigneeAgentId: "agent-1",
  outputMode: "track_issue",
  chatConversationId: null,
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: "2026-04-25T08:00:00.000Z",
  lastEnqueuedAt: "2026-04-25T08:00:00.000Z",
  createdAt: "2026-04-24T08:00:00.000Z",
  updatedAt: "2026-04-25T08:00:00.000Z",
  project: {
    id: "project-1",
    name: "Automation UX",
    description: "Automation UX work",
    status: "active",
    goalId: null,
  },
  assignee: {
    id: "agent-1",
    name: "Ada",
    role: "engineer",
    title: "Automation UX Agent",
  },
  parentIssue: null,
  chatConversation: null,
  triggers: [
    {
      id: "trigger-1",
      orgId: "org-1",
      automationId: "auto-1",
      kind: "schedule",
      label: "daily-check",
      enabled: true,
      cronExpression: "0 10 * * *",
      timezone: "UTC",
      nextRunAt: "2026-04-26T10:00:00.000Z",
      lastFiredAt: "2026-04-25T10:00:00.000Z",
      publicId: null,
      secretId: null,
      signingMode: null,
      replayWindowSec: null,
      lastRotatedAt: null,
      lastResult: "success",
      createdByAgentId: null,
      createdByUserId: null,
      updatedByAgentId: null,
      updatedByUserId: null,
      createdAt: "2026-04-24T08:00:00.000Z",
      updatedAt: "2026-04-25T08:00:00.000Z",
    },
  ],
  recentRuns: [
    {
      id: "run-1",
      orgId: "org-1",
      automationId: "auto-1",
      triggerId: "trigger-1",
      source: "manual",
      status: "running",
      triggeredAt: "2026-04-25T08:00:00.000Z",
      idempotencyKey: null,
      triggerPayload: null,
      linkedIssueId: "issue-1",
      linkedChatConversationId: null,
      startedChatMessageId: null,
      terminalChatMessageId: null,
      lastChatMessageId: null,
      coalescedIntoRunId: null,
      failureReason: null,
      completedAt: null,
      createdAt: "2026-04-25T08:00:00.000Z",
      updatedAt: "2026-04-25T08:00:00.000Z",
      linkedIssue: {
        id: "issue-1",
        identifier: "AUT-7",
        title: "Execution issue",
        status: "in_progress",
        priority: "medium",
        updatedAt: "2026-04-25T08:00:00.000Z",
      },
      linkedChatConversation: null,
      trigger: {
        id: "trigger-1",
        kind: "schedule",
        label: "daily-check",
      },
    },
  ],
  activeIssue: {
    id: "issue-1",
    identifier: "AUT-7",
    title: "Execution issue",
    status: "in_progress",
    priority: "medium",
    updatedAt: "2026-04-25T08:00:00.000Z",
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "automations" && queryKey[1] === "detail") {
      return { data: automation, isLoading: false, error: null };
    }
    if (queryKey[0] === "automations" && queryKey[1] === "runs") {
      return { data: automation.recentRuns, isLoading: false, error: null };
    }
    if (queryKey[0] === "automations" && queryKey[1] === "activity") {
      return {
        data: [
          {
            id: "evt-1",
            action: "automation.updated",
            entityType: "automation",
            entityId: "auto-1",
            createdAt: "2026-04-25T08:00:00.000Z",
            details: { title: "Daily automation review" },
          },
          {
            id: "evt-2",
            action: "automation.trigger_created",
            entityType: "automation_trigger",
            entityId: "trigger-1",
            createdAt: "2026-04-24T09:00:00.000Z",
            details: { automationId: "auto-1", kind: "schedule" },
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues" && queryKey[1] === "live-runs") {
      return {
        data: [
          {
            id: "live-run-1",
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "issues") {
      return {
        data: [
          {
            id: "issue-2",
            identifier: "AUT-8",
            title: "Review automation instructions",
            status: "todo",
            projectId: "project-1",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "organization-skills") {
      return { data: [], isLoading: false, error: null };
    }
    if (queryKey[0] === "agents" && queryKey[1] === "skills") {
      return {
        data: {
          agentRuntimeType: "codex_local",
          supported: true,
          mode: "persistent",
          desiredSkills: ["agent:build-advisor"],
          entries: [
            {
              key: "build-advisor",
              selectionKey: "agent:build-advisor",
              runtimeName: "build-advisor",
              desired: true,
              configurable: true,
              alwaysEnabled: false,
              managed: false,
              state: "configured",
              sourceClass: "agent_home",
              sourcePath: "/workspace/agents/ada/skills/build-advisor",
            },
          ],
        },
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "agents") {
      return {
        data: [
          {
            id: "agent-1",
            name: "Ada",
            urlKey: "ada",
            role: "engineer",
            title: "Automation UX Agent",
            status: "active",
            icon: null,
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[0] === "projects") {
      return {
        data: [
          {
            id: "project-1",
            name: "Automation UX",
            description: "Automation UX work",
            color: "#6366f1",
          },
        ],
        isLoading: false,
        error: null,
      };
    }
    return { data: [], isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => mockNavigate,
  useParams: () => ({ automationId: "auto-1" }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", urlKey: "zst" },
  }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setHeaderActions: mockSetHeaderActions,
  }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    confirm: mockConfirm,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    {
      value,
      onChange,
      placeholder,
      mentions,
    }: {
      value: string;
      onChange: (value: string) => void;
      placeholder?: string;
      mentions?: Array<{ id: string; kind?: string; name: string }>;
    },
    ref,
  ) {
    markdownEditorProps.push({ mentions });
    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
    }));
    return (
      <textarea
        aria-label="Instructions"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }),
}));

vi.mock("../components/InlineEntitySelector", () => ({
  InlineEntitySelector: forwardRef(function MockInlineEntitySelector(
    {
      value,
      options,
      renderTriggerValue,
      placeholder,
    }: {
      value: string;
      options: Array<{ id: string; label: string }>;
      renderTriggerValue?: (option: { id: string; label: string } | undefined) => import("react").ReactNode;
      placeholder?: string;
    },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      focus: vi.fn(),
    }));
    const option = options.find((item) => item.id === value);
    return <button type="button">{renderTriggerValue?.(option) ?? option?.label ?? placeholder ?? "Select"}</button>;
  }),
}));

vi.mock("../components/ScheduleEditor", () => ({
  ScheduleEditor: ({
    value,
    onChange,
    variant,
  }: {
    value: string;
    onChange: (value: string) => void;
    variant?: "default" | "compact";
  }) => (
    <input
      data-testid="schedule-editor"
      data-variant={variant ?? "default"}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  describeSchedule: (value: string) => `Schedule ${value}`,
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading…</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span aria-hidden="true">icon</span>,
}));

vi.mock("../components/LiveRunWidget", () => ({
  LiveRunWidget: () => <div>Live run widget</div>,
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  markdownEditorProps.length = 0;
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
});

function renderPage() {
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
    root.render(<AutomationDetail />);
  });

  return container;
}

describe("AutomationDetail", () => {
  it("keeps run state compact and moves high-frequency fields into the configuration rail", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Configuration");
    expect(container.textContent).toContain("Assignee");
    expect(container.textContent).toContain("Run output");
    expect(container.textContent).toContain("Track as issue");
    expect(container.textContent).toContain("Schedule");
    expect(container.textContent).toContain("Project");
    expect(container.textContent).toContain("Run status");
    expect(container.textContent).toContain("Manual run is in progress");
    expect(container.textContent).toContain("AUT-7");
    expect(container.textContent).toContain('Updated automation settings for "Daily automation review"');
    expect(container.textContent).toContain("Added schedule trigger");
    expect(container.textContent).toContain("for Schedule 0 10 * * *");
    expect(container.textContent).toContain("Live run widget");
    expect(container.textContent).toContain("Last ran");
    expect(container.textContent).toContain("In sync");
    expect(container.textContent).toContain("Action");
    expect(container.textContent).toContain("Risk");
    expect(container.textContent).toContain("Monitor run");
    expect(container.textContent).toContain("Active run");
    expect(container.textContent).toContain("Repeats");
    expect(container.textContent).toContain("Issue");
    expect(container.textContent).not.toContain("Details");
    expect(container.textContent).not.toContain("Changes save automatically as you edit instructions, ownership, and delivery rules.");
    expect(container.textContent).not.toContain("Automatic triggers are live.");
    expect(container.textContent).not.toContain("Previous runs");
    expect(container.textContent).not.toContain("automation updated");
    expect(container.textContent).not.toContain("Automation updated");
    expect(container.textContent).not.toContain("Title: Daily automation review");
    expect(container.textContent).not.toContain("Execution issue is active");
    expect(container.textContent).not.toContain("Activity recorded");
    expect(container.textContent).not.toContain("kind: schedule");
    expect(container.textContent).not.toContain("Pause automation");
    expect(container.textContent).not.toContain("Run now");
    expect(container.querySelector('[role="switch"]')).toBeNull();
    expect(container.querySelector("aside")?.className).toContain("lg:sticky");
    const configurationCard = container.querySelector('[data-testid="automation-configuration-card"]');
    expect(configurationCard).toBeTruthy();
    expect(configurationCard?.className).toContain("bg-card/85");
    expect(configurationCard?.className).not.toContain("bg-[#fbfaf7]");
    expect(configurationCard?.textContent).toContain("Triggers");
    expect(configurationCard?.querySelector('[data-testid="automation-add-trigger-button"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="automation-add-trigger-card"]')).toBeNull();
    expect(configurationCard?.querySelector('[data-testid="automation-triggers-list"]')).toBeTruthy();
    expect(configurationCard?.querySelector('[data-testid="automation-trigger-editor-body"]')?.hasAttribute("hidden")).toBe(true);
    const overviewStrip = container.querySelector('[data-testid="automation-overview-strip"]');
    expect(overviewStrip?.textContent).toContain("Active");
    expect(overviewStrip?.textContent).not.toContain("Automation UX");
    expect(overviewStrip?.textContent).not.toContain("Ada");
    expect(container.querySelector('[data-testid="automation-detail-agent-control"]')?.textContent).toContain("Ada");
    expect(container.querySelector('[data-testid="automation-detail-project-control"]')?.textContent).toContain("Automation UX");
  });

  it("registers the header as the only manual action surface", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerActions = [...mockSetHeaderActions.mock.calls]
      .map(([actions]) => actions)
      .findLast((actions) => actions !== null);
    expect(headerActions).toBeTruthy();

    const headerContainer = document.createElement("div");
    document.body.appendChild(headerContainer);
    const headerRoot = createRoot(headerContainer);

    act(() => {
      headerRoot.render(<>{headerActions}</>);
    });

    expect(headerContainer.querySelector('button[aria-label="Pause automation"]')).toBeTruthy();
    const deleteButton = headerContainer.querySelector('button[aria-label="Delete automation"]');
    expect(deleteButton).toBeTruthy();
    expect(Array.from(headerContainer.querySelectorAll("button")).filter((button) => button.textContent?.includes("Run now"))).toHaveLength(1);

    await act(async () => {
      deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mockConfirm).toHaveBeenCalledWith({
      title: 'Delete "Daily automation review"?',
      description: "This will permanently remove the automation and stop future runs.",
      confirmLabel: "Delete",
      tone: "destructive",
    });

    act(() => {
      headerRoot.unmount();
    });
    headerContainer.remove();
  });

  it("passes agent, project, issue, and assignee skill mentions to the instructions editor", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const mentionIds = markdownEditorProps.at(-1)?.mentions?.map((mention) => mention.id) ?? [];
    expect(mentionIds).toEqual(expect.arrayContaining([
      "agent:agent-1",
      "project:project-1",
      "issue:issue-2",
      "skill:agent:build-advisor",
    ]));
  });

  it("opens the compact trigger composer from the primary add action", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const addTriggerButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Add trigger"));
    expect(addTriggerButton).toBeTruthy();
    expect(addTriggerButton?.hasAttribute("disabled")).toBe(false);
    expect(document.querySelector('[data-testid="automation-add-trigger-card"]')).toBeNull();

    await act(async () => {
      addTriggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="automation-add-trigger-card"]')).toBeTruthy();
    expect(document.body.textContent).toContain("Schedule");
    expect(document.body.textContent).toContain("Create trigger");
    expect(document.querySelector('[data-testid="schedule-editor"]')?.getAttribute("data-variant")).toBe("compact");
  });

  it("shows per-trigger sync status and confirms before deleting a trigger", async () => {
    mockConfirm.mockResolvedValue(false);
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect((container.textContent?.match(/In sync/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const triggerEditorBody = container.querySelector('[data-testid="automation-trigger-editor-body"]');
    expect(triggerEditorBody?.hasAttribute("hidden")).toBe(true);

    const editTriggerButton = container.querySelector('button[aria-label="Edit trigger"]');
    expect(editTriggerButton).toBeTruthy();

    await act(async () => {
      editTriggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(triggerEditorBody?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector('button[aria-label="Collapse trigger editor"]')).toBeTruthy();

    const deleteTriggerButton = container.querySelector('button[aria-label="Delete trigger"]');
    expect(deleteTriggerButton).toBeTruthy();

    await act(async () => {
      deleteTriggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockConfirm).toHaveBeenCalledWith({
      title: 'Delete trigger "daily-check"?',
      description: "It will stop new schedule activations.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
  });
});
