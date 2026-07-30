// @vitest-environment jsdom

import {
  CHAT_FILE_ANNOTATION_REQUEST_EVENT,
  requestChatFileAnnotationLocation,
  type ChatFileAnnotationRequestDetail,
} from "@/lib/chat-file-annotation-events";
import {
  chatAnnotationRenderedTextToSourceSpans,
} from "@/lib/chat-response-annotation-selection";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FileAnnotationSelectionToolbar,
  resolveRenderedFileSelectionRange,
} from "./FileAnnotationSelectionToolbar";

vi.mock("@/lib/chat-response-annotation-selection", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/chat-response-annotation-selection")>(),
  hashChatAnnotationSource: async () => "a".repeat(64),
  shouldAutoFocusChatAnnotationToolbar: () => false,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

describe("FileAnnotationSelectionToolbar", () => {
  it("maps the selected rendered occurrence across repeated Markdown and decoded entities", () => {
    const container = document.createElement("div");
    const first = document.createElement("p");
    first.textContent = "same & ";
    const second = document.createElement("p");
    second.textContent = "same";
    container.append(first, second);
    document.body.appendChild(container);
    const range = document.createRange();
    range.setStart(second.firstChild!, 0);
    range.setEnd(second.firstChild!, 4);
    const source = "**same** &amp;\n\nsame";

    expect(resolveRenderedFileSelectionRange(container, range, source)).toEqual({
      start: source.lastIndexOf("same"),
      end: source.length,
      selectedText: "same",
    });
  });

  it("does not map visible text to the same text inside a hidden link destination", () => {
    const container = document.createElement("div");
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.textContent = "foo";
    const trailingText = document.createTextNode("baz");
    paragraph.append(link, trailingText);
    container.append(paragraph);
    document.body.appendChild(container);
    const range = document.createRange();
    range.setStart(trailingText, 0);
    range.setEnd(trailingText, 3);
    const source = "[foo](baz)baz";

    expect(resolveRenderedFileSelectionRange(container, range, source)).toEqual({
      start: 10,
      end: 13,
      selectedText: "baz",
    });
  });

  it("ignores duplicate text in image destinations when mapping following prose", () => {
    const container = document.createElement("div");
    const paragraph = document.createElement("p");
    const trailingText = document.createTextNode("baz");
    paragraph.append(document.createElement("img"), trailingText);
    container.append(paragraph);
    document.body.appendChild(container);
    const range = document.createRange();
    range.setStart(trailingText, 0);
    range.setEnd(trailingText, 3);
    const source = "![alt](baz)baz";

    expect(resolveRenderedFileSelectionRange(container, range, source)).toEqual({
      start: source.lastIndexOf("baz"),
      end: source.length,
      selectedText: "baz",
    });
  });

  it("maps inline code text after a duplicate link destination", () => {
    const container = document.createElement("div");
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.textContent = "x";
    const code = document.createElement("code");
    code.textContent = "baz";
    paragraph.append(link, " ", code);
    container.append(paragraph);
    document.body.appendChild(container);
    const range = document.createRange();
    range.selectNodeContents(code);
    const source = "[x](baz) `baz`";

    expect(resolveRenderedFileSelectionRange(container, range, source)).toEqual({
      start: source.lastIndexOf("baz"),
      end: source.lastIndexOf("baz") + 3,
      selectedText: "baz",
    });
  });

  it("ignores a duplicate reference-link identifier before following prose", () => {
    const container = document.createElement("div");
    const paragraph = document.createElement("p");
    const link = document.createElement("a");
    link.textContent = "foo";
    const trailingText = document.createTextNode("baz");
    paragraph.append(link, trailingText);
    container.append(paragraph);
    document.body.appendChild(container);
    const range = document.createRange();
    range.setStart(trailingText, 0);
    range.setEnd(trailingText, 3);
    const source = "[foo][baz]baz\n\n[baz]: /url";

    expect(resolveRenderedFileSelectionRange(container, range, source)).toEqual({
      start: 10,
      end: 13,
      selectedText: "baz",
    });
  });

  it("preserves semantic block breaks and excludes frontmatter chrome", () => {
    const container = document.createElement("div");
    const frontmatter = document.createElement("details");
    frontmatter.setAttribute("data-chat-annotation-ignore", "");
    frontmatter.textContent = "Frontmatter title: hidden";
    const first = document.createElement("p");
    first.textContent = "First";
    const second = document.createElement("p");
    second.textContent = "Second";
    container.append(frontmatter, first, second);
    document.body.appendChild(container);
    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(second.firstChild!, 6);
    const prefix = "---\ntitle: hidden\n---\n";
    const body = "First\n\nSecond";

    expect(resolveRenderedFileSelectionRange(
      container,
      range,
      body,
      prefix.length,
    )).toEqual({
      start: prefix.length,
      end: prefix.length + body.length,
      selectedText: "First\nSecond",
    });
  });

  it("emits a canonical workspace-file annotation for an exact source selection", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const containerRef = createRef<HTMLElement>();
    Object.defineProperty(containerRef, "current", { value: container });
    const details: ChatFileAnnotationRequestDetail[] = [];
    window.addEventListener(CHAT_FILE_ANNOTATION_REQUEST_EVENT, (event) => {
      details.push((event as CustomEvent<ChatFileAnnotationRequestDetail>).detail);
    }, { once: true });

    await act(async () => {
      root.render(
        <FileAnnotationSelectionToolbar
          containerRef={containerRef}
          conversationId="conversation-1"
          explicitSelection={{
            start: 6,
            end: 10,
            selectedText: "beta",
            anchorRect: {
              left: 10,
              right: 60,
              top: 20,
              bottom: 40,
              width: 50,
              height: 20,
            },
          }}
          saved
          source="alpha beta gamma"
          sourceIdentity={{
            surface: "workspace_file",
            sourceFilePath: "notes/example.txt",
            sourceLibraryEntryId: "entry-1",
          }}
          sourceRenderMode="text"
        />,
      );
      await Promise.resolve();
    });

    const addButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Add to chat");
    expect(addButton).toBeTruthy();
    act(() => addButton!.click());

    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({
      action: "add_to_chat",
      annotation: {
        surface: "workspace_file",
        sourceConversationId: "conversation-1",
        sourceFilePath: "notes/example.txt",
        sourceLibraryEntryId: "entry-1",
        sourceRenderMode: "text",
        selectedText: "beta",
        start: 6,
        end: 10,
        prefix: "alpha ",
        suffix: " gamma",
      },
    });
    expect(details[0]!.annotation.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not offer annotation actions while the file has unsaved changes", async () => {
    const containerRef = createRef<HTMLElement>();
    Object.defineProperty(containerRef, "current", { value: host });

    await act(async () => {
      root.render(
        <FileAnnotationSelectionToolbar
          containerRef={containerRef}
          conversationId="conversation-1"
          explicitSelection={{
            start: 0,
            end: 5,
            selectedText: "alpha",
            anchorRect: {
              left: 10,
              right: 60,
              top: 20,
              bottom: 40,
              width: 50,
              height: 20,
            },
          }}
          saved={false}
          source="alpha"
          sourceIdentity={{
            surface: "local_file",
            sourceFilePath: "/tmp/example.txt",
          }}
          sourceRenderMode="text"
        />,
      );
      await Promise.resolve();
    });

    expect(document.body.querySelector("[role='toolbar']")).toBeNull();
  });

  it("locates a persisted Markdown range after the source surface mounts", async () => {
    const container = document.createElement("div");
    const first = document.createElement("p");
    first.textContent = "First";
    const second = document.createElement("p");
    second.textContent = "Second";
    container.append(first, second);
    document.body.appendChild(container);
    const containerRef = createRef<HTMLElement>();
    Object.defineProperty(containerRef, "current", { value: container });
    Element.prototype.scrollIntoView = vi.fn();
    const spans = chatAnnotationRenderedTextToSourceSpans(
      "First\nSecond",
      "First\n\nSecond",
    );
    expect(spans[6]).toEqual({ start: 7, end: 8 });
    expect(spans.at(-1)).toEqual({ start: 12, end: 13 });

    requestChatFileAnnotationLocation({
      surface: "workspace_file",
      sourceFilePath: "notes/example.md",
      sourceHash: "a".repeat(64),
      sourceRenderMode: "markdown",
      start: 7,
      end: 13,
    });
    await act(async () => {
      root.render(
        <FileAnnotationSelectionToolbar
          containerRef={containerRef}
          conversationId="conversation-1"
          saved
          source={"First\n\nSecond"}
          sourceIdentity={{
            surface: "workspace_file",
            sourceFilePath: "notes/example.md",
            sourceLibraryEntryId: null,
          }}
          sourceRenderMode="markdown"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.getSelection()?.toString()).toBe("Second");
  });

  it("locates exact text after a Markdown list without adding a container break", async () => {
    const container = document.createElement("div");
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.textContent = "One";
    list.append(item);
    const paragraph = document.createElement("p");
    paragraph.textContent = "After";
    container.append(list, paragraph);
    document.body.appendChild(container);
    const containerRef = createRef<HTMLElement>();
    Object.defineProperty(containerRef, "current", { value: container });
    Element.prototype.scrollIntoView = vi.fn();

    requestChatFileAnnotationLocation({
      surface: "workspace_file",
      sourceFilePath: "notes/list.md",
      sourceHash: "a".repeat(64),
      sourceRenderMode: "markdown",
      start: 7,
      end: 12,
    });
    await act(async () => {
      root.render(
        <FileAnnotationSelectionToolbar
          containerRef={containerRef}
          conversationId="conversation-1"
          saved
          source={"- One\n\nAfter"}
          sourceIdentity={{
            surface: "workspace_file",
            sourceFilePath: "notes/list.md",
            sourceLibraryEntryId: null,
          }}
          sourceRenderMode="markdown"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.getSelection()?.toString()).toBe("After");
  });
});
