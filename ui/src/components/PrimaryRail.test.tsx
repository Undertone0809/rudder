// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
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
    failedRuns: 0,
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

beforeEach(() => {
  mockState.desktopShell.setBadgeCount.mockResolvedValue(undefined);
  mockState.desktopShell.showNotification.mockResolvedValue(undefined);
  mockState.notificationSettings = {
    desktopInboxNotifications: true,
    desktopDockBadge: false,
  };
  mockState.inboxBadge = {
    inbox: 4,
    failedRuns: 0,
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
});

describe("PrimaryRail active motion indicator", () => {
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

  it("moves the rail indicator to issue routes", async () => {
    mockState.pathname = "/issues/RUD-123";

    await renderPrimaryRail();

    const nav = document.querySelector(".motion-rail-nav");

    expect(nav?.getAttribute("data-active-index")).toBe("2");
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
