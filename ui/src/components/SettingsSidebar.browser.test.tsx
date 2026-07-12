// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsSidebar } from "./SettingsSidebar";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => {
    const key = queryKey.join(":");
    if (key === "access:current-board-access") return { data: { isInstanceAdmin: true } };
    if (key === "health") return { data: { deploymentMode: "local_trusted" } };
    return { data: [] };
  },
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "common.desktopApp": "Desktop app",
      "common.browser": "Browser",
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
});

describe("SettingsSidebar Browser entry", () => {
  it("shows Browser under Desktop app for instance admins", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
    };

    act(() => {
      root.render(<SettingsSidebar showOrganizationSwitcher={false} showBackButton={false} />);
    });

    const browserLink = container.querySelector('a[href="/instance/settings/browser"]');
    expect(browserLink?.textContent).toBe("Browser");
  });
});
