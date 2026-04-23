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
  onBootState: vi.fn(),
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
        "common.notifications": "Notifications",
        "settings.eyebrow.system": "System settings",
        "notifications.title": "Notifications",
        "notifications.description": "Manage inbox alerts and app icon badges.",
        "notifications.loadFailed": "Failed to load notification settings.",
        "notifications.updateFailed": "Failed to save notification settings.",
        "notifications.permission.requestFailed": "Failed to request notifications.",
        "notifications.permission.openSettingsFailed": "Failed to open settings.",
        "notifications.permission.title": "Permission",
        "notifications.permission.description": "Desktop access and repair actions.",
        "notifications.permission.access.title": "Notification access",
        "notifications.permission.access.summary":
          "Permission: {{permission}}. Alerts: {{notificationsSupport}}. Badge: {{badgeSupport}}.",
        "notifications.permission.access.summaryDesktop":
          "Permission: {{permission}}. Native alerts: {{notificationsSupport}}. Badge path: {{badgeSupport}}.",
        "notifications.permission.access.systemManaged": "System-managed",
        "notifications.permission.access.default": "Rudder has not asked for access yet.",
        "notifications.permission.access.denied.browser": "Browser denied.",
        "notifications.permission.access.requesting": "Requesting...",
        "notifications.permission.access.enable": "Enable notifications",
        "notifications.permission.access.testing": "Sending...",
        "notifications.permission.access.testNotification": "Send test notification",
        "notifications.permission.access.testNotificationTitle": "Rudder notifications are on",
        "notifications.permission.access.testNotificationBody": "Test body",
        "notifications.permission.access.desktopHelp": "Desktop help for {{appName}}.",
        "notifications.permission.access.lastTest": "Last notification {{title}} at {{timestamp}}.",
        "notifications.permission.access.openSettings": "Open notification settings",
        "notifications.environment.title": "Environment",
        "notifications.environment.desktop": "Running inside the desktop shell.",
        "notifications.environment.browser": "Running in browser preview.",
        "notifications.environment.desktopHelp": "Desktop badges and alerts can both run here.",
        "notifications.environment.browserHelp": "Browser mode can preview alerts, but it has no app icon badge.",
        "notifications.behavior.title": "Behavior",
        "notifications.behavior.description": "Choose what Rudder should surface.",
        "notifications.behavior.inbox.title": "Inbox activity",
        "notifications.behavior.inbox.description": "Show an alert when unread inbox count increases.",
        "notifications.behavior.inbox.toggle": "Toggle inbox notifications",
        "notifications.behavior.badge.title": "App icon badge",
        "notifications.behavior.badge.description": "Show unread inbox count on the app icon.",
        "notifications.behavior.badge.browserOnly": "Only visible in the desktop shell.",
        "notifications.behavior.badge.lastSync": "Last badge sync: {{count}} ({{result}}).",
        "notifications.behavior.badge.desktopDebug": "Desktop debug badge copy.",
        "notifications.behavior.badge.preview": "Preview badge",
        "notifications.behavior.badge.previewing": "Previewing...",
        "notifications.behavior.badge.toggle": "Toggle app icon badge",
        "notifications.support.available": "available",
        "notifications.support.unavailable": "unavailable",
        "notifications.support.accepted": "accepted",
        "notifications.support.rejected": "rejected",
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
  desktopShellMock.onBootState.mockReset();
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
  it("explains browser preview behavior and shows both notification controls", async () => {
    const container = renderPage();

    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Notifications");
    expect(container.textContent).toContain("Running in browser preview.");
    expect(container.textContent).toContain("Browser mode can preview alerts, but it has no app icon badge.");
    expect(container.textContent).toContain("Inbox activity");
    expect(container.textContent).toContain("App icon badge");
  });

  it("shows desktop debug actions instead of browser permission actions in the desktop shell", async () => {
    desktopShellValue = desktopShellMock;
    desktopShellMock.onBootState.mockReturnValue(() => {});
    desktopShellMock.getBootState.mockResolvedValue({
      capabilities: {
        notifications: true,
        badgeCount: true,
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

    expect(container.textContent).toContain("Running inside the desktop shell.");
    expect(container.textContent).toContain("Desktop help for Rudder-dev.");
    expect(container.textContent).toContain("Send test notification");
    expect(container.textContent).toContain("Preview badge");
    expect(container.textContent).toContain("Last notification Rudder notifications are on at 2026-04-22T09:30:00.000Z.");
    expect(container.textContent).not.toContain("Enable notifications");
  });
});
