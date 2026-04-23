// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Messenger } from "./Messenger";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let messengerRoute: any;
let messengerModel: any;
let cleanupFn: (() => void) | null = null;
const navigate = vi.fn();
const setBreadcrumbs = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/useMessenger", () => ({
  useMessengerModel: () => messengerModel,
  messengerThreadKindLabel: (kind: string) => kind,
  resolveMessengerRoute: () => messengerRoute,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: "/messenger/system/failed-runs", search: "", hash: "" }),
  useNavigate: () => navigate,
  useParams: () => ({}),
  useSearchParams: () => [new URLSearchParams()],
}));

vi.mock("@/components/ApprovalCard", () => ({
  ApprovalCard: () => null,
}));

vi.mock("@/components/ApprovalDetailDialog", () => ({
  ApprovalDetailDialog: () => null,
}));

describe("Messenger auto-scroll", () => {
  beforeEach(() => {
    messengerRoute = { kind: "system", threadKind: "failed-runs" };
    messengerModel = {
      currentUserId: "user-1",
      selectedOrganizationId: "org-1",
      threadSummaries: [],
      issueThreadDetail: null,
      approvalThreadDetail: null,
      systemThreadDetail: {
        title: "Failed runs",
        description: "Recent failed runs",
        unreadCount: 0,
        items: [],
      },
      isLoading: false,
      error: null,
    };
    navigate.mockReset();
    setBreadcrumbs.mockReset();

    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();
  });

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = null;
    document.body.innerHTML = "";
  });

  it("scrolls the main Messenger container to the bottom when a thread opens", async () => {
    const mainContent = document.createElement("main");
    mainContent.id = "main-content";
    mainContent.style.overflowY = "auto";
    const scrollTo = vi.fn();
    Object.defineProperty(mainContent, "scrollHeight", { value: 1200, configurable: true });
    Object.defineProperty(mainContent, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(mainContent, "scrollTo", { value: scrollTo, configurable: true });
    document.body.appendChild(mainContent);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    cleanupFn = () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      mainContent.remove();
    };

    await act(async () => {
      root.render(<Messenger />);
      await Promise.resolve();
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "auto" });
    expect(setBreadcrumbs).toHaveBeenCalledWith([{ label: "failed-runs" }]);
  });
});
