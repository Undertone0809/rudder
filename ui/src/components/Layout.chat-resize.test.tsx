// @vitest-environment jsdom

import { act, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { StreamTranscriptItem } from "../pages/Chat.StreamTranscriptItem";
import { Layout } from "./Layout";
import { TranscriptImageArtifact } from "./transcript/TranscriptImageArtifact";

const state = vi.hoisted(() => ({ mobile: false, path: "/chat/test", close: vi.fn() }));
function noop() {}
function passthrough({ children }: { children: ReactNode }) { return children; }
vi.mock("@/context/I18nContext", () => ({ useI18n: () => ({ t: (s: string) => s }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: state.mobile, sidebarOpen: false, setSidebarOpen: noop, toggleSidebar: noop }) }));
vi.mock("@/context/DialogContext", () => ({ useDialog: () => ({}) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => ({}) }));
vi.mock("@/context/SidePanelContext", () => ({ useSidePanel: () => ({ open: false, registerBeforeOpen: () => noop }) }));
vi.mock("@/context/OrganizationContext", () => ({ useOrganization: () => ({ organizations: [], loading: true, selectedOrganizationId: null }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({}) }));
vi.mock("@/context/NavigationBackContext", () => ({ NavigationBackProvider: passthrough }));
vi.mock("@/context/MarkdownMentionsContext", () => ({ MarkdownMentionsProvider: passthrough }));
vi.mock("@/context/CalendarWorkspaceContext", () => ({ CalendarWorkspaceProvider: passthrough }));
vi.mock("@/context/ImagePreviewContext", () => ({ useImagePreview: () => ({ closeImagePreviewIfSource: state.close }) }));
vi.mock("@/lib/desktop-shell", () => ({ readDesktopShell: () => null }));
vi.mock("../pages/Chat.parts", () => ({ displayedChatMessageState: () => "completed" }));
vi.mock("@/hooks/useOrganizationPageMemory", () => ({ useOrganizationPageMemory: noop }));
vi.mock("@/hooks/useKeyboardShortcuts", () => ({ useKeyboardShortcuts: noop }));
vi.mock("@/hooks/useScrollbarActivityRef", () => ({ useScrollbarActivityRef: () => useRef(null) }));
vi.mock("@/hooks/useWorkspaceSidebarLayout", () => ({ useWorkspaceContextSidebarLayout: () => ({ contextSidebarVisible: false }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}), useQuery: () => ({ data: undefined }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: state.path, search: "", hash: "" }),
  useParams: () => ({}), useNavigate: () => noop, useNavigationType: () => "POP",
  Link: passthrough, NavLink: passthrough,
  Outlet: () => <StreamTranscriptItem entries={[{ kind: "stderr", text: "image inspection", ts: "2026-10-03T00:00:00Z" }]} state="completed" streamStartedAt={new Date(0)} />,
}));
// Keep the real process disclosure and image picker; other transcript rendering
// is outside this layout/remount regression.
vi.mock("@/components/transcript/RunTranscriptView", () => ({ RunTranscriptView: () => <TranscriptImageArtifact path="/tmp/screenshot.png" displayLabel="screenshot.png" /> }));
vi.mock("@/components/InspectableImage", () => ({ InspectableImage: ({ src }: { src: string }) => <img src={src} alt="selected image" /> }));
vi.mock("./SidePanelRouteContext", () => ({ SidePanelRouteContextBinder: () => null, isSidePanelRouteContextReady: () => false }));
vi.mock("../pages/Chat.side-panel", () => ({ ChatSidePanel: () => null }));
vi.mock("./BreadcrumbBar", () => ({ BreadcrumbBar: () => null }));
vi.mock("./PrimaryRail", () => ({ PrimaryRail: () => null }));
vi.mock("./MobileWorkspaceDrawer", () => ({ MobileWorkspaceDrawer: () => null }));
vi.mock("./ThreeColumnContextSidebar", () => ({ ThreeColumnContextSidebar: () => null }));
vi.mock("./MobileBottomNav", () => ({ MobileBottomNav: () => null }));
vi.mock("./WorktreeBanner", () => ({ WorktreeBanner: () => null }));
vi.mock("./DevRestartBanner", () => ({ DevRestartBanner: () => null }));
vi.mock("./CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./NewIssueDialog", () => ({ NewIssueDialog: () => null }));
vi.mock("./NewProjectDialog", () => ({ NewProjectDialog: () => null }));
vi.mock("./NewGoalDialog", () => ({ NewGoalDialog: () => null }));
vi.mock("./NewAgentDialog", () => ({ NewAgentDialog: () => null }));
vi.mock("./SettingsSidebar", () => ({ SettingsSidebar: () => null }));
vi.mock("./WorkspaceBackupFilesSidebar", () => ({ WorkspaceBackupFilesSidebar: () => null }));
vi.mock("../pages/organization-workspaces/OrganizationWorkspaceFilesSidebar", () => ({ OrganizationWorkspaceFilesSidebar: () => null }));
vi.mock("../pages/NotFound", () => ({ NotFoundPage: () => null }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  state.mobile = false;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["/chat/test", "/messenger/chat/test"])("keeps the expanded process and canceled local image picker mounted across desktop/mobile resizing at %s", async (path) => {
  state.path = path;
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const createUrl = vi.fn(() => "blob:resize-image");
  const revokeUrl = vi.fn();
  class BrowserURL extends URL {
    static createObjectURL = createUrl;
    static revokeObjectURL = revokeUrl;
  }
  vi.stubGlobal("URL", BrowserURL);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<Layout />));
  const process = container.querySelector<HTMLButtonElement>("[data-testid='chat-transcript-item'] button")!;
  act(() => process.click());
  const input = container.querySelector<HTMLInputElement>("input[type='file']")!;
  const picker = container.querySelector("[data-testid='transcript-browser-image-picker']")!;
  expect(picker).not.toBeNull();
  Object.defineProperty(input, "files", { configurable: true, value: [] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));

  state.mobile = true;
  await act(async () => root!.render(<Layout />));
  expect(container.querySelector("[data-testid='chat-transcript-item'] button")).toBe(process);
  expect(process.getAttribute("aria-expanded")).toBe("true");
  expect(container.querySelector("[data-testid='transcript-browser-image-picker']")).toBe(picker);
  expect(container.querySelector("input[type='file']")).toBe(input);
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["image"], "screenshot.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:resize-image");
  state.mobile = false;
  await act(async () => root!.render(<Layout />));
  expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:resize-image");
  expect(revokeUrl).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  await act(async () => root!.unmount());
  root = undefined;
  expect(revokeUrl).toHaveBeenCalledExactlyOnceWith("blob:resize-image");
});
