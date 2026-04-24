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
  requestPermission: vi.fn(),
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
  }: {
    children: ReactNode;
    className?: string | ((input: { isActive: boolean }) => string);
    to: string;
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
    >
      {children}
    </a>
  ),
  useLocation: () => ({ pathname: "/dashboard" }),
  useNavigate: () => mockState.navigate,
}));

vi.mock("@/components/OrganizationSwitcher", () => ({
  OrganizationSwitcher: () => <div>Organization switcher</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
});
