// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceBackupFilesSidebar } from "./WorkspaceBackupFilesSidebar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  // Models the router update landing in the address bar before this sidebar
  // render receives the refreshed search params.
  searchParams: "",
  setSearchParams: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[2] === "workspace-backups") {
      return {
        data: {
          backups: [{
            id: "backup-current",
            status: "succeeded",
            createdAt: "2026-10-16T12:00:00.000Z",
            finishedAt: "2026-10-16T12:00:00.000Z",
            triggerSource: "manual",
            fileCount: 1,
            byteSize: 12,
          }],
        },
        isLoading: false,
        error: null,
      };
    }
    if (queryKey[2] === "workspace-backup-files") {
      return {
        data: {
          rootExists: true,
          entries: [{ name: "roadmap.md", path: "plans/roadmap.md", isDirectory: false }],
        },
        isLoading: false,
        error: null,
      };
    }
    return { data: null, isLoading: false, error: null };
  },
}));

vi.mock("@/api/orgs", () => ({
  organizationsApi: {
    listWorkspaceBackups: vi.fn(),
    listWorkspaceBackupFiles: vi.fn(),
  },
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("@/hooks/useViewedOrganization", () => ({
  useViewedOrganization: () => ({ viewedOrganizationId: "org-1" }),
}));

vi.mock("@/lib/router", () => ({
  useSearchParams: () => [new URLSearchParams(state.searchParams), state.setSearchParams],
}));

vi.mock("@/components/workbench/WorkspaceContextSidebar", () => ({
  WorkspaceContextSidebar: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  WorkspaceContextHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  WorkspaceSidebarCollapseButton: () => null,
}));

let mounted: { container: HTMLDivElement; root: Root } | null = null;

afterEach(() => {
  if (mounted) {
    act(() => mounted?.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  state.searchParams = "";
  state.setSearchParams.mockClear();
});

describe("WorkspaceBackupFilesSidebar", () => {
  it("writes the selected backup with the file when its search params are stale", () => {
    state.searchParams = "view=backups";
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted = { container, root };

    act(() => root.render(<WorkspaceBackupFilesSidebar />));
    const fileButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("roadmap.md"));
    expect(fileButton).toBeDefined();

    act(() => fileButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

    expect(state.setSearchParams).toHaveBeenCalledTimes(1);
    const [nextParams, options] = state.setSearchParams.mock.calls[0] as [URLSearchParams, { replace: boolean }];
    expect(nextParams.get("view")).toBe("backups");
    expect(nextParams.get("backup")).toBe("backup-current");
    expect(nextParams.get("file")).toBe("plans/roadmap.md");
    expect(options).toEqual({ replace: true });
  });
});
