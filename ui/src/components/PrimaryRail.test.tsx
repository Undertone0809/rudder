// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrimaryRail } from "./PrimaryRail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  desktopShell: {
    setBadgeCount: vi.fn(),
    showNotification: vi.fn(),
  },
  notificationSettings: {
    desktopInboxNotifications: true,
    desktopDockBadge: false,
  },
  inboxBadge: {
    inbox: 4,
    isReady: true,
    approvals: 0,
    failedRuns: 0,
    joinRequests: 0,
    unreadTouchedIssues: 0,
    chatAttention: 4,
    alerts: 0,
    notificationContent: {
      title: "Unread inbox",
      body: "4 unread items",
    },
  },
  navigate: vi.fn(),
  setSidebarOpen: vi.fn(),
  requestPermission: vi.fn(),
  dismissUnreads: vi.fn(),
  invalidateQueries: vi.fn(),
  pathname: "/dashboard",
  primaryRailPaths: {} as Record<string, string>,
  pinnedLocalApps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: {
    mutationFn: () => Promise<unknown>;
    onSuccess?: () => Promise<void> | void;
  }) => ({
    mutate: vi.fn(async () => {
      await options.mutationFn();
      await options.onSuccess?.();
    }),
    isPending: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: mockState.invalidateQueries,
  }),
  useQuery: (options: { queryKey?: readonly unknown[] }) => ({
    data: options.queryKey?.includes("primary-rail-pins")
      ? { items: mockState.pinnedLocalApps }
      : mockState.notificationSettings,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useInboxBadge", () => ({
  useInboxBadge: () => mockState.inboxBadge,
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => mockState.desktopShell,
}));

vi.mock("@/lib/desktop-notification-permission", () => ({
  readDesktopNotificationPermission: () => "granted",
  requestDesktopNotificationPermission: () => mockState.requestPermission(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: {
    getNotifications: vi.fn(),
  },
}));

vi.mock("@/api/messenger", () => ({
  messengerApi: {
    dismissUnreads: mockState.dismissUnreads,
    listSavedViews: vi.fn(),
  },
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
    openNewAgent: vi.fn(),
    openNewProject: vi.fn(),
  }),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
  }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({
    setSidebarOpen: mockState.setSidebarOpen,
  }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/lib/issue-navigation", () => ({
  readRememberedIssueNavigationPath: () => "/issues",
}));

vi.mock("@/lib/primary-rail-memory", () => ({
  readRememberedPrimaryRailPath: (_orgId: string | null | undefined, section: string, fallbackPath: string) =>
    mockState.primaryRailPaths[section] ?? fallbackPath,
}));

vi.mock("@/lib/organization-routes", () => ({
  toOrganizationRelativePath: (path: string) => path,
}));

vi.mock("@/lib/router", () => ({
  NavLink: ({
    children,
    className,
    to,
    ...props
  }: {
    children: ReactNode;
    className?: string | ((input: { isActive: boolean }) => string);
    to: string;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: mockState.pathname }),
  useNavigate: () => mockState.navigate,
}));

vi.mock("@/components/OrganizationSwitcher", () => ({
  OrganizationSwitcher: () => <div>Organization switcher</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

let cleanupFn: (() => void) | null = null;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: userAgent,
  });
}

beforeEach(() => {
  setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  mockState.desktopShell.setBadgeCount.mockResolvedValue(undefined);
  mockState.desktopShell.showNotification.mockResolvedValue(undefined);
  mockState.notificationSettings = {
    desktopInboxNotifications: true,
    desktopDockBadge: false,
  };
  mockState.inboxBadge = {
    inbox: 4,
    isReady: true,
    approvals: 0,
    failedRuns: 0,
    joinRequests: 0,
    unreadTouchedIssues: 0,
    chatAttention: 4,
    alerts: 0,
    notificationContent: {
      title: "Unread inbox",
      body: "4 unread items",
    },
  };
  mockState.pathname = "/dashboard";
  mockState.primaryRailPaths = {};
  mockState.pinnedLocalApps = [];
  mockState.setSidebarOpen.mockReset();
  mockState.dismissUnreads.mockResolvedValue({ dismissedCount: 4, dismissedThreadKeys: [] });
  mockState.invalidateQueries.mockReset();
});

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  vi.clearAllMocks();
});

async function renderPrimaryRail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  cleanupFn = () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };

  await act(async () => {
    root.render(<PrimaryRail onOpenSettings={vi.fn()} onWarmSettings={vi.fn()} />);
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    rerender: async () => {
      await act(async () => {
        root.render(<PrimaryRail onOpenSettings={vi.fn()} onWarmSettings={vi.fn()} />);
      });
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

describe("PrimaryRail desktop inbox signals", () => {
  it("syncs the desktop badge when notifications are enabled even if the legacy badge setting is off", async () => {
    await renderPrimaryRail();

    expect(mockState.desktopShell.setBadgeCount).toHaveBeenCalledWith(4);
  });

  it("clears the desktop badge when notifications are disabled", async () => {
    mockState.notificationSettings = {
      desktopInboxNotifications: false,
      desktopDockBadge: true,
    };

    await renderPrimaryRail();

    expect(mockState.desktopShell.setBadgeCount).toHaveBeenCalledWith(0);
  });

  it("does not show a desktop notification when the unread count increases on Messenger routes", async () => {
    mockState.pathname = "/messenger/issues";
    mockState.inboxBadge = {
      ...mockState.inboxBadge,
      inbox: 1,
    };
    const view = await renderPrimaryRail();

    mockState.inboxBadge = {
      ...mockState.inboxBadge,
      inbox: 2,
      notificationContent: {
        title: "Unread inbox",
        body: "2 unread items",
      },
    };
    await view.rerender();

    expect(mockState.desktopShell.setBadgeCount).toHaveBeenLastCalledWith(2);
    expect(mockState.desktopShell.showNotification).not.toHaveBeenCalled();
  });

  it("uses the aggregate inbox count for rail, dock badge, and desktop notifications", async () => {
    mockState.inboxBadge = {
      ...mockState.inboxBadge,
      inbox: 32,
      unreadTouchedIssues: 22,
      chatAttention: 10,
      notificationContent: {
        title: "New inbox activity",
        body: "You have 32 inbox items needing attention: 10 chat threads, 22 issue updates.",
      },
    };
    const view = await renderPrimaryRail();

    expect(document.querySelector('[data-testid="rail-badge-messenger"]')?.textContent).toBe("32");
    expect(mockState.desktopShell.setBadgeCount).toHaveBeenLastCalledWith(32);

    mockState.inboxBadge = {
      ...mockState.inboxBadge,
      inbox: 33,
      unreadTouchedIssues: 23,
      chatAttention: 10,
      notificationContent: {
        title: "New inbox activity",
        body: "You have 33 inbox items needing attention: 10 chat threads, 23 issue updates.",
      },
    };
    await view.rerender();

    expect(document.querySelector('[data-testid="rail-badge-messenger"]')?.textContent).toBe("33");
    expect(mockState.desktopShell.setBadgeCount).toHaveBeenLastCalledWith(33);
    expect(mockState.desktopShell.showNotification).toHaveBeenLastCalledWith({
      title: "New inbox activity",
      body: "You have 33 inbox items needing attention: 10 chat threads, 23 issue updates.",
    });
  });

  it("does not announce the first server-ready inbox count after reload", async () => {
    mockState.inboxBadge = {
      ...mockState.inboxBadge,
      inbox: 0,
      isReady: false,
      notificationContent: {
        title: "New inbox activity",
        body: "You have 0 unread inbox items.",
      },
    };
    const view = await renderPrimaryRail();

    mockState.inboxBadge = {
      ...mockState.inboxBadge,
      inbox: 4,
      isReady: true,
      chatAttention: 4,
      notificationContent: {
        title: "Unread inbox",
        body: "4 unread items",
      },
    };
    await view.rerender();

    expect(mockState.desktopShell.setBadgeCount).toHaveBeenLastCalledWith(4);
    expect(mockState.desktopShell.showNotification).not.toHaveBeenCalled();

    mockState.inboxBadge = {
      ...mockState.inboxBadge,
      inbox: 5,
      chatAttention: 5,
      notificationContent: {
        title: "Unread inbox",
        body: "5 unread items",
      },
    };
    await view.rerender();

    expect(mockState.desktopShell.showNotification).toHaveBeenCalledWith({
      title: "Unread inbox",
      body: "5 unread items",
    });
  });
});

describe("PrimaryRail active motion indicator", () => {
  it("uses a narrow Windows desktop rail with platform-scoped active affordances", async () => {
    await renderPrimaryRail();

    const rail = document.querySelector('[data-testid="primary-rail"]');

    expect(rail?.getAttribute("data-desktop-shell")).toBe("true");
    expect(rail?.getAttribute("data-desktop-platform")).toBe("windows");
    expect(rail?.className).toContain("w-[52px]");
    expect(rail?.className).toContain("[--primary-rail-item-width:52px]");
    expect(rail?.className).toContain("[--primary-rail-item-shift:0px]");
  });

  it("uses the same rail shift variable for utility controls and nav items", async () => {
    await renderPrimaryRail();

    const searchButton = document.querySelector('button[aria-label="common.search"]');
    const organizationLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Organization"));
    const organizationSwitcher = Array.from(document.querySelectorAll("div"))
      .find((element) =>
        element.textContent === "Organization switcher"
        && element.className.includes("translate-x-[var(--primary-rail-item-shift,0.25rem)]")
      );

    expect(searchButton?.className).toContain("translate-x-[var(--primary-rail-item-shift,0.25rem)]");
    expect(organizationLink?.className).toContain("translate-x-[var(--primary-rail-item-shift,0.25rem)]");
    expect(organizationSwitcher?.className).toContain("translate-x-[var(--primary-rail-item-shift,0.25rem)]");
  });

  it("preserves the compact macOS desktop rail width", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7)");

    await renderPrimaryRail();

    const rail = document.querySelector('[data-testid="primary-rail"]');
    const nav = document.querySelector(".motion-rail-nav");

    expect(rail?.getAttribute("data-desktop-platform")).toBe("macos");
    expect(rail?.className).toContain("w-[40px]");
    expect(rail?.className).not.toContain("w-[52px]");
    expect(rail?.className).not.toContain("[--primary-rail-item-width:52px]");
    expect(nav?.className).toContain(
      "w-[calc(var(--primary-rail-item-width,66px)+var(--primary-rail-item-shift,0.25rem)+var(--primary-rail-item-shift,0.25rem)+0.625rem)]",
    );
    expect(nav?.className).not.toContain("w-full");
  });

  it("applies rail motion styling to the create menu", async () => {
    await renderPrimaryRail();

    expect(document.querySelector(".rail-create-menu-trigger")).not.toBeNull();
    expect(document.querySelector(".rail-create-menu-content.morph-popover.morph-popover--from-left")).not.toBeNull();
  });

  it("dismisses Messenger unreads from the rail context menu and refreshes Messenger caches", async () => {
    await renderPrimaryRail();

    const messengerLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Messenger"));
    expect(messengerLink).toBeTruthy();

    await act(async () => {
      messengerLink!.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 144,
        clientY: 188,
      }));
    });

    const dismissButton = Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Dismiss Unreads"));
    expect(dismissButton).toBeTruthy();

    await act(async () => {
      dismissButton!.click();
      await Promise.resolve();
    });

    expect(mockState.dismissUnreads).toHaveBeenCalledWith("org-1");
    expect(mockState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["sidebar-badges", "org-1"] });
    expect(mockState.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["messenger", "org-1", "threads", "preview"] });
  });

  it("positions the rail indicator on the organization item for dashboard routes", async () => {
    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");
    const indicator = document.querySelector('[data-testid="primary-rail-active-indicator"]');

    expect(nav?.getAttribute("data-active-index")).toBe("4");
    expect(indicator).not.toBeNull();
  });

  it("keeps calendar nested under the organization rail item", async () => {
    mockState.pathname = "/dashboard/calendar";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");
    const dashboardLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Dashboard"));

    expect(nav?.getAttribute("data-active-index")).toBe("4");
    expect(dashboardLink).toBeUndefined();
  });

  it("moves the rail indicator to issue routes", async () => {
    mockState.pathname = "/issues/RUD-123";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");

    expect(nav?.getAttribute("data-active-index")).toBe("1");
  });

  it("surfaces Library as a primary rail destination", async () => {
    mockState.pathname = "/library";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");
    const libraryLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Library"));

    expect(libraryLink?.getAttribute("href")).toBe("/library");
    expect(nav?.getAttribute("data-active-index")).toBe("3");
  });

  it("shows pinned Local App Saved Views after the fixed destinations", async () => {
    mockState.pinnedLocalApps = [{
      id: "saved-local-a",
      title: "MKT dashboard with a very long project name",
      targetPayload: {
        kind: "local_app",
        desktopInstallationId: "installation-a",
        appPublicId: "public-a",
        localBindingId: "binding-a",
        viewInstanceId: "view-a",
      },
    }];

    await renderPrimaryRail();

    const pinnedLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("MKT dashboard with a very long project name"));
    expect(pinnedLink?.getAttribute("href")).toBe("/messenger/saved/saved-local-a");
    expect(pinnedLink?.querySelector('[data-testid="primary-rail-local-app-icon"]')).not.toBeNull();
    expect(pinnedLink?.lastElementChild?.className).toContain("truncate");
    expect(pinnedLink?.lastElementChild?.getAttribute("title"))
      .toBe("MKT dashboard with a very long project name");
    expect(document.querySelector(".motion-rail-nav")?.className).toContain("overflow-y-auto");
  });

  it("gives an exact pinned Saved View the only Messenger-route active treatment", async () => {
    mockState.pathname = "/messenger/saved/saved-local-a";
    mockState.pinnedLocalApps = [{
      id: "saved-local-a",
      title: "MKT dashboard",
      targetPayload: {
        kind: "local_app",
        desktopInstallationId: "installation-a",
        appPublicId: "public-a",
        localBindingId: "binding-a",
        viewInstanceId: "view-a",
      },
    }];

    await renderPrimaryRail();

    const links = Array.from(document.querySelectorAll("a"));
    const messenger = links.find((link) => link.textContent?.includes("Messenger"));
    const pinned = links.find((link) => link.textContent?.includes("MKT dashboard"));
    expect(messenger?.hasAttribute("aria-current")).toBe(false);
    expect(pinned?.getAttribute("aria-current")).toBe("page");
    expect(pinned?.className).toContain("var(--sidebar-foreground)");
    expect(pinned?.className).toContain("dark:text-[#def4eb]");
    expect(pinned?.querySelector('[data-testid="primary-rail-pinned-active-indicator"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="primary-rail-active-indicator"]')).toBeNull();
  });

  it("keeps the legacy resources route active under Library", async () => {
    mockState.pathname = "/resources";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");

    expect(nav?.getAttribute("data-active-index")).toBe("3");
  });

  it("uses remembered section paths as primary rail destinations", async () => {
    mockState.primaryRailPaths = {
      messenger: "/messenger/issues/ZST-200",
      issues: "/issues/ZST-586",
      agents: "/agents/wesley/runs/run-1",
      library: "/library?path=projects%2Frudder",
      organization: "/dashboard/calendar",
      automations: "/automations/weekly-ci",
    };

    await renderPrimaryRail();

    const links = Array.from(document.querySelectorAll("a"));
    const linkHref = (label: string) => links.find((link) => link.textContent?.includes(label))?.getAttribute("href");

    expect(linkHref("Messenger")).toBe("/messenger/issues/ZST-200");
    expect(linkHref("Issue")).toBe("/issues/ZST-586");
    expect(linkHref("Agents")).toBe("/agents/wesley/runs/run-1");
    expect(linkHref("Library")).toBe("/library?path=projects%2Frudder");
    expect(linkHref("Organization")).toBe("/dashboard/calendar");
    expect(linkHref("Automations")).toBe("/automations/weekly-ci");
  });
});

describe("PrimaryRail Messenger double click", () => {
  it("opens the sidebar and requests an unread Messenger scroll when unread items exist", async () => {
    const scrollRequest = vi.fn();
    document.addEventListener("rudder:messenger-scroll-to-unread", scrollRequest);
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;

    await renderPrimaryRail();

    const messengerLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Messenger"));
    expect(messengerLink).toBeTruthy();

    messengerLink?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

    expect(mockState.setSidebarOpen).toHaveBeenCalledWith(true);
    expect(scrollRequest).toHaveBeenCalled();

    document.removeEventListener("rudder:messenger-scroll-to-unread", scrollRequest);
  });
});
