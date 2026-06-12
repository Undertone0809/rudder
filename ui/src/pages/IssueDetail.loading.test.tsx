// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { IssueDetail } from "./IssueDetail";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const navigateMock = vi.fn();
const location = {
  pathname: "/NEW/issues/NEW-8",
  search: "",
  hash: "",
  state: null,
  key: "issue-loading",
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => {
    if (enabled === false) return { data: undefined, isLoading: false, error: null };
    if (queryKey[0] === "issues" && queryKey[1] === "detail") {
      return { data: undefined, isLoading: true, error: null };
    }
    if (queryKey.includes("workspace-mention-files")) {
      return { data: { entries: [] }, isLoading: false, error: null };
    }
    return { data: [], isLoading: false, error: null };
  },
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    error: null,
  }),
  useQueryClient: () => ({
    getQueryData: vi.fn(),
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
  useLocation: () => location,
  useNavigate: () => navigateMock,
  useParams: () => ({ issueId: "NEW-8" }),
}));

vi.mock("../context/NavigationBackContext", () => ({
  useNavigationBack: () => null,
}));

vi.mock("../context/OrganizationContext", () => ({
  useOrganization: () => ({
    organizations: [{ id: "org-new", issuePrefix: "NEW", urlKey: "new", status: "active" }],
    selectedOrganizationId: "org-new",
    selectedOrganization: { id: "org-new", issuePrefix: "NEW", urlKey: "new", status: "active" },
  }),
}));

vi.mock("../context/I18nContext", () => ({
  useI18n: () => ({ locale: "en", t: (key: string) => key }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

vi.mock("../hooks/useOperatorDisplayName", () => ({
  useOperatorDisplayName: () => "Operator",
}));

vi.mock("../hooks/useProjectOrder", () => ({
  useProjectOrder: ({ projects }: { projects: unknown[] }) => ({ orderedProjects: projects }),
}));

vi.mock("../components/InlineEditor", () => ({
  InlineEditor: () => <div />,
}));

vi.mock("../components/CommentThread", () => ({
  CommentThread: () => <div />,
}));

vi.mock("../components/IssueDetailFind", () => ({
  IssueDetailFind: () => <div />,
}));

vi.mock("../components/IssueProperties", () => ({
  IssueProperties: () => <div />,
}));

vi.mock("../components/LiveRunWidget", () => ({
  LiveRunWidget: () => <div />,
}));

vi.mock("../components/ScrollToBottom", () => ({
  ScrollToBottom: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotMount: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PluginSlotOutlet: () => null,
  usePluginSlots: () => ({ slots: [], isLoading: false }),
}));

vi.mock("@/plugins/launchers", () => ({
  PluginLauncherOutlet: () => null,
}));

describe("IssueDetail loading state", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    navigateMock.mockClear();
  });

  it("does not loop breadcrumb updates while the issue query is still loading", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(
        <BreadcrumbProvider>
          <IssueDetail />
        </BreadcrumbProvider>,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Loading");
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
