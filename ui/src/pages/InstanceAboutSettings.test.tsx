// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { InstanceAboutSettings } from "./InstanceAboutSettings";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      version: "1.2.3",
      instanceId: "default",
      localEnv: "prod_local",
      runtimeOwnerKind: "desktop",
    },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: string }) => <a href={to}>{children}</a>,
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "about.title": "About",
        "about.description": "About page",
        "about.version.title": "Version",
        "about.version.description": "Version section",
        "about.version.current": "App version",
        "about.desktop.serverVersion": "Server version",
        "about.desktop.title": "Desktop app",
        "about.desktop.description": "Desktop section",
        "about.desktop.profile": "Environment",
        "about.desktop.instance": "Instance ID",
        "about.desktop.runtime": "Runtime",
        "about.desktop.owner": "Owner",
        "about.desktop.instanceDataPath": "Instance data path",
        "about.actions.title": "Actions",
        "about.actions.description": "Actions section",
        "about.updates.title": "Check for updates",
        "about.updates.description": "Update section",
        "about.updates.check": "Check for updates",
        "about.feedback.title": "Send feedback",
        "about.feedback.description": "Feedback section",
        "about.feedback.send": "Send feedback",
        "about.notifications.description": "Notification settings live on their own page.",
        "about.notifications.open": "Open notifications",
        "common.systemSettings": "System settings",
        "common.about": "About",
        "common.notifications": "Notifications",
        "common.unknown": "unknown",
      })[key] ?? key,
  }),
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => null,
}));

describe("InstanceAboutSettings", () => {
  it("shows environment separately from the instance id", () => {
    const html = renderToStaticMarkup(<InstanceAboutSettings />);

    expect(html).toContain("Environment");
    expect(html).toContain("Prod");
    expect(html).toContain("Instance ID");
    expect(html).toContain("default");
    expect(html).not.toContain(">Profile<");
  });

  it("links notification management to the notifications settings page", () => {
    const html = renderToStaticMarkup(<InstanceAboutSettings />);

    expect(html).toContain("Notifications");
    expect(html).toContain("Notification settings live on their own page.");
    expect(html).toContain("Open notifications");
  });
});
