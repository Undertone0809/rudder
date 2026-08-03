// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  CHAT_ANNOTATION_BLOCK_ATTRIBUTE,
  CHAT_ANNOTATION_IGNORE_ATTRIBUTE,
  CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
  hashChatAnnotationSource,
  resolveChatAnnotationRange,
  restoreChatAnnotationRange,
  shouldAutoFocusChatAnnotationToolbar,
} from "./chat-response-annotation-selection";

const sourceHash = "b".repeat(64);

function sourceRoot(sourceId: string, blockId: string) {
  const root = document.createElement("div");
  root.setAttribute(CHAT_ANNOTATION_SOURCE_ATTRIBUTE, sourceId);
  root.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, blockId);
  return root;
}

describe("chat response annotation selection", () => {
  it("autofocuses annotation actions only for keyboard range selection", () => {
    expect(shouldAutoFocusChatAnnotationToolbar(
      new KeyboardEvent("keyup", { key: "ArrowRight", shiftKey: true }),
    )).toBe(true);
    expect(shouldAutoFocusChatAnnotationToolbar(
      new KeyboardEvent("keyup", { key: "End", shiftKey: true }),
    )).toBe(true);
    expect(shouldAutoFocusChatAnnotationToolbar(
      new KeyboardEvent("keyup", { key: "ArrowRight" }),
    )).toBe(false);
    expect(shouldAutoFocusChatAnnotationToolbar(new MouseEvent("mouseup"))).toBe(false);
    expect(shouldAutoFocusChatAnnotationToolbar(new TouchEvent("touchend"))).toBe(false);
  });

  it("hashes the persisted raw source with SHA-256", async () => {
    await expect(hashChatAnnotationSource("hello")).resolves.toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("maps a precise CJK selection across Markdown links and inline code to source offsets", () => {
    const source = "这是 **Rudder**，查看 [文档](https://rudder.dev) 与 `inline code`。";
    const root = sourceRoot("assistant:message-1", "message-1");
    root.innerHTML = "这是 <strong>Rudder</strong>，查看 <a>文档</a> 与 <code>inline code</code>。";
    document.body.appendChild(root);

    const linkText = root.querySelector("a")!.firstChild!;
    const codeText = root.querySelector("code")!.firstChild!;
    const range = document.createRange();
    range.setStart(linkText, 0);
    range.setEnd(codeText, "inline code".length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
      contextLength: 6,
    })).toEqual({
      selectedText: "文档 与 inline code",
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
      sourceHash,
      start: source.indexOf("文档"),
      end: source.indexOf("inline code") + "inline code".length,
      prefix: source.slice(Math.max(0, source.indexOf("文档") - 6), source.indexOf("文档")),
      suffix: source.slice(
        source.indexOf("inline code") + "inline code".length,
        source.indexOf("inline code") + "inline code".length + 6,
      ),
    });

    root.remove();
  });

  it("uses Markdown source spans to map decoded HTML entities", () => {
    const source = "Before &amp; after.";
    const root = sourceRoot("assistant:message-entity", "message-entity");
    const paragraph = document.createElement("p");
    paragraph.dataset.markdownSourceStart = "0";
    paragraph.dataset.markdownSourceEnd = String(source.length);
    paragraph.textContent = "Before & after.";
    root.append(paragraph);
    document.body.appendChild(root);

    const text = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(text, "Before ".length);
    range.setEnd(text, "Before &".length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "&",
      start: source.indexOf("&amp;"),
      end: source.indexOf("&amp;") + "&amp;".length,
    });

    root.remove();
  });

  it("uses endpoint source spans without requiring layout wrappers to map to Markdown", () => {
    const source = "第一段包含链接。\n\n- 第一项";
    const root = sourceRoot("assistant:message-layout", "message-layout");
    const layout = document.createElement("div");
    const nestedLayout = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.dataset.markdownSourceStart = "0";
    paragraph.dataset.markdownSourceEnd = String(source.indexOf("\n\n"));
    paragraph.textContent = "第一段包含链接。";
    nestedLayout.append(paragraph);
    layout.append(nestedLayout);
    root.append(layout);
    document.body.appendChild(root);

    const text = paragraph.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "第一段包含".length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "第一段包含",
      start: 0,
      end: "第一段包含".length,
    });

    root.remove();
  });

  it("uses the nearest Markdown source span for repeated emphasized text", () => {
    const source = "repeat outside and **repeat repeat**";
    const root = sourceRoot("assistant:message-repeat", "message-repeat");
    const paragraph = document.createElement("p");
    paragraph.dataset.markdownSourceStart = "0";
    paragraph.dataset.markdownSourceEnd = String(source.length);
    paragraph.append("repeat outside and ");
    const strong = document.createElement("strong");
    strong.dataset.markdownSourceStart = String(source.indexOf("**repeat"));
    strong.dataset.markdownSourceEnd = String(source.length);
    strong.textContent = "repeat repeat";
    paragraph.append(strong);
    root.append(paragraph);
    document.body.appendChild(root);

    const text = strong.firstChild!;
    const range = document.createRange();
    range.setStart(text, "repeat ".length);
    range.setEnd(text, "repeat repeat".length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "repeat",
      start: source.lastIndexOf("repeat"),
      end: source.lastIndexOf("repeat") + "repeat".length,
    });

    root.remove();
  });

  it("restores a source range to its exact rendered endpoint across Markdown nodes", () => {
    const source = "Prefix **selected** and [linked text](https://rudder.dev).";
    const root = sourceRoot("assistant:message-restore", "message-restore");
    const paragraph = document.createElement("p");
    paragraph.dataset.markdownSourceStart = "0";
    paragraph.dataset.markdownSourceEnd = String(source.length);
    paragraph.append("Prefix ");
    const strong = document.createElement("strong");
    strong.dataset.markdownSourceStart = String(source.indexOf("**selected**"));
    strong.dataset.markdownSourceEnd = String(source.indexOf("**selected**") + "**selected**".length);
    strong.textContent = "selected";
    const link = document.createElement("a");
    link.dataset.markdownSourceStart = String(source.indexOf("[linked text]"));
    link.dataset.markdownSourceEnd = String(source.length - 1);
    link.textContent = "linked text";
    paragraph.append(strong, " and ", link, ".");
    root.append(paragraph);
    document.body.appendChild(root);

    const restored = restoreChatAnnotationRange({
      sourceRoot: root,
      source,
      start: source.indexOf("selected"),
      end: source.indexOf("linked text") + "linked text".length,
    });

    expect(restored?.toString()).toBe("selected and linked text");
    root.remove();
  });

  it("carries process generation provenance for a valid same-block selection", () => {
    const source = "Thinking about the edge case.";
    const root = sourceRoot("process:message-1:generation-1:4:6", "transcript-block-4-6");
    root.textContent = source;
    document.body.appendChild(root);
    const text = root.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "process_transcript",
      transcriptKind: "thinking",
      generationId: "30000000-0000-4000-8000-000000000001",
      generationSeqStart: 4,
      generationSeqEnd: 6,
    })).toMatchObject({
      selectedText: "Thinking",
      transcriptKind: "thinking",
      generationId: "30000000-0000-4000-8000-000000000001",
      generationSeqStart: 4,
      generationSeqEnd: 6,
    });

    root.remove();
  });

  it("allows a final-answer selection across paragraphs and list items in one message", () => {
    const source = "First paragraph.\n\n- 第一项\n- 第二项";
    const root = sourceRoot("assistant:message-3", "message-3");
    const paragraph = document.createElement("p");
    paragraph.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "markdown-paragraph");
    paragraph.textContent = "First paragraph.";
    const list = document.createElement("ul");
    const firstItem = document.createElement("li");
    firstItem.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "markdown-list-item-1");
    firstItem.textContent = "第一项";
    const secondItem = document.createElement("li");
    secondItem.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "markdown-list-item-2");
    secondItem.textContent = "第二项";
    list.append(firstItem, secondItem);
    root.append(paragraph, list);
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(paragraph.firstChild!, "First ".length);
    range.setEnd(secondItem.firstChild!, "第二项".length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "paragraph.\n第一项\n第二项",
      start: source.indexOf("paragraph."),
      end: source.length,
    });

    root.remove();
  });

  it("drops an unselected block separator when a range ends at the next block", () => {
    const source = "## Heading\n\nBody";
    const root = sourceRoot("assistant:message-boundary", "message-boundary");
    const heading = document.createElement("h2");
    heading.dataset.markdownSourceStart = "0";
    heading.dataset.markdownSourceEnd = "10";
    heading.textContent = "Heading";
    const paragraph = document.createElement("p");
    paragraph.dataset.markdownSourceStart = "12";
    paragraph.dataset.markdownSourceEnd = String(source.length);
    paragraph.textContent = "Body";
    root.append(heading, paragraph);
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(heading.firstChild!, 0);
    range.setEnd(paragraph.firstChild!, 0);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "Heading",
      start: 3,
      end: 10,
    });

    root.remove();
  });

  it("drops the list separator when a range ends at the next ordered item", () => {
    const source = "1. 第一项\n2. 第二项";
    const root = sourceRoot("assistant:message-ordered-boundary", "ordered-boundary");
    const list = document.createElement("ol");
    const first = document.createElement("li");
    first.dataset.markdownSourceStart = "0";
    first.dataset.markdownSourceEnd = "6";
    first.textContent = "第一项";
    const second = document.createElement("li");
    second.dataset.markdownSourceStart = "7";
    second.dataset.markdownSourceEnd = String(source.length);
    second.textContent = "第二项";
    list.append(first, second);
    root.append(list);
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(second.firstChild!, 0);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "第一项",
      start: 3,
      end: 6,
    });

    root.remove();
  });

  it("rejects collapsed and cross-source ranges", () => {
    const first = sourceRoot("assistant:message-1", "block-1");
    const second = sourceRoot("assistant:message-2", "block-2");
    first.textContent = "First";
    second.textContent = "Second";
    document.body.append(first, second);

    const collapsed = document.createRange();
    collapsed.setStart(first.firstChild!, 1);
    collapsed.collapse(true);
    expect(resolveChatAnnotationRange({
      range: collapsed,
      sourceRoot: first,
      source: "First",
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toBeNull();

    const crossSource = document.createRange();
    crossSource.setStart(first.firstChild!, 0);
    crossSource.setEnd(second.firstChild!, 3);
    expect(resolveChatAnnotationRange({
      range: crossSource,
      sourceRoot: first,
      source: "First",
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toBeNull();

    first.remove();
    second.remove();
  });

  it("rejects a process selection across transcript provenance blocks", () => {
    const nestedBlocks = sourceRoot("process:message-3", "message-3");
    const blockOne = document.createElement("span");
    blockOne.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "nested-1");
    blockOne.textContent = "One";
    const blockTwo = document.createElement("span");
    blockTwo.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "nested-2");
    blockTwo.textContent = "Two";
    nestedBlocks.append(blockOne, blockTwo);
    document.body.appendChild(nestedBlocks);
    const crossBlock = document.createRange();
    crossBlock.setStart(blockOne.firstChild!, 0);
    crossBlock.setEnd(blockTwo.firstChild!, 3);
    expect(resolveChatAnnotationRange({
      range: crossBlock,
      sourceRoot: nestedBlocks,
      source: "OneTwo",
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "process_transcript",
      transcriptKind: "thinking",
      generationId: "30000000-0000-4000-8000-000000000001",
      generationSeqStart: 4,
      generationSeqEnd: 6,
    })).toBeNull();

    nestedBlocks.remove();
  });

  it("rejects a final-answer range that spans an ignored inline visual subtree", () => {
    const source = "Before visual after";
    const root = sourceRoot("assistant:message-visual", "message-visual");
    const before = document.createTextNode("Before ");
    const visual = document.createElement("iframe");
    visual.setAttribute(CHAT_ANNOTATION_IGNORE_ATTRIBUTE, "true");
    const after = document.createTextNode(" after");
    root.append(before, visual, after);
    document.body.appendChild(root);
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, after.textContent!.length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toBeNull();

    root.remove();
  });
});
