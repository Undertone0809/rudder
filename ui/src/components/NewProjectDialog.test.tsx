// @vitest-environment jsdom

import { DEFAULT_PROJECT_ICON } from "@rudderhq/shared";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  closeNewProject: vi.fn(),
  createProject: vi.fn(),
  invalidateQueries: vi.fn(),
  navigate: vi.fn(),
  pickPath: vi.fn(),
  organizationResources: [] as Array<Record<string, unknown>>,
  libraryEntries: [] as Array<Record<string, unknown>>,
}));
const markdownEditorState = vi.hoisted(() => ({
  engine: null as string | null,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[2] === "resources") return { data: mockState.organizationResources };
    if (queryKey[2] === "workspace-mention-files") return { data: { entries: mockState.libraryEntries } };
    return { data: [] };
  },
  useQueryClient: () => ({
    invalidateQueries: mockState.invalidateQueries,
  }),
  useMutation: ({ mutationFn }: { mutationFn: (data: Record<string, unknown>) => Promise<unknown> }) => ({
    mutateAsync: mutationFn,
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => mockState.navigate,
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({
    newProjectOpen: true,
    closeNewProject: mockState.closeNewProject,
  }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: {
      id: "org-1",
      issuePrefix: "RUD",
      name: "Rudder",
    },
  }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    create: (orgId: string, data: Record<string, unknown>) => mockState.createProject(orgId, data),
  },
}));

vi.mock("../api/goals", () => ({
  goalsApi: {
    list: vi.fn(),
  },
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: {
    pickPath: (input: Record<string, unknown>) => mockState.pickPath(input),
  },
}));

vi.mock("../api/orgs", () => ({
  organizationsApi: {
    listResources: vi.fn(),
  },
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(),
  },
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, engine, placeholder }: {
    value: string;
    onChange: (value: string) => void;
    engine?: string;
    placeholder?: string;
  }) => {
    markdownEditorState.engine = engine ?? null;
    return (
      <textarea
        aria-label={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  },
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children, className, showCloseButton: _showCloseButton, ...props }: { children: ReactNode; className?: string; showCloseButton?: boolean; [key: string]: unknown }) => (
    <div className={className} data-slot="dialog-content" {...props}>
      {children}
    </div>
  ),
  DialogDescription: ({ children, className }: { children: ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
  DialogTitle: ({ children, className }: { children: ReactNode; className?: string }) => (
    <h2 className={className}>{children}</h2>
  ),
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({
    children,
    className,
    disablePortal,
  }: {
    children: ReactNode;
    className?: string;
    disablePortal?: boolean;
  }) => (
    <div className={className} data-disable-portal={disablePortal ? "true" : undefined}>
      {children}
    </div>
  ),
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

let cleanupFn: (() => void) | null = null;

function setInputValue(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(input, "value")?.set;
  const prototypeValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  if (prototypeValueSetter && valueSetter !== prototypeValueSetter) {
    prototypeValueSetter.call(input, value);
  } else if (valueSetter) {
    valueSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderDialog() {
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
    root.render(<NewProjectDialog />);
  });

  return container;
}

beforeEach(() => {
  mockState.closeNewProject.mockReset();
  mockState.createProject.mockReset();
  mockState.invalidateQueries.mockReset();
  mockState.navigate.mockReset();
  mockState.pickPath.mockReset();
  mockState.organizationResources = [];
  mockState.libraryEntries = [];
  mockState.createProject.mockResolvedValue({
    id: "project-created-1",
    name: "New project",
    orgId: "org-1",
  });
  mockState.pickPath.mockResolvedValue({ path: null, cancelled: true });
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

describe("NewProjectDialog", () => {
  it("keeps the identity trigger target aligned with the large project icon", () => {
    const container = renderDialog();
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="new-project-identity-trigger"]');
    const projectIcon = trigger?.querySelector<HTMLElement>('[aria-hidden="true"]');

    expect(trigger).not.toBeNull();
    expect(trigger?.classList.contains("h-9")).toBe(true);
    expect(trigger?.classList.contains("w-9")).toBe(true);
    expect(trigger?.className).not.toContain("h-8");
    expect(projectIcon?.classList.contains("h-9")).toBe(true);
  });

  it("uses one Add sources entry point under Project Sources", () => {
    const container = renderDialog();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent ?? "");

    expect(container.textContent).toContain("Project Sources");
    expect(container.textContent).not.toContain("Project Context");
    expect(buttons.filter((text) => text.includes("Add sources"))).toHaveLength(1);
    expect(buttons.some((text) => text.includes("Add resources"))).toBe(false);
  });

  it("opens a low-density source type dialog before showing source details", () => {
    const container = renderDialog();
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add sources"));

    act(() => trigger!.click());

    const sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]');
    expect(sourceDialog).not.toBeNull();
    expect(sourceDialog?.textContent).toContain("Add from library");
    expect(sourceDialog?.textContent).toContain("Select from local");
    expect(sourceDialog?.textContent).toContain("Add from URL");
    expect(sourceDialog?.textContent).not.toContain("Search Library");
    expect(sourceDialog?.textContent).not.toContain("Recent sources");
  });

  it("provides accessible titles and descriptions for both dialog layers", () => {
    const container = renderDialog();
    const projectDialog = container.querySelector('[data-slot="dialog-content"]');
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add sources"));

    expect(projectDialog?.querySelector("h2")?.textContent).toBe("New project");
    expect(projectDialog?.querySelector("p")?.textContent).toContain("Create a project");

    act(() => trigger!.click());

    const sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]');
    expect(sourceDialog?.querySelector("h2")?.textContent).toBe("Add sources");
    expect(sourceDialog?.querySelector("p")?.textContent).toContain("Choose one source type");
  });

  it("keeps the new project footer visible while resource drafts scroll inside the dialog", () => {
    const container = renderDialog();
    const dialogContent = container.querySelector('[data-slot="dialog-content"]');
    const dialogScroll = container.querySelector('[data-testid="new-project-dialog-scroll"]');
    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create project");

    expect(dialogContent?.className).toContain("max-h-[min(860px,calc(100vh-2rem))]");
    expect(dialogContent?.className).toContain("flex-col");
    expect(dialogContent?.className).toContain("overflow-visible");
    expect(dialogScroll?.className).toContain("flex-1");
    expect(dialogScroll?.className).toContain("overflow-y-auto");
    expect(dialogScroll?.className).toContain("overscroll-contain");
    expect(createButton?.parentElement?.className).toContain("shrink-0");
  });

  it("keeps Library search inside its own source step", () => {
    vi.useFakeTimers();
    mockState.libraryEntries = [
      {
        name: "brief.md",
        displayLabel: "Project brief",
        path: "projects/rudder/brief.md",
        isDirectory: false,
      },
    ];
    const container = renderDialog();
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add sources"));

    act(() => trigger!.click());
    let sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]')!;
    const libraryButton = [...sourceDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add from library"));
    act(() => libraryButton!.click());
    sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]')!;

    const libraryScroll = sourceDialog.querySelector<HTMLElement>("[data-testid='new-project-library-sources-scroll']");
    expect(libraryScroll).not.toBeNull();
    act(() => libraryScroll!.dispatchEvent(new Event("scroll")));
    expect(libraryScroll?.classList.contains("is-scrolling")).toBe(true);
    act(() => vi.advanceTimersByTime(700));
    expect(libraryScroll?.classList.contains("is-scrolling")).toBe(false);
    expect(sourceDialog.querySelector("input[placeholder='Search Library or paste relative path']")).not.toBeNull();
    expect(sourceDialog.textContent).toContain("Project brief");
    expect(sourceDialog.textContent).not.toContain("Recent sources");
    expect(sourceDialog.querySelector("input[type='url']")).toBeNull();
    vi.useRealTimers();
  });

  it("reuses recent local sources and keeps direct file selection available", async () => {
    mockState.organizationResources = [
      {
        id: "resource-old",
        orgId: "org-1",
        name: "Older local source",
        kind: "directory",
        sourceType: "external",
        locator: "/Users/zeeland/projects/older",
        description: null,
        metadata: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        id: "resource-new",
        orgId: "org-1",
        name: "Rudder source repository",
        kind: "directory",
        sourceType: "external",
        locator: "/Users/zeeland/projects/rudder-oss",
        description: null,
        metadata: null,
        createdAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
      {
        id: "resource-url",
        orgId: "org-1",
        name: "Remote docs",
        kind: "url",
        sourceType: "external",
        locator: "https://example.com/docs",
        description: null,
        metadata: null,
        createdAt: "2026-08-09T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      },
    ];
    const container = renderDialog();
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add sources"));

    act(() => trigger!.click());
    const sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]')!;
    const localButton = [...sourceDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Select from local"));
    act(() => localButton!.click());

    expect(sourceDialog.textContent).toContain("Recent sources");
    expect(sourceDialog.textContent).toContain("Choose file");
    expect(sourceDialog.textContent).toContain("Rudder source repository");
    expect(sourceDialog.textContent).not.toContain("Remote docs");
    expect(sourceDialog.textContent?.indexOf("Rudder source repository"))
      .toBeLessThan(sourceDialog.textContent?.indexOf("Older local source") ?? 0);
    const localScroll = sourceDialog.querySelector<HTMLElement>("[data-testid='new-project-local-sources-scroll']");
    act(() => localScroll!.dispatchEvent(new Event("scroll")));
    expect(localScroll?.classList.contains("is-scrolling")).toBe(true);

    const checkbox = sourceDialog.querySelector<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => {
      checkbox!.click();
    });
    const addSelected = [...sourceDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add sources");
    expect(addSelected?.disabled).toBe(false);
    act(() => addSelected!.click());

    expect(container.textContent).toContain("Rudder source repository");
    expect(container.textContent).toContain("1 source queued");
    expect(container.querySelector<HTMLInputElement>("input[placeholder='Optional guidance specific to this project']")).not.toBeNull();
  });

  it("adds a local file returned by the native picker", async () => {
    mockState.pickPath.mockResolvedValue({
      path: "/Users/zeeland/Documents/source-notes.md",
      cancelled: false,
    });
    const container = renderDialog();
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add sources"));

    act(() => trigger!.click());
    let sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]')!;
    const localButton = [...sourceDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Select from local"));
    act(() => localButton!.click());
    sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]')!;
    const chooseFile = [...sourceDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Choose file"));

    await act(async () => {
      chooseFile!.click();
      await Promise.resolve();
    });

    expect(mockState.pickPath).toHaveBeenCalledWith({ selectionType: "file" });
    expect(container.textContent).toContain("source-notes.md");
    expect(container.textContent).toContain("1 source queued");
  });

  it("adds a valid URL without showing unrelated source choices", async () => {
    const container = renderDialog();
    const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add sources"));

    act(() => trigger!.click());
    let sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]')!;
    const urlButton = [...sourceDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Add from URL"));
    act(() => urlButton!.click());
    sourceDialog = container.querySelector('[data-testid="new-project-add-sources-dialog"]')!;

    expect(sourceDialog.textContent).not.toContain("Recent sources");
    expect(sourceDialog.textContent).not.toContain("Search Library");
    const urlInput = sourceDialog.querySelector<HTMLInputElement>('input[type="url"]')!;
    await act(async () => {
      setInputValue(urlInput, "https://example.com/reference");
    });
    const addSource = [...sourceDialog.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Add source");
    act(() => addSource!.click());

    expect(container.textContent).toContain("reference");
    expect(container.textContent).toContain("1 source queued");
  });

  it("defaults new projects to in progress", () => {
    const container = renderDialog();
    const selectedStatus = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "in progress");

    expect(selectedStatus).not.toBeUndefined();
  });

  it("opens the created project's issue board slice after creation", async () => {
    const container = renderDialog();
    const nameInput = container.querySelector<HTMLInputElement>("input[placeholder='Project name']");
    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create project");

    expect(nameInput).not.toBeNull();
    expect(createButton).not.toBeUndefined();

    await act(async () => {
      setInputValue(nameInput!, "New project");
    });

    await act(async () => {
      createButton!.click();
    });

    expect(mockState.createProject).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        name: "New project",
        status: "in_progress",
        color: expect.any(String),
        icon: DEFAULT_PROJECT_ICON,
      }),
    );
    expect(mockState.closeNewProject).toHaveBeenCalledTimes(1);
    expect(mockState.navigate).toHaveBeenCalledWith("/issues?projectId=project-created-1");
  });

  it("uses CodeMirror and preserves the exact non-empty project description", async () => {
    const container = renderDialog();
    const nameInput = container.querySelector<HTMLInputElement>("input[placeholder='Project name']");
    const descriptionInput = container.querySelector<HTMLTextAreaElement>("textarea[aria-label='Add description...']");
    const createButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Create project");

    expect(descriptionInput).not.toBeNull();
    expect(markdownEditorState.engine).toBe("codemirror");

    await act(async () => {
      setInputValue(nameInput!, "Exact source");
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      valueSetter.call(descriptionInput, "\n  *exact*  \n");
      descriptionInput!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      createButton!.click();
    });

    expect(mockState.createProject).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        description: "\n  *exact*  \n",
      }),
    );
  });
});
