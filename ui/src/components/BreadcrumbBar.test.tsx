// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let pathname = "/RUD/messenger/issues";
let search = "";
let sidebarOpen = true;
let cleanupFn: (() => void) | null = null;
let mockBreadcrumbs: Array<{ label: string; href?: string }> = [];
let locationState: unknown = null;
let capturedLinks: Array<{ to: string; state?: unknown }> = [];
let mockNavigate = vi.fn();
let mockUseQuery = vi.fn();

vi.mock("@/lib/router", () => ({
  Link: ({ to, state, children, ...props }: { to: string; state?: unknown; children: import("react").ReactNode }) => {
    capturedLinks.push({ to, state });
    return <a href={to} {...props}>{children}</a>;
  },
  useLocation: () => ({ pathname, search, state: locationState }),
  useNavigate: () => mockNavigate,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ breadcrumbs: mockBreadcrumbs }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ sidebarOpen, setSidebarOpen: vi.fn(), toggleSidebar: vi.fn(), isMobile: false }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { issuePrefix: "RUD" },
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
    openNewProject: vi.fn(),
    openNewAgent: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => mockUseQuery(options),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
  usePluginLaunchers: () => ({ launchers: [] }),
}));

describe("BreadcrumbBar", () => {
  beforeEach(() => {
    pathname = "/RUD/messenger/issues";
    search = "";
    sidebarOpen = true;
    mockBreadcrumbs = [];
    locationState = null;
    capturedLinks = [];
    mockNavigate = vi.fn();
    mockUseQuery = vi.fn(() => ({ data: undefined, isFetching: false }));
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("hides the integrated card header on messenger routes", () => {
    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).not.toContain("Messenger");
  });

  it("hides the integrated card header on agent detail routes", () => {
    pathname = "/RUD/agents/designlead/configuration";

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toBe("");
  });

  it("keeps the shell header on messenger routes", () => {
    pathname = "/RUD/messenger/issues";

    const html = renderToStaticMarkup(<BreadcrumbBar />);

    expect(html).toContain("Messenger");
  });

  it("shows a workspace sidebar opener when hidden card headers are collapsed", () => {
    sidebarOpen = false;
    pathname = "/RUD/agents/designlead/configuration";

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toContain("Open workspace sidebar");
  });

  it("uses the Linear source header without native issue actions", () => {
    pathname = "/RUD/issues";
    search = "?source=linear&linearTeamId=team-rudder";

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toContain("Linear Issues");
    expect(html).not.toContain("Issue Tracker");
    expect(html).toContain("Search Linear issues...");
    expect(html).not.toContain("Create Issue");
  });

  it("uses issue detail breadcrumbs in the issues header instead of the generic title", () => {
    pathname = "/RUD/issues/RUD-197";
    mockBreadcrumbs = [
      { label: "Issues", href: "/issues" },
      { label: "RUD-197 chat ai response thing 的动效换成这个" },
    ];

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toContain('href="/issues"');
    expect(html).toContain("RUD-197 chat ai response thing 的动效换成这个");
    expect(html).toContain("list-none");
    expect(html).not.toContain("Issue Tracker");
    expect(html).toContain("Search issues...");
    expect(html).toContain("Create Issue");
  });

  it("uses issue detail breadcrumbs in the messenger issue detail header", () => {
    pathname = "/RUD/messenger/issues/RUD-357";
    mockBreadcrumbs = [
      { label: "Messenger", href: "/messenger" },
      { label: "RUD-357 Review 能力优化" },
    ];

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toContain('href="/messenger"');
    expect(html).toContain("RUD-357 Review 能力优化");
    expect(html).toContain("list-none");
    expect(html).not.toContain("Issue Tracker");
    expect(html).not.toContain("Search issues...");
    expect(html).not.toContain("Create Issue");
  });

  it("keeps issue detail source state on ancestor breadcrumb links", () => {
    pathname = "/RUD/issues/RUD-197";
    locationState = { issueDetailBreadcrumb: { label: "Inbox", href: "/inbox?scope=recent" } };
    mockBreadcrumbs = [
      { label: "Inbox", href: "/inbox?scope=recent" },
      { label: "Parent issue", href: "/issues/RUD-100" },
      { label: "RUD-197 chat ai response thing 的动效换成这个" },
    ];

    renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(capturedLinks).toContainEqual({ to: "/inbox?scope=recent", state: undefined });
    expect(capturedLinks).toContainEqual({ to: "/issues/RUD-100", state: locationState });
  });

  it("does not let the issue search retain focus after the native find shortcut", async () => {
    pathname = "/RUD/issues";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<BreadcrumbBar variant="card" />);
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>("input[placeholder='Search issues...']");
    expect(input).not.toBeNull();
    input!.focus();
    expect(document.activeElement).toBe(input);

    const event = new KeyboardEvent("keydown", {
      key: "f",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    await act(async () => {
      document.dispatchEvent(event);
      await Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(input);
  });

  it("opens an issue result menu from issue detail search and navigates to the selected issue", async () => {
    pathname = "/RUD/issues/RUD-197";
    mockBreadcrumbs = [
      { label: "Issues", href: "/issues" },
      { label: "RUD-197 current issue" },
    ];
    mockUseQuery = vi.fn((options: { queryKey?: readonly unknown[] }) => {
      if (options.queryKey?.[2] === "search") {
        return {
          data: [
            {
              id: "issue-377",
              identifier: "ZST-377",
              title: "new issue 时候输入文档持弹窗出来的位置不对",
              status: "todo",
            },
          ],
          isFetching: false,
        };
      }
      return { data: undefined, isFetching: false };
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
    };

    await act(async () => {
      root.render(<BreadcrumbBar variant="card" />);
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Search issues']");
    expect(input).not.toBeNull();

    await act(async () => {
      input!.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "ZST-377");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    const menu = container.querySelector<HTMLElement>("[role='listbox']#issue-search-menu");
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain("ZST-377");
    expect(menu?.textContent).toContain("new issue 时候输入文档持弹窗出来的位置不对");
    expect(menu?.querySelector("[data-slot='issue-status-icon']")?.getAttribute("data-status")).toBe("todo");

    const result = container.querySelector<HTMLButtonElement>("[role='option']");
    expect(result).not.toBeNull();

    await act(async () => {
      result!.click();
      await Promise.resolve();
    });

    expect(mockNavigate).toHaveBeenCalledWith("/issues/ZST-377");
  });

  it("dismisses the issue detail search menu when clicking outside", async () => {
    pathname = "/RUD/issues/RUD-197";
    mockBreadcrumbs = [
      { label: "Issues", href: "/issues" },
      { label: "RUD-197 current issue" },
    ];
    mockUseQuery = vi.fn((options: { queryKey?: readonly unknown[] }) => {
      if (options.queryKey?.[2] === "search") {
        return {
          data: [
            {
              id: "issue-377",
              identifier: "ZST-377",
              title: "new issue 时候输入文档持弹窗出来的位置不对",
              status: "todo",
            },
          ],
          isFetching: false,
        };
      }
      return { data: undefined, isFetching: false };
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const outsideButton = document.createElement("button");
    outsideButton.textContent = "Outside";
    document.body.appendChild(outsideButton);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => root.unmount());
      container.remove();
      outsideButton.remove();
    };

    await act(async () => {
      root.render(<BreadcrumbBar variant="card" />);
      await Promise.resolve();
    });

    const input = container.querySelector<HTMLInputElement>("input[aria-label='Search issues']");
    expect(input).not.toBeNull();

    await act(async () => {
      input!.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "ZST-377");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector("[role='listbox']#issue-search-menu")).not.toBeNull();

    await act(async () => {
      outsideButton.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      await Promise.resolve();
    });

    expect(container.querySelector("[role='listbox']#issue-search-menu")).toBeNull();
  });

  it("renders a Dashboard and Calendar switcher on the dashboard page", () => {
    pathname = "/RUD/dashboard";

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toContain("dashboard-calendar-switcher");
    expect(html).toContain("data-mode=\"dashboard\"");
    expect(html).toContain("Dashboard");
    expect(html).toContain("Calendar");
  });

  it("omits the Dashboard and Calendar switcher from the main header on the nested calendar page", () => {
    pathname = "/RUD/dashboard/calendar";

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).not.toContain("dashboard-calendar-switcher");
  });
});
