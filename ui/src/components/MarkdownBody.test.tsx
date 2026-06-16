// @vitest-environment jsdom

import { buildAgentMentionHref, buildChatMentionHref, buildIssueMentionHref, buildLibraryDirectoryMentionHref, buildLibraryDocMentionHref, buildLibraryEntryMentionHref, buildLibraryFileMentionHref, buildProjectMentionHref } from "@rudderhq/shared";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import type { MentionOption } from "./MarkdownEditor";
import {
  __clearRudderEntityPreviewCachesForTests,
  RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS,
} from "./RudderEntityPreview";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const markdownMentionsMock = vi.hoisted(() => ({
  mentions: [] as MentionOption[],
}));

const entityPreviewApiMocks = vi.hoisted(() => ({
  getIssue: vi.fn(),
  getComment: vi.fn(),
  getAgent: vi.fn(),
  getProject: vi.fn(),
  getLibraryDocument: vi.fn(),
  getLibraryEntry: vi.fn(),
  readWorkspaceFile: vi.fn(),
}));

const localStorageMock = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn((key: string) => localStorageMock.values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageMock.values.set(key, value);
  }),
  removeItem: vi.fn((key: string) => {
    localStorageMock.values.delete(key);
  }),
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class MockResizeObserver {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

Object.defineProperty(globalThis, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: MockResizeObserver,
});

Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: MockResizeObserver,
});

Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: localStorageMock.getItem,
    setItem: localStorageMock.setItem,
    removeItem: localStorageMock.removeItem,
  },
});

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div data-testid="mock-dialog-root">{children}</div> : null),
  DialogContent: ({
    children,
    showCloseButton: _showCloseButton,
    ...props
  }: {
    children: ReactNode;
    showCloseButton?: boolean;
  }) => <div data-slot="dialog-content" {...props}>{children}</div>,
  DialogClose: ({
    children,
    ...props
  }: {
    children: ReactNode;
  }) => <button data-slot="dialog-close" {...props}>{children}</button>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("../context/MarkdownMentionsContext", () => ({
  useMarkdownMentions: () => ({
    mentions: markdownMentionsMock.mentions,
    onMentionQueryChange: vi.fn(),
  }),
}));

vi.mock("../api/issues", () => ({
  issuesApi: {
    get: entityPreviewApiMocks.getIssue,
    getComment: entityPreviewApiMocks.getComment,
  },
}));

vi.mock("../api/agents", () => ({
  agentsApi: {
    get: entityPreviewApiMocks.getAgent,
  },
}));

vi.mock("../api/projects", () => ({
  projectsApi: {
    get: entityPreviewApiMocks.getProject,
  },
}));

vi.mock("../api/orgs", () => ({
  organizationsApi: {
    getLibraryDocument: entityPreviewApiMocks.getLibraryDocument,
    getLibraryEntry: entityPreviewApiMocks.getLibraryEntry,
    readWorkspaceFile: entityPreviewApiMocks.readWorkspaceFile,
  },
}));

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  __clearRudderEntityPreviewCachesForTests();
  markdownMentionsMock.mentions = [];
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  localStorageMock.values.clear();
  document.body.innerHTML = "";
  window.history.pushState({}, "", "/");
});

function render(element: ReactNode) {
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
    root.render(element);
  });
  return container;
}

async function focusPreviewLink(link: Element | null) {
  expect(link).toBeTruthy();
  await act(async () => {
    link?.dispatchEvent(new FocusEvent("focusin", { bubbles: true, cancelable: true }));
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function hoverPreviewLink(link: Element | null) {
  expect(link).toBeTruthy();
  await act(async () => {
    link?.closest(".rudder-entity-preview-wrap")?.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true, relatedTarget: document.body }),
    );
  });
}

async function leavePreviewLink(link: Element | null) {
  expect(link).toBeTruthy();
  await act(async () => {
    link?.closest(".rudder-entity-preview-wrap")?.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, cancelable: true, relatedTarget: document.body }),
    );
  });
}

async function hoverPreviewCard() {
  const card = document.body.querySelector(".rudder-entity-preview-card");
  expect(card).toBeTruthy();
  await act(async () => {
    card?.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true, relatedTarget: document.body }),
    );
  });
}

async function leavePreviewCard() {
  const card = document.body.querySelector(".rudder-entity-preview-card");
  expect(card).toBeTruthy();
  await act(async () => {
    card?.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, cancelable: true, relatedTarget: document.body }),
    );
  });
}

async function advanceTimersAndFlush(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("MarkdownBody", () => {
  it("renders markdown images without a resolver", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{"![](/api/attachments/test/content)"}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('<img src="/api/attachments/test/content" alt=""/>');
  });

  it("renders library document mentions as live Library links", () => {
    const href = buildLibraryDocMentionHref("doc-123", "Product principles");
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{`[@Product principles](${href})`}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/library?doc=doc-123"');
    expect(html).toContain('data-mention-kind="library_doc"');
    expect(html).toContain("Product principles");
  });

  it("renders library file mentions as live Library path links", () => {
    const href = buildLibraryFileMentionHref("docs/product-brief.md", "product-brief.md");
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{`[@product-brief.md](${href})`}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/library?path=docs%2Fproduct-brief.md"');
    expect(html).toContain('data-mention-kind="library_file"');
    expect(html).toContain("product-brief.md");
  });

  it("renders server-normalized Library file links from agent replies as mention chips", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"See [ship.md](library-file://file?p=projects%2Frudder%2Fplans%2Fship.md)."}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/library?path=projects%2Frudder%2Fplans%2Fship.md"');
    expect(html).toContain('data-mention-kind="library_file"');
    expect(html).toContain("ship.md");
  });

  it("renders library entry mentions as live Library entry links with path hints", () => {
    const href = buildLibraryEntryMentionHref("entry-123", "product-brief.md", "docs/product-brief.md");
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{`[@product-brief.md](${href})`}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/library?entry=entry-123"');
    expect(html).toContain('data-mention-kind="library_entry"');
    expect(html).toContain("product-brief.md");
  });

  it("renders library directory mentions as live Library directory links", () => {
    const href = buildLibraryDirectoryMentionHref("projects/rudder-mkt", "Rudder marketing");
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{`[@Rudder marketing](${href})`}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/library?directory=projects%2Frudder-mkt"');
    expect(html).toContain('data-mention-kind="library_directory"');
    expect(html).toContain("Rudder marketing");
  });

  it("can copy rendered markdown as its source markdown", () => {
    const href = buildLibraryFileMentionHref("docs/product-brief.md", "product-brief.md");
    const source = `# Brief\n\n- Keep **syntax**\n- [@product-brief.md](${href})`;
    const container = render(
      <ThemeProvider>
        <MarkdownBody copyMarkdownOnCopy>{source}</MarkdownBody>
      </ThemeProvider>,
    );
    const body = container.querySelector("[data-copy-markdown-source='true']");
    expect(body).toBeTruthy();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(body!);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const copyData = { setData: vi.fn() };
    const copyEvent = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copyEvent, "clipboardData", {
      value: copyData,
    });
    body!.dispatchEvent(copyEvent);

    expect(copyData.setData).toHaveBeenCalledWith("text/plain", source);
    expect(copyEvent.defaultPrevented).toBe(true);
  });

  it("copies block code when code-block copy is enabled without adding inline-code buttons", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const container = render(
      <ThemeProvider>
        <MarkdownBody enableCodeBlockCopy>{"Inline `code`\n\n```sh\npnpm test\n```"}</MarkdownBody>
      </ThemeProvider>,
    );

    const copyButton = container.querySelector<HTMLButtonElement>(".rudder-code-block-copy-button");
    expect(copyButton).toBeTruthy();
    expect(container.querySelector("p code")).toBeTruthy();
    expect(container.querySelectorAll(".rudder-code-block-copy-button")).toHaveLength(1);

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(writeText).toHaveBeenCalledWith("pnpm test");
    expect(copyButton?.getAttribute("aria-label")).toBe("Copied");
  });

  it("does not render code-block copy controls by default", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{"```sh\npnpm test\n```"}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(container.querySelector(".rudder-code-block-copy-button")).toBeNull();
  });

  it("renders diff fences as patch rows with additions and deletions", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"```diff\ndiff --git a/app.ts b/app.ts\n@@ -1,2 +1,2 @@\n-old value\n+new value\n context\n```"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(container.querySelector(".rudder-markdown-patch-block")).toBeTruthy();
    expect(container.querySelector(".language-diff")).toBeNull();
    expect(container.querySelector(".rudder-markdown-patch-line--meta")?.textContent).toContain("diff --git");
    expect(container.querySelector(".rudder-markdown-patch-line--hunk")?.textContent).toContain("@@ -1,2 +1,2 @@");
    expect(container.querySelector(".rudder-markdown-patch-line--remove")?.textContent).toContain("-old value");
    expect(container.querySelector(".rudder-markdown-patch-line--add")?.textContent).toContain("+new value");
    expect(container.querySelector(".rudder-markdown-patch-line--context")?.textContent).toContain(" context");
  });

  it("copies patch fences as their original source when code-block copy is enabled", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const patch = "```patch\n--- a/app.ts\n+++ b/app.ts\n-old value\n+new value\n```";
    const container = render(
      <ThemeProvider>
        <MarkdownBody enableCodeBlockCopy>{patch}</MarkdownBody>
      </ThemeProvider>,
    );

    const copyButton = container.querySelector<HTMLButtonElement>(".rudder-code-block-copy-button");
    expect(copyButton).toBeTruthy();
    expect(container.querySelector(".rudder-markdown-patch-block")).toBeTruthy();

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(writeText).toHaveBeenCalledWith("--- a/app.ts\n+++ b/app.ts\n-old value\n+new value");
  });

  it("renders chat mentions as live Messenger links", () => {
    const href = buildChatMentionHref("chat-123", "Launch planning");
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{`[@Launch planning](${href})`}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/messenger/chat/chat-123"');
    expect(html).toContain('data-mention-kind="chat"');
    expect(html).toContain("Launch planning");
    expect(html).not.toContain("rudder-entity-preview-wrap");
  });

  it("resolves relative image paths when a resolver is provided", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody resolveImageSrc={(src) => `/resolved/${src}`}>
          {"![Org chart](images/org-chart.png)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('src="/resolved/images/org-chart.png"');
    expect(html).toContain('alt="Org chart"');
  });

  it("opens a markdown image preview dialog when an inline image is double-clicked", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{"![Architecture diagram](/api/attachments/test/content)"}</MarkdownBody>
      </ThemeProvider>,
    );

    const image = container.querySelector("img");
    expect(image).toBeTruthy();

    act(() => {
      image?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });

    const previewRoot = document.body.querySelector('[data-testid="markdown-body-image-preview-dialog"]');
    const preview = previewRoot?.querySelector("img");
    expect(preview).toBeTruthy();
    expect(new URL(preview?.getAttribute("src") ?? "", "http://localhost:3000").pathname).toBe(
      "/api/attachments/test/content",
    );
    expect(document.body.textContent).toContain("Architecture diagram");
  });

  it("opens a markdown image preview dialog when an inline image is clicked", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{"![Build screenshot](/api/assets/test/content)"}</MarkdownBody>
      </ThemeProvider>,
    );

    const imageButton = container.querySelector(".rudder-inspectable-image-trigger");
    expect(imageButton).toBeTruthy();

    act(() => {
      imageButton?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    const previewRoot = document.body.querySelector('[data-testid="markdown-body-image-preview-dialog"]');
    expect(previewRoot?.querySelector("img")?.getAttribute("alt")).toBe("Build screenshot");
    expect(previewRoot?.textContent).not.toContain("Open Image");
    expect(previewRoot?.textContent).toContain("Copy Image");
  });

  it("shows image actions from the custom markdown image context menu", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{"![Evidence](/api/attachments/test/content)"}</MarkdownBody>
      </ThemeProvider>,
    );

    const image = container.querySelector("img");
    expect(image).toBeTruthy();

    act(() => {
      image?.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: 32,
        clientY: 48,
      }));
    });

    const contextMenu = document.body.querySelector('[data-testid="markdown-image-context-menu"]');
    expect(contextMenu).toBeTruthy();
    expect(contextMenu?.textContent).toContain("Open Image");
    expect(contextMenu?.textContent).toContain("Copy Image");
    expect(contextMenu?.textContent).toContain("Download Image");

    const openItem = Array.from(contextMenu?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent?.includes("Open Image"));
    act(() => {
      openItem?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(openSpy).toHaveBeenCalledWith("/api/attachments/test/content", "_blank", "noopener,noreferrer");

    openSpy.mockRestore();
  });

  it("leaves images non-interactive when preview is disabled", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody enableImagePreview={false}>
          {"![Static diagram](/api/assets/static/content)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(container.querySelector("img")).toBeTruthy();
    expect(container.querySelector(".rudder-inspectable-image-trigger")).toBeNull();
  });

  it("renders agent and project mentions as chips", () => {
    markdownMentionsMock.mentions = [
      {
        id: "agent:agent-123",
        name: "CodexCoder",
        kind: "agent",
        agentId: "agent-123",
        agentIcon: "code",
      },
      {
        id: "project:project-456",
        name: "Rudder App",
        kind: "project",
        projectId: "project-456",
        projectColor: "#336699",
      },
    ];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[@CodexCoder](${buildAgentMentionHref("agent-123", "code")}) [@Rudder App](${buildProjectMentionHref("project-456", "#336699")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/agents/agent-123"');
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain("--rudder-mention-icon-mask");
    expect(html).toContain(">CodexCoder</a>");
    expect(html).not.toContain(">@CodexCoder</a>");
    expect(html).toContain('href="/projects/project-456"');
    expect(html).toContain('data-mention-kind="project"');
    expect(html).toContain("--rudder-mention-project-color:#336699");
    expect(html).toContain(">Rudder App</a>");
    expect(html).not.toContain(">@Rudder App</a>");
  });

  it("uses the current agent avatar when rendering existing agent mention links", () => {
    markdownMentionsMock.mentions = [{
      id: "agent:agent-123",
      name: "Current CodexCoder",
      kind: "agent",
      agentId: "agent-123",
      agentIcon: "dicebear:notionists:11111111-1111-4111-8111-111111111111",
    }];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[@CodexCoder](${buildAgentMentionHref("agent-123", "user")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain(">Current CodexCoder</a>");
    expect(html).toContain("--rudder-mention-agent-avatar-background");
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("--rudder-mention-icon-mask:none");
  });

  it("uses current entity display data instead of stale link metadata", () => {
    markdownMentionsMock.mentions = [
      {
        id: "agent:agent-123",
        name: "Renamed Agent",
        kind: "agent",
        agentId: "agent-123",
        agentIcon: "code",
      },
      {
        id: "project:project-456",
        name: "Renamed Project",
        kind: "project",
        projectId: "project-456",
        projectColor: "#22c55e",
        projectIcon: "plane",
      },
      {
        id: "issue:issue-789",
        name: "ZST-789 Renamed issue",
        kind: "issue",
        issueId: "issue-789",
        issueIdentifier: "ZST-789",
        issueStatus: "blocked",
      },
      {
        id: "chat:chat-123",
        name: "Renamed Chat",
        kind: "chat",
        chatConversationId: "chat-123",
      },
    ];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {[
            "[Old Agent](agent://agent-123?i=user)",
            "[Old Project](project://project-456?c=336699&i=folder)",
            "[OLD-1 Old issue](issue://issue-789?r=OLD-1&s=todo)",
            "[Old Chat](chat://chat-123?t=Old%20Chat)",
          ].join(" ")}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain(">Renamed Agent</a>");
    expect(html).toContain(">Renamed Project</a>");
    expect(html).toContain(">ZST-789 Renamed issue</a>");
    expect(html).toContain(">Renamed Chat</a>");
    expect(html).toContain('href="/issues/issue-789"');
    expect(html).toContain('data-mention-status="blocked"');
    expect(html).not.toContain("Old Agent");
    expect(html).not.toContain("Old Project");
    expect(html).not.toContain("OLD-1 Old issue");
    expect(html).not.toContain("Old Chat");
  });

  it("renders empty-label entity links from current mention data", () => {
    markdownMentionsMock.mentions = [
      {
        id: "agent:agent-123",
        name: "Renamed Agent",
        kind: "agent",
        agentId: "agent-123",
        agentIcon: "code",
      },
      {
        id: "issue:issue-789",
        name: "ZST-789 Renamed issue",
        kind: "issue",
        issueId: "issue-789",
        issueIdentifier: "ZST-789",
        issueStatus: "in_progress",
      },
    ];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"[](agent://agent-123) [](issue://issue-789)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain(">Renamed Agent</a>");
    expect(html).toContain(">ZST-789 Renamed issue</a>");
    expect(html).toContain('href="/issues/issue-789"');
    expect(html).toContain('data-mention-status="in_progress"');
  });

  it("renders issue mentions as chips that link to the issue route", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/issue-789"');
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain(">PAP-123 auth flow</a>");
    expect(html).not.toContain(">@PAP-123 auth flow</a>");
  });

  it("prefixes special mention links with the active organization route", () => {
    window.history.pushState({}, "", "/ZST/issues/ZST-559");

    const issueHref = buildIssueMentionHref("issue-789", "ZST-557");
    const chatHref = buildChatMentionHref("chat-123", "Review chat");
    const libraryFileHref = buildLibraryFileMentionHref("docs/review.md", "review.md");
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[ZST-557](${issueHref}) [Review chat](${chatHref}) [review.md](${libraryFileHref})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/ZST/issues/issue-789"');
    expect(html).toContain('href="/ZST/messenger/chat/chat-123"');
    expect(html).toContain('href="/ZST/library?path=docs%2Freview.md"');
    expect(html).not.toContain("issue://issue-789");
    expect(html).not.toContain("chat://chat-123");
    expect(html).not.toContain("library-file://file");
  });

  it("prefixes ordinary internal app links and navigates without document reload", () => {
    window.history.pushState({}, "", "/ZST/library?doc=old-doc");
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);

    const container = render(
      <ThemeProvider>
        <MarkdownBody>{"Open [Library doc](/library?doc=doc-123)"}</MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/ZST/library?doc=doc-123");
    const clickResult = link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(clickResult).toBe(false);
    expect(window.location.pathname).toBe("/ZST/library");
    expect(window.location.search).toBe("?doc=doc-123");
    expect(popstate).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", popstate);
  });

  it("navigates library mention chips without relying on caller click handlers", () => {
    window.history.pushState({}, "", "/ZST/issues/ZST-559");
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[Product principles](${buildLibraryDocMentionHref("doc-123", "Product principles")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a.rudder-mention-chip");
    expect(link?.getAttribute("href")).toBe("/ZST/library?doc=doc-123");
    const clickResult = link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(clickResult).toBe(false);
    expect(window.location.pathname).toBe("/ZST/library");
    expect(window.location.search).toBe("?doc=doc-123");
    expect(popstate).toHaveBeenCalledTimes(1);
    window.removeEventListener("popstate", popstate);
  });

  it("renders issue mentions with status metadata using the issue status icon", () => {
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123", null, "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/issue-789"');
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain('data-mention-status="in_review"');
    expect(html).not.toContain('title="Open PAP-123 auth flow"');
    expect(html).toContain("rudder-mention-chip--with-status-icon");
    expect(html).toContain('data-slot="issue-status-icon"');
    expect(html).toContain('data-status="in_review"');
  });

  it("loads an issue preview from the rendered mention chip on focus", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "issue-789",
      orgId: "org-1",
      title: "Auth flow polish",
      identifier: "PAP-123",
      status: "in_review",
      priority: "high",
      projectId: "project-1",
      project: { name: "Rudder dev" },
      assigneeAgentId: "agent-1",
      reviewerAgentId: "agent-2",
      description: "Tighten the markdown renderable link behavior.\n\nMore detail.",
    });
    entityPreviewApiMocks.getAgent
      .mockResolvedValueOnce({ name: "Wesley" })
      .mockResolvedValueOnce({ name: "Holden" });
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123", null, "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(entityPreviewApiMocks.getIssue).not.toHaveBeenCalled();
    await focusPreviewLink(container.querySelector("a.rudder-mention-chip"));

    expect(entityPreviewApiMocks.getIssue).toHaveBeenCalledWith("issue-789");
    expect(document.body.textContent).toContain("Auth flow polish");
    expect(document.body.textContent).toContain("In Review");
    expect(document.body.textContent).toContain("High");
    expect(document.body.textContent).toContain("Rudder dev");
    expect(document.body.textContent).toContain("Wesley");
    expect(document.body.querySelector('[data-slot="issue-status-icon"]')).toBeTruthy();
    expect(document.body.querySelector('[data-slot="priority-bars-icon"]')).toBeTruthy();
    const previewRows = Array.from(document.body.querySelectorAll(".rudder-entity-preview-row"));
    const expectedPreviewRows = new Set(["Status", "Priority", "Project", "Assignee"]);
    for (const row of previewRows) {
      const label = row.querySelector(".rudder-entity-preview-row-label")?.textContent?.trim();
      if (!label || !expectedPreviewRows.has(label)) continue;
      expect(row.querySelector(".rudder-entity-preview-row-value > span[aria-hidden='true']")).toBeTruthy();
    }
    expect(document.body.querySelector(".rudder-entity-preview-card")?.classList.contains("motion-entity-preview-pop")).toBe(true);
  });

  it("does not load or render entity previews during quick hover passes", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "issue-789",
      orgId: "org-1",
      title: "Auth flow polish",
      identifier: "PAP-123",
      status: "in_review",
      priority: "high",
      projectId: "project-1",
      project: { name: "Rudder dev" },
      assigneeAgentId: null,
      reviewerAgentId: null,
      description: "Tighten the markdown renderable link behavior.",
    });
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123", null, "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const link = container.querySelector("a.rudder-mention-chip");

    await hoverPreviewLink(link);
    await advanceTimersAndFlush(RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS - 1);

    expect(entityPreviewApiMocks.getIssue).not.toHaveBeenCalled();
    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeNull();

    await leavePreviewLink(link);
    await advanceTimersAndFlush(1);

    expect(entityPreviewApiMocks.getIssue).not.toHaveBeenCalled();
    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeNull();
  });

  it("loads entity previews only after the hover dwell delay", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "issue-789",
      orgId: "org-1",
      title: "Auth flow polish",
      identifier: "PAP-123",
      status: "in_review",
      priority: "high",
      projectId: "project-1",
      project: { name: "Rudder dev" },
      assigneeAgentId: null,
      reviewerAgentId: null,
      description: "Tighten the markdown renderable link behavior.",
    });
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123", null, "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    await hoverPreviewLink(container.querySelector("a.rudder-mention-chip"));
    await advanceTimersAndFlush(RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS);

    expect(entityPreviewApiMocks.getIssue).toHaveBeenCalledWith("issue-789");
    expect(document.body.textContent).toContain("Auth flow polish");
  });

  it("requires the full hover dwell delay when reopening the same entity preview", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "issue-789",
      orgId: "org-1",
      title: "Auth flow polish",
      identifier: "PAP-123",
      status: "in_review",
      priority: "high",
      projectId: "project-1",
      project: { name: "Rudder dev" },
      assigneeAgentId: null,
      reviewerAgentId: null,
      description: "Tighten the markdown renderable link behavior.",
    });
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123", null, "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const link = container.querySelector("a.rudder-mention-chip");

    await hoverPreviewLink(link);
    await advanceTimersAndFlush(RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS);
    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeTruthy();

    await leavePreviewLink(link);
    await advanceTimersAndFlush(300);
    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeNull();

    await hoverPreviewLink(link);
    await advanceTimersAndFlush(RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS - 1);

    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeNull();

    await advanceTimersAndFlush(1);

    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeTruthy();
    expect(entityPreviewApiMocks.getIssue).toHaveBeenCalledTimes(1);
  });

  it("keeps an open entity preview visible while the mouse moves into the preview card", async () => {
    vi.useFakeTimers();
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "issue-789",
      orgId: "org-1",
      title: "Auth flow polish",
      identifier: "PAP-123",
      status: "in_review",
      priority: "high",
      projectId: "project-1",
      project: { name: "Rudder dev" },
      assigneeAgentId: null,
      reviewerAgentId: null,
      description: "Tighten the markdown renderable link behavior.",
    });
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123", null, "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const link = container.querySelector("a.rudder-mention-chip");

    await hoverPreviewLink(link);
    await advanceTimersAndFlush(RUDDER_ENTITY_PREVIEW_HOVER_DELAY_MS);
    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeTruthy();

    await leavePreviewLink(link);
    await hoverPreviewCard();
    await advanceTimersAndFlush(300);

    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeTruthy();

    await leavePreviewCard();
    await advanceTimersAndFlush(300);

    expect(document.body.querySelector(".rudder-entity-preview-card")).toBeNull();
  });

  it("loads an issue comment preview from comment-anchored issue links", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "issue-789",
      orgId: "org-1",
      title: "Auth flow polish",
      identifier: "PAP-123",
      status: "in_review",
      priority: "high",
      projectId: "project-1",
      project: { name: "Rudder dev" },
      assigneeAgentId: "agent-1",
      reviewerAgentId: "agent-2",
      description: "Issue metadata should not be the comment preview.",
    });
    entityPreviewApiMocks.getComment.mockResolvedValue({
      id: "comment-123",
      orgId: "org-1",
      issueId: "issue-789",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Reviewer said **render the comment body** instead of issue metadata.",
      createdAt: new Date("2026-06-13T17:38:56.776Z"),
      updatedAt: new Date("2026-06-13T17:38:56.776Z"),
    });
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[Issue comment abc12345](${buildIssueMentionHref("issue-789", "PAP-123", "comment-123", "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    await focusPreviewLink(container.querySelector("a.rudder-mention-chip"));

    expect(entityPreviewApiMocks.getIssue).toHaveBeenCalledWith("issue-789");
    expect(entityPreviewApiMocks.getComment).toHaveBeenCalledWith("issue-789", "comment-123");
    const card = document.body.querySelector(".rudder-entity-preview-card");
    expect(card?.textContent).toContain("Issue comment");
    expect(card?.textContent).toContain("Auth flow polish");
    expect(card?.textContent).toContain("Reviewer said render the comment body instead of issue metadata.");
    expect(card?.textContent).not.toContain("In Review");
    expect(card?.textContent).not.toContain("High");
    expect(card?.querySelector("[data-testid='issue-comment-preview-body']")?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(card?.querySelector('[data-slot="issue-comment-preview-icon"]')).toBeTruthy();
    expect(card?.querySelector('[data-slot="issue-status-icon"]')).toBeNull();
  });

  it("renders markdown images inside issue comment hover previews", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "issue-789",
      orgId: "org-1",
      title: "Auth flow polish",
      identifier: "PAP-123",
      status: "in_review",
      priority: "high",
      projectId: "project-1",
      project: { name: "Rudder dev" },
      assigneeAgentId: null,
      reviewerAgentId: null,
      description: "Issue metadata should not be the comment preview.",
    });
    entityPreviewApiMocks.getComment.mockResolvedValue({
      id: "comment-123",
      orgId: "org-1",
      issueId: "issue-789",
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Screenshot evidence:\n\n![Hover card](/api/assets/comment-image/content)\n\n- Keep this readable.",
      createdAt: new Date("2026-06-13T17:38:56.776Z"),
      updatedAt: new Date("2026-06-13T17:38:56.776Z"),
    });
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[Issue comment abc12345](${buildIssueMentionHref("issue-789", "PAP-123", "comment-123", "in_review")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    await focusPreviewLink(container.querySelector("a.rudder-mention-chip"));

    const previewBody = document.body.querySelector("[data-testid='issue-comment-preview-body']");
    const image = previewBody?.querySelector("img");
    expect(previewBody?.textContent).toContain("Screenshot evidence:");
    expect(previewBody?.textContent).toContain("Keep this readable.");
    expect(image?.getAttribute("src")).toBe("/api/assets/comment-image/content");
    expect(image?.getAttribute("alt")).toBe("Hover card");
  });

  it("loads agent, project, and Library previews from rendered mention chips", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    entityPreviewApiMocks.getAgent.mockResolvedValue({
      id: "agent-1",
      orgId: "org-1",
      name: "Wesley",
      role: "engineer",
      title: "Founding engineer",
      icon: "code",
      status: "active",
      capabilities: "Ships focused Rudder changes and validates them.",
    });
    entityPreviewApiMocks.getProject.mockResolvedValue({
      id: "project-1",
      orgId: "org-1",
      name: "Rudder dev",
      status: "in_progress",
      description: "Primary Rudder OSS development project.",
      goals: [{ id: "goal-1", title: "Ship reliable agent work loops" }],
      primaryWorkspace: { cwd: "/Users/zeeland/projects/rudder-oss" },
      codebase: {},
    });
    entityPreviewApiMocks.readWorkspaceFile.mockResolvedValue({
      filePath: "projects/rudder/product-brief.md",
      content: "# Product brief\n\nRudder coordinates agent work loops.",
      contentType: "text/markdown",
      previewKind: "text",
      truncated: false,
      message: null,
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {[
            `[Wesley](${buildAgentMentionHref("agent-1", "code")})`,
            `[Rudder dev](${buildProjectMentionHref("project-1", "#336699")})`,
            `[product-brief.md](${buildLibraryFileMentionHref("projects/rudder/product-brief.md", "product-brief.md")})`,
          ].join(" ")}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const links = container.querySelectorAll("a.rudder-mention-chip");
    await focusPreviewLink(links[0] ?? null);
    expect(document.body.textContent).toContain("Founding engineer");
    expect(document.body.textContent).toContain("Ships focused Rudder changes");

    await focusPreviewLink(links[1] ?? null);
    expect(document.body.textContent).toContain("Primary Rudder OSS development project.");
    expect(document.body.textContent).toContain("Ship reliable agent work loops");

    await focusPreviewLink(links[2] ?? null);
    expect(document.body.textContent).toContain("projects/rudder/product-brief.md");
    expect(document.body.textContent).toContain("Rudder coordinates agent work loops.");
  });

  it("renders long Library file hover cards with readable rows and summary content", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    const longPath = "projects/rudder/proposals/2026-06-16-guarded-product-feature-registry.md";
    entityPreviewApiMocks.readWorkspaceFile.mockResolvedValue({
      filePath: longPath,
      content: "Date: 2026-06-16 Status: Proposed Owner: Wesley Source: [Rudder chat: /doc 产品逻辑文档优化](chat://097c434b-b681-4609-8625-000000000000)",
      contentType: "text/markdown",
      previewKind: "text",
      truncated: false,
      message: null,
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[2026-06-16-guarded-product-feature-registry.md](${buildLibraryFileMentionHref(longPath, "2026-06-16-guarded-product-feature-registry.md")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    await focusPreviewLink(container.querySelector("a.rudder-mention-chip"));

    const card = document.body.querySelector(".rudder-entity-preview-card");
    expect(card?.textContent).toContain("Library file");
    expect(card?.textContent).toContain("2026-06-16-guarded-product-feature-registry.md");
    const rows = Array.from(card?.querySelectorAll(".rudder-entity-preview-row") ?? []);
    const pathRow = rows.find((row) => row.querySelector(".rudder-entity-preview-row-label")?.textContent === "Path");
    const pathValue = pathRow?.querySelector(".rudder-entity-preview-row-value-text");
    expect(pathValue?.textContent).toBe(longPath);
    expect(pathValue?.classList.contains("truncate")).toBe(false);
    const summary = card?.querySelector(".rudder-entity-preview-summary");
    expect(summary?.classList.contains("scrollbar-auto-hide")).toBe(true);
    expect(summary?.textContent).toContain("Date: 2026-06-16 Status: Proposed Owner: Wesley");
    const summaryLink = summary?.querySelector("a");
    expect(summaryLink?.textContent).toBe("Rudder chat: /doc 产品逻辑文档优化");
    expect(summaryLink?.getAttribute("href")).toBe("/messenger/chat/097c434b-b681-4609-8625-000000000000");
    expect(summary?.textContent).not.toContain("chat://097c434b-b681-4609-8625-000000000000");
  });

  it("renders unsafe Library preview summary links as inert text", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    entityPreviewApiMocks.readWorkspaceFile.mockResolvedValue({
      filePath: "projects/rudder/proposals/unsafe-summary.md",
      content: "Do not run [unsafe link](javascript:alert(1)) inside a hover card.",
      contentType: "text/markdown",
      previewKind: "text",
      truncated: false,
      message: null,
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[unsafe-summary.md](${buildLibraryFileMentionHref("projects/rudder/proposals/unsafe-summary.md", "unsafe-summary.md")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    await focusPreviewLink(container.querySelector("a.rudder-mention-chip"));

    const summary = document.body.querySelector(".rudder-entity-preview-summary");
    expect(summary?.textContent).toContain("unsafe link");
    expect(summary?.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(summary?.querySelector("a")?.textContent).not.toBe("unsafe link");
  });

  it("reuses cached agent previews across repeated rendered mention chips", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    entityPreviewApiMocks.getAgent.mockResolvedValue({
      id: "agent-1",
      orgId: "org-1",
      name: "Wesley",
      role: "engineer",
      title: "Founding engineer",
      icon: "code",
      status: "active",
      capabilities: "Ships focused Rudder changes and validates them.",
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {[
            `[Wesley](${buildAgentMentionHref("agent-1", "code")})`,
            `[Wesley again](${buildAgentMentionHref("agent-1", "code")})`,
          ].join(" ")}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const links = container.querySelectorAll("a.rudder-mention-chip");
    await focusPreviewLink(links[0] ?? null);
    await focusPreviewLink(links[1] ?? null);

    expect(entityPreviewApiMocks.getAgent).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Ships focused Rudder changes");
  });

  it("loads Library document and entry previews without giving chat links previews", async () => {
    window.localStorage.setItem("rudder.selectedOrganizationId", "org-1");
    entityPreviewApiMocks.getLibraryDocument.mockResolvedValue({
      id: "doc-1",
      orgId: "org-1",
      title: "Operating notes",
      format: "markdown",
      latestRevisionNumber: 3,
      body: "# Operating notes\n\nUse hover previews for renderable entity links.",
    });
    entityPreviewApiMocks.getLibraryEntry.mockResolvedValue({
      id: "entry-1",
      orgId: "org-1",
      title: "handoff.md",
      currentPath: "projects/rudder/handoff.md",
      status: "active",
    });
    entityPreviewApiMocks.readWorkspaceFile.mockResolvedValue({
      filePath: "projects/rudder/handoff.md",
      content: "Handoff evidence lives here.",
      contentType: "text/markdown",
      previewKind: "text",
      truncated: false,
      message: null,
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {[
            `[Operating notes](${buildLibraryDocMentionHref("doc-1", "Operating notes")})`,
            `[handoff.md](${buildLibraryEntryMentionHref("entry-1", "handoff.md", "projects/rudder/handoff.md")})`,
            `[Chat](${buildChatMentionHref("chat-1", "Chat")})`,
          ].join(" ")}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const previewWraps = container.querySelectorAll(".rudder-entity-preview-wrap");
    expect(previewWraps).toHaveLength(2);
    expect(container.querySelector('a[data-mention-kind="chat"]')?.closest(".rudder-entity-preview-wrap")).toBeNull();

    await focusPreviewLink(container.querySelector('a[data-mention-kind="library_doc"]'));
    expect(document.body.textContent).toContain("Use hover previews for renderable entity links.");

    await focusPreviewLink(container.querySelector('a[data-mention-kind="library_entry"]'));
    expect(entityPreviewApiMocks.getLibraryEntry).toHaveBeenCalledWith("org-1", "entry-1");
    expect(entityPreviewApiMocks.readWorkspaceFile).toHaveBeenCalledWith("org-1", "projects/rudder/handoff.md");
    expect(document.body.textContent).toContain("Handoff evidence lives here.");
  });

  it("renders issue comment mentions as chips that link to the comment anchor", () => {
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "in_review",
    }];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[Issue comment abc12345](${buildIssueMentionHref("issue-789", "PAP-123", "comment-123")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/issue-789#comment-comment-123"');
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain('data-mention-status="in_review"');
    expect(html).toContain(">Issue comment abc12345</a>");
    expect(html).not.toContain(">PAP-123 auth flow</a>");
  });

  it("renders skill references as non-interactive tokens instead of links", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"[$rudder/rudder-create-plugin](/Users/zeeland/projects/rudder/.agents/skills/rudder-create-plugin/SKILL.md)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('class="rudder-skill-token"');
    expect(html).toContain("rudder-create-plugin");
    expect(html).not.toContain("rudder/rudder-create-plugin");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("/Users/zeeland/projects/rudder/.agents/skills/rudder-create-plugin/SKILL.md");
  });

  it("renders skill reference hover card metadata when provided", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody
          skillReferences={[
            {
              href: "/workspace/.agents/skills/build-advisor/SKILL.md",
              label: "build-advisor",
              displayName: "Build Advisor",
              description: "Turn vague build feedback into expert diagnosis.",
              categoryLabel: "Global skill",
              locationLabel: "~/.agents/skills",
              detailsHref: "/skills/skill-1",
            },
          ]}
        >
          {"Use [$rudder/build-advisor](/workspace/.agents/skills/build-advisor/SKILL.md)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('class="rudder-skill-hover-card scrollbar-auto-hide"');
    expect(html).toContain("Global skill");
    expect(html).toContain("~/.agents/skills");
    expect(html).toContain("Turn vague build feedback into expert diagnosis.");
    expect(html).toContain('href="/skills/skill-1"');
    expect(html).toContain('class="rudder-skill-token"');
    expect(html).toContain(">build-advisor</a>");
    expect(html).not.toContain("rudder/build-advisor");
  });

  it("renders skill protocol references from current skill metadata", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody
          skillReferences={[
            {
              href: "skill://org/skill-1?ref=build-advisor",
              label: "renamed-advisor",
              displayName: "Renamed Advisor",
              description: "Current skill metadata.",
              categoryLabel: "Org skill",
              locationLabel: "Organization skills",
              detailsHref: "/skills/skill-1",
            },
          ]}
        >
          {"Use [](skill://org/skill-1?ref=build-advisor)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('class="rudder-skill-hover-card scrollbar-auto-hide"');
    expect(html).toContain("Current skill metadata.");
    expect(html).toContain('href="/skills/skill-1"');
    expect(html).toContain(">renamed-advisor</a>");
    expect(html).not.toContain("build-advisor</a>");
    expect(html).not.toContain("skill://org/skill-1");
  });

  it("renders markdown when agent comments contain escaped newline sequences", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"Plan complete.\\n\\n1. Confirm positioning\\n2. Run R-3 and R-4 first"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain("<ol>");
    expect(html).toContain(">Confirm positioning</li>");
    expect(html).not.toContain("\\n");
  });

  it("leaves isolated escaped newline examples alone", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{"Use `\\n` for a newline escape."}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain("\\n");
  });

  it("does not render standalone html break tags as visible markdown text", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"- Trace the agent run context\n  <br />\n- Optimize the skill and memory notes\n&lt;br&gt;\nDone<br />again"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain("Trace the agent run context");
    expect(html).toContain("Optimize the skill and memory notes");
    expect(html).toContain("Done");
    expect(html).toContain("again");
    expect(html).not.toContain("&lt;br");
    expect(html).not.toContain("<br");
  });

  it("keeps html break examples visible inside markdown code", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"Use `<br />` only when documenting HTML.\n\n```html\n<br />\n```"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain("Use ");
    expect(html.match(/&lt;br/g)?.length).toBe(2);
  });

  it("keeps html break examples visible inside multiline markdown code spans", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{"Use `first\n<br />\nsecond` as a literal example."}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain("&lt;br");
  });

  it("does not rewrite html break examples inside markdown links and images", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"See [literal <br /> example](https://example.com/docs?tag=%3Cbr%3E) and ![literal <br /> image](/api/assets/test/content)."}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain("literal &lt;br /&gt; example");
    expect(html).toContain("tag=%3Cbr%3E");
    expect(html).toContain('alt="literal &lt;br /&gt; image"');
  });

  it("lets callers intercept ordinary markdown links", () => {
    const onLinkClick = vi.fn(({ event }) => event.preventDefault());
    const container = render(
      <ThemeProvider>
        <MarkdownBody onLinkClick={onLinkClick}>
          {"Open [daily note](/Users/zeeland/.rudder/notes/2026-04-30.md)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link).toBeTruthy();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

    expect(onLinkClick).toHaveBeenCalledWith(expect.objectContaining({
      href: "/Users/zeeland/.rudder/notes/2026-04-30.md",
      label: "daily note",
    }));
  });

  it("renders external markdown links as ordinary icon-leading blue text links with safe new-window attributes", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"Read [the guide](https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    expect(link?.classList.contains("rudder-link-chip--website")).toBe(false);
    expect(link?.textContent).toBe("the guide");
    expect(link?.querySelector("svg.rudder-website-link-icon")?.getAttribute("aria-hidden")).toBe("true");
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
    expect(link?.querySelector(".rudder-website-link-label")?.textContent).toBe("the guide");
    expect(link?.querySelector(".rudder-link-chip-domain")).toBeNull();
    expect(link?.querySelector(".rudder-link-chip-detail")).toBeNull();
  });

  it("renders recognized website icons without wrapping links in chips", () => {
    const githubContainer = render(
      <ThemeProvider>
        <MarkdownBody>
          {"Read [GitHub traffic](https://github.com/Undertone0809/rudder/graphs/traffic)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const githubLink = githubContainer.querySelector("a");
    expect(githubLink?.getAttribute("href")).toBe("https://github.com/Undertone0809/rudder/graphs/traffic");
    expect(githubLink?.classList.contains("rudder-link-chip--website")).toBe(false);
    expect(githubLink?.querySelector("[data-website-icon='github']")).toBeTruthy();
    expect(githubLink?.querySelector(".rudder-website-link-label")?.textContent).toBe("GitHub traffic");

    cleanupFn?.();
    cleanupFn = null;

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"Read [Rudder docs](https://doc.rudder.zeeland.studio)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://doc.rudder.zeeland.studio");
    expect(link?.classList.contains("rudder-link-chip--website")).toBe(false);
    expect(link?.textContent).toBe("Rudder docs");
    expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("src")).toBe("/rudder-logo.png");
  });

  it("keeps same-origin absolute markdown links in the current window", () => {
    const sameOriginHref = `${window.location.origin}/NEW/issues/NEW-13#comment-comment-1`;
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`Open [Issue comment](<${sameOriginHref}>)`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(sameOriginHref);
    expect(link?.getAttribute("target")).toBeNull();
  });

  it("renders bare long website URLs as ordinary links", () => {
    const url = "https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/";
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{url}</MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe(url);
    expect(link?.getAttribute("title")).toBe(url);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.classList.contains("rudder-link-chip--website")).toBe(false);
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
    expect(link?.textContent).toBe(url);
  });

  it("wraps markdown tables in a horizontal scroll boundary", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"| Source | Reliability | Support |\n|---|---|---|\n| OpenClaw official docs | Official | Phase model and defaults |\n"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const tableScroll = container.querySelector(".rudder-markdown-table-scroll");
    expect(tableScroll).toBeTruthy();
    expect(tableScroll?.querySelector("table")).toBeTruthy();
    expect(tableScroll?.textContent).toContain("OpenClaw official docs");
  });

  it("keeps app-relative markdown links in the current window", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{"Open [the issue](/issues/ZST-9)"}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/ZST-9"');
    expect(html).not.toContain('target="_blank"');
  });

  it("renders relaxed Library markdown link and list syntax", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {[
            "[https://github.com/Undertone0809/rudder/releases?page=5](https://github.com/Undertone0809/rudder/releases?",
            "page=5)",
            "",
            "-[]1",
            "-\\[]1",
          ].join("\n")}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/Undertone0809/rudder/releases?page=5");
    expect(container.querySelector("input[type='checkbox']")).toBeTruthy();
    expect(container.textContent).toContain("[]1");
  });
});
