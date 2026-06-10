// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_PROJECT_ICON } from "@rudderhq/shared";
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
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: [] }),
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
  MarkdownEditor: ({ value, onChange, placeholder }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label={placeholder}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  ),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  mockState.createProject.mockResolvedValue({
    id: "project-created-1",
    name: "New project",
    orgId: "org-1",
  });
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
});

describe("NewProjectDialog", () => {
  it("uses one add resources entry point in Project Context", () => {
    const container = renderDialog();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) => button.textContent ?? "");

    expect(buttons.filter((text) => text.includes("Add resources"))).toHaveLength(1);
    expect(buttons.some((text) => text.includes("Attach resource"))).toBe(false);
    expect(buttons.some((text) => text.includes("New resource"))).toBe(false);
  });

  it("keeps resource draft project settings to a single note field", () => {
    const container = renderDialog();
    const createExternalResourceButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Create external resource"));

    expect(createExternalResourceButton).not.toBeUndefined();

    act(() => {
      createExternalResourceButton!.click();
    });

    expect(container.textContent).toContain("Project note");
    expect(container.textContent).not.toContain("Project role");
    expect(container.querySelector<HTMLInputElement>("input[placeholder='Optional guidance specific to this project']")).not.toBeNull();
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
        color: expect.any(String),
        icon: DEFAULT_PROJECT_ICON,
      }),
    );
    expect(mockState.closeNewProject).toHaveBeenCalledTimes(1);
    expect(mockState.navigate).toHaveBeenCalledWith("/issues?projectId=project-created-1");
  });
});
