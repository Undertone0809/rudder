// @vitest-environment jsdom

import { isolateHistory } from "@codemirror/commands";
import { highlightingFor } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import {
  act,
  createRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeMirrorMarkdownHighlightStyle } from "../lib/codemirror-markdown-theme";
import { getMarkdownPreviewDocument } from "../lib/markdown-live-preview";
import { __clearWebsiteMetadataCacheForTests } from "../lib/website-metadata-cache";
import {
  __getCodeMirrorMarkdownViewForTests,
  CodeMirrorMarkdownEditor,
  previewDocumentForTransaction,
} from "./CodeMirrorMarkdownEditor";
import type { MarkdownEditorRef } from "./MarkdownEditor";

const websiteMetadataMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));
const scrollIntoViewMock = vi.fn();

vi.mock("../api/websiteMetadata", () => ({
  websiteMetadataApi: websiteMetadataMocks,
}));

vi.mock("./MarkdownBody", () => ({
  WebsiteLinkIcon: ({ url }: { url: URL }) => (
    <span data-website-icon="mock" data-website-url={url.href} />
  ),
  MarkdownBody: ({
    children,
    className,
    onLinkClick,
    sourceOffsetBase = 0,
    skillReferences,
  }: {
    children: string;
    className?: string;
    onLinkClick?: (args: {
      event: ReactMouseEvent<HTMLAnchorElement>;
      href: string;
      label: string;
    }) => boolean | void;
    sourceOffsetBase?: number;
    skillReferences?: Array<{
      href: string;
      detailsHref?: string | null;
    }>;
  }) => {
    const renderedSource = children.replace(/^#{1,6}\s+/u, "");
    const imageMatch = renderedSource.match(/^!\[([^\]]*)\]\(([^)]+)\)$/u);
    if (imageMatch) {
      return (
        <div className={className} data-rendered-markdown={children}>
          <button type="button" className="rudder-inspectable-image-trigger">
            <img src={imageMatch[2]} alt={imageMatch[1]} />
            <span className="rudder-inspectable-image-overlay" aria-hidden="true">
              <svg aria-hidden="true" />
            </span>
          </button>
        </div>
      );
    }
    const tableLines = renderedSource.split("\n");
    if (tableLines.length >= 2 && /\|/u.test(tableLines[0] ?? "")) {
      let lineOffset = 0;
      const rows = tableLines.flatMap((line, lineIndex) => {
        const currentOffset = lineOffset;
        lineOffset += line.length + 1;
        if (lineIndex === 1) return [];
        const cells: Array<{ from: number; to: number; value: string }> = [];
        const pipeIndexes = Array.from(line.matchAll(/\|/gu), (match) => match.index);
        const boundaries = [...pipeIndexes];
        if (boundaries[0] !== 0) boundaries.unshift(0);
        if (boundaries.at(-1) !== line.length - 1) boundaries.push(line.length);
        for (let index = 0; index + 1 < boundaries.length; index += 1) {
          const segmentFrom = boundaries[index]! + (boundaries[index] === 0 && line[0] !== "|" ? 0 : 1);
          const segmentTo = boundaries[index + 1]!;
          const segment = line.slice(segmentFrom, segmentTo);
          cells.push({
            from: sourceOffsetBase + currentOffset + boundaries[index]!,
            to: sourceOffsetBase + currentOffset + (
              index + 2 === boundaries.length ? line.length : boundaries[index + 1]!
            ),
            value: segment.trim(),
          });
        }
        const Cell = lineIndex === 0 ? "th" : "td";
        return [(
          <tr key={lineIndex}>
            {cells.map((cell, cellIndex) => (
              <Cell
                key={cellIndex}
                data-markdown-source-start={cell.from}
                data-markdown-source-end={cell.to}
              >
                {cell.value}
              </Cell>
            ))}
          </tr>
        )];
      });
      return (
        <div className={className} data-rendered-markdown={children}>
          <table><tbody>{rows}</tbody></table>
        </div>
      );
    }
    const parts: ReactNode[] = [];
    const linkPattern = /\[([^\]]+)\]\(([^)]+)\)/gu;
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = linkPattern.exec(renderedSource)) !== null) {
      parts.push(renderedSource.slice(cursor, match.index));
      const href = match[2] ?? "";
      if (/^skill:\/\//iu.test(href) || /\/SKILL\.md(?:[#?].*)?$/iu.test(href)) {
        const detailsHref = skillReferences?.find(
          (reference) => reference.href === href,
        )?.detailsHref;
        parts.push(detailsHref ? (
          <a
            key={`${match.index}:${href}`}
            href={detailsHref}
            data-skill-token="true"
            data-markdown-source-start={match.index}
            data-markdown-source-end={match.index + match[0].length}
          >
            {match[1]}
          </a>
        ) : (
          <span
            key={`${match.index}:${href}`}
            data-skill-token="true"
            data-markdown-source-start={match.index}
            data-markdown-source-end={match.index + match[0].length}
          >
            {match[1]}
          </span>
        ));
      } else {
        parts.push(
          <a
            key={`${match.index}:${href}`}
            href={href}
            data-rendered-link={href}
            data-mention-kind={/^(?:agent|automation|chat|issue|library[-_]|project):\/\//u.test(href)
              ? "mock"
              : undefined}
            data-website-icon={/^https?:\/\//u.test(href) ? "mock" : undefined}
            onClick={(event) => {
              if (onLinkClick?.({
                event,
                href,
                label: match?.[1] ?? "",
              })) {
                event.preventDefault();
              }
            }}
          >
            {match[1]}
          </a>,
        );
      }
      cursor = match.index + match[0].length;
    }
    parts.push(renderedSource.slice(cursor));
    return <div className={className} data-rendered-markdown={children}>{parts}</div>;
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function clipboardEvent(text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files: [],
      items: [],
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  return event;
}

function imageClipboardEvent(fileOrFiles: File | File[]) {
  const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: [],
      getData: () => "",
    },
  });
  return event;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function editorView() {
  const view = __getCodeMirrorMarkdownViewForTests(container);
  expect(view).toBeTruthy();
  return view as EditorView;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  scrollIntoViewMock.mockReset();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoViewMock,
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => null,
  });
  if (!Range.prototype.getClientRects) {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  }
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 1,
      height: 18,
      top: 0,
      right: 1,
      bottom: 18,
      left: 0,
      toJSON: () => undefined,
    }),
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      width: 800,
      height: 400,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      toJSON: () => undefined,
    }),
  });
  __clearWebsiteMetadataCacheForTests();
  websiteMetadataMocks.get.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

describe("CodeMirrorMarkdownEditor live preview", { timeout: 15_000 }, () => {
  it("updates the content accessibility label when editor props change", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value=""
          onChange={() => undefined}
          placeholder="Add description..."
        />,
      );
    });
    await flushReact();

    expect(editorView().contentDOM.getAttribute("aria-label")).toBe(
      "Add description... Markdown editor",
    );

    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value=""
          onChange={() => undefined}
          ariaLabel="Instruction"
          placeholder="Describe the Issue you want the Agent to create..."
        />,
      );
    });
    await flushReact();

    expect(editorView().contentDOM.getAttribute("aria-label")).toBe("Instruction");
  });

  it("blocks text and image paste mutations while read-only", async () => {
    const onChange = vi.fn();
    const imageUploadHandler = vi.fn(async () => "/api/assets/read-only/content");
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="Submitted instruction"
          onChange={onChange}
          imageUploadHandler={imageUploadHandler}
          readOnly
        />,
      );
    });
    await flushReact();

    expect(editorView().state.readOnly).toBe(true);
    expect(editorView().contentDOM.getAttribute("contenteditable")).not.toBe("true");
    act(() => {
      editorView().contentDOM.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: " changed",
        inputType: "insertText",
      }));
      editorView().contentDOM.dispatchEvent(
        imageClipboardEvent(new File(["image"], "blocked.png", { type: "image/png" })),
      );
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("Submitted instruction");
    expect(imageUploadHandler).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders inactive blocks, reveals exact source on click, and previews again on blur", async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={"# Heading\nRead [OpenAI](https://openai.com)."}
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    const headingPreview = container?.querySelector<HTMLElement>(
      '[data-markdown-preview-state="preview"][data-source-line-start="1"]',
    );
    const linkPreview = container?.querySelector<HTMLElement>(
      '[data-markdown-preview-state="preview"][data-source-line-start="2"]',
    );
    expect(headingPreview?.textContent).toBe("Heading");
    expect(linkPreview?.querySelector('[data-website-icon="mock"]')).toBeTruthy();
    expect(container?.textContent).not.toContain("# Heading");

    const previewLineCount = container?.querySelectorAll(".cm-line").length;
    act(() => {
      editorView().focus();
      editorView().dispatch({ selection: { anchor: 2 } });
    });
    await flushReact();

    expect(container?.querySelector(
      '[data-markdown-preview-state="source"][data-source-line-start="1"][data-markdown-source-heading-level="1"]',
    )).toBeTruthy();
    expect(container?.querySelectorAll(".cm-line")).toHaveLength(previewLineCount ?? 0);
    expect(editorView().state.doc.toString()).toBe("# Heading\nRead [OpenAI](https://openai.com).");
    expect(onChange).not.toHaveBeenCalled();

    act(() => {
      editorView().contentDOM.blur();
    });
    await flushReact();

    expect(container?.querySelector('[data-markdown-preview-state="preview"][data-source-line-start="1"]')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps image previews clickable without revealing their Markdown source", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="![Screenshot](/api/assets/image/content)"
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const imageTrigger = container?.querySelector<HTMLButtonElement>(
      ".rudder-inspectable-image-trigger",
    );
    expect(imageTrigger).toBeTruthy();
    expect(container?.querySelector('[data-markdown-preview-state="preview"]')).toBeTruthy();
    expect(container?.textContent).not.toContain("![Screenshot](/api/assets/image/content)");

    const imageOverlayIcon = imageTrigger?.querySelector("svg");
    act(() => {
      imageOverlayIcon?.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(container?.querySelector('[data-markdown-preview-state="preview"]')).toBeTruthy();
    expect(container?.textContent).not.toContain("![Screenshot](/api/assets/image/content)");

    act(() => {
      imageTrigger?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(container?.querySelector('[data-markdown-preview-state="preview"]')).toBeTruthy();
    expect(container?.textContent).not.toContain("![Screenshot](/api/assets/image/content)");
  });

  it("edits rendered table cells in place and targets hover actions to the visual row", async () => {
    const ref = createRef<MarkdownEditorRef>();
    const markdown = [
      "| Item | Status |",
      "| --- | --- |",
      "| First | Needs work |",
    ].join("\n");
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={markdown}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const statusCell = Array.from(container?.querySelectorAll<HTMLTableCellElement>("td") ?? [])
      .find((cell) => cell.textContent === "Needs work");
    expect(statusCell).toBeTruthy();
    act(() => {
      statusCell?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await flushReact();
    expect(document.querySelector('[aria-label="Open block actions for line 3"]')).toBeTruthy();

    let cellTop = 120;
    vi.spyOn(statusCell!, "getBoundingClientRect").mockImplementation(() => ({
      bottom: cellTop + 32,
      height: 32,
      left: 100,
      right: 260,
      top: cellTop,
      width: 160,
      x: 100,
      y: cellTop,
      toJSON: () => ({}),
    }));

    act(() => {
      statusCell?.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="markdown-table-cell-editor"]',
    );
    expect(input?.value).toBe("Needs work");
    expect(input?.style.top).toBe("120px");
    expect(container?.querySelector("table")).toBeTruthy();
    expect(container?.textContent).not.toContain("| Item | Status |");

    cellTop = 48;
    act(() => window.dispatchEvent(new Event("scroll")));
    await flushReact();
    expect(input?.style.top).toBe("48px");

    act(() => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Ready");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe(markdown.replace("Needs work", "Ready"));
    expect(container?.querySelector("table")).toBeTruthy();
    expect(Array.from(container?.querySelectorAll("td") ?? []).some(
      (cell) => cell.textContent === "Ready",
    )).toBe(true);
    const previousCellInput = document.querySelector<HTMLInputElement>(
      '[aria-label="Edit table cell row 2 column 1"]',
    );
    expect(previousCellInput?.value).toBe("First");
    act(() => {
      previousCellInput?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();
    expect(document.querySelector('[data-testid="markdown-table-cell-editor"]')).toBeNull();
  });

  it("refreshes rendered tables when a document change follows an unfinished preview drag", async () => {
    const ref = createRef<MarkdownEditorRef>();
    const markdown = [
      "# Instructions",
      "",
      "| Step | Owner |",
      "| --- | --- |",
      "| Run safely | Agent |",
    ].join("\n");
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={markdown}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const headingPreview = container?.querySelector<HTMLElement>(
      '[data-markdown-preview-state="preview"][data-source-line-start="1"]',
    );
    vi.spyOn(editorView(), "posAtCoords").mockReturnValue(0);
    act(() => {
      headingPreview?.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    const runCell = Array.from(container?.querySelectorAll<HTMLTableCellElement>("td") ?? [])
      .find((cell) => cell.textContent === "Run safely");
    expect(runCell).toBeTruthy();
    vi.spyOn(runCell!, "getBoundingClientRect").mockImplementation(() => ({
      bottom: 152,
      height: 32,
      left: 100,
      right: 260,
      top: 120,
      width: 160,
      x: 100,
      y: 120,
      toJSON: () => ({}),
    }));
    act(() => {
      runCell?.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="markdown-table-cell-editor"]',
    );
    act(() => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Review safely");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toContain("| Review safely | Agent |");
    expect(Array.from(container?.querySelectorAll("td") ?? []).some(
      (cell) => cell.textContent === "Review safely",
    )).toBe(true);
  });

  it.each([
    ["outer pipes", ["| Item | Status |", "| --- | --- |", "| First | Needs work |"].join("\n")],
    ["no outer pipes", ["Item | Status", "--- | ---", "First | Needs work"].join("\n")],
  ])("escapes every unescaped table delimiter with %s without changing surrounding source", async (
    _label,
    markdown,
  ) => {
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor ref={ref} value={markdown} onChange={() => undefined} />,
      );
    });
    await flushReact();

    const statusCell = Array.from(container?.querySelectorAll<HTMLTableCellElement>("td") ?? [])
      .find((cell) => cell.textContent === "Needs work");
    act(() => {
      statusCell?.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="markdown-table-cell-editor"]',
    );
    const editedValue = String.raw`A||B\\|C\|D`;
    act(() => {
      if (!input) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        editedValue,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe(
      markdown.replace("Needs work", String.raw`A\|\|B\\\|C\|D`),
    );
  });

  it("marks fenced source lines so the active block keeps its visual container", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={"```ts\nconst answer = 42;\n```"}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({ selection: { anchor: 1 } });
    });
    await flushReact();

    expect(container?.querySelector(
      '[data-markdown-source-kind="fenced-code"][data-markdown-source-block-edge="first"]',
    )).toBeTruthy();
    expect(container?.querySelector(
      '[data-markdown-source-kind="fenced-code"][data-markdown-source-block-edge="last"]',
    )).toBeTruthy();
  });

  it("applies sizing classes to the editor once instead of every preview block", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={"first\nsecond"}
          onChange={() => undefined}
          contentClassName="live-preview-min-height live-preview-typography"
        />,
      );
    });
    await flushReact();

    expect(container?.querySelector(
      ".rudder-codemirror-markdown-content.live-preview-min-height",
    )).toBeTruthy();
    expect(container?.querySelectorAll(
      ".rudder-codemirror-markdown-rendered.live-preview-min-height",
    )).toHaveLength(0);
  });

  it("installs the theme-aware URL highlight in active Markdown source", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Read [OpenAI](https://openai.com)."
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({ selection: { anchor: 6 } });
    });
    await flushReact();

    const urlClass = codeMirrorMarkdownHighlightStyle.style([tags.url]);
    expect(highlightingFor(editorView().state, [tags.url])).toContain(urlClass);
    const urlSource = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-markdown-preview-state="source"] span') ?? [],
    ).find((element) => element.textContent === "https://openai.com");
    expect(urlClass).toBeTruthy();
    expect(urlSource?.classList.contains(urlClass!)).toBe(true);
  });

  it("keeps ordinary links source-driven and reveals exact syntax on selection", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Read [Section](#target)."
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    expect(container?.querySelector(".rudder-cm-markdown-link")?.textContent).toBe("Section");
    expect(container?.querySelector('[data-rendered-link="#target"]')).toBeNull();
    expect(container?.querySelector('[data-markdown-preview-state="preview"]')).toBeTruthy();

    act(() => {
      editorView().focus();
      editorView().dispatch({ selection: { anchor: 7 } });
    });
    await flushReact();
    expect(container?.querySelector('[data-markdown-preview-state="source"]')).toBeTruthy();
    expect(container?.textContent).toContain("[Section](#target)");
  });

  it("opens an ordinary preview link on a modifier click or keyboard Enter", async () => {
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Read [OpenAI](https://openai.com)."
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const link = container?.querySelector<HTMLElement>("[data-markdown-link-href]");
    const click = new MouseEvent("click", {
      button: 0,
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
    });
    act(() => {
      expect(link?.dispatchEvent(click)).toBe(false);
    });

    expect(anchorClick).toHaveBeenCalledTimes(1);
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      link?.focus();
      expect(link?.dispatchEvent(enter)).toBe(false);
    });
    expect(anchorClick).toHaveBeenCalledTimes(2);
    anchorClick.mockRestore();
  });

  it("keeps canonical Rudder and skill references atomic inside an active source block", async () => {
    const markdown = "Assign [Ada](agent://agent-1) and [$review](/skills/review/SKILL.md).";
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={markdown}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({ selection: { anchor: 1 } });
    });
    await flushReact();

    expect(container?.querySelectorAll('[data-markdown-atomic-reference="true"]')).toHaveLength(2);
    expect(container?.textContent).not.toContain("agent://agent-1");
    expect(ref.current?.getMarkdown?.()).toBe(markdown);
  });

  it("emits one navigation callback when an atomic reference receives a pointer sequence", async () => {
    const onInlineTokenClick = vi.fn();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Assign [Ada](agent://agent-1)."
          onChange={() => undefined}
          onInlineTokenClick={onInlineTokenClick}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({ selection: { anchor: 1 } });
    });
    await flushReact();

    const atomicLink = container?.querySelector<HTMLAnchorElement>(
      '[data-markdown-atomic-reference="true"] [data-rendered-link="agent://agent-1"]',
    );
    const atomicPointerDown = new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    const atomicPointerUp = new MouseEvent("mouseup", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      atomicLink?.dispatchEvent(atomicPointerDown);
      atomicLink?.dispatchEvent(atomicPointerUp);
    });
    expect(atomicPointerDown.defaultPrevented).toBe(true);
    expect(onInlineTokenClick).toHaveBeenCalledTimes(1);
  });

  it("keeps a clicked Rudder token atomic without revealing its block source", async () => {
    const onInlineTokenClick = vi.fn();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Assign [Ada](agent://agent-1)."
          onChange={() => undefined}
          onInlineTokenClick={onInlineTokenClick}
        />,
      );
    });
    await flushReact();

    const token = container?.querySelector<HTMLAnchorElement>(
      '[data-markdown-preview-state="preview"] [data-rendered-link="agent://agent-1"]',
    );
    const pointerDown = new MouseEvent("mousedown", {
      button: 0,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      token?.dispatchEvent(pointerDown);
      token?.dispatchEvent(new MouseEvent("click", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(pointerDown.defaultPrevented).toBe(true);
    expect(onInlineTokenClick).toHaveBeenCalledTimes(1);
    expect(container?.querySelector(
      '[data-markdown-preview-state="preview"]',
    )).toBeTruthy();
    expect(container?.querySelector(
      '[data-markdown-preview-state="source"]',
    )).toBeNull();
  });

  it("uses the default app navigation for a Rudder token without a surface callback", async () => {
    window.history.replaceState({}, "", "/acme/library");
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Assign [Ada](agent://agent-1)."
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const token = container?.querySelector<HTMLAnchorElement>(
      '[data-rendered-link="agent://agent-1"]',
    );
    act(() => {
      token?.dispatchEvent(new MouseEvent("click", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/acme/agents/agent-1",
    );
  });

  it("activates a non-anchor skill token exactly once", async () => {
    const onInlineTokenClick = vi.fn();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Use [$review](/skills/review/SKILL.md)."
          onChange={() => undefined}
          onInlineTokenClick={onInlineTokenClick}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({ selection: { anchor: 1 } });
    });
    await flushReact();

    const atomicHost = container?.querySelector<HTMLElement>(
      '[data-markdown-atomic-reference="true"]',
    );
    const token = atomicHost?.querySelector<HTMLElement>("[data-skill-token='true']");
    expect(token).toBeTruthy();
    act(() => {
      token?.dispatchEvent(new MouseEvent("click", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onInlineTokenClick).toHaveBeenCalledTimes(1);
    expect(onInlineTokenClick.mock.calls[0]?.[0]).toMatchObject({
      href: "/skills/review/SKILL.md",
      kind: "skill",
      label: "review",
    });
  });

  it("resolves duplicate skill labels by their source position", async () => {
    const onInlineTokenClick = vi.fn();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Use [$review](/skills/first/SKILL.md) then [$review](/skills/second/SKILL.md)."
          onChange={() => undefined}
          onInlineTokenClick={onInlineTokenClick}
        />,
      );
    });
    await flushReact();

    const tokens = container?.querySelectorAll<HTMLElement>("[data-skill-token='true']");
    expect(tokens).toHaveLength(2);
    act(() => {
      tokens?.[1]?.dispatchEvent(new MouseEvent("click", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onInlineTokenClick).toHaveBeenCalledTimes(1);
    expect(onInlineTokenClick.mock.calls[0]?.[0]).toMatchObject({
      href: "/skills/second/SKILL.md",
      kind: "skill",
      label: "review",
    });
  });

  it("renders a known skill token with its direct details target", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Use [$review](/skills/review/SKILL.md)."
          onChange={() => undefined}
          mentions={[{
            id: "skill:review",
            kind: "skill",
            name: "review",
            skillRefLabel: "$review",
            skillMarkdownTarget: "/skills/review/SKILL.md",
            skillDetailsHref: "/library?skill=review&skillFile=SKILL.md",
          }]}
        />,
      );
    });
    await flushReact();

    expect(container?.querySelector<HTMLAnchorElement>(
      'a[data-skill-token="true"]',
    )?.getAttribute("href")).toBe(
      "/library?skill=review&skillFile=SKILL.md",
    );
  });

  it("navigates a historical organization skill token without loaded mention metadata", async () => {
    window.history.replaceState({}, "", "/acme/issues/issue-1");
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value="Use [$review](skill://org/skill-123?ref=review)."
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const token = container?.querySelector<HTMLElement>(
      '[data-markdown-preview-state="preview"] [data-skill-token="true"]',
    );
    expect(token?.tabIndex).toBe(0);
    expect(token?.getAttribute("role")).toBe("link");
    act(() => {
      token?.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(`${window.location.pathname}${window.location.search}`).toBe(
      "/acme/library?skill=skill-123&skillFile=SKILL.md",
    );
    expect(container?.querySelector('[data-markdown-preview-state="source"]')).toBeNull();
  });

  it("uses Rudder's custom mention menu and refreshes async Library results", async () => {
    const onMentionQueryChange = vi.fn();
    let controlledValue = "";
    const renderEditor = (mentions: Array<{
      id: string;
      kind: "library_file";
      name: string;
      libraryFilePath: string;
    }>) => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={controlledValue}
          onChange={(nextValue) => {
            controlledValue = nextValue;
          }}
          mentions={mentions}
          onMentionQueryChange={onMentionQueryChange}
        />,
      );
    };
    act(() => {
      renderEditor([]);
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({
        changes: { from: 0, insert: "@brief" },
        selection: { anchor: 6 },
        userEvent: "input.type",
      });
    });
    await flushReact();
    expect(onMentionQueryChange).toHaveBeenLastCalledWith("brief");
    expect(document.querySelector('[data-testid="markdown-mention-menu"]')).toBeNull();

    act(() => {
      renderEditor([{
        id: "library_file:docs/brief.md",
        kind: "library_file",
        name: "brief.md",
        libraryFilePath: "docs/brief.md",
      }]);
    });
    await flushReact();

    const option = document.querySelector<HTMLElement>(
      '[data-testid="markdown-mention-option-library_file:docs/brief.md"]',
    );
    expect(
      document.querySelector('[data-testid="markdown-mention-menu"]')
        ?.classList.contains("pointer-events-auto"),
    ).toBe(true);
    expect(option).toBeTruthy();
    act(() => {
      option?.dispatchEvent(new MouseEvent("mousedown", {
        button: 0,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(controlledValue).toBe(
      "[brief.md](library-file://file?p=docs%2Fbrief.md) ",
    );
    expect(document.querySelector('[data-testid="markdown-mention-menu"]')).toBeNull();
  });

  it("connects the source editor to its active mention option with listbox semantics", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value=""
          onChange={() => undefined}
          mentions={[
            {
              id: "skill:browser",
              kind: "skill",
              name: "browser",
              skillDisplayName: "browser",
              skillCategoryLabel: "Org skill",
              skillDescription: "A deliberately long description that should not become the option name.",
              skillMarkdownTarget: "skill://browser",
            },
            {
              id: "agent:agent-1",
              kind: "agent",
              name: "Agent One",
              agentId: "agent-1",
            },
          ]}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({
        changes: { from: 0, insert: "@" },
        selection: { anchor: 1 },
        userEvent: "input.type",
      });
    });
    await flushReact();

    const content = editorView().contentDOM;
    const menu = document.querySelector<HTMLElement>(
      '[data-testid="markdown-mention-menu"]',
    );
    const firstOption = document.querySelector<HTMLElement>(
      '[data-testid="markdown-mention-option-skill:browser"]',
    );
    const initiallyActiveOption = menu?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    expect(menu?.getAttribute("role")).toBe("listbox");
    expect(menu?.id).toBeTruthy();
    expect(menu?.getAttribute("aria-label")).toBe("Reference suggestions");
    expect(content.getAttribute("aria-autocomplete")).toBe("list");
    expect(content.getAttribute("aria-expanded")).toBe("true");
    expect(content.getAttribute("aria-controls")).toBe(menu?.id);
    expect(content.getAttribute("aria-activedescendant")).toBe(initiallyActiveOption?.id);
    expect(firstOption?.getAttribute("aria-label")).toBe("browser, Org skill");
    expect(firstOption?.getAttribute("aria-label")).not.toContain("deliberately long");

    act(() => {
      content.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    const nextActiveOption = menu?.querySelector<HTMLElement>(
      '[role="option"][aria-selected="true"]',
    );
    expect(nextActiveOption?.id).not.toBe(initiallyActiveOption?.id);
    expect(content.getAttribute("aria-activedescendant")).toBe(nextActiveOption?.id);

    let escapeHandled = true;
    act(() => {
      escapeHandled = content.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(escapeHandled).toBe(false);
    expect(document.querySelector('[data-testid="markdown-mention-menu"]')).toBeNull();
    expect(content.getAttribute("aria-expanded")).toBe("false");
    expect(content.hasAttribute("aria-controls")).toBe(false);
    expect(content.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("accepts the active mention on Tab and preserves Shift+Tab focus navigation", async () => {
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <>
          <button data-testid="before-editor">Before</button>
          <CodeMirrorMarkdownEditor
            value=""
            onChange={onChange}
            mentions={[
              {
                id: "agent:agent-1",
                kind: "agent",
                name: "Agent One",
                agentId: "agent-1",
              },
            ]}
          />
          <button data-testid="after-editor">After</button>
        </>,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({
        changes: { from: 0, insert: "@" },
        selection: { anchor: 1 },
        userEvent: "input.type",
      });
    });
    await flushReact();
    expect(document.querySelector('[data-testid="markdown-mention-menu"]')).toBeTruthy();
    const changesBeforeTab = onChange.mock.calls.length;

    act(() => {
      editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(document.querySelector('[data-testid="markdown-mention-menu"]')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(changesBeforeTab + 1);
    expect(editorView().state.doc.toString()).toBe(
      "[Agent One](agent://agent-1) ",
    );
    expect(document.activeElement).toBe(editorView().contentDOM);

    act(() => {
      editorView().dispatch({
        changes: {
          from: editorView().state.doc.length,
          insert: "@a",
        },
        selection: {
          anchor: editorView().state.doc.length + 2,
        },
        userEvent: "input.type",
      });
    });
    await flushReact();
    expect(document.querySelector('[data-testid="markdown-mention-menu"]')).toBeTruthy();

    act(() => {
      editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(document.activeElement).toBe(
      container?.querySelector('[data-testid="before-editor"]'),
    );
  });

  it("indents and outdents Markdown list items with Tab without moving focus", async () => {
    act(() => {
      root?.render(
        <>
          <button data-testid="before-editor">Before</button>
          <CodeMirrorMarkdownEditor
            value={"- first\n- second"}
            onChange={() => undefined}
          />
          <button data-testid="after-editor">After</button>
        </>,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({
        selection: { anchor: editorView().state.doc.length },
      });
      editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(editorView().state.doc.toString()).toBe("- first\n  - second");
    expect(document.activeElement).toBe(editorView().contentDOM);

    act(() => {
      editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();
    expect(editorView().state.doc.toString()).toBe("- first\n    - second");

    act(() => {
      editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(editorView().state.doc.toString()).toBe("- first\n  - second");

    act(() => {
      editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(editorView().state.doc.toString()).toBe("- first\n- second");
    expect(document.activeElement).toBe(editorView().contentDOM);
  });

  it("does not indent mixed paragraph and list selections in either direction", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={"paragraph\n- item"}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    for (const selection of [
      { anchor: 0, head: editorView().state.doc.length },
      { anchor: editorView().state.doc.length, head: 0 },
    ]) {
      act(() => {
        editorView().dispatch({ selection });
        editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
          key: "Tab",
          bubbles: true,
          cancelable: true,
        }));
      });
      await flushReact();
      expect(editorView().state.doc.toString()).toBe("paragraph\n- item");
    }
  });

  it("removes transient Setext heading styling as a list marker becomes text", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value=""
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    for (const text of ["keyi", "\n", "-", " asd", "\n", "-", " asd", "\n", "-"]) {
      act(() => {
        const end = editorView().state.doc.length;
        editorView().dispatch({
          changes: { from: end, insert: text },
          selection: { anchor: end + text.length },
          userEvent: "input.type",
        });
      });
      await flushReact();
    }

    const lines = container?.querySelectorAll<HTMLElement>(".cm-line");
    expect(lines?.[0]?.dataset.markdownSourceKind).toBe("line");
    expect(lines?.[0]?.dataset.markdownSourceHeadingLevel).toBe("none");
    expect(lines?.[1]?.dataset.markdownSourceKind).toBe("list");
    expect(lines?.[2]?.dataset.markdownSourceKind).toBe("list");

    act(() => {
      editorView().dispatch({
        changes: {
          from: 0,
          to: editorView().state.doc.length,
          insert: "",
        },
        selection: { anchor: 0 },
        userEvent: "delete.selection",
      });
    });
    await flushReact();

    const emptyLine = container?.querySelector<HTMLElement>(".cm-line");
    expect(emptyLine?.dataset.markdownSourceHeadingLevel).toBe("none");
    expect(emptyLine?.dataset.markdownThematicBreak).toBe("false");
  });

  it("keeps listbox semantics when mention suggestions use container placement", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value=""
          onChange={() => undefined}
          mentionMenuPlacement="container"
          mentions={[
            {
              id: "agent:agent-1",
              kind: "agent",
              name: "Agent One",
              agentId: "agent-1",
            },
          ]}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().focus();
      editorView().dispatch({
        changes: { from: 0, insert: "@" },
        selection: { anchor: 1 },
        userEvent: "input.type",
      });
    });
    await flushReact();

    const content = editorView().contentDOM;
    const activeId = content.getAttribute("aria-activedescendant");
    const activeOption = activeId ? document.getElementById(activeId) : null;
    expect(content.getAttribute("aria-expanded")).toBe("true");
    expect(activeOption?.getAttribute("role")).toBe("option");
    expect(activeOption?.getAttribute("aria-selected")).toBe("true");
  });

  it("does not rebuild or stringify the preview document for selection-only transactions", () => {
    const state = EditorState.create({ doc: "# Heading\nParagraph" });
    const document = getMarkdownPreviewDocument(state.doc.toString());
    const transaction = state.update({ selection: { anchor: 4 } });
    const toString = vi.spyOn(transaction.state.doc, "toString");

    expect(previewDocumentForTransaction(document, transaction)).toBe(document);
    expect(toString).not.toHaveBeenCalled();
  });

  it("wraps a pasted URL, upgrades the provisional label safely, and undoes as one edit", async () => {
    let resolveMetadata!: (value: {
      url: string;
      siteName: string | null;
      pageTitle: string | null;
      iconUrl: string | null;
    }) => void;
    websiteMetadataMocks.get.mockReturnValue(new Promise((resolve) => {
      resolveMetadata = resolve;
    }));
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(clipboardEvent("https://github.com/openai/codex"));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("[GitHub](https://github.com/openai/codex)");
    expect(websiteMetadataMocks.get).toHaveBeenCalledWith(
      "https://github.com/openai/codex",
      "authoring",
    );

    await act(async () => {
      resolveMetadata({
        url: "https://github.com/openai/codex",
        siteName: "GitHub",
        pageTitle: "openai/codex",
        iconUrl: null,
      });
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe("[openai/codex](https://github.com/openai/codex)");
    expect(ref.current?.undo?.()).toBe(true);
    expect(ref.current?.getMarkdown?.()).toBe("");
    expect(ref.current?.redo?.()).toBe(true);
    expect(ref.current?.getMarkdown?.()).toBe("[openai/codex](https://github.com/openai/codex)");
    expect(onChange).toHaveBeenCalled();
  });

  it("does not add a title-enrichment undo step after a later user edit", async () => {
    const url = "https://undo.example.test/article";
    let resolveMetadata!: (value: {
      url: string;
      siteName: string | null;
      pageTitle: string | null;
      iconUrl: string | null;
    }) => void;
    websiteMetadataMocks.get.mockReturnValue(new Promise((resolve) => {
      resolveMetadata = resolve;
    }));
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(clipboardEvent(url));
      const end = editorView().state.doc.length;
      editorView().dispatch({
        changes: { from: end, insert: "!" },
        selection: { anchor: end + 1 },
        annotations: isolateHistory.of("before"),
        userEvent: "input.type",
      });
    });
    await act(async () => {
      resolveMetadata({
        url,
        siteName: "Undo",
        pageTitle: "Undo-safe title",
        iconUrl: null,
      });
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe(`[Undo-safe title](${url})!`);
    expect(ref.current?.undo?.()).toBe(true);
    expect(ref.current?.getMarkdown?.()).toBe(`[undo.example.test](${url})`);
    expect(ref.current?.undo?.()).toBe(true);
    expect(ref.current?.getMarkdown?.()).toBe("");
  });

  it("wraps selected source immediately and does not fetch authoring metadata", async () => {
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="Read this"
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().dispatch({ selection: { anchor: 0, head: 9 } });
      editorView().contentDOM.dispatchEvent(clipboardEvent("https://example.com/a_(b)"));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("[Read this](https://example.com/a_\\(b\\))");
    expect(websiteMetadataMocks.get).not.toHaveBeenCalled();
  });

  it("reuses authoring metadata for repeated exact URL pastes", async () => {
    const url = "https://cache.example.test/article";
    websiteMetadataMocks.get.mockResolvedValue({
      url,
      siteName: "Cache Example",
      pageTitle: "Cached Article",
      iconUrl: null,
    });
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(clipboardEvent(url));
    });
    await flushReact();
    await vi.waitFor(() => {
      expect(ref.current?.getMarkdown?.()).toBe(`[Cached Article](${url})`);
    });

    act(() => {
      const view = editorView();
      const end = view.state.doc.length;
      view.dispatch({
        changes: { from: end, insert: "\n" },
        selection: { anchor: end + 1 },
      });
      editorView().contentDOM.dispatchEvent(clipboardEvent(url));
    });
    await flushReact();
    await vi.waitFor(() => {
      expect(ref.current?.getMarkdown?.()).toBe(
        `[Cached Article](${url})\n[Cached Article](${url})`,
      );
    });

    expect(websiteMetadataMocks.get).toHaveBeenCalledTimes(1);
  });

  it("upgrades multiple pending URL pastes independently when titles resolve out of order", async () => {
    const resolvers = new Map<string, (value: {
      url: string;
      siteName: string | null;
      pageTitle: string | null;
      iconUrl: string | null;
    }) => void>();
    websiteMetadataMocks.get.mockImplementation((url: string) => (
      new Promise((resolve) => {
        resolvers.set(url, resolve);
      })
    ));
    const firstUrl = "https://first.example.test/article";
    const secondUrl = "https://second.example.test/article";
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(clipboardEvent(firstUrl));
      const end = editorView().state.doc.length;
      editorView().dispatch({
        changes: { from: end, insert: "\n" },
        selection: { anchor: end + 1 },
      });
      editorView().contentDOM.dispatchEvent(clipboardEvent(secondUrl));
    });
    await flushReact();

    await act(async () => {
      resolvers.get(secondUrl)?.({
        url: secondUrl,
        siteName: null,
        pageTitle: "Second title",
        iconUrl: null,
      });
      await Promise.resolve();
      resolvers.get(firstUrl)?.({
        url: firstUrl,
        siteName: null,
        pageTitle: "First title",
        iconUrl: null,
      });
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe(
      `[First title](${firstUrl})\n[Second title](${secondUrl})`,
    );
  });

  it("does not emit changes or rebuild history for controlled value synchronization", async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="first"
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={"  exact\nvalue\n"}
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("  exact\nvalue\n");
    expect(onChange).not.toHaveBeenCalled();
    expect(ref.current?.undo?.()).toBe(false);
  });

  it("preserves CRLF source when reading and editing a controlled document", async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={"alpha\r\nbeta\r\n"}
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("alpha\r\nbeta\r\n");
    act(() => {
      editorView().dispatch({
        changes: { from: 5, insert: "!" },
      });
    });
    await flushReact();
    expect(ref.current?.getMarkdown?.()).toBe("alpha!\r\nbeta\r\n");
    expect(onChange).toHaveBeenLastCalledWith("alpha!\r\nbeta\r\n");
  });

  it("preserves mixed LF and CRLF delimiters instead of normalizing the document", async () => {
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={"alpha\r\nbeta\ngamma\r\n"}
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("alpha\r\nbeta\ngamma\r\n");
    act(() => {
      editorView().dispatch({
        changes: { from: 5, insert: "!" },
      });
    });
    await flushReact();
    expect(ref.current?.getMarkdown?.()).toBe("alpha!\r\nbeta\ngamma\r\n");
    expect(onChange).toHaveBeenLastCalledWith(
      "alpha!\r\nbeta\ngamma\r\n",
    );
  });

  it("does not let a delayed page title overwrite a label edited after paste", async () => {
    let resolveMetadata!: (value: {
      url: string;
      siteName: string | null;
      pageTitle: string | null;
      iconUrl: string | null;
    }) => void;
    websiteMetadataMocks.get.mockReturnValue(new Promise((resolve) => {
      resolveMetadata = resolve;
    }));
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(clipboardEvent("https://github.com/openai/codex"));
      editorView().dispatch({
        changes: { from: 1, to: 7, insert: "My label" },
      });
    });

    await act(async () => {
      resolveMetadata({
        url: "https://github.com/openai/codex",
        siteName: "GitHub",
        pageTitle: "openai/codex",
        iconUrl: null,
      });
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe("[My label](https://github.com/openai/codex)");
  });

  it("cancels delayed title enrichment after an edit is reverted", async () => {
    const url = "https://reverted.example.test/article";
    let resolveMetadata!: (value: {
      url: string;
      siteName: string | null;
      pageTitle: string | null;
      iconUrl: string | null;
    }) => void;
    websiteMetadataMocks.get.mockReturnValue(new Promise((resolve) => {
      resolveMetadata = resolve;
    }));
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(clipboardEvent(url));
      editorView().dispatch({ changes: { from: 1, to: 22, insert: "changed" } });
      editorView().dispatch({ changes: { from: 1, to: 8, insert: "reverted.example.test" } });
    });

    await act(async () => {
      resolveMetadata({
        url,
        siteName: "Reverted",
        pageTitle: "Stale title",
        iconUrl: null,
      });
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe(`[reverted.example.test](${url})`);
  });

  it("cancels a delayed page-title upgrade when the document identity changes", async () => {
    const url = "https://identity.example.test/article";
    let resolveMetadata!: (value: {
      url: string;
      siteName: string | null;
      pageTitle: string | null;
      iconUrl: string | null;
    }) => void;
    websiteMetadataMocks.get.mockReturnValue(new Promise((resolve) => {
      resolveMetadata = resolve;
    }));
    const onChange = vi.fn();
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          documentIdentity="document-a"
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(clipboardEvent(url));
    });
    await flushReact();
    const provisionalMarkdown = `[identity.example.test](${url})`;
    expect(ref.current?.getMarkdown?.()).toBe(provisionalMarkdown);

    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={provisionalMarkdown}
          documentIdentity="document-b"
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    await act(async () => {
      resolveMetadata({
        url,
        siteName: "Identity",
        pageTitle: "Stale title",
        iconUrl: null,
      });
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe(provisionalMarkdown);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("starts a new undo history when the document identity changes", async () => {
    const ref = createRef<MarkdownEditorRef>();
    const onChange = vi.fn();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="Document A"
          documentIdentity="document-a"
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    act(() => {
      editorView().dispatch({
        changes: { from: editorView().state.doc.length, insert: " edited" },
      });
    });
    expect(ref.current?.getMarkdown?.()).toBe("Document A edited");
    expect(ref.current?.canUndo?.()).toBe(true);

    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="Document B"
          documentIdentity="document-b"
          onChange={onChange}
        />,
      );
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("Document B");
    expect(ref.current?.canUndo?.()).toBe(false);
    act(() => {
      ref.current?.undo?.();
    });
    expect(ref.current?.getMarkdown?.()).toBe("Document B");
  });

  it("leaves URL paste literal inside inline code", async () => {
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="`code`"
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().dispatch({ selection: { anchor: 3 } });
      editorView().contentDOM.dispatchEvent(clipboardEvent("https://example.com"));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("`cohttps://example.comde`");
    expect(websiteMetadataMocks.get).not.toHaveBeenCalled();
  });

  it("does not wrap a selection that spans existing Markdown syntax", async () => {
    const source = "Keep [Existing](https://example.com) tail";
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={source}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().dispatch({ selection: { anchor: 0, head: source.length } });
      editorView().contentDOM.dispatchEvent(
        clipboardEvent("https://replacement.example.test"),
      );
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("https://replacement.example.test");
    expect(websiteMetadataMocks.get).not.toHaveBeenCalled();
  });

  it("leaves URL paste literal inside inert raw HTML source", async () => {
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="<div>placeholder</div>"
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().dispatch({ selection: { anchor: 5, head: 16 } });
      editorView().contentDOM.dispatchEvent(clipboardEvent("https://example.com"));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe(
      "<div>https://example.com</div>",
    );
    expect(websiteMetadataMocks.get).not.toHaveBeenCalled();
  });

  it("preserves the uploaded image filename in generated Markdown", async () => {
    const ref = createRef<MarkdownEditorRef>();
    const upload = vi.fn().mockResolvedValue("/api/assets/image/content");
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
          imageUploadHandler={upload}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(
        imageClipboardEvent(new File(["image"], "library-screenshot.png", {
          type: "image/png",
        })),
      );
    });
    await vi.waitFor(() => {
      expect(ref.current?.getMarkdown?.()).toBe(
        "![library-screenshot.png](/api/assets/image/content)",
      );
    });
  });

  it("pastes multiple images in clipboard order as one undoable edit", async () => {
    const ref = createRef<MarkdownEditorRef>();
    const resolvers = new Map<string, (url: string) => void>();
    const upload = vi.fn((file: File) => new Promise<string>((resolve) => {
      resolvers.set(file.name, resolve);
    }));
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
          imageUploadHandler={upload}
        />,
      );
    });
    await flushReact();

    const files = [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["second"], "second.png", { type: "image/png" }),
      new File(["third"], "third.png", { type: "image/png" }),
    ];
    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(imageClipboardEvent(files));
    });
    expect(upload).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolvers.get("third.png")?.("/api/assets/third/content");
      resolvers.get("first.png")?.("/api/assets/first/content");
      resolvers.get("second.png")?.("/api/assets/second/content");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe([
      "![first.png](/api/assets/first/content)",
      "![second.png](/api/assets/second/content)",
      "![third.png](/api/assets/third/content)",
    ].join("\n"));
    expect(container?.querySelector('img[alt="first.png"]')).toBeTruthy();
    expect(container?.querySelector('img[alt="second.png"]')).toBeTruthy();
    expect(container?.querySelector('img[alt="third.png"]')).toBeTruthy();
    expect(container?.textContent).not.toContain("![third.png]");

    act(() => ref.current?.undo?.());
    await flushReact();
    expect(ref.current?.getMarkdown?.()).toBe("");
  });

  it("keeps successful images in clipboard order when part of a multi-image paste fails", async () => {
    const ref = createRef<MarkdownEditorRef>();
    const uploads = new Map<string, {
      reject: (error: Error) => void;
      resolve: (url: string) => void;
    }>();
    const upload = vi.fn((file: File) => new Promise<string>((resolve, reject) => {
      uploads.set(file.name, { reject, resolve });
    }));
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
          imageUploadHandler={upload}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(imageClipboardEvent([
        new File(["first"], "first.png", { type: "image/png" }),
        new File(["broken"], "broken.png", { type: "image/png" }),
        new File(["third"], "third.png", { type: "image/png" }),
      ]));
    });

    await act(async () => {
      uploads.get("first.png")?.resolve("/api/assets/first.png/content");
      uploads.get("broken.png")?.reject(new Error("Upload unavailable"));
      uploads.get("third.png")?.resolve("/api/assets/third.png/content");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(ref.current?.getMarkdown?.()).toBe([
      "![first.png](/api/assets/first.png/content)",
      "![third.png](/api/assets/third.png/content)",
    ].join("\n"));
    expect(container?.textContent).toContain("1 of 3 images failed to upload. Upload unavailable");
  });

  it("maps a pending image replacement through edits made before upload completes", async () => {
    let resolveUpload!: (url: string) => void;
    const upload = vi.fn(() => new Promise<string>((resolve) => {
      resolveUpload = resolve;
    }));
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value="aaa TARGET zzz"
          onChange={() => undefined}
          imageUploadHandler={upload}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().dispatch({ selection: { anchor: 4, head: 10 } });
      editorView().contentDOM.dispatchEvent(
        imageClipboardEvent(new File(["image"], "evidence.png", {
          type: "image/png",
        })),
      );
      editorView().dispatch({
        changes: { from: 0, insert: "prefix " },
      });
    });
    await act(async () => {
      resolveUpload("/api/assets/evidence/content");
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe(
      "prefix aaa ![evidence.png](/api/assets/evidence/content) zzz",
    );
  });

  it("keeps an empty image-paste anchor stable when typing continues before upload completes", async () => {
    let resolveUpload!: (url: string) => void;
    const upload = vi.fn(() => new Promise<string>((resolve) => {
      resolveUpload = resolve;
    }));
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value=""
          onChange={() => undefined}
          imageUploadHandler={upload}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(
        imageClipboardEvent(new File(["image"], "evidence.png", {
          type: "image/png",
        })),
      );
      editorView().dispatch({
        changes: { from: 0, insert: "caption" },
        selection: { anchor: 7 },
      });
    });
    await act(async () => {
      resolveUpload("/api/assets/evidence/content");
      await Promise.resolve();
    });

    expect(ref.current?.getMarkdown?.()).toBe(
      "![evidence.png](/api/assets/evidence/content)caption",
    );
  });

  it("deletes an atomic reference as one source operation", async () => {
    const markdown = "[Ada](agent://agent-1)";
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={markdown}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().dispatch({ selection: { anchor: markdown.length } });
      editorView().contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Backspace",
        bubbles: true,
        cancelable: true,
      }));
    });
    await flushReact();

    expect(ref.current?.getMarkdown?.()).toBe("");
  });

  it("does not recalculate the active block during IME composition", async () => {
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          ref={ref}
          value={"first\nsecond"}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    act(() => {
      ref.current?.focus();
      editorView().contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      editorView().dispatch({
        changes: {
          from: editorView().state.doc.length,
          insert: "\nthird",
        },
        selection: { anchor: editorView().state.doc.length + "\nthird".length },
      });
    });
    await flushReact();

    expect(container?.querySelector(
      '[data-markdown-preview-state="source"][data-source-line-start="1"]',
    )).toBeTruthy();
    expect(container?.querySelector(
      '[data-markdown-preview-state="preview"][data-source-line-start="2"]',
    )).toBeTruthy();

    act(() => {
      editorView().dispatch({
        changes: {
          from: editorView().state.doc.length,
          insert: " composed",
        },
        selection: { anchor: editorView().state.doc.length + " composed".length },
      });
    });
    await flushReact();

    expect(container?.querySelector(
      '[data-markdown-preview-state="source"][data-source-line-start="1"]',
    )).toBeTruthy();
    expect(container?.querySelector(
      '[data-markdown-preview-state="preview"][data-source-line-start="2"]',
    )).toBeTruthy();

    act(() => {
      editorView().contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    await flushReact();

    expect(container?.querySelector(
      '[data-markdown-preview-state="source"][data-source-line-start="3"]',
    )).toBeTruthy();
    expect(editorView().state.doc.toString()).toBe("first\nsecond\nthird composed");
  });

  it("shows raw HTML as source without creating executable elements", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={'<img src="bad" onerror="alert(1)">'}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    expect(container?.querySelector('[data-markdown-preview-state="source"]')).toBeTruthy();
    expect(container?.querySelector("img")).toBeNull();
    expect(editorView().state.doc.toString()).toContain("onerror");
  });

  it("reveals an outline line through the imperative source-line API", async () => {
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <div data-markdown-scroll-container="true">
          <CodeMirrorMarkdownEditor
            ref={ref}
            value={"# One\nparagraph\n## Three"}
            onChange={() => undefined}
          />
        </div>,
      );
    });
    await flushReact();
    const scrollContainer = container?.querySelector<HTMLElement>(
      '[data-markdown-scroll-container="true"]',
    );
    expect(scrollContainer).toBeTruthy();
    if (scrollContainer) {
      scrollContainer.scrollTop = 10;
      Object.defineProperty(scrollContainer, "clientHeight", {
        configurable: true,
        value: 200,
      });
      Object.defineProperty(scrollContainer, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          x: 0,
          y: 20,
          width: 800,
          height: 200,
          top: 20,
          right: 800,
          bottom: 220,
          left: 0,
          toJSON: () => undefined,
        }),
      });
    }
    const thirdLine = editorView().dom.querySelectorAll<HTMLElement>(".cm-line")[2];
    expect(thirdLine).toBeTruthy();
    if (thirdLine) {
      Object.defineProperty(thirdLine, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          x: 0,
          y: 200,
          width: 800,
          height: 20,
          top: 200,
          right: 800,
          bottom: 220,
          left: 0,
          toJSON: () => undefined,
        }),
      });
    }

    act(() => {
      ref.current?.revealLine?.(3);
    });
    await flushReact();

    expect(container?.querySelector(
      '[data-markdown-preview-state="source"][data-source-line-start="3"]',
    )).toBeTruthy();
    expect(editorView().state.selection.main.head).toBe(
      editorView().state.doc.line(3).from,
    );
    expect(scrollIntoViewMock).toHaveBeenCalledWith({
      block: "start",
      inline: "nearest",
    });
    expect(scrollContainer?.scrollTop).toBe(190);
    expect(editorView().contentDOM.style.paddingBottom).toBe("200px");
  });

  it("does not pull the cursor back when the user edits before outline alignment", async () => {
    const ref = createRef<MarkdownEditorRef>();
    act(() => {
      root?.render(
        <div data-markdown-scroll-container="true">
          <CodeMirrorMarkdownEditor
            ref={ref}
            value={"# One\nparagraph\n## Three"}
            onChange={() => undefined}
          />
        </div>,
      );
    });
    await flushReact();

    const frameCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frameCallbacks.push(callback);
      return frameCallbacks.length;
    });
    act(() => {
      ref.current?.revealLine?.(3);
    });
    const revealPosition = editorView().state.doc.line(3).from;
    act(() => {
      editorView().dispatch({
        changes: { from: revealPosition, insert: "X" },
        selection: { anchor: revealPosition + 1 },
        userEvent: "input",
      });
    });
    act(() => {
      frameCallbacks.splice(0).forEach((callback) => callback(0));
      frameCallbacks.splice(0).forEach((callback) => callback(0));
    });
    await flushReact();

    expect(editorView().state.doc.line(3).text).toBe("X## Three");
    expect(editorView().state.selection.main.head).toBe(revealPosition + 1);
  });

  it("restores the line hover menu and applies its action to the source block", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={"# Heading\n\nParagraph"}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const paragraph = editorView().dom.querySelector<HTMLElement>(
      '[data-source-line-start="3"]',
    );
    expect(paragraph).toBeTruthy();
    act(() => {
      paragraph?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await flushReact();

    const trigger = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="markdown-block-menu-trigger"]',
    );
    expect(trigger).toBeTruthy();
    expect(trigger?.getAttribute("aria-label")).toBe("Open block actions for line 3");
    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    const menu = document.body.querySelector<HTMLElement>(
      '[data-testid="markdown-block-menu"]',
    );
    expect(menu).toBeTruthy();
    expect(menu?.querySelectorAll("[role='menuitem']")).toHaveLength(8);
    expect(menu?.querySelector<HTMLButtonElement>(
      '[data-markdown-block-action="headline"]',
    )?.disabled).toBe(false);
    act(() => {
      menu?.querySelector<HTMLButtonElement>(
        '[data-markdown-block-action="headline"]',
      )?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flushReact();

    expect(editorView().state.doc.toString()).toBe("# Heading\n\n## Paragraph");
    expect(document.body.querySelector('[data-testid="markdown-block-menu"]')).toBeNull();
  });

  it("formats the whole list block when hovering an inner line", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={"- first\n1. second\n\n```ts\nconst value = 1;\n```"}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const hoverAndClick = async (lineNumber: string, action: string) => {
      const line = editorView().dom.querySelector<HTMLElement>(
        `[data-source-line-start="${lineNumber}"]`,
      );
      expect(line).toBeTruthy();
      act(() => {
        line?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      });
      await flushReact();
      const trigger = document.body.querySelector<HTMLButtonElement>(
        '[data-testid="markdown-block-menu-trigger"]',
      );
      expect(trigger).toBeTruthy();
      act(() => {
        trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flushReact();
      const option = document.body.querySelector<HTMLButtonElement>(
        `[data-markdown-block-action="${action}"]`,
      );
      expect(option?.disabled).toBe(false);
      act(() => {
        option?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flushReact();
    };

    await hoverAndClick("2", "number-list");
    expect(editorView().state.doc.toString()).toBe(
      "1. first\n1. second\n\n```ts\nconst value = 1;\n```",
    );
  });

  it("clamps vertical cursor movement when preview widgets skip source lines", async () => {
    act(() => {
      root?.render(
        <CodeMirrorMarkdownEditor
          value={"# Heading\n\nParagraph\n"}
          onChange={() => undefined}
        />,
      );
    });
    await flushReact();

    const view = editorView();
    act(() => {
      view.focus();
      view.dispatch({ selection: { anchor: view.state.doc.line(2).from } });
    });
    const verticalMove = vi.spyOn(view, "moveVertically");
    verticalMove.mockImplementation((_range, forward) => EditorSelection.cursor(
      view.state.doc.line(forward ? 4 : 1).from,
    ));

    act(() => {
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);

    act(() => {
      view.dispatch({ selection: { anchor: view.state.doc.line(4).from } });
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
        key: "ArrowUp",
        bubbles: true,
        cancelable: true,
      }));
    });
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(3);
  });
});
