// @vitest-environment jsdom

import type { Project, ProjectResourceAttachment } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openPath: vi.fn(),
  pushToast: vi.fn(),
  updateAttachment: vi.fn(),
  updateResource: vi.fn(),
}));

vi.mock("../../api/orgs", () => ({
  organizationsApi: { updateResource: mocks.updateResource },
}));
vi.mock("../../api/projects", () => ({
  projectsApi: { updateResourceAttachment: mocks.updateAttachment },
}));
vi.mock("../../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mocks.pushToast }),
}));
vi.mock("../../lib/desktop-shell", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/desktop-shell")>();
  return {
    ...actual,
    readDesktopShell: () => ({ openExternal: mocks.openExternal, openPath: mocks.openPath }),
  };
});

import { ProjectResourceDetailPanel } from "./ProjectResourceDetailPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { id: "project-1", orgId: "org-1", name: "Alpha" } as Project;
const target = { id: "cursor", kind: "ide", label: "Cursor" } as never;

describe("ProjectResourceDetailPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.updateResource.mockResolvedValue({ id: "resource-1" });
    mocks.updateAttachment.mockResolvedValue({ id: "attachment-1" });
    mocks.openExternal.mockResolvedValue(undefined);
    mocks.openPath.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  function renderPanel(
    attachment: ProjectResourceAttachment,
    overrides: Partial<Parameters<typeof ProjectResourceDetailPanel>[0]> = {},
  ) {
    act(() => root.render(
      <QueryClientProvider client={queryClient}>
        <ProjectResourceDetailPanel
          project={project}
          attachment={attachment}
          workspaceRootPath="/tmp/workspace"
          workspaceLaunchTargets={[]}
          selectedWorkspaceLaunchTarget={null}
          openingWorkspaceTargetId={null}
          onSelectWorkspaceLaunchTarget={vi.fn()}
          onOpenWorkspaceTarget={vi.fn()}
          {...overrides}
        />
      </QueryClientProvider>,
    ));
  }

  it("resets edit state on attachment changes and persists both resource owners", async () => {
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderPanel(attachment("attachment-1", "Resource one", "/tmp/one.txt", "file"));
    act(() => button("Edit").click());
    changeValue(container.querySelector<HTMLInputElement>("[data-testid='org-workspaces-resource-edit-form'] input")!, "Updated resource");
    await act(async () => {
      button("Save").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.updateResource).toHaveBeenCalledWith("org-1", "resource-1", expect.objectContaining({ name: "Updated resource" }));
    expect(mocks.updateAttachment).toHaveBeenCalledWith("project-1", "attachment-1", expect.objectContaining({ role: "reference" }), "org-1");
    expect(invalidate).toHaveBeenCalledTimes(4);

    renderPanel(attachment("attachment-2", "Resource two", "/tmp/two.txt", "file"));
    expect(container.querySelector("[data-testid='org-workspaces-resource-edit-form']")).toBeNull();
    act(() => button("Edit").click());
    expect(container.querySelector<HTMLInputElement>("[data-testid='org-workspaces-resource-edit-form'] input")?.value).toBe("Resource two");
  });

  it("delegates external, path, and workspace launcher opens and reports failures", async () => {
    renderPanel(attachment("attachment-url", "Website", "https://example.test", "url"));
    await act(async () => {
      button("Open").click();
      await Promise.resolve();
    });
    expect(mocks.openExternal).toHaveBeenCalledWith("https://example.test");

    mocks.openPath.mockRejectedValueOnce(new Error("cannot open"));
    renderPanel(attachment("attachment-file", "File", "/tmp/file.txt", "file"));
    await act(async () => {
      button("Open").click();
      await Promise.resolve();
    });
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed to open resource", tone: "error" }));

    const onOpenWorkspaceTarget = vi.fn();
    renderPanel(attachment("attachment-dir", "Folder", "projects/alpha", "directory"), {
      workspaceLaunchTargets: [target],
      selectedWorkspaceLaunchTarget: target,
      onOpenWorkspaceTarget,
    });
    act(() => button("Open resource in Cursor").click());
    expect(onOpenWorkspaceTarget).toHaveBeenCalledWith("projects/alpha", target, "resource");
  });
});

function attachment(id: string, name: string, locator: string, kind: "file" | "directory" | "url") {
  return {
    id,
    projectId: "project-1",
    resourceId: "resource-1",
    role: "reference",
    note: "Project note",
    sortOrder: 0,
    resource: {
      id: "resource-1",
      orgId: "org-1",
      name,
      locator,
      description: "Description",
      kind,
      sourceType: "local",
    },
  } as unknown as ProjectResourceAttachment;
}

function button(label: string) {
  const match = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
    .find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function changeValue(element: HTMLInputElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
