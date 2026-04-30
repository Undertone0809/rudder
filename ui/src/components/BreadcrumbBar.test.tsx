// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";

let pathname = "/RUD/messenger/issues";
let breadcrumbs: Array<{ label: string; href?: string }> = [];

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname, search: "" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ breadcrumbs, headerActions: null }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ toggleSidebar: vi.fn(), isMobile: false }),
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    selectedOrganizationId: "org-1",
    selectedOrganization: { issuePrefix: "RUD" },
  }),
}));

vi.mock("@/context/DialogContext", () => ({
  useDialog: () => ({
    openNewIssue: vi.fn(),
    openNewProject: vi.fn(),
    openNewAgent: vi.fn(),
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: undefined }),
}));

vi.mock("@/context/I18nContext", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [] }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
  usePluginLaunchers: () => ({ launchers: [] }),
}));

describe("BreadcrumbBar", () => {
  beforeEach(() => {
    pathname = "/RUD/messenger/issues";
    breadcrumbs = [];
  });

  it("hides the integrated card header on messenger routes", () => {
    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).not.toContain("Messenger");
  });

  it("hides the integrated card header on agent detail routes", () => {
    pathname = "/RUD/agents/designlead/configuration";

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toBe("");
  });

  it("keeps the shell header on messenger routes", () => {
    pathname = "/RUD/messenger/issues";

    const html = renderToStaticMarkup(<BreadcrumbBar />);

    expect(html).toContain("Messenger");
  });

  it("renders the goal detail breadcrumb trail instead of the generic goals header", () => {
    pathname = "/RUD/goals/goal-2";
    breadcrumbs = [
      { label: "Goals", href: "/goals" },
      { label: "Goal Center rollout", href: "/goals/goal-1" },
      { label: "Lifecycle controls hardening" },
    ];

    const html = renderToStaticMarkup(<BreadcrumbBar variant="card" />);

    expect(html).toContain("Goal Center rollout");
    expect(html).toContain("Lifecycle controls hardening");
    expect(html).not.toContain("<h1");
  });
});
