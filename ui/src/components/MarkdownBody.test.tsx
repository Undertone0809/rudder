// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAgentMentionHref, buildChatMentionHref, buildIssueMentionHref, buildLibraryDocMentionHref, buildLibraryFileMentionHref, buildProjectMentionHref } from "@rudderhq/shared";
import { ThemeProvider } from "../context/ThemeContext";
import { MarkdownBody } from "./MarkdownBody";
import type { MentionOption } from "./MarkdownEditor";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const markdownMentionsMock = vi.hoisted(() => ({
  mentions: [] as MentionOption[],
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

let cleanupFn: (() => void) | null = null;

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  markdownMentionsMock.mentions = [];
  document.body.innerHTML = "";
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
      name: "CodexCoder",
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
    expect(html).toContain("--rudder-mention-agent-avatar-background");
    expect(html).toContain("data:image/svg+xml");
    expect(html).toContain("--rudder-mention-icon-mask:none");
  });

  it("renders issue mentions as chips that link to the issue route", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {`[@PAP-123 auth flow](${buildIssueMentionHref("issue-789", "PAP-123")})`}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="/issues/PAP-123"');
    expect(html).toContain('data-mention-kind="issue"');
    expect(html).toContain(">PAP-123 auth flow</a>");
    expect(html).not.toContain(">@PAP-123 auth flow</a>");
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

    expect(html).toContain('class="rudder-skill-hover-card"');
    expect(html).toContain("Global skill");
    expect(html).toContain("~/.agents/skills");
    expect(html).toContain("Turn vague build feedback into expert diagnosis.");
    expect(html).toContain('href="/skills/skill-1"');
    expect(html).toContain('class="rudder-skill-token"');
    expect(html).toContain(">build-advisor</a>");
    expect(html).not.toContain("rudder/build-advisor");
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

  it("renders external markdown links with safe new-window attributes", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>
          {"Read [the guide](https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/)"}
        </MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain('href="https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain('class="rudder-link-chip"');
  });

  it("renders bare long URLs with the complete URL as link text", () => {
    const url = "https://gingiris.github.io/growth-tools/blog/2026/04/02/github-readme-template-guide/";
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <MarkdownBody>{url}</MarkdownBody>
      </ThemeProvider>,
    );

    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(`title="${url}"`);
    expect(html).toContain(`>${url}</a>`);
    expect(html).not.toContain('class="rudder-link-chip"');
    expect(html).not.toContain('github readme template guide');
    expect(html).toContain('target="_blank"');
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
});
