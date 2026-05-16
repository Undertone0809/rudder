// @vitest-environment jsdom

import { act, forwardRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Automations } from "./Automations";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockNavigate = vi.fn();
const mockSetHeaderActions = vi.fn();
const markdownEditorProps = vi.hoisted(() => [] as Array<{ mentions?: Array<{ id: string; kind?: string; name: string }> }>);
const automationListState = vi.hoisted(() => ({ items: [] as unknown[] }));

const automation = {
  id: "auto-1",
  orgId: "org-1",
  projectId: "project-1",
  goalId: null,
  parentIssueId: null,
  title: "flomo memo export",
  description: "Export recent memos.",
  assigneeAgentId: "agent-1",
  priority: "medium",
  status: "active",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
  createdByAgentId: null,
  createdByUserId: null,
  updatedByAgentId: null,
  updatedByUserId: null,
  lastTriggeredAt: "2026-05-11T12:35:18",
  lastEnqueuedAt: "2026-05-11T12:35:18",
  createdAt: "2026-05-11T12:00:00",
  updatedAt: "2026-05-11T12:35:18",
  lastRun: {
    id: "run-1",
    orgId: "org-1",
    automationId: "auto-1",
    triggerId: "trigger-1",
    source: "schedule",
    status: "issue_created",
    triggeredAt: "2026-05-11T12:35:18",
    idempotencyKey: null,
    triggerPayload: null,
    linkedIssueId: "issue-1",
    coalescedIntoRunId: null,
    failureReason: null,
    completedAt: "2026-05-11T12:35:20",
    createdAt: "2026-05-11T12:35:18",
    updatedAt: "2026-05-11T12:35:20",
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "automations") {
      return { data: automationListState.items, isLoading: false, error: null };
    }
    if (queryKey[0] === "organization-skills") {
      return { data: [], isLoading: false, error: null };
    }
    if (queryKey[0] === "issues") {
      return {
        data: [
          {
            id: "issue-1",
            identifier: "AUT-7",
            title: "Review automation output",
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
              sourcePath: "/workspace/agents/mira/skills/build-advisor",
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
            name: "Mira",
            urlKey: "mira",
            role: "assistant",
            title: "Zeeland Personal Assistant",
            status: "active",
            icon: null,
          },
        ],
      };
    }
    if (queryKey[0] === "projects") {
      return {
        data: [
          {
            id: "project-1",
            name: "uranus",
            description: null,
            color: "#22c55e",
          },
        ],
      };
    }
    return { data: [], isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
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

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: vi.fn(),
  }),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    props: {
      mentions?: Array<{ id: string; kind?: string; name: string }>;
      value?: string;
      onChange?: (value: string) => void;
      placeholder?: string;
    },
    _ref,
  ) {
    markdownEditorProps.push(props);
    return (
      <textarea
        aria-label="Instructions"
        value={props.value ?? ""}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange?.(event.target.value)}
      />
    );
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
      aria-label="Schedule"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
  describeSchedule: (value: string) => `Schedule ${value}`,
}));

vi.mock("../components/InlineEntitySelector", () => ({
  InlineEntitySelector: ({
    options,
    onChange,
    placeholder,
  }: {
    options: Array<{ id: string; label: string }>;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <button type="button" onClick={() => onChange(options[0]?.id ?? "")}>
      {placeholder ?? "Select"}
    </button>
  ),
}));

vi.mock("../components/PageSkeleton", () => ({
  PageSkeleton: () => <div>Loading...</div>,
}));

vi.mock("../components/EmptyState", () => ({
  EmptyState: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../components/AgentIconPicker", () => ({
  AgentIcon: () => <span aria-hidden="true">icon</span>,
}));

let cleanupFn: (() => void) | null = null;

beforeEach(() => {
  document.documentElement.lang = "en";
  automationListState.items = [automation];
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
    },
  });
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  markdownEditorProps.length = 0;
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
    root.render(<Automations />);
  });

  return container;
}

function renderHeaderActions() {
  const headerContainer = document.createElement("div");
  document.body.appendChild(headerContainer);
  const headerRoot = createRoot(headerContainer);
  cleanupFn = ((previousCleanup) => () => {
    act(() => {
      headerRoot.unmount();
    });
    headerContainer.remove();
    previousCleanup?.();
  })(cleanupFn);

  act(() => {
    headerRoot.render(mockSetHeaderActions.mock.calls.at(-1)?.[0]);
  });

  return headerContainer;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Automations", () => {
  it("renders use-case templates in the empty state and prefills the automation composer", async () => {
    automationListState.items = [];
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("No automations yet");
    expect(container.textContent).toContain("Bug triage");
    expect(container.textContent).toContain("Daily standup");
    expect(container.textContent).toContain("Weekly progress report");
    expect(container.textContent).toContain("Create custom automation");
    expect(container.textContent).not.toContain("Start from scratch");
    expect(container.querySelector('[data-testid="automation-template-grid"]')).toBeTruthy();

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Bug triage"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation name"]') as HTMLTextAreaElement | null;
    const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
    const scheduleInput = document.querySelector('input[aria-label="Schedule"]') as HTMLInputElement | null;
    expect(titleInput?.value).toBe("Bug triage");
    expect(runbookInput?.value).toContain("List all open issues labeled bug");
    expect(scheduleInput?.value).toBe("0 9 * * 1-5");
    expect(document.body.textContent).toContain("Run output");
    expect(document.body.textContent).toContain("Send to chat");
    expect(document.body.textContent).toContain("Create automation");

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Send to chat"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(runbookInput?.value).toContain("relevant Rudder chat conversation");
  });

  it("renders localized use-case templates for Chinese UI", async () => {
    document.documentElement.lang = "zh-CN";
    automationListState.items = [];
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Bug 分诊");
    expect(container.textContent).toContain("日会");
    expect(container.textContent).toContain("周进展报告");

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("日会"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation name"]') as HTMLTextAreaElement | null;
    const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
    expect(titleInput?.value).toBe("日会");
    expect(runbookInput?.value).toContain("上一个工作日以来更新的进行中任务");
    expect(runbookInput?.value).toContain("发送到相关 Rudder chat");
  });

  it("renders last run as a fixed timestamp without the run status caption", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2026-05-11 12:35:18");
    expect(container.textContent).not.toContain("issue created");
  });

  it("passes agent, project, issue, and selected-assignee skill mentions to the create editor", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const baseMentionIds = markdownEditorProps.at(-1)?.mentions?.map((mention) => mention.id) ?? [];
    expect(baseMentionIds).toEqual(expect.arrayContaining([
      "agent:agent-1",
      "project:project-1",
      "issue:issue-1",
    ]));

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Select agent"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const selectedMentionIds = markdownEditorProps.at(-1)?.mentions?.map((mention) => mention.id) ?? [];
    expect(selectedMentionIds).toContain("skill:agent:build-advisor");
  });

  it("allows creating an automation without selecting a project", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation name"]') as HTMLTextAreaElement | null;
    expect(titleInput).toBeTruthy();

    await act(async () => {
      setTextareaValue(titleInput!, "帮我 flomo 打 tag");
    });
    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Select agent"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const createButton = Array.from(document.body.querySelectorAll("button"))
      .filter((button) => button.textContent?.includes("Create automation"))
      .at(-1) as HTMLButtonElement | undefined;
    expect(createButton).toBeTruthy();
    expect(createButton?.disabled).toBe(false);
  });
});
