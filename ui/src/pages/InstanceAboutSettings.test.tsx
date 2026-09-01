// @vitest-environment node

import { en } from "@/i18n/locales/en";
import { zhCN } from "@/i18n/locales/zh-CN";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceAboutSettings, resolveAboutCurrentVersion } from "./InstanceAboutSettings";

const updateProgressState = vi.hoisted(() => ({
  current: null as null | {
    updateId: string;
    version: string;
    phase: "preparing_runtime";
    message: string;
    at: string;
  },
}));

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

vi.mock("@/context/DesktopUpdateProgressContext", () => ({
  useDesktopUpdateProgress: () => ({
    progress: updateProgressState.current,
    dismissProgress: vi.fn(),
  }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) =>
      ({
        "about.title": "About",
        "about.version.title": "Version",
        "about.version.description": "Version section",
        "about.version.current": "Version",
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
        "about.updates.description": "__static_update_description__",
        "about.updates.check": "Check for updates",
        "about.updates.progress.detailsTitle": "Update progress details",
        "about.updates.progress.title": "Updating to v0.7.14",
        "about.updates.progress.phase.preparing_runtime": "Preparing lightweight update...",
        "about.feedback.title": "Send feedback",
        "about.feedback.description": "__static_feedback_description__",
        "about.feedback.send": "Send feedback",
        "common.systemSettings": "System settings",
        "common.about": "About",
        "common.unknown": "unknown",
      })[key] ?? key,
  }),
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => null,
}));

describe("InstanceAboutSettings", () => {
  beforeEach(() => {
    updateProgressState.current = null;
  });

  it("shows environment separately from the instance id", () => {
    const html = renderToStaticMarkup(<InstanceAboutSettings />);

    expect(html).toContain("Environment");
    expect(html).toContain("Prod");
    expect(html).toContain("Instance ID");
    expect(html).toContain("default");
    expect(html).not.toContain(">Profile<");
  });

  it("does not duplicate the system permissions entry inside actions", () => {
    const html = renderToStaticMarkup(<InstanceAboutSettings />);

    expect(html).not.toContain("Notifications");
    expect(html).not.toContain("Open notifications");
  });

  it("shows one unified build version", () => {
    const html = renderToStaticMarkup(<InstanceAboutSettings />);

    expect(html).toContain(">Version<");
    expect(html).toContain(">v1.2.3<");
    expect(html).not.toContain("App version");
    expect(html).not.toContain("Server version");
  });

  it("prefers the Rudder runtime version over the desktop shell package version", () => {
    expect(
      resolveAboutCurrentVersion({
        desktopRuntimeVersion: "0.1.0-canary.18",
        desktopAppVersion: "37.10.3",
        healthVersion: "0.1.0",
      }),
    ).toBe("0.1.0-canary.18");
  });

  it("keeps feedback recipient details out of the static about page copy", () => {
    expect(en["about.feedback.toastBody"]).toContain("Rudder maintainer's email");
    expect(zhCN["about.feedback.toastBody"]).toContain("Rudder 维护者邮箱");
    expect(en["about.feedback.toastBody"]).not.toContain("zeeland4work@gmail.com");
    expect(zhCN["about.feedback.toastBody"]).not.toContain("zeeland4work@gmail.com");
  });

  it("does not render static descriptions for update and feedback actions", () => {
    const html = renderToStaticMarkup(<InstanceAboutSettings />);

    expect(html).not.toContain("__static_update_description__");
    expect(html).not.toContain("__static_feedback_description__");
  });

  it("provides natural runtime preparation labels in both supported locales", () => {
    expect(en["about.updates.progress.phase.preparing_runtime"])
      .toBe("Preparing lightweight update...");
    expect(zhCN["about.updates.progress.phase.preparing_runtime"])
      .toBe("正在准备轻量更新...");
  });

  it("renders runtime preparation as the active update step", () => {
    updateProgressState.current = {
      updateId: "update-layered",
      version: "0.7.14",
      phase: "preparing_runtime",
      message: "Preparing the target runtime for a lightweight update.",
      at: new Date().toISOString(),
    };

    const html = renderToStaticMarkup(<InstanceAboutSettings />);

    expect(html).toContain("Update progress details");
    expect(html).toContain("Preparing lightweight update...");
    expect(html).toContain("text-foreground\"><span class=\"h-2 w-2 rounded-full bg-emerald-700\"></span><span>Preparing lightweight update...");
    expect(html).toContain("disabled=\"\"");
    expect(html).not.toContain("Update failed");
  });
});
