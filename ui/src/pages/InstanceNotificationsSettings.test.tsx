// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstanceNotificationsSettings } from "./InstanceNotificationsSettings";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const desktopShellMock = {
  getBootState: vi.fn(),
  getSystemPermissions: vi.fn(),
  onBootState: vi.fn(),
  openExternal: vi.fn(),
  openNotificationSettings: vi.fn(),
  setBadgeCount: vi.fn(),
  showNotification: vi.fn(),
};

let desktopShellValue: typeof desktopShellMock | null = null;

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => {
    const key = queryKey.join(":");
    if (key === "instance:notification-settings") {
      return {
        data: {
          desktopInboxNotifications: true,
          desktopDockBadge: true,
          desktopIssueNotifications: true,
          desktopChatNotifications: true,
        },
        isLoading: false,
        error: null,
      };
    }
    return {
      data: null,
      isLoading: false,
      error: null,
    };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useQueryClient: () => ({
    setQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const messages: Record<string, string> = {
        "common.systemSettings": "System settings",
        "common.systemPermissions": "System permissions",
        "common.notifications": "Notifications",
        "settings.eyebrow.system": "System settings",
        "notifications.title": "Notifications",
        "notifications.description": "Manage inbox alerts.",
        "notifications.loadFailed": "Failed to load notification settings.",
        "notifications.updateFailed": "Failed to save notification settings.",
        "notifications.permission.requestFailed": "Failed to request notifications.",
        "notifications.permission.openSettingsFailed": "Failed to open settings.",
        "notifications.permission.title": "Permission",
        "notifications.permission.description": "Desktop access and repair actions.",
        "notifications.permission.access.title": "Notification access",
        "notifications.permission.access.summary":
          "Permission: {{permission}}. Alerts: {{notificationsSupport}}.",
        "notifications.permission.access.summaryDesktop":
          "Permission: {{permission}}. Native alerts: {{notificationsSupport}}.",
        "notifications.permission.access.default": "Rudder has not asked for access yet.",
        "notifications.permission.access.denied.browser": "Browser denied.",
        "notifications.permission.access.requesting": "Requesting...",
        "notifications.permission.access.enable": "Enable notifications",
        "notifications.permission.access.desktopHelp": "Desktop help for {{appName}}.",
        "notifications.permission.access.desktopHelpProd": "Production desktop help for {{appName}}.",
        "notifications.permission.access.openSettings": "Open notification settings",
        "notifications.environment.title": "Environment",
        "notifications.environment.desktop": "Running inside the desktop shell.",
        "notifications.environment.browser": "Running in browser preview.",
        "notifications.environment.desktopHelp": "Desktop alerts can run here.",
        "notifications.environment.browserHelp": "Browser mode can preview alerts.",
        "notifications.behavior.title": "Behavior",
        "notifications.behavior.description": "Choose what Rudder should surface.",
        "notifications.behavior.inbox.title": "Inbox activity",
        "notifications.behavior.inbox.description": "Show an alert when unread inbox count increases.",
        "notifications.behavior.inbox.toggle": "Toggle inbox notifications",
        "notifications.support.available": "available",
        "notifications.support.unavailable": "unavailable",
        "systemPermissions.title": "System permissions",
        "systemPermissions.description": "Review OS permissions.",
        "systemPermissions.section.title": "Permissions",
        "systemPermissions.section.description": "Open the relevant system pane.",
        "systemPermissions.status.authorized": "Authorized",
        "systemPermissions.status.needsAccess": "Needs access",
        "systemPermissions.status.blocked": "Blocked",
        "systemPermissions.status.checking": "Checking",
        "systemPermissions.status.desktopOnly": "Desktop app only",
        "systemPermissions.status.perApp": "Per app",
        "systemPermissions.status.unknown": "Unknown",
        "systemPermissions.status.unavailable": "Unavailable",
        "systemPermissions.action.openSettings": "Open settings",
        "systemPermissions.action.desktopOnly": "Desktop only",
        "systemPermissions.action.browserManaged": "Browser managed",
        "systemPermissions.openSettingsFailed": "Failed to open system settings.",
        "systemPermissions.permission.fullDiskAccess.title": "Full Disk Access",
        "systemPermissions.permission.fullDiskAccess.description": "Read local project files.",
        "systemPermissions.permission.accessibility.title": "Accessibility",
        "systemPermissions.permission.accessibility.description": "Observe and control app UI.",
        "systemPermissions.permission.automation.title": "Automation",
        "systemPermissions.permission.automation.description": "macOS grants Automation per target app.",
        "systemPermissions.permission.notifications.title": "Notifications",
        "systemPermissions.permission.notifications.description": "System notification access for Rudder alerts.",
        "systemPermissions.permission.notifications.inboxLabel": "Inbox activity alerts",
        "systemPermissions.notifications.title": "Notifications",
        "systemPermissions.notifications.description": "Choose notification types.",
        "systemPermissions.notifications.system.title": "System notification access",
        "systemPermissions.notifications.system.description": "Open the OS notification pane.",
        "systemPermissions.notifications.issue.title": "Issue notifications",
        "systemPermissions.notifications.issue.description": "Notify about issue activity.",
        "systemPermissions.notifications.issue.toggle": "Toggle issue notifications",
        "systemPermissions.notifications.chat.title": "Chat notifications",
        "systemPermissions.notifications.chat.description": "Notify about chat replies.",
        "systemPermissions.notifications.chat.toggle": "Toggle chat notifications",
      };
      return (messages[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars?.[name] ?? ""));
    },
  }),
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => desktopShellValue,
}));

vi.mock("@/lib/desktop-notification-permission", () => ({
  readDesktopNotificationPermission: () => "default",
  requestDesktopNotificationPermission: vi.fn(),
  formatDesktopNotificationPermission: () => "Not asked",
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  desktopShellValue = null;
  desktopShellMock.getBootState.mockReset();
  desktopShellMock.getSystemPermissions.mockReset();
  desktopShellMock.onBootState.mockReset();
  desktopShellMock.openExternal.mockReset();
  desktopShellMock.openNotificationSettings.mockReset();
  desktopShellMock.setBadgeCount.mockReset();
  desktopShellMock.showNotification.mockReset();
});

function renderPage() {
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
    root.render(<InstanceNotificationsSettings />);
  });

  return container;
}

describe("InstanceNotificationsSettings", () => {
  it("separates system permissions from notification preferences", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("System permissions");
    expect(container.textContent).toContain("Full Disk Access");
    expect(container.textContent).toContain("Accessibility");
    expect(container.textContent).toContain("Automation");
    expect(container.textContent).toContain("Notifications");
    expect(container.textContent).toContain("System notification access");
    expect(container.textContent).toContain("Issue notifications");
    expect(container.textContent).toContain("Chat notifications");
    expect(container.textContent).not.toContain("Inbox activity alerts");
    expect(container.textContent).toContain("Desktop app only");
    expect(container.textContent).not.toContain("Running in browser preview.");
    expect(container.textContent).not.toContain("App icon badge");
    expect(
      container.querySelector('button[role="switch"][aria-label="Toggle issue notifications"]')?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container.querySelector('button[role="switch"][aria-label="Toggle chat notifications"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("shows desktop system-settings actions instead of browser permission action in the desktop shell", async () => {
    desktopShellValue = desktopShellMock;
    desktopShellMock.onBootState.mockReturnValue(() => {});
    desktopShellMock.getSystemPermissions.mockResolvedValue({
      fullDiskAccess: "needs_access",
      accessibility: "authorized",
      automation: "per_app",
    });
    desktopShellMock.getBootState.mockResolvedValue({
      capabilities: {
        notifications: true,
        badgeCount: true,
      },
      permissions: {
        fullDiskAccess: "needs_access",
        accessibility: "authorized",
        automation: "per_app",
      },
      diagnostics: {
        lastBadgeCount: 2,
        badgeSyncSucceeded: true,
        lastNotificationTitle: "Rudder notifications are on",
        lastNotificationTriggeredAt: "2026-04-22T09:30:00.000Z",
      },
      runtime: {
        localEnv: "dev",
      },
    });

    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("System permissions");
    expect(container.textContent).toContain("Full Disk Access");
    expect(container.textContent).toContain("Needs access");
    expect(container.textContent).toContain("Accessibility");
    expect(container.textContent).toContain("Authorized");
    expect(container.textContent).toContain("Automation");
    expect(container.textContent).toContain("Per app");
    expect(container.textContent).not.toContain("System managed");
    expect(container.textContent).toContain("Open settings");
    expect(container.textContent).not.toContain("Send test notification");
    expect(container.textContent).not.toContain("Preview badge");
    expect(container.textContent).not.toContain("Last notification Rudder notifications are on at 2026-04-22T09:30:00.000Z.");
    expect(container.textContent).not.toContain("Enable notifications");
  });

  it("hides desktop debug actions outside the dev desktop shell", async () => {
    desktopShellValue = desktopShellMock;
    desktopShellMock.onBootState.mockReturnValue(() => {});
    desktopShellMock.getSystemPermissions.mockResolvedValue({
      fullDiskAccess: "authorized",
      accessibility: "authorized",
      automation: "per_app",
    });
    desktopShellMock.getBootState.mockResolvedValue({
      capabilities: {
        notifications: true,
        badgeCount: true,
      },
      permissions: {
        fullDiskAccess: "authorized",
        accessibility: "authorized",
        automation: "per_app",
      },
      diagnostics: {
        lastBadgeCount: 2,
        badgeSyncSucceeded: true,
        lastNotificationTitle: "Rudder notifications are on",
        lastNotificationTriggeredAt: "2026-04-22T09:30:00.000Z",
      },
      runtime: {
        localEnv: "prod_local",
      },
    });

    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("System permissions");
    expect(container.textContent).toContain("Authorized");
    expect(container.textContent).toContain("Per app");
    expect(container.textContent).not.toContain("System managed");
    expect(container.textContent).toContain("Open settings");
    expect(container.textContent).not.toContain("Send test notification");
    expect(container.textContent).not.toContain("Preview badge");
    expect(container.textContent).not.toContain("Last notification Rudder notifications are on at 2026-04-22T09:30:00.000Z.");
    expect(container.textContent).not.toContain("Enable notifications");
  });
});
