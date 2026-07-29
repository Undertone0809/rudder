// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./SettingsSidebar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const desktopShellMocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
  forceOpenExternal: vi.fn(async () => undefined),
}));
const desktopShellState = vi.hoisted(() => ({ forceOpenExternalAvailable: true }));

const queryState = vi.hoisted(() => ({
  isInstanceAdmin: true,
  deploymentMode: "local_trusted" as "local_trusted" | "authenticated",
}));

vi.mock("@/lib/desktop-shell", () => ({
  readDesktopShell: () => ({
    openExternal: desktopShellMocks.openExternal,
    ...(desktopShellState.forceOpenExternalAvailable
      ? { forceOpenExternal: desktopShellMocks.forceOpenExternal }
      : {}),
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => {
    const key = queryKey.join(":");
    if (key === "access:current-board-access") return { data: { isInstanceAdmin: queryState.isInstanceAdmin } };
    if (key === "health") return { data: { deploymentMode: queryState.deploymentMode } };
    return { data: [] };
  },
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.desktopApp": "Desktop app",
      "common.browser": "Browser",
      "common.account": "Account & security",
    })[key] ?? key,
  }),
}));

vi.mock("@/context/OrganizationContext", () => ({
  useOrganization: () => ({ organizations: [] }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("@/hooks/useScrollbarActivityRef", () => ({
  useScrollbarActivityRef: () => ({ current: null }),
}));

vi.mock("@/hooks/useViewedOrganization", () => ({
  useViewedOrganization: () => ({ viewedOrganizationId: null }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  NavLink: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  useLocation: () => ({ pathname: "/instance/settings/browser", state: null }),
  useNavigate: () => vi.fn(),
}));

vi.mock("./OrganizationSwitcher", () => ({
  OrganizationSwitcher: () => null,
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: ({ label, to }: { label: string; to: string }) => <a href={to}>{label}</a>,
}));

let cleanup: (() => void) | null = null;

afterEach(() => {
  cleanup?.();
  cleanup = null;
  queryState.isInstanceAdmin = true;
  queryState.deploymentMode = "local_trusted";
  desktopShellState.forceOpenExternalAvailable = true;
  desktopShellMocks.openExternal.mockClear();
  desktopShellMocks.forceOpenExternal.mockClear();
});

function renderSidebar(variant: "panel" | "modal" = "panel") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };

  act(() => {
    root.render(
      <SettingsSidebar
        showOrganizationSwitcher={false}
        showBackButton={false}
        variant={variant}
      />,
    );
  });

  return container;
}

describe("SettingsSidebar Browser entry", () => {
  it("opens Docs through the system browser even when built-in link routing is enabled", () => {
    const container = renderSidebar("modal");
    const docsLink = container.querySelector<HTMLAnchorElement>('a[href="https://docs.rudderhq.dev"]');

    expect(docsLink).not.toBeNull();
    act(() => {
      docsLink?.click();
    });

    expect(desktopShellMocks.forceOpenExternal).toHaveBeenCalledWith("https://docs.rudderhq.dev");
    expect(desktopShellMocks.openExternal).not.toHaveBeenCalled();
  });

  it("keeps Docs usable with an older desktop shell bridge", () => {
    desktopShellState.forceOpenExternalAvailable = false;
    const container = renderSidebar("modal");
    const docsLink = container.querySelector<HTMLAnchorElement>('a[href="https://docs.rudderhq.dev"]');

    act(() => {
      docsLink?.click();
    });

    expect(desktopShellMocks.openExternal).toHaveBeenCalledWith("https://docs.rudderhq.dev");
    expect(desktopShellMocks.forceOpenExternal).not.toHaveBeenCalled();
  });

  it("constrains modal navigation so its inner nav becomes the scroll container", () => {
    const container = renderSidebar("modal");

    const sidebar = container.querySelector('[data-testid="workspace-sidebar"]');
    const navigation = sidebar?.querySelector("nav");

    expect(sidebar?.classList.contains("h-full")).toBe(true);
    expect(navigation?.classList.contains("min-h-0")).toBe(true);
    expect(navigation?.classList.contains("overflow-y-auto")).toBe(true);
  });

  it("shows Browser under Desktop app for instance admins", () => {
    const container = renderSidebar();

    const browserLink = container.querySelector('a[href="/instance/settings/browser"]');
    expect(browserLink?.textContent).toBe("Browser");
  });

  it("hides Browser outside local trusted deployments", () => {
    queryState.deploymentMode = "authenticated";
    const container = renderSidebar();

    expect(container.querySelector('a[href="/instance/settings/browser"]')).toBeNull();
    expect(container.querySelector('a[href="/instance/settings/general"]')).not.toBeNull();
  });

  it("hides instance administration destinations from non-admin operators", () => {
    queryState.isInstanceAdmin = false;
    const container = renderSidebar();

    expect(container.querySelector('a[href="/instance/settings/profile"]')).not.toBeNull();
    expect(container.querySelector('a[href="/instance/settings/account"]')).not.toBeNull();
    expect(container.querySelector('a[href="/instance/settings/shortcuts"]')).not.toBeNull();
    expect(container.querySelector('a[href="/instance/settings/general"]')).toBeNull();
    expect(container.querySelector('a[href="/instance/settings/browser"]')).toBeNull();
    expect(container.querySelector('a[href="/instance/settings/heartbeats"]')).toBeNull();
    expect(container.querySelector('a[href="/instance/settings/plugins"]')).toBeNull();
  });
});
