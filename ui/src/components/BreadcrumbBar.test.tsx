// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BreadcrumbBar } from "./BreadcrumbBar";

let pathname = "/RUD/messenger/issues";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: import("react").ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname, search: "" }),
  useNavigate: () => vi.fn(),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ breadcrumbs: [] }),
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
});
