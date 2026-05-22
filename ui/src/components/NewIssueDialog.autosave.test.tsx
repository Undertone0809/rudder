// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_AUTOSAVE_STORAGE_KEY, ISSUE_DRAFTS_STORAGE_KEY } from "@/lib/new-issue-dialog";
import { NewIssueDialog } from "./NewIssueDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  adapterModels: [] as unknown[],
  agents: [{ id: "agent-1", name: "Ella", urlKey: "ella", icon: null, status: "active", agentRuntimeType: "codex_local" }],
  closeNewIssue: vi.fn(),
  labels: [] as unknown[],
  recentAssigneeIds: [] as string[],
  newIssueDefaults: {} as Record<string, unknown>,
  organizationSkills: [] as unknown[],
  projects: [] as unknown[],
  pushToast: vi.fn(),
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
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
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
});
