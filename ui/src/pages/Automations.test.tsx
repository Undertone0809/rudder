// @vitest-environment jsdom

import { act, forwardRef, type RefObject, useImperativeHandle, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../context/I18nContext";
import { Automations } from "./Automations";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockNavigate = vi.fn();
const mockSetHeaderActions = vi.fn();
const mockConfirm = vi.fn(async () => true);
const markdownEditorProps = vi.hoisted(() => [] as Array<{
  engine?: string;
  mentions?: Array<{ id: string; kind?: string; name: string }>;
  mentionMenuAnchorRef?: RefObject<HTMLElement | null>;
  mentionMenuPlacement?: "caret" | "container";
  plainText?: boolean;
}>);
const automationListState = vi.hoisted(() => ({ items: [] as unknown[] }));
const automationRouteState = vi.hoisted(() => ({ automationId: undefined as string | undefined }));
const mockCreateAutomation = vi.hoisted(() => vi.fn(async () => ({ id: "created-auto-1" })));
const mockCreateTrigger = vi.hoisted(() => vi.fn(async () => ({ trigger: { id: "trigger-created-1" }, secretMaterial: null })));

const automation = {
  id: "auto-1",
  orgId: "org-1",
  projectId: "project-1",
  goalId: null,
  parentIssueId: null,
  title: "flomo memo export",
  description: "Export recent memos.",
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
    linkedChatConversationId: null,
    startedChatMessageId: null,
    terminalChatMessageId: null,
    lastChatMessageId: null,
    coalescedIntoRunId: null,
    failureReason: null,
    completedAt: "2026-05-11T12:35:20",
    createdAt: "2026-05-11T12:35:18",
    updatedAt: "2026-05-11T12:35:20",
    linkedIssue: {
      id: "issue-1",
      identifier: "AUT-7",
      title: "Review automation output",
      status: "todo",
      priority: "medium",
      updatedAt: "2026-05-11T12:35:20",
    },
    linkedChatConversation: null,
    trigger: {
      id: "trigger-1",
      kind: "schedule",
      label: null,
    },
  },
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "health") {
      return {
        data: { uiLocale: document.documentElement.lang === "zh-CN" ? "zh-CN" : "en" },
        isLoading: false,
        error: null,
      };
    }
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
  useMutation: (options?: {
    mutationFn?: (variables: unknown) => Promise<unknown> | unknown;
    onSuccess?: (data: unknown, variables: unknown) => Promise<void> | void;
    onError?: (error: unknown, variables: unknown) => Promise<void> | void;
    onSettled?: () => Promise<void> | void;
  }) => ({
    mutate: vi.fn(async (variables?: unknown) => {
      try {
        const result = await options?.mutationFn?.(variables);
        await options?.onSuccess?.(result, variables);
        return result;
      } catch (error) {
        await options?.onError?.(error, variables);
        throw error;
      } finally {
        await options?.onSettled?.();
      }
    }),
    isPending: false,
    isError: false,
    error: null,
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("../api/automations", () => ({
  automationsApi: {
    list: vi.fn(),
    create: mockCreateAutomation,
    createTrigger: mockCreateTrigger,
    get: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    listRuns: vi.fn(),
    run: vi.fn(),
    activity: vi.fn(),
  },
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockNavigate,
  useParams: () => automationRouteState,
}));

vi.mock("./AutomationDetail", () => ({
  AutomationDetail: ({ automationId, onClose }: { automationId: string; onClose: () => void }) => (
    <div data-testid="mock-automation-detail">
      <span>{automationId}</span>
      <button type="button" onClick={onClose}>Close automation detail</button>
    </div>
  ),
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
    props: {
      mentions?: Array<{ id: string; kind?: string; name: string }>;
      engine?: string;
      value?: string;
      onChange?: (value: string) => void;
      placeholder?: string;
      mentionMenuAnchorRef?: RefObject<HTMLElement | null>;
      mentionMenuPlacement?: "caret" | "container";
      plainText?: boolean;
    },
    ref,
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    useImperativeHandle(ref, () => ({
      focus: () => textareaRef.current?.focus(),
      getMarkdown: () => textareaRef.current?.value ?? props.value ?? "",
    }));
    markdownEditorProps.push(props);
    return (
      <textarea
        ref={textareaRef}
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
  automationRouteState.automationId = undefined;
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
        <Automations />
      </I18nProvider>,
    );
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
    headerRoot.render(
      <I18nProvider>
        {mockSetHeaderActions.mock.calls.at(-1)?.[0]}
      </I18nProvider>,
    );
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
    expect(container.textContent).not.toContain("Advisor review loop");
    expect(container.textContent).toContain("Daily review");
    expect(container.textContent).toContain("Bug triage");
    expect(container.textContent).toContain("Daily standup review");
    expect(container.textContent).toContain("Weekly progress report");
    expect(container.textContent).not.toContain("Dependency audit");
    expect(container.textContent).not.toContain("Create custom automation");
    expect(container.textContent).not.toContain("Start from scratch");
    expect(container.querySelector('[data-testid="automation-template-grid"]')).toBeTruthy();

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Bug triage"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation title"]') as HTMLTextAreaElement | null;
    const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
    expect(titleInput?.value).toBe("Bug triage");
    expect(runbookInput?.value).toContain("List all open issues labeled bug");

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Schedule 0 9 * * 1-5"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const scheduleInput = document.querySelector('input[aria-label="Schedule"]') as HTMLInputElement | null;
    expect(scheduleInput?.value).toBe("0 9 * * 1-5");

    expect(document.body.textContent).toContain("Track as issue");
    expect(document.body.textContent).toContain("Create");
    expect(runbookInput?.value).not.toMatch(/(?:^|\n)(?:Output:|输出：)/u);
    const originalInstructions = runbookInput?.value;

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Track as issue"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("Send to chat");

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Post each run to a new chat"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(runbookInput?.value).toBe(originalInstructions);
    expect(runbookInput?.value).not.toMatch(/(?:^|\n)(?:Output:|输出：)/u);

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Post each run to a new chat"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(runbookInput?.value).toBe(originalInstructions);

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Daily standup review"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(titleInput?.value).toBe("Daily standup review");
    expect(runbookInput?.value).toContain("Review today's work across issues, comments, chats, and runs");
    expect(runbookInput?.value).toContain("Recommended next tasks");
    expect(runbookInput?.value).toContain("Needs my review");
  });

  it("defaults new custom automations to chat output and allows switching output method", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const outputButton = document.body.querySelector(
      '[data-testid="automation-create-output-mode"]',
    ) as HTMLButtonElement | null;
    expect(outputButton?.textContent).toContain("Send to chat");
    expect(document.body.textContent).toContain("New chat per run");

    await act(async () => {
      outputButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const trackAsIssueOption = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Each run opens board-tracked work"));
    expect(trackAsIssueOption).toBeTruthy();

    await act(async () => {
      trackAsIssueOption?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(outputButton?.textContent).toContain("Track as issue");
    expect(document.body.textContent).not.toContain("New chat per run");
  });

  it("preserves nonempty Markdown without injecting output instructions while switching output method", async () => {
    renderPage();
    await act(async () => {
      await Promise.resolve();
    });
    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      await Promise.resolve();
    });

    const prefix = "\n  **Keep exact instructions**  \n";
    const runbookInput = document.querySelector(
      'textarea[aria-label="Instructions"]',
    ) as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(runbookInput, prefix);
      document.body.querySelector<HTMLButtonElement>(
        '[data-testid="automation-create-output-mode"]',
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Each run opens board-tracked work"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(runbookInput.value).toBe(prefix);
  });

  it("opens the composer from the header as a blank prompt input", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation title"]') as HTMLTextAreaElement | null;
    const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
    expect(titleInput?.value).toBe("");
    expect(runbookInput?.value).toBe("");
    expect(runbookInput?.placeholder).toBe("Add instructions e.g. look for crashes in Sentry");
  });

  it("applies the Daily review template from the composer header", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation title"]') as HTMLTextAreaElement | null;
    const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
    expect(titleInput).toBeTruthy();
    expect(runbookInput).toBeTruthy();

    await act(async () => {
      setTextareaValue(titleInput!, "Temporary custom draft");
      setTextareaValue(runbookInput!, "Temporary instructions");
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Use template"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const templatePicker = document.body.querySelector('[data-testid="automation-template-picker"]');
    expect(templatePicker).toBeTruthy();
    expect(templatePicker?.textContent).toContain("Daily review");

    await act(async () => {
      Array.from(templatePicker?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent?.includes("Daily review"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(titleInput?.value).toBe("Daily review");
    expect(runbookInput?.value).toContain("Review what I worked on today");
    expect(runbookInput?.value).toContain("highest-priority next action for tomorrow");
    expect(document.body.textContent).toContain("Schedule 0 18 * * *");
    expect(document.body.textContent).toContain("Send to chat");
    expect(document.body.querySelector('[data-testid="automation-template-picker"]')).toBeNull();
  });

  it.each([
    {
      locale: "en",
      useTemplateLabel: "Use template",
      templateTitles: [
        "Daily review",
        "Bug triage",
        "PR review reminder",
        "Weekly progress report",
        "Documentation check",
        "Daily news digest",
        "Daily standup review",
      ],
    },
    {
      locale: "zh-CN",
      useTemplateLabel: "使用模板",
      templateTitles: [
        "每日回顾",
        "Bug 分诊",
        "PR review 提醒",
        "周进展报告",
        "文档检查",
        "每日信息简报",
        "日会",
      ],
    },
  ])("keeps standalone output descriptions out of every $locale automation template", async ({
    locale,
    useTemplateLabel,
    templateTitles,
  }) => {
    document.documentElement.lang = locale;
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    for (const templateTitle of templateTitles) {
      const useTemplateButton = Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes(useTemplateLabel));
      expect(useTemplateButton).toBeTruthy();
      await act(async () => {
        useTemplateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      const templatePicker = document.body.querySelector('[data-testid="automation-template-picker"]');
      const templateButton = Array.from(templatePicker?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent?.includes(templateTitle));
      expect(templateButton).toBeTruthy();
      await act(async () => {
        templateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        await Promise.resolve();
      });

      const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
      expect(runbookInput).toBeTruthy();
      expect(runbookInput?.value).not.toMatch(/(?:^|\n)(?:Output:|输出：)/u);
    }
  });

  it("renders localized use-case templates for Chinese UI", async () => {
    document.documentElement.lang = "zh-CN";
    automationListState.items = [];
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("每日回顾");
    expect(container.textContent).toContain("Bug 分诊");
    expect(container.textContent).toContain("日会");
    expect(container.textContent).toContain("周进展报告");
    expect(container.textContent).not.toContain("依赖审计");

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const useTemplateButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("使用模板"));
    expect(useTemplateButton).toBeTruthy();

    await act(async () => {
      useTemplateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const templatePicker = document.body.querySelector('[data-testid="automation-template-picker"]');
    expect(templatePicker?.textContent).toContain("模板");
    expect(templatePicker?.textContent).toContain("每日回顾");
    expect(templatePicker?.textContent).toContain("回顾今天的工作并生成简短状态更新");

    await act(async () => {
      Array.from(templatePicker?.querySelectorAll("button") ?? [])
        .find((button) => button.textContent?.includes("每日回顾"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation title"]') as HTMLTextAreaElement | null;
    const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
    expect(titleInput?.value).toBe("每日回顾");
    expect(runbookInput?.value).toContain("回顾我今天完成的工作");
    expect(runbookInput?.value).toContain("推荐明天优先级最高的行动");
    expect(document.body.textContent).toContain("Schedule 0 18 * * *");
    expect(document.body.textContent).toContain("发送到聊天");

    await act(async () => {
      (document.body.querySelector('[data-testid="automation-create-output-mode"]') as HTMLButtonElement | null)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain("运行输出");
    expect(document.body.textContent).toContain("每次运行创建可跟踪任务");
    expect(document.body.textContent).toContain("每次运行发布到新聊天");
    expect(document.body.textContent).toContain("每次运行新建聊天");
  });

  it("renders last run with trigger source, status, timestamp, and destination", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("2026-05-11 12:35:18");
    expect(container.textContent).toContain("Opened issue");
    expect(container.textContent).toContain("Scheduled run");
    expect(container.textContent).toContain("Issue AUT-7");
  });

  it("does not expose the archived lifecycle in the list", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("flomo memo export");
    expect(container.textContent).not.toContain("Archive");
    expect(container.textContent).not.toContain("Restore");
    expect(container.textContent).not.toContain("Archived");
  });

  it("filters automations by active and paused status", async () => {
    automationListState.items = [
      automation,
      {
        ...automation,
        id: "auto-2",
        title: "Paused weekly review",
        status: "paused",
      },
    ];
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("flomo memo export");
    expect(container.textContent).toContain("Paused weekly review");

    await act(async () => {
      (Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Active") as HTMLButtonElement | undefined)?.focus();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("flomo memo export");
    expect(container.textContent).not.toContain("Paused weekly review");

    await act(async () => {
      (Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Paused") as HTMLButtonElement | undefined)?.focus();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain("flomo memo export");
    expect(container.textContent).toContain("Paused weekly review");
  });

  it("shows a filtered empty result without replacing it with onboarding templates", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
      (Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Paused") as HTMLButtonElement | undefined)?.focus();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("No paused automations");
    expect(container.textContent).not.toContain("No automations yet");
    expect(container.querySelector('[data-testid="automation-template-grid"]')).toBeNull();
  });

  it("keeps the selected automation in the list and closes its detail back to the index route", async () => {
    automationRouteState.automationId = "auto-1";
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const selectedRow = container.querySelector('tr[data-selected="true"]');
    expect(selectedRow?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[data-testid="automations-table-surface"]')?.className).toContain("rounded-[var(--radius-md)]");
    expect(selectedRow?.className).toContain("[&>td:first-child]:rounded-l-[var(--radius-sm)]");
    expect(container.querySelector('[data-testid="mock-automation-detail"]')?.textContent).toContain("auto-1");

    await act(async () => {
      Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Close automation detail")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(mockNavigate).toHaveBeenCalledWith("/automations");
  });

  it("closes a selected detail when it is outside the chosen status filter", async () => {
    automationRouteState.automationId = "auto-1";
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
      (Array.from(container.querySelectorAll("button"))
        .find((button) => button.textContent === "Paused") as HTMLButtonElement | undefined)?.focus();
      await Promise.resolve();
    });

    expect(mockNavigate).toHaveBeenCalledWith("/automations");
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
    expect(markdownEditorProps.at(-1)?.engine).toBe("codemirror");
    expect(markdownEditorProps.at(-1)?.plainText).toBeUndefined();
    expect(markdownEditorProps.at(-1)?.mentionMenuPlacement).toBe("container");
    expect(markdownEditorProps.at(-1)?.mentionMenuAnchorRef?.current?.dataset.testid)
      .toBe("automation-instructions-composer");
    expect(baseMentionIds).toEqual(expect.arrayContaining([
      "agent:agent-1",
      "project:project-1",
      "issue:issue-1",
    ]));

    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Select assignee"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const selectedMentionIds = markdownEditorProps.at(-1)?.mentions?.map((mention) => mention.id) ?? [];
    expect(selectedMentionIds).toContain("skill:agent:build-advisor");
  });

  it("submits live editor instructions when creating without a project", async () => {
    renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    const headerContainer = renderHeaderActions();
    await act(async () => {
      headerContainer.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const titleInput = document.querySelector('textarea[placeholder="Automation title"]') as HTMLTextAreaElement | null;
    const runbookInput = document.querySelector('textarea[aria-label="Instructions"]') as HTMLTextAreaElement | null;
    expect(titleInput).toBeTruthy();
    expect(runbookInput?.value).toBe("");
    expect(runbookInput?.placeholder).toBe("Add instructions e.g. look for crashes in Sentry");

    await act(async () => {
      setTextareaValue(titleInput!, "帮我 flomo 打 tag");
      setTextareaValue(runbookInput!, "\n  **Keep exact instructions**  \n");
    });
    await act(async () => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent?.includes("Select assignee"))
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    const createButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Create") as HTMLButtonElement | undefined;
    expect(createButton).toBeTruthy();
    expect(createButton?.disabled).toBe(false);

    const currentInstructions = "每天汇总最新消息并发送给我";
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    valueSetter?.call(runbookInput!, currentInstructions);
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCreateAutomation).toHaveBeenCalledWith("org-1", expect.objectContaining({
      title: "帮我 flomo 打 tag",
      instructions: currentInstructions,
      projectId: null,
      assigneeAgentId: "agent-1",
      outputMode: "chat_output",
      chatConversationId: null,
      notifyOnIssueCreated: false,
    }));
    expect(mockCreateTrigger).toHaveBeenCalledWith("created-auto-1", expect.objectContaining({
      kind: "schedule",
      cronExpression: "0 9 * * *",
      timezone: expect.any(String),
    }));
  });
});
