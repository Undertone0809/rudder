// @vitest-environment jsdom

import { ISSUE_AUTOSAVE_STORAGE_KEY, ISSUE_DRAFTS_STORAGE_KEY } from "@/lib/new-issue-dialog";
import type { ReactNode } from "react";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { NewIssueDialog } from "./NewIssueDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  adapterModels: [] as unknown[],
  agents: [{
    id: "agent-1",
    name: "Ella",
    urlKey: "ella",
    icon: null,
    status: "active",
    agentRuntimeType: "codex_local",
    agentRuntimeConfig: {},
  }],
  closeNewIssue: vi.fn(),
  labels: [] as unknown[],
  recentAssigneeIds: [] as string[],
  newIssueDefaults: {} as Record<string, unknown>,
  organizationSkills: [] as unknown[],
  projects: [] as unknown[],
  pushToast: vi.fn(),
  mutationCalls: [] as Array<{ variables: Record<string, unknown> }>,
  agentMutationOutcome: "success" as "success" | "deferred" | "failure" | "terminal-failure" | "pending",
  skills: {
    agentRuntimeType: "codex_local",
    supported: true,
    mode: "persistent",
    desiredSkills: [],
    entries: [],
    warnings: [],
  },
  session: { user: { id: "user-1" } },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === "agents" && queryKey[1] === "skills") {
      return { data: mockState.skills };
    }
    if (queryKey[0] === "agents" && queryKey[2] === "adapter-models") return { data: mockState.adapterModels };
    if (queryKey[0] === "agents") return { data: mockState.agents };
    if (queryKey[0] === "projects") return { data: mockState.projects };
    if (queryKey[0] === "issues" && queryKey[2] === "labels") return { data: mockState.labels };
    if (queryKey[0] === "auth") return { data: mockState.session };
    if (queryKey[0] === "organization-skills") return { data: mockState.organizationSkills };
    return { data: undefined };
  },
  useMutation: (options: {
    onError?: (error: Error, variables: Record<string, unknown>) => void;
    onSettled?: (...args: unknown[]) => void;
    onSuccess?: (data: Record<string, unknown>, variables: Record<string, unknown>) => void;
  } = {}) => {
    const isAgentMutation = typeof options.onSettled === "function";
    const [agentMutationStarted, setAgentMutationStarted] = useState(false);
    return {
      mutate: vi.fn((variables: Record<string, unknown>) => {
        mockState.mutationCalls.push({ variables });
        if (!isAgentMutation) return;
        if (mockState.agentMutationOutcome === "pending") {
          setAgentMutationStarted(true);
          return;
        }
        if (mockState.agentMutationOutcome === "failure" || mockState.agentMutationOutcome === "terminal-failure") {
          const error = mockState.agentMutationOutcome === "terminal-failure"
            ? new ApiError("Agent request key is terminal", 409, { error: "Agent Issue request is already terminal" })
            : new Error("Agent request failed");
          options.onError?.(error, variables);
          options.onSettled?.(undefined, error, variables, undefined);
          return;
        }
        options.onSuccess?.({ status: mockState.agentMutationOutcome }, variables);
        options.onSettled?.(undefined, null, variables, undefined);
      }),
      mutateAsync: vi.fn(),
      isPending: isAgentMutation && mockState.agentMutationOutcome === "pending" && agentMutationStarted,
      isError: isAgentMutation && mockState.agentMutationOutcome === "failure",
      error: isAgentMutation && (mockState.agentMutationOutcome === "failure" || mockState.agentMutationOutcome === "terminal-failure")
        ? mockState.agentMutationOutcome === "terminal-failure"
          ? new ApiError("Agent request key is terminal", 409, { error: "Agent Issue request is already terminal" })
          : new Error("Agent request failed")
        : null,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    newIssueOpen: true,
    newIssueDefaults: mockState.newIssueDefaults,
    closeNewIssue: mockState.closeNewIssue,
  }),
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues", search: "" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { id: "org-1", name: "Rudder", urlKey: "rudder", issuePrefix: "RUD", brandColor: "#111827" },
    organizations: [{ id: "org-1", name: "Rudder", urlKey: "rudder", issuePrefix: "RUD", brandColor: "#111827", status: "active" }],
  }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockState.pushToast }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <textarea aria-label="Description" value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: ({ placeholder }: { placeholder?: string }) => <button type="button">{placeholder ?? "selector"}</button>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => null,
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({ orderedProjects: projects }),
}));

vi.mock("../lib/recent-assignees", () => ({
  getRecentAssigneeIds: () => mockState.recentAssigneeIds,
  sortAgentsByRecency: (agents: unknown[]) => agents,
  trackRecentAssignee: vi.fn(),
}));

vi.mock("../api/agents", () => ({
  agentsApi: { list: vi.fn(), adapterModels: vi.fn() },
}));

vi.mock("../api/projects", () => ({
  projectsApi: { list: vi.fn() },
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    listLabels: vi.fn(),
    create: vi.fn(),
    createLabel: vi.fn(),
    upsertDocument: vi.fn(),
    uploadAttachment: vi.fn(),
    createAgentIssueRequest: vi.fn(),
  },
}));

vi.mock("../api/auth", () => ({
  authApi: { getSession: vi.fn() },
}));

vi.mock("../api/assets", () => ({
  assetsApi: { uploadImage: vi.fn() },
}));

const savedDraft = {
  id: "draft-1",
  orgId: "org-1",
  title: "Saved draft issue",
  description: "Saved body",
  status: "todo",
  priority: "medium",
  labelIds: [],
  assigneeValue: "",
  reviewerValue: "",
  projectId: "",
  projectWorkspaceId: "",
  assigneeModelOverride: "",
  assigneeThinkingEffort: "",
  assigneeChrome: false,
  createdAt: "2026-05-08T00:00:00.000Z",
  updatedAt: "2026-05-08T00:00:00.000Z",
};

let root: Root | null = null;
let storageState: Record<string, string> = {};

function installLocalStorageMock() {
  storageState = {};
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => storageState[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storageState[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete storageState[key];
    }),
    clear: vi.fn(() => {
      storageState = {};
    }),
  });
}

async function renderDialog() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<NewIssueDialog />);
  });
}

async function advanceAutosaveDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(900);
  });
}

async function fillTextarea(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    valueSetter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  installLocalStorageMock();
  vi.useFakeTimers();
  window.localStorage.clear();
  document.body.innerHTML = "";
  mockState.closeNewIssue.mockReset();
  mockState.pushToast.mockReset();
  mockState.mutationCalls.length = 0;
  mockState.agentMutationOutcome = "success";
  mockState.newIssueDefaults = {};
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  window.localStorage.clear();
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("NewIssueDialog autosave", () => {
  it("autosaves an opened saved draft back to the same draft", async () => {
    window.localStorage.setItem(ISSUE_DRAFTS_STORAGE_KEY, JSON.stringify([savedDraft]));
    mockState.newIssueDefaults = { draftId: savedDraft.id };

    await renderDialog();
    const titleInput = document.querySelector("textarea[placeholder='Issue title']") as HTMLTextAreaElement | null;
    expect(titleInput?.value).toBe("Saved draft issue");
    expect(document.body.textContent).toContain("Saved to Draft Issues");
    expect(document.body.textContent).not.toContain("Save Draft");

    await fillTextarea(titleInput!, "Edited saved draft issue");

    await advanceAutosaveDebounce();

    expect(window.localStorage.getItem(ISSUE_AUTOSAVE_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(ISSUE_DRAFTS_STORAGE_KEY) ?? "[]")).toMatchObject([
      {
        id: savedDraft.id,
        createdAt: savedDraft.createdAt,
        title: "Edited saved draft issue",
      },
    ]);
  });

  it("continues to autosave ordinary new issue drafts", async () => {
    mockState.newIssueDefaults = { title: "Ordinary new issue", description: "Keep recovering this one" };

    await renderDialog();
    await advanceAutosaveDebounce();

    expect(JSON.parse(window.localStorage.getItem(ISSUE_AUTOSAVE_STORAGE_KEY) ?? "null")).toMatchObject({
      title: "Ordinary new issue",
      description: "Keep recovering this one",
    });
  });

  it("submits Agent mode once without saving a Manual draft", async () => {
    mockState.agentMutationOutcome = "pending";
    mockState.newIssueDefaults = {
      title: "Manual-only context should not be saved from Agent mode",
      assigneeAgentId: "agent-1",
    };

    await renderDialog();
    const agentTab = document.querySelector<HTMLButtonElement>(
      'button[role="tab"][aria-selected="false"]',
    );
    expect(agentTab).not.toBeNull();
    await act(async () => {
      agentTab?.click();
    });

    const instruction = document.querySelector<HTMLTextAreaElement>(
      '[data-slot="agent-issue-instruction"]',
    );
    expect(instruction).not.toBeNull();
    await fillTextarea(instruction!, "Create an issue for the onboarding regression.");

    const sendButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Send to Agent",
    );
    expect(sendButton).not.toBeNull();
    await act(async () => {
      sendButton?.click();
      sendButton?.click();
    });

    const agentCalls = mockState.mutationCalls.filter(
      ({ variables }) => variables.instruction === "Create an issue for the onboarding regression.",
    );
    expect(agentCalls).toHaveLength(1);
    expect(agentCalls[0]?.variables).toMatchObject({
      orgId: "org-1",
      agentId: "agent-1",
      projectId: null,
      goalId: null,
      parentId: null,
      idempotencyKey: expect.any(String),
    });

    await advanceAutosaveDebounce();
    expect(window.localStorage.getItem(ISSUE_AUTOSAVE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(ISSUE_DRAFTS_STORAGE_KEY)).toBeNull();
    expect(document.body.textContent).not.toContain("Save Draft");
  });

  it("shows the exact accepted-request toast and closes after a deferred response", async () => {
    mockState.agentMutationOutcome = "deferred";
    mockState.newIssueDefaults = { assigneeAgentId: "agent-1" };

    await renderDialog();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="false"]')?.click();
    });
    await fillTextarea(
      document.querySelector<HTMLTextAreaElement>('[data-slot="agent-issue-instruction"]')!,
      "Create the deferred issue.",
    );
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Send to Agent")
        ?.click();
    });

    expect(mockState.pushToast).toHaveBeenCalledWith({
      title: "已发送给 Agent，完成后会在 Inbox 通知你",
      tone: "success",
    });
    expect(mockState.closeNewIssue).toHaveBeenCalledTimes(1);
  });

  it("keeps the Agent submit disabled while the request is pending", async () => {
    mockState.agentMutationOutcome = "pending";
    mockState.newIssueDefaults = { assigneeAgentId: "agent-1" };

    await renderDialog();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="false"]')?.click();
    });
    await fillTextarea(
      document.querySelector<HTMLTextAreaElement>('[data-slot="agent-issue-instruction"]')!,
      "Create the pending issue.",
    );
    const sendButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Send to Agent") as HTMLButtonElement | undefined;
    expect(sendButton).not.toBeUndefined();
    expect(sendButton?.disabled).toBe(false);
    await act(async () => {
      sendButton?.click();
    });

    expect(sendButton?.disabled).toBe(true);
    expect(mockState.mutationCalls).toHaveLength(1);
    await act(async () => {
      sendButton?.click();
    });
    expect(mockState.mutationCalls).toHaveLength(1);
  });

  it("keeps the dialog open and exposes a failed Agent response", async () => {
    mockState.agentMutationOutcome = "failure";
    mockState.newIssueDefaults = { assigneeAgentId: "agent-1" };

    await renderDialog();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="false"]')?.click();
    });
    await fillTextarea(
      document.querySelector<HTMLTextAreaElement>('[data-slot="agent-issue-instruction"]')!,
      "Create the failed issue.",
    );
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Send to Agent")
        ?.click();
    });

    expect(document.body.textContent).toContain("Agent request failed");
    expect(mockState.closeNewIssue).not.toHaveBeenCalled();
    expect(mockState.mutationCalls).toHaveLength(1);

    const firstKey = mockState.mutationCalls[0]?.variables.idempotencyKey;
    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Send to Agent")
        ?.click();
    });
    expect(mockState.mutationCalls[1]?.variables.idempotencyKey).toBe(firstKey);
  });

  it("rotates the Agent request key after a terminal HTTP response", async () => {
    mockState.agentMutationOutcome = "terminal-failure";
    mockState.newIssueDefaults = { assigneeAgentId: "agent-1" };

    await renderDialog();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[role="tab"][aria-selected="false"]')?.click();
    });
    await fillTextarea(
      document.querySelector<HTMLTextAreaElement>('[data-slot="agent-issue-instruction"]')!,
      "Create the retryable issue.",
    );

    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Send to Agent")
        ?.click();
    });
    const firstKey = mockState.mutationCalls[0]?.variables.idempotencyKey;

    await act(async () => {
      [...document.querySelectorAll("button")]
        .find((button) => button.textContent?.trim() === "Send to Agent")
        ?.click();
    });

    expect(mockState.mutationCalls).toHaveLength(2);
    expect(mockState.mutationCalls[1]?.variables.idempotencyKey).toEqual(expect.any(String));
    expect(mockState.mutationCalls[1]?.variables.idempotencyKey).not.toBe(firstKey);
  });
});
