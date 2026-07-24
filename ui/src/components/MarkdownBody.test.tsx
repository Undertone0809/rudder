// @vitest-environment jsdom

import { buildAgentMentionHref, buildAutomationMentionHref, buildChatMentionHref, buildIssueMentionHref, buildLibraryDirectoryMentionHref, buildLibraryDocMentionHref, buildLibraryEntryMentionHref, buildLibraryFileMentionHref, buildProjectMentionHref, createMarkdownSourceBoundaryMap } from "@rudderhq/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup as renderReactToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewProvider } from "../context/ImagePreviewContext";
import { ThemeProvider } from "../context/ThemeContext";
import {
  CHAT_ANNOTATION_BLOCK_ATTRIBUTE,
  CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
  resolveChatAnnotationRange,
  restoreChatAnnotationRange,
} from "../lib/chat-response-annotation-selection";
import { __clearWebsiteMetadataIconCacheForTests, MarkdownBody, WebsiteLinkIcon } from "./MarkdownBody";
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

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMocks,
}));

const entityPreviewApiMocks = vi.hoisted(() => ({
  getIssue: vi.fn(),
  getComment: vi.fn(),
  getAgent: vi.fn(),
  getProject: vi.fn(),
  getLibraryDocument: vi.fn(),
  getLibraryEntry: vi.fn(),
  readWorkspaceFile: vi.fn(),
  getWebsiteMetadata: vi.fn(),
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

vi.mock("../api/websiteMetadata", () => ({
  websiteMetadataApi: {
    get: entityPreviewApiMocks.getWebsiteMetadata,
  },
}));

let cleanupFn: (() => void) | null = null;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function withQueryClient(element: ReactNode) {
  return <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>;
}

function renderToStaticMarkup(element: ReactNode) {
  return renderReactToStaticMarkup(withQueryClient(element));
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  __clearRudderEntityPreviewCachesForTests();
  __clearWebsiteMetadataIconCacheForTests();
  markdownMentionsMock.mentions = [];
  vi.clearAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  localStorageMock.values.clear();
  document.body.innerHTML = "";
  window.history.pushState({}, "", "/");
  queryClient.clear();
});

beforeEach(() => {
  mermaidMocks.initialize.mockReset();
  mermaidMocks.render.mockReset();
  mermaidMocks.render.mockResolvedValue({
    svg: '<svg data-testid="mock-mermaid-svg"></svg>',
  });
  entityPreviewApiMocks.getIssue.mockRejectedValue(new Error("Issue detail is not configured for this test"));
  entityPreviewApiMocks.getWebsiteMetadata.mockResolvedValue({
    url: "https://example.com/",
    siteName: null,
    iconUrl: null,
  });
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
    root.render(
      <MemoryRouter>
        <ImagePreviewProvider>{withQueryClient(element)}</ImagePreviewProvider>
      </MemoryRouter>,
    );
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
  it("stores raw source offsets alongside rendered offsets after response normalization", () => {
    const source = "Plan\\n\\n-[]任务\\n<br />\\nDone";
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{source}</MarkdownBody>
      </ThemeProvider>,
    );
    const task = container.querySelector("li")!;
    const paragraphs = Array.from(container.querySelectorAll("p"));
    const done = paragraphs.at(-1)!;
    const taskStart = Number(task.dataset.markdownSourceStart);
    const taskEnd = Number(task.dataset.markdownSourceEnd);
    const doneStart = Number(done.dataset.markdownSourceStart);
    const doneEnd = Number(done.dataset.markdownSourceEnd);

    expect(source.slice(taskStart, taskEnd)).toBe("-[]任务");
    expect(source.slice(doneStart, doneEnd)).toBe("Done");
    expect(task.dataset.markdownRenderedSourceStart).not.toBe(task.dataset.markdownSourceStart);
    expect(done.dataset.markdownRenderedSourceStart).not.toBe(done.dataset.markdownSourceStart);
  });

  it("resolves normalized DOM selections to canonical raw message ranges", () => {
    const source = "Plan\\n\\n-[]任务\\n<br />\\nDone";
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{source}</MarkdownBody>
      </ThemeProvider>,
    );
    const sourceRoot = container.querySelector<HTMLElement>(".rudder-markdown")!;
    sourceRoot.setAttribute(CHAT_ANNOTATION_SOURCE_ATTRIBUTE, "assistant:message-normalized");
    sourceRoot.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "message-normalized");
    const taskText = Array.from(sourceRoot.querySelector("li")!.childNodes)
      .find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("任务"))!;
    const doneText = Array.from(sourceRoot.querySelectorAll("p")).at(-1)!.firstChild!;
    const range = document.createRange();
    range.setStart(taskText, taskText.textContent!.indexOf("任务"));
    range.setEnd(doneText, "Done".length);

    const result = resolveChatAnnotationRange({
      range,
      sourceRoot,
      source,
      sourceHash: "b".repeat(64),
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    });
    expect(result).toMatchObject({
      start: source.indexOf("任务"),
      end: source.length,
    });

    const restored = restoreChatAnnotationRange({
      sourceRoot,
      source,
      start: source.indexOf("任务"),
      end: source.length,
    });
    expect(restored?.startContainer).toBe(taskText);
    expect(restored?.startOffset).toBe(taskText.textContent!.indexOf("任务"));
    expect(restored?.endContainer).toBe(doneText);
    expect(restored?.endOffset).toBe("Done".length);
  });

  it("maps generated bare-agent mention Markdown back to the original mention text", () => {
    const source = "你好 @Alice 👩🏽‍💻 &amp; 完成";
    const container = render(
      <ThemeProvider>
        <MarkdownBody
          agentMentions={[{ name: "Alice", agentId: "agent-1" }]}
        >
          {source}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const mention = container.querySelector<HTMLElement>(
      '[data-mention-kind="agent"]',
    )!;
    const start = Number(mention.dataset.markdownSourceStart);
    const end = Number(mention.dataset.markdownSourceEnd);

    expect(source.slice(start, end)).toBe("@Alice");
    expect(Number(mention.dataset.markdownRenderedSourceEnd)).toBeGreaterThan(end);
  });

  it("maps selections over current mention and skill labels to immutable raw link spans", () => {
    const issueId = "1664b23e-1111-4111-8111-111111111111";
    const skillId = "2664b23e-1111-4111-8111-111111111111";
    const issueLink = `[stale issue](${buildIssueMentionHref(issueId, "RUD-1")})`;
    const skillHref = `skill://org/${skillId}?ref=stale-skill`;
    const skillLink = `[stale-skill](${skillHref})`;
    const source = `Review ${issueLink} with ${skillLink} before shipping.`;
    markdownMentionsMock.mentions = [{
      id: `issue:${issueId}`,
      name: "RUD-42 Current issue title",
      kind: "issue",
      issueId,
      issueIdentifier: "RUD-42",
      issueStatus: "in_progress",
    }];
    const container = render(
      <ThemeProvider>
        <MarkdownBody
          skillReferences={[{
            href: skillHref,
            label: "current-skill",
            description: "Tooltip-only skill metadata",
            categoryLabel: "Organization skill",
          }]}
        >
          {source}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const sourceRoot = container.querySelector<HTMLElement>(".rudder-markdown")!;
    sourceRoot.setAttribute(CHAT_ANNOTATION_SOURCE_ATTRIBUTE, "assistant:resolved-labels");
    sourceRoot.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "resolved-labels");
    const issueText = container.querySelector<HTMLElement>('[data-mention-kind="issue"]')!.firstChild!;
    const skillText = container.querySelector<HTMLElement>('[data-skill-token="true"]')!.firstChild!;
    const range = document.createRange();
    range.setStart(issueText, 0);
    range.setEnd(skillText, skillText.textContent!.length);

    const result = resolveChatAnnotationRange({
      range,
      sourceRoot,
      source,
      sourceHash: "b".repeat(64),
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    });

    expect(result).toMatchObject({
      selectedText: "RUD-42 Current issue title with current-skill",
      start: source.indexOf(issueLink),
      end: source.indexOf(skillLink) + skillLink.length,
    });

    const partialRange = document.createRange();
    partialRange.setStart(issueText, "RUD-42 ".length);
    partialRange.setEnd(skillText, "current".length);
    const partial = resolveChatAnnotationRange({
      range: partialRange,
      sourceRoot,
      source,
      sourceHash: "b".repeat(64),
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    });
    const issueStart = source.indexOf(issueLink);
    const skillStart = source.indexOf(skillLink);
    expect(partial).toMatchObject({
      selectedText: "Current issue title with current",
      start: issueStart + createMarkdownSourceBoundaryMap(
        issueLink,
        "RUD-42 Current issue title",
      ).renderedBoundaryToRaw["RUD-42 ".length],
      end: skillStart + createMarkdownSourceBoundaryMap(
        skillLink,
        "current-skill",
      ).renderedBoundaryToRaw["current".length],
    });

    const skillWrap = container.querySelector<HTMLElement>(".rudder-skill-token-wrap")!;
    const trailingText = skillWrap.nextSibling!;
    const spanningRange = document.createRange();
    spanningRange.setStart(issueText, 0);
    spanningRange.setEnd(trailingText, trailingText.textContent!.length);
    const spanning = resolveChatAnnotationRange({
      range: spanningRange,
      sourceRoot,
      source,
      sourceHash: "b".repeat(64),
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    });

    expect(spanning).toMatchObject({
      selectedText: "RUD-42 Current issue title with current-skill before shipping.",
      start: source.indexOf(issueLink),
      end: source.length,
    });
    expect(spanning?.selectedText).not.toContain("Tooltip-only");
  });

  it("renders a file-type icon for local file links with source locations", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"Open [Chat.parts.tsx](/Users/zeeland/projects/rudder-oss/ui/src/pages/Chat.parts.tsx:656)."}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector<HTMLAnchorElement>('a[href$="Chat.parts.tsx:656"]');
    expect(link).not.toBeNull();
    expect(link?.querySelector('[data-local-file-icon="code"]')).not.toBeNull();
  });

  it("renders extension-specific and fallback icons for local file links", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {[
            "[image](/tmp/image.png)",
            "[archive](/tmp/archive.zip)",
            "[sheet](/tmp/data.xlsx)",
            "[document](/tmp/notes.md)",
            "[code](/tmp/main.rs)",
            "[unknown](/tmp/evidence.custom)",
          ].join(" ")}
        </MarkdownBody>
      </ThemeProvider>,
    );

    for (const kind of ["image", "archive", "spreadsheet", "document", "code", "file"]) {
      expect(container.querySelector(`[data-local-file-icon="${kind}"]`)).not.toBeNull();
    }
  });

  it("keeps a rendered Mermaid diagram mounted when its parent rerenders", async () => {
    function RerenderingParent() {
      const [draft, setDraft] = useState("");
      return (
        <ThemeProvider>
          <MarkdownBody>{"- Diagram\n\n  ```mermaid\n  graph TD\n    A --> B\n  ```"}</MarkdownBody>
          <input aria-label="Composer" value={draft} readOnly />
          <button type="button" onClick={() => setDraft("typing")}>Type</button>
        </ThemeProvider>
      );
    }

    const container = render(<RerenderingParent />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
    const renderedSvg = container.querySelector('[data-testid="mock-mermaid-svg"]');
    expect(renderedSvg).toBeTruthy();

    const typeButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Type");
    await act(async () => {
      typeButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLInputElement>('[aria-label="Composer"]')?.value).toBe("typing");

    expect(mermaidMocks.render).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="mock-mermaid-svg"]')).toBe(renderedSvg);
    expect(container.querySelector(".rudder-mermaid-source")).toBeNull();
  });

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

    expect(html).toContain('href="/library?entry=entry-123&amp;path=docs%2Fproduct-brief.md"');
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

  it("exposes Markdown source offsets on inline formatting nodes for precise selections", () => {
    const source = "Use **bold**, *emphasis*, ~~removed~~, and `code`.";
    const container = render(
      <ThemeProvider>
        <MarkdownBody>{source}</MarkdownBody>
      </ThemeProvider>,
    );

    for (const selector of ["strong", "em", "del", "code"]) {
      const element = container.querySelector<HTMLElement>(selector);
      expect(element, selector).toBeTruthy();
      const start = Number(element?.dataset.markdownSourceStart);
      const end = Number(element?.dataset.markdownSourceEnd);
      expect(Number.isInteger(start), `${selector} start`).toBe(true);
      expect(Number.isInteger(end), `${selector} end`).toBe(true);
      expect(source.slice(start, end)).toContain(element?.textContent ?? "");
    }
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

  it("renders automation mentions as live Automation links without previews", () => {
    const href = buildAutomationMentionHref("automation-123", "Morning review");
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{`[@Morning review](${href})`}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/automations/automation-123"');
    expect(html).toContain('data-mention-kind="automation"');
    expect(html).toContain("Morning review");
    expect(html).not.toContain("rudder-entity-preview-wrap");
  });

  it("uses current automation titles for rendered automation mention chips", () => {
    markdownMentionsMock.mentions = [{
      id: "automation:0d232c68-1111-4111-8111-111111111111",
      name: "每日 Rudder 产品与搜索数据分析报告",
      kind: "automation",
      automationId: "0d232c68-1111-4111-8111-111111111111",
      automationTitle: "每日 Rudder 产品与搜索数据分析报告",
      automationStatus: "active",
    }];

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"完成 chat [0d232c68](automation://0d232c68-1111-4111-8111-111111111111)。"}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const mention = container.querySelector('[data-mention-kind="automation"]');

    expect(mention?.textContent).toBe("每日 Rudder 产品与搜索数据分析报告");
    expect(mention?.getAttribute("href")).toBe("/automations/0d232c68-1111-4111-8111-111111111111");
    expect(mention?.classList.contains("rudder-mention-chip")).toBe(true);
    expect(container.textContent).not.toContain("0d232c68");
  });

  it("uses automation title metadata when the mention catalog has not loaded", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`完成 chat [0d232c68](${buildAutomationMentionHref("0d232c68-1111-4111-8111-111111111111", "每日 Rudder 产品与搜索数据分析报告")})。`}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const mention = container.querySelector('[data-mention-kind="automation"]');

    expect(mention?.textContent).toBe("每日 Rudder 产品与搜索数据分析报告");
    expect(mention?.getAttribute("href")).toBe("/automations/0d232c68-1111-4111-8111-111111111111");
    expect(container.textContent).not.toContain("0d232c68");
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
    const previewRoot = document.body.querySelector('[data-testid="markdown-body-image-preview-dialog"]');
    expect(previewRoot?.querySelector("img")?.getAttribute("alt")).toBe("Evidence");
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
        id: "agent:agt_d573266f",
        name: "ShortRef Agent",
        kind: "agent",
        agentId: "agt_d573266f",
        agentIcon: null,
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
          {`[@CodexCoder](${buildAgentMentionHref("agent-123", "code")}) [ShortRef Agent](${buildAgentMentionHref("agt_d573266f", null, "wake")}) [@Rudder App](${buildProjectMentionHref("project-456", "#336699")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/agents/agent-123"');
    expect(html).toContain('data-mention-kind="agent"');
    expect(html).toContain("--rudder-mention-icon-mask");
    expect(html).toContain(">CodexCoder</a>");
    expect(html).not.toContain(">@CodexCoder</a>");
    expect(html).toContain('href="/agents/agt_d573266f"');
    expect(html).toContain(">ShortRef Agent</a>");
    expect(html).not.toContain("agent://agt_d573266f");
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

  it("renders empty-label issue links without current mention data as readable links", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"- [](issue://843c381d-0b1a-48fb-9015-8c7df88d543f) CI/Release 巡检完成。"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/843c381d-0b1a-48fb-9015-8c7df88d543f"');
    expect(html).toContain(">843c381d</a>");
    expect(html).toContain("rudder-entity-preview-wrap");
    expect(html).toContain("rudder-mention-chip");
    expect(html).toContain("CI/Release 巡检完成");
    expect(html).not.toContain("></a>");
  });

  it("renders whitespace-label issue links without current mention data as readable links", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"- [   ](issue://843c381d-0b1a-48fb-9015-8c7df88d543f) CI/Release 巡检完成。"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/843c381d-0b1a-48fb-9015-8c7df88d543f"');
    expect(html).toContain(">843c381d</a>");
    expect(html).not.toContain(">   </a>");
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

  it("decodes HTML entity spacing in issue mention labels", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`[ZST-646&#x20;改回 AGENT HOME](${buildIssueMentionHref("issue-646", "ZST-646")}) 看看这个`}
        </MarkdownBody>
      </ThemeProvider>,
    );
    const mention = container.querySelector('[data-mention-kind="issue"]');

    expect(mention?.textContent).toBe("ZST-646 改回 AGENT HOME");
    expect(container.textContent).not.toContain("&#x20;");
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

  it("prefetches Library entry metadata when entry mention chips render", async () => {
    localStorageMock.values.set("rudder.selectedOrganizationId", "org-1");
    entityPreviewApiMocks.getLibraryEntry.mockResolvedValue({
      id: "entry-123",
      orgId: "org-1",
      kind: "file",
      sourceType: "workspace_file",
      currentPath: "projects/rudder/product-brief.md",
      title: "Product brief",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    render(
      <ThemeProvider>
        <MarkdownBody>
          {`[Product brief](${buildLibraryEntryMentionHref("entry-123", "Product brief")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(entityPreviewApiMocks.getLibraryEntry).toHaveBeenCalledWith("org-1", "entry-123");
  });

  it("renders issue mentions with status metadata using the status icon affordance", () => {
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "done",
    }];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`- 当前自动化列表里已经完成 [@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123", null, "done")})，继续检查后续正文排版。`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/issue-789"');
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain('data-mention-status="done"');
    expect(html).toContain("rudder-mention-chip--with-status-icon");
    expect(html).not.toContain('title="Open PAP-123 auth flow"');
    expect(html).not.toContain('data-slot="issue-status-icon"');
    expect(html).not.toContain('data-status="done"');
    expect(html).toContain("当前自动化列表里已经完成");
    expect(html).toContain("继续检查后续正文排版");
  });

  it("resolves live issue status when the reference is outside the mention catalog", async () => {
    entityPreviewApiMocks.getIssue.mockResolvedValue({
      id: "a6ecf978-b334-43aa-8065-a5ea6abffb9f",
      identifier: "ZST-776",
      status: "in_progress",
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {[
            "总结一下，这个任务都在做些啥？ ",
            "[ZST-776 深度分析一下你今天这些 agent run 中遇到的各种报错和困难，优化系统]",
            "(issue://a6ecf978-b334-43aa-8065-a5ea6abffb9f?r=ZST-776)",
            " 再检查一次 ",
            "[ZST-776](issue://a6ecf978-b334-43aa-8065-a5ea6abffb9f?r=ZST-776)",
          ].join("")}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const mentions = container.querySelectorAll<HTMLElement>('[data-mention-kind="issue"]');
    expect(mentions).toHaveLength(2);
    await act(async () => {
      await vi.waitFor(() => {
        expect(mentions[0]?.dataset.mentionStatus).toBe("in_progress");
        expect(mentions[1]?.dataset.mentionStatus).toBe("in_progress");
      });
    });
    expect(entityPreviewApiMocks.getIssue).toHaveBeenCalledTimes(1);
    expect(entityPreviewApiMocks.getIssue).toHaveBeenCalledWith("a6ecf978-b334-43aa-8065-a5ea6abffb9f");
    for (const mention of mentions) {
      expect(mention.dataset.mentionStatus).toBe("in_progress");
      expect(mention.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
    }
  });

  it("renders issue comment mentions with the same status affordance as editor tokens", () => {
    markdownMentionsMock.mentions = [{
      id: "issue:issue-789",
      name: "PAP-123 auth flow",
      kind: "issue",
      issueId: "issue-789",
      issueIdentifier: "PAP-123",
      issueStatus: "backlog",
    }];

    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[Issue comment c7fe865f](${buildIssueMentionHref("issue-789", "PAP-123", "comment-123", "backlog")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/issue-789#comment-comment-123"');
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain('data-mention-comment="true"');
    expect(html).toContain('data-mention-status="backlog"');
    expect(html).toContain("rudder-mention-chip--with-status-icon");
    expect(html).toContain(">PAP-123 auth flow</a>");
    expect(html).not.toContain("Issue comment c7fe865f");
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
      body: "Reviewer said **render the comment body** instead of issue metadata.\n<br />\nFollow-up text stays visible.",
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
    expect(card?.textContent).toContain("Auth flow polish");
    expect(card?.textContent).toContain("Reviewer said render the comment body instead of issue metadata.");
    expect(card?.textContent).toContain("Follow-up text stays visible.");
    expect(card?.textContent).not.toContain("<br");
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
    const imageTrigger = previewBody?.querySelector<HTMLButtonElement>(".rudder-inspectable-image-trigger");
    await act(async () => {
      imageTrigger?.click();
    });
    expect(document.body.querySelector("[data-testid='entity-image-preview-dialog']"))
      .not.toBeNull();
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
    expect(html).toContain(">PAP-123 auth flow</a>");
    expect(html).not.toContain("Issue comment abc12345");
  });

  it("renders skill references as non-interactive tokens instead of links", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"[$rudder/rudder-docs](/Users/zeeland/projects/rudder/server/resources/bundled-skills/rudder-docs/SKILL.md)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('class="rudder-skill-token"');
    expect(html).toContain("rudder-docs");
    expect(html).not.toContain("rudder/rudder-docs");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("/Users/zeeland/projects/rudder/server/resources/bundled-skills/rudder-docs/SKILL.md");
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
              detailsHref: "/library?skill=skill-1&skillFile=SKILL.md",
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
    expect(html).toContain('href="/library?skill=skill-1&amp;skillFile=SKILL.md"');
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
              detailsHref: "/library?skill=skill-1&skillFile=SKILL.md",
            },
          ]}
        >
          {"Use [](skill://org/skill-1?ref=build-advisor)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('class="rudder-skill-hover-card scrollbar-auto-hide"');
    expect(html).toContain("Current skill metadata.");
    expect(html).toContain('href="/library?skill=skill-1&amp;skillFile=SKILL.md"');
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
    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
    expect(link?.querySelector(".rudder-website-link-label")?.textContent).toBe("the guide");
    expect(link?.querySelector(".rudder-link-chip-domain")).toBeNull();
    expect(link?.querySelector(".rudder-link-chip-detail")).toBeNull();
  });

  it("keeps the generic website icon when metadata has no site icon", async () => {
    entityPreviewApiMocks.getWebsiteMetadata.mockResolvedValueOnce({
      url: "https://policy.example.test/terms-of-use/",
      siteName: "Policy Example",
      iconUrl: null,
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"Reference [Terms of Use](https://policy.example.test/terms-of-use/)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://policy.example.test/terms-of-use/");
    expect(link?.classList.contains("rudder-link-chip--website")).toBe(false);
    expect(link?.textContent).toBe("Terms of Use");
    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
    await act(async () => {
      await vi.waitFor(() => {
        expect(entityPreviewApiMocks.getWebsiteMetadata).toHaveBeenCalledWith("https://policy.example.test/terms-of-use/");
      });
    });

    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
  });

  it("uses known website icons without fetching metadata", () => {
    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"Read [tweet](https://x.com/my_knn_totoro/status/2068910037238772102), [Feishu](https://docs.feishu.cn/docx/example), [Rudder](https://rudderhq.dev/docs), [ChatGPT](https://learn.chatgpt.com/docs/sandboxing/auto-review), [OpenAI](https://platform.openai.com/docs), [Reddit](https://www.reddit.com/r/LocalLLaMA/), [Medium](https://engineering.medium.com/post), [Hacker News](https://news.ycombinator.com/item?id=1), and [Linux.do](https://linux.do/t/topic/1)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const links = Array.from(container.querySelectorAll("a"));
    const logos = links.map((link) => link.querySelector("img.rudder-website-link-logo"));
    expect(entityPreviewApiMocks.getWebsiteMetadata).not.toHaveBeenCalled();
    expect(links).toHaveLength(9);
    expect(logos.map((logo) => logo?.getAttribute("src"))).toEqual(
      Array.from({ length: 9 }, () => expect.stringMatching(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u)),
    );
    for (const link of links) {
      expect(link.querySelector("img.rudder-website-link-logo")?.getAttribute("data-website-icon")).toBe("metadata");
      expect(link.querySelector("[data-website-icon='generic']")).toBeNull();
    }
    expect(links[4]?.querySelector("img.rudder-website-link-logo")?.getAttribute("data-dark-mode")).toBe("invert");
    expect(links[3]?.querySelector("img.rudder-website-link-logo")?.hasAttribute("data-dark-mode")).toBe(false);
    expect(links.map((link) => link.textContent)).toEqual([
      "tweet", "Feishu", "Rudder", "ChatGPT", "OpenAI", "Reddit", "Medium", "Hacker News", "Linux.do",
    ]);
  });

  it("adapts the GitHub website icon for dark backgrounds", () => {
    const container = render(
      <ThemeProvider>
        <WebsiteLinkIcon url={new URL("https://github.com/Undertone0809/rudder")} />
      </ThemeProvider>,
    );

    const logo = container.querySelector("img.rudder-website-link-logo");
    expect(logo?.getAttribute("data-dark-mode")).toBe("invert");
  });

  it("replaces the generic website icon only with fetched metadata icons", async () => {
    const url = "https://metadata-icon.example.test/post";
    entityPreviewApiMocks.getWebsiteMetadata.mockResolvedValue({
      url,
      siteName: "Example",
      iconUrl: "https://static.example.com/favicon.ico",
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {"Read [post](https://metadata-icon.example.test/post)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();

    await act(async () => {
      await vi.waitFor(() => {
        expect(entityPreviewApiMocks.getWebsiteMetadata).toHaveBeenCalledWith(url);
      });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("src")).toBe("https://static.example.com/favicon.ico");
      });
    });
    expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("data-website-icon")).toBe("metadata");
    expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("aria-hidden")).toBe("true");
    expect(link?.querySelector("img.rudder-website-link-logo")?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(link?.textContent).toBe("post");
  });

  it("reuses one metadata request when the same website icon appears multiple times", async () => {
    const url = "https://example.com/docs";
    entityPreviewApiMocks.getWebsiteMetadata.mockResolvedValue({
      url,
      siteName: "Example",
      iconUrl: "/api/website-metadata/icon?url=https%3A%2F%2Fstatic.example.com%2Ffavicon.png",
    });

    const container = render(
      <ThemeProvider>
        <span>
          <WebsiteLinkIcon url={new URL(url)} />
          <WebsiteLinkIcon url={new URL(url)} />
        </span>
      </ThemeProvider>,
    );

    await act(async () => {
      await vi.waitFor(() => {
        expect(entityPreviewApiMocks.getWebsiteMetadata).toHaveBeenCalledWith(url);
      });
    });

    expect(entityPreviewApiMocks.getWebsiteMetadata).toHaveBeenCalledTimes(1);
  });

  it("keeps the generic website icon when website metadata lookup is blocked", async () => {
    const url = "https://developers.google.com/engineering-practices/code-review";
    entityPreviewApiMocks.getWebsiteMetadata.mockRejectedValueOnce(new Error("Private network URLs cannot be inspected"));

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`Read [Google Engineering Practices](${url})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();

    await act(async () => {
      await vi.waitFor(() => {
        expect(entityPreviewApiMocks.getWebsiteMetadata).toHaveBeenCalledWith(url);
      });
    });

    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
  });

  it.each([
    "http://localhost:8080/post",
    "http://127.0.0.1:8080/post",
    "http://10.2.3.4/post",
    "http://100.64.0.1/post",
    "http://app.local/post",
    "http://service.internal/post",
    "http://intranet/post",
  ])("does not request origin or provider favicons for private or internal origins: %s", async (url) => {
    entityPreviewApiMocks.getWebsiteMetadata.mockRejectedValueOnce(new Error("Private network URLs cannot be inspected"));

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`Read [internal](${url})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();

    await act(async () => {
      await vi.waitFor(() => {
        expect(entityPreviewApiMocks.getWebsiteMetadata).toHaveBeenCalledWith(url);
      });
    });

    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
  });

  it("falls back directly to the generic icon when a fetched metadata icon fails to load", async () => {
    const url = "https://broken-icon.example.org/post/";
    entityPreviewApiMocks.getWebsiteMetadata.mockResolvedValue({
      url,
      siteName: "Broken Icon",
      iconUrl: "/api/website-metadata/icon?url=https%3A%2F%2Fbroken-icon.example.org%2Fbroken.ico",
    });

    const container = render(
      <ThemeProvider>
        <MarkdownBody>
          {`Read [post](${url})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    const link = container.querySelector("a");
    await act(async () => {
      await vi.waitFor(() => {
        expect(entityPreviewApiMocks.getWebsiteMetadata).toHaveBeenCalledWith(url);
      });
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(link?.querySelector("img.rudder-website-link-logo")).toBeTruthy();
      });
    });

    await act(async () => {
      link?.querySelector("img.rudder-website-link-logo")?.dispatchEvent(new Event("error", { bubbles: false }));
    });

    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
    expect(link?.querySelector("[data-website-icon='generic']")).toBeTruthy();
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
    expect(link?.querySelector("img.rudder-website-link-logo")).toBeNull();
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

  it("renders resolved app-relative issue links as issue mention chips", () => {
    window.history.pushState({}, "", "/ZST/messenger/issues/ZST-752");
    markdownMentionsMock.mentions = [{
      id: "issue:1664b23e-1111-4111-8111-111111111111",
      name: "ZST-747 Rudder SEO / GSC Daily Check",
      kind: "issue",
      issueId: "1664b23e-1111-4111-8111-111111111111",
      issueIdentifier: "ZST-747",
      issueStatus: "done",
    }];

    const container = render(
      <ThemeProvider>
        <MarkdownBody>{"- 完成 [1664b23e](/issues/1664b23e): 2026-06-21 Rudder SEO / GSC Daily Check。"}</MarkdownBody>
      </ThemeProvider>,
    );
    const mention = container.querySelector('[data-mention-kind="issue"]');

    expect(mention?.textContent).toBe("ZST-747 Rudder SEO / GSC Daily Check");
    expect(mention?.getAttribute("href")).toBe("/ZST/issues/1664b23e");
    expect(mention?.getAttribute("data-mention-status")).toBe("done");
    expect(mention?.classList.contains("rudder-mention-chip")).toBe(true);
    expect(mention?.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
  });

  it("uses canonical issue identity for resolved internal issue links with opaque labels", () => {
    window.history.pushState({}, "", "/ZST/messenger/issues/ZST-752");
    markdownMentionsMock.mentions = [{
      id: "issue:1664b23e-1111-4111-8111-111111111111",
      name: "ZST-747 Rudder SEO / GSC Daily Check",
      kind: "issue",
      issueId: "1664b23e-1111-4111-8111-111111111111",
      issueIdentifier: "ZST-747",
      issueStatus: "done",
    }];

    const container = render(
      <ThemeProvider>
        <MarkdownBody>{"Open [the issue](/issues/ZST-747) for the automation result."}</MarkdownBody>
      </ThemeProvider>,
    );
    const mention = container.querySelector('[data-mention-kind="issue"]');

    expect(mention?.textContent).toBe("ZST-747 Rudder SEO / GSC Daily Check");
    expect(mention?.getAttribute("href")).toBe("/ZST/issues/ZST-747");
    expect(mention?.classList.contains("rudder-mention-chip")).toBe(true);
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
