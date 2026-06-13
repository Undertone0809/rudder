// @vitest-environment jsdom

import { act, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../context/I18nContext";
import { AutomationDetail } from "./AutomationDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockNavigate = vi.fn();
const mockSetHeaderActions = vi.fn();
const mockConfirm = vi.fn(async () => true);
const markdownEditorProps = vi.hoisted(() => [] as Array<{ mentions?: Array<{ id: string; kind?: string; name: string }> }>);
const mutationCalls = vi.hoisted(() => [] as Array<unknown>);

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
  notifyOnIssueCreated: false,
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
    mutate: vi.fn((variables: unknown) => {
      mutationCalls.push(variables);
    }),
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

beforeEach(() => {
  automation.outputMode = "track_issue";
  automation.chatConversationId = null;
  automation.chatConversation = null;
  automation.recentRuns[0]!.linkedChatConversationId = null;
  automation.recentRuns[0]!.linkedChatConversation = null;
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  markdownEditorProps.length = 0;
  mutationCalls.length = 0;
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
    root.render(
      <I18nProvider>
        <AutomationDetail />
      </I18nProvider>,
    );
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
    expect(container.textContent).toContain("Output");
    expect(container.textContent).toContain("Track as issue");
    expect(container.textContent).toContain("Repeats");
    expect(container.textContent).toContain("Next run");
    expect(container.textContent).toContain("Project");
    expect(container.textContent).toContain("Run status");
    expect(container.textContent).toContain("Manual run is in progress");
    expect(container.textContent).toContain("AUT-7");
    expect(container.textContent).toContain("Added schedule trigger");
    expect(container.textContent).toContain("for Schedule 0 10 * * *");
    expect(container.textContent).toContain("Live run widget");
    expect(container.textContent).toContain("Last ran");
    expect(container.textContent).toContain("In sync");
    expect(container.textContent).toContain("Active run");
    expect(container.textContent).toContain("Repeats");
    expect(container.textContent).toContain("Issue");
    expect(container.textContent).not.toContain("Details");
    expect(container.textContent).not.toContain("Changes save automatically as you edit instructions, ownership, and delivery rules.");
    expect(container.textContent).not.toContain("Automatic triggers are live.");
    expect(container.textContent).not.toContain("Previous runs");
    expect(container.textContent).not.toContain('Updated automation settings for "Daily automation review"');
    expect(container.textContent).not.toContain("automation updated");
    expect(container.textContent).not.toContain("Automation updated");
    expect(container.textContent).not.toContain("Title: Daily automation review");
    expect(container.textContent).not.toContain("Execution issue is active");
    expect(container.textContent).not.toContain("Activity recorded");
    expect(container.textContent).not.toContain("kind: schedule");
    expect(container.textContent).not.toContain("Pause automation");
    expect(container.textContent).not.toContain("Run now");
    expect(container.querySelector('[role="switch"]')?.getAttribute("aria-label")).toBe("Follow issues created by this automation");
    const sidebar = container.querySelector("aside");
    expect(sidebar?.className).toContain("lg:sticky");
    expect(sidebar?.className).not.toContain("overflow-y-auto");
    expect(sidebar?.className).not.toContain("max-h");
    expect(sidebar?.className).not.toContain("scrollbar-auto-hide");
    const configurationCard = container.querySelector('[data-testid="automation-configuration-card"]');
    expect(configurationCard).toBeTruthy();
    expect(configurationCard?.className).toContain("bg-card/85");
    expect(configurationCard?.className).not.toContain("bg-[#fbfaf7]");
    expect(configurationCard?.textContent).toContain("Triggers");
    expect(configurationCard?.querySelector('[data-testid="automation-add-trigger-button"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="automation-add-trigger-card"]')).toBeNull();
    await act(async () => {
      configurationCard
        ?.querySelector('[data-testid="automation-add-trigger-button"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    const addTriggerCard = document.querySelector('[data-testid="automation-add-trigger-card"]');
    expect(addTriggerCard).toBeTruthy();
    expect(addTriggerCard?.className).toContain("w-[min(320px,calc(100vw-2rem))]");
    expect(addTriggerCard?.className).toContain("max-h-[min(28rem,var(--radix-popover-content-available-height))]");
    expect(addTriggerCard?.textContent).toContain("Schedule");
    expect(addTriggerCard?.textContent).toContain("Create trigger");
    expect(configurationCard?.querySelector('[data-testid="automation-triggers-list"]')).toBeTruthy();
    expect(document.querySelector('[data-testid="automation-trigger-editor-body"]')).toBeNull();
    const deliveryRules = configurationCard?.querySelector('[data-testid="automation-delivery-rules-section"]');
    expect(deliveryRules?.className).toContain("rounded-md");
    expect(deliveryRules?.className).toContain("bg-background/35");
    expect(deliveryRules?.className).not.toContain("border-t");
    const overviewStrip = container.querySelector('[data-testid="automation-overview-strip"]');
    expect(overviewStrip?.textContent).toContain("Active");
    expect(overviewStrip?.textContent).toContain("Repeats");
    expect(overviewStrip?.textContent).toContain("Next");
    expect(overviewStrip?.textContent).toContain("Issue");
    expect(overviewStrip?.textContent).not.toContain("Action");
    expect(overviewStrip?.textContent).not.toContain("Risk");
    expect(overviewStrip?.textContent).not.toContain("Automation UX");
    expect(overviewStrip?.textContent).not.toContain("Ada");
    const activitySection = container.querySelector('section[aria-label="Activity"]');
    expect(activitySection).toBeTruthy();
    expect(activitySection?.textContent).toContain("Activity");
    const activityList = activitySection?.querySelector('[data-testid="automation-activity-list"]');
    expect(activityList).toBeTruthy();
    expect(activityList?.className).toContain("before:left-[7.5px]");
    const activityRow = activitySection?.querySelector('[data-testid="automation-activity-row"]');
    expect(activityRow?.className).toContain("min-h-8");
    expect(activityRow?.className).toContain("grid-cols-[16px_minmax(0,1fr)]");
    expect(activityRow?.className).toContain("sm:grid-cols-[16px_minmax(0,1fr)_auto]");
    expect(activityRow?.firstElementChild?.className).toContain("justify-center");
    expect(activityRow?.querySelector('[data-testid="automation-activity-summary"]')?.className).toContain("whitespace-nowrap");
    expect(activityRow?.querySelector('[data-testid="automation-activity-summary"] span')?.className).toContain("truncate");
    expect(activityRow?.querySelector("svg")).toBeNull();
    expect(container.querySelector('[data-testid="automation-detail-agent-control"]')?.textContent).toContain("Ada");
    expect(container.querySelector('[data-testid="automation-detail-project-control"]')?.textContent).toContain("Automation UX");
  });

  it("shows chat output without a redundant per-run chat selector", async () => {
    automation.outputMode = "chat_output";
    automation.chatConversationId = null;
    automation.chatConversation = null;

    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Send to chat");
    expect(container.querySelector('[data-testid="automation-configuration-card"]')?.textContent).not.toContain("New chat");
    expect(container.textContent).not.toContain("Search chats");
  });

  it("autosaves the issue-created notification opt-in", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const notifySwitch = container.querySelector('button[role="switch"][aria-label="Follow issues created by this automation"]');
    expect(notifySwitch).toBeTruthy();
    expect(notifySwitch?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      notifySwitch?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 760));
    });

    expect(mutationCalls).toContainEqual(expect.objectContaining({
      notifyOnIssueCreated: true,
      outputMode: "track_issue",
    }));
  });

  it("keeps delivery rule controls contained in the sidebar width", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const deliveryRules = container.querySelector('[data-testid="automation-delivery-rules-section"]');
    const toggle = Array.from(deliveryRules?.querySelectorAll("button") ?? []).find((button) => button.textContent?.includes("Delivery rules"));

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const selectTriggers = Array.from(deliveryRules?.querySelectorAll("button") ?? [])
      .filter((button) => /coalesce if active|skip missed/.test(button.textContent ?? ""));

    expect(selectTriggers).toHaveLength(2);
    for (const trigger of selectTriggers) {
      expect(trigger.className).toContain("w-full");
    }
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
      headerRoot.render(
        <I18nProvider>
          <>{headerActions}</>
        </I18nProvider>,
      );
  });

    const statusSwitch = headerContainer.querySelector('button[role="switch"][aria-label="Disable automation"]');
    expect(statusSwitch).toBeTruthy();
    expect(statusSwitch?.getAttribute("aria-checked")).toBe("true");
    expect(headerContainer.textContent).toContain("On");
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

    expect((container.textContent?.match(/In sync/g) ?? []).length).toBe(1);
    const triggersList = container.querySelector('[data-testid="automation-triggers-list"]');
    expect(triggersList?.textContent).toContain("Schedule 0 10 * * *");
    expect(triggersList?.textContent).toContain("Next:");
    expect(triggersList?.textContent).not.toContain("daily-check");
    expect(triggersList?.textContent).not.toContain("In sync");
    expect(document.querySelector('[data-testid="automation-trigger-editor-body"]')).toBeNull();

    const editTriggerButton = container.querySelector('button[aria-label="Edit trigger"]');
    expect(editTriggerButton).toBeTruthy();

    await act(async () => {
      editTriggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.querySelector('[data-testid="automation-trigger-editor-body"]')).toBeTruthy();
    const triggerEditorBody = document.querySelector('[data-testid="automation-trigger-editor-body"]');
    expect(triggerEditorBody?.textContent).not.toContain("Label");
    expect(triggerEditorBody?.textContent).not.toContain("daily-check");
    expect(document.querySelector('[data-testid="automation-trigger-editor-body"] [data-testid="schedule-editor"]')?.getAttribute("data-variant")).toBe("compact");
    expect(container.querySelector('button[aria-label="Collapse trigger editor"]')).toBeNull();

    const deleteTriggerButton = container.querySelector('button[aria-label="Delete trigger"]');
    expect(deleteTriggerButton).toBeTruthy();

    await act(async () => {
      deleteTriggerButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockConfirm).toHaveBeenCalledWith({
      title: "Delete schedule trigger?",
      description: "It will stop new schedule activations.",
      confirmLabel: "Delete",
      tone: "destructive",
    });
  });
});
