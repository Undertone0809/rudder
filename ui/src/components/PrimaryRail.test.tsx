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
  pathname: "/dashboard",
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mockState.notificationSettings,
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
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
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
  mockState.setSidebarOpen.mockReset();
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
    const dashboardLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Dashboard"));
    const organizationSwitcher = Array.from(document.querySelectorAll("div"))
      .find((element) =>
        element.textContent === "Organization switcher"
        && element.className.includes("translate-x-[var(--primary-rail-item-shift,0.25rem)]")
      );

    expect(searchButton?.className).toContain("translate-x-[var(--primary-rail-item-shift,0.25rem)]");
    expect(dashboardLink?.className).toContain("translate-x-[var(--primary-rail-item-shift,0.25rem)]");
    expect(organizationSwitcher?.className).toContain("translate-x-[var(--primary-rail-item-shift,0.25rem)]");
  });

  it("preserves the compact macOS desktop rail width", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7)");

    await renderPrimaryRail();

    const rail = document.querySelector('[data-testid="primary-rail"]');

    expect(rail?.getAttribute("data-desktop-platform")).toBe("macos");
    expect(rail?.className).toContain("w-[40px]");
    expect(rail?.className).not.toContain("w-[52px]");
    expect(rail?.className).not.toContain("[--primary-rail-item-width:52px]");
  });

  it("applies rail motion styling to the create menu", async () => {
    await renderPrimaryRail();

    expect(document.querySelector(".rail-create-menu-content")).not.toBeNull();
  });

  it("positions the rail indicator on the active dashboard item", async () => {
    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");
    const indicator = document.querySelector('[data-testid="primary-rail-active-indicator"]');

    expect(nav?.getAttribute("data-active-index")).toBe("1");
    expect(indicator).not.toBeNull();
  });

  it("keeps calendar nested under the dashboard rail item", async () => {
    mockState.pathname = "/dashboard/calendar";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");
    const calendarLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Calendar"));

    expect(nav?.getAttribute("data-active-index")).toBe("1");
    expect(calendarLink).toBeUndefined();
  });

  it("moves the rail indicator to issue routes", async () => {
    mockState.pathname = "/issues/RUD-123";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");

    expect(nav?.getAttribute("data-active-index")).toBe("2");
  });

  it("surfaces Library as a primary rail destination", async () => {
    mockState.pathname = "/library";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");
    const libraryLink = Array.from(document.querySelectorAll("a"))
      .find((link) => link.textContent?.includes("Library"));

    expect(libraryLink?.getAttribute("href")).toBe("/library");
    expect(nav?.getAttribute("data-active-index")).toBe("4");
  });

  it("keeps the legacy resources route active under Library", async () => {
    mockState.pathname = "/resources";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");

    expect(nav?.getAttribute("data-active-index")).toBe("4");
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
