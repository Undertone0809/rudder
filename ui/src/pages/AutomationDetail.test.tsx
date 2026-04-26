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

const automation = {
  id: "auto-1",
  orgId: "org-1",
  projectId: "project-1",
  goalId: null,
  parentIssueId: null,
  title: "Daily automation review",
  description: "Check the automation detail layout and interaction affordances.",
  assigneeAgentId: "agent-1",
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
            createdAt: "2026-04-25T08:00:00.000Z",
            details: { title: "Daily automation review" },
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
    if (queryKey[0] === "agents") {
      return {
        data: [
          {
            id: "agent-1",
            name: "Ada",
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
  useOrganization: () => ({ selectedOrganizationId: "org-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: vi.fn(),
    setHeaderActions: mockSetHeaderActions,
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
    }: { value: string; onChange: (value: string) => void; placeholder?: string },
    ref,
  ) {
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
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <input
      data-testid="schedule-editor"
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
  vi.clearAllMocks();
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
  it("keeps status compact and removes duplicate in-page controls", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("State");
    expect(container.textContent).toContain("Next run");
    expect(container.textContent).toContain("Last ran");
    expect(container.textContent).toContain("In sync");
    expect(container.textContent).not.toContain("Changes save automatically as you edit instructions, ownership, and delivery rules.");
    expect(container.textContent).not.toContain("Automatic triggers are live.");
    expect(container.textContent).not.toContain("Pause automation");
    expect(container.textContent).not.toContain("Run now");
    expect(container.textContent).not.toContain("Open issue");
    expect(container.querySelector("aside")?.className).toContain("lg:sticky");
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
    expect(headerContainer.querySelector('button[aria-label="Delete automation"]')).toBeTruthy();
    expect(Array.from(headerContainer.querySelectorAll("button")).filter((button) => button.textContent?.includes("Run now"))).toHaveLength(1);

    act(() => {
      headerRoot.unmount();
    });
    headerContainer.remove();
  });

  it("renders the trigger composer guidance next to the primary add action", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const addTriggerButton = Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.includes("Add trigger"));
    expect(addTriggerButton).toBeTruthy();
    expect(addTriggerButton?.hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("Add at least one trigger so the automation has a clear way to start work.");
    expect(container.textContent).toContain("Triggers autosave after edits");
  });
});
