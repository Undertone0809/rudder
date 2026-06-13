// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";
import {
  applyMention,
  hasRudderMarkdownReference,
  insertMissingRudderTokenBoundarySpaces,
  insertTextAfterRudderTokenBoundary,
  isMilkdownEditableUnexpectedlyBlank,
  isRudderTokenHref,
  milkdownMentionDecorationAttrs,
  mentionMarkdown,
  moveSelectionAfterRudderTokenBoundary,
  readCanonicalFragmentMarkdown,
  rudderTokenNavigationPath,
  shouldActivateMilkdownInlineTokenClick,
  shouldParsePastedMarkdown,
} from "./MilkdownMarkdownEditor";
import type { MentionOption } from "./MarkdownEditor";

describe("isMilkdownEditableUnexpectedlyBlank", () => {
  it("detects a non-empty markdown document whose editable DOM came back empty", () => {
    const editable = document.createElement("div");
    editable.append(document.createElement("p"));

    expect(isMilkdownEditableUnexpectedlyBlank(editable, "# HEARTBEAT.md\n\nContent")).toBe(true);
  });

  it("does not repair intentionally empty documents", () => {
    const editable = document.createElement("div");

    expect(isMilkdownEditableUnexpectedlyBlank(editable, "   \n")).toBe(false);
  });

  it("does not repair when visible text or media content is present", () => {
    const textEditable = document.createElement("div");
    textEditable.textContent = "HEARTBEAT.md";
    expect(isMilkdownEditableUnexpectedlyBlank(textEditable, "# HEARTBEAT.md")).toBe(false);

    const mediaEditable = document.createElement("div");
    mediaEditable.append(document.createElement("img"));
    expect(isMilkdownEditableUnexpectedlyBlank(mediaEditable, "![diagram](diagram.png)")).toBe(false);
  });
});

describe("MilkdownMarkdownEditor mention serialization", () => {
  it("keeps canonical Rudder mention markdown for all mention kinds", () => {
    const options: Array<{ option: MentionOption; expected: string }> = [
      {
        option: {
          id: "agent:agent-1",
          name: "Jade",
          kind: "agent",
          agentId: "agent-1",
          agentIcon: "bot",
        },
        expected: `[Jade](${buildAgentMentionHref("agent-1", "bot")}) `,
      },
      {
        option: {
          id: "issue:issue-1",
          name: "R-6",
          kind: "issue",
          issueId: "issue-1",
          issueIdentifier: "R-6",
        },
        expected: `[R-6](${buildIssueMentionHref("issue-1", "R-6")}) `,
      },
      {
        option: {
          id: "project:project-1",
          name: "Editor Migration",
          kind: "project",
          projectId: "project-1",
          projectColor: "#4f46e5",
        },
        expected: `[Editor Migration](${buildProjectMentionHref("project-1", "#4f46e5")}) `,
      },
      {
        option: {
          id: "chat:chat-1",
          name: "Launch planning",
          kind: "chat",
          chatConversationId: "chat-1",
          chatTitle: "Launch planning",
        },
        expected: `[Launch planning](${buildChatMentionHref("chat-1", "Launch planning")}) `,
      },
      {
        option: {
          id: "library-doc:doc-1",
          name: "Milkdown proposal",
          kind: "library_doc",
          libraryDocumentId: "doc-1",
          libraryDocumentTitle: "Milkdown proposal",
        },
        expected: `[Milkdown proposal](${buildLibraryDocMentionHref("doc-1", "Milkdown proposal")}) `,
      },
      {
        option: {
          id: "library-file:docs/editor.md",
          name: "docs/editor.md",
          kind: "library_file",
          libraryFilePath: "docs/editor.md",
        },
        expected: `[docs/editor.md](${buildLibraryFileMentionHref("docs/editor.md", "docs/editor.md")}) `,
      },
      {
        option: {
          id: "library-directory:projects/rudder-mkt",
          name: "Rudder marketing",
          kind: "library_directory",
          libraryDirectoryPath: "projects/rudder-mkt",
        },
        expected: `[Rudder marketing](${buildLibraryDirectoryMentionHref("projects/rudder-mkt", "Rudder marketing")}) `,
      },
      {
        option: {
          id: "skill:writer",
          name: "Writer",
          kind: "skill",
          skillRefLabel: "$writer",
          skillMarkdownTarget: "skill://writer",
        },
        expected: "[$writer](skill://writer) ",
      },
    ];

    for (const { option, expected } of options) {
      expect(mentionMarkdown(option)).toBe(expected);
    }
  });

  it("can serialize selected agent mentions as issue-comment wake requests", () => {
    const option: MentionOption = {
      id: "agent:agent-1",
      name: "Jade",
      kind: "agent",
      agentId: "agent-1",
      agentIcon: "bot",
    };

    expect(mentionMarkdown(option, "wake")).toBe(`[Jade](${buildAgentMentionHref("agent-1", "bot", "wake")}) `);
  });

  it("decorates status-bearing issue mentions with editor status icon attributes", () => {
    const href = buildIssueMentionHref("issue-1", "R-6", null, "todo");
    const attrs = milkdownMentionDecorationAttrs({
      kind: "issue",
      issueId: "issue-1",
      ref: "R-6",
      commentId: null,
      status: "todo",
    }, "R-6", href);

    expect(attrs.class).toContain("rudder-mention-chip--issue");
    expect(attrs.class).toContain("rudder-mention-chip--with-status-icon");
    expect(attrs["data-mention-kind"]).toBe("issue");
    expect(attrs["data-mention-status"]).toBe("todo");
    expect(attrs["data-mention-href"]).toBe(href);
  });

  it("recognizes Rudder mention and skill links as token links", () => {
    expect(isRudderTokenHref("agent://agent-1", "Jade")).toBe(true);
    expect(isRudderTokenHref("issue://issue-1?ref=R-1", "R-1")).toBe(true);
    expect(isRudderTokenHref("chat://chat-1?t=Launch", "Launch")).toBe(true);
    expect(isRudderTokenHref("project://project-1", "Project")).toBe(true);
    expect(isRudderTokenHref("library-doc://doc-1?t=Spec", "Spec")).toBe(true);
    expect(isRudderTokenHref("library-file://file?p=docs%2Fspec.md&t=spec.md", "spec.md")).toBe(true);
    expect(isRudderTokenHref("skill://writer", "$writer")).toBe(true);
    expect(isRudderTokenHref("/workspace/skills/build-advisor/SKILL.md", "$build-advisor")).toBe(true);
    expect(isRudderTokenHref("https://example.com", "Example")).toBe(false);
  });

  it("detects pasted canonical Rudder markdown references", () => {
    expect(hasRudderMarkdownReference("[Winter](agent://agent-1?i=bot)")).toBe(true);
    expect(hasRudderMarkdownReference("[docs-proposal.md](library-file://file?p=docs-proposal.md\\&t=docs-proposal.md)")).toBe(true);
    expect(hasRudderMarkdownReference("[skill-creator](/Users/zeeland/rudder/server/resources/bundled-skills/skill-creator/SKILL.md)")).toBe(true);
    expect(hasRudderMarkdownReference("[Example](https://example.com)")).toBe(false);
  });

  it("detects markdown syntax that should be parsed on paste", () => {
    expect(shouldParsePastedMarkdown("## HEAD2")).toBe(true);
    expect(shouldParsePastedMarkdown("- checklist item")).toBe(true);
    expect(shouldParsePastedMarkdown("```md\n# Context\n```")).toBe(true);
    expect(shouldParsePastedMarkdown("[Winter](agent://agent-1?i=bot)")).toBe(true);
    expect(shouldParsePastedMarkdown("plain sentence")).toBe(false);
  });

  it("replaces the active repeated mention query instead of the last matching text", () => {
    const editable = document.createElement("div");
    const textNode = document.createTextNode("first @dyl second @dyl");
    editable.append(textNode);
    document.body.append(editable);

    const option: MentionOption = {
      id: "agent:agent-1",
      name: "Dylan",
      kind: "agent",
      agentId: "agent-1",
    };
    const markdown = applyMention(
      "first @dyl second @dyl",
      {
        trigger: "@",
        query: "dyl",
        top: 0,
        left: 0,
        viewportTop: 0,
        viewportBottom: 0,
        viewportLeft: 0,
        textNode,
        atPos: 6,
        endPos: 10,
      },
      option,
      editable,
    );

    expect(markdown).toBe(`first [Dylan](${buildAgentMentionHref("agent-1", null)}) second @dyl`);
    editable.remove();
  });

  it("keeps a space between an inserted mention and following plain text", () => {
    const editable = document.createElement("div");
    const textNode = document.createTextNode("@ceo我们");
    editable.append(textNode);
    document.body.append(editable);

    const option: MentionOption = {
      id: "agent:agent-1",
      name: "Griffin (CEO)",
      kind: "agent",
      agentId: "agent-1",
    };

    const markdown = applyMention(
      "@ceo我们",
      {
        trigger: "@",
        query: "ceo",
        top: 0,
        left: 0,
        viewportTop: 0,
        viewportBottom: 0,
        viewportLeft: 0,
        textNode,
        atPos: 0,
        endPos: 4,
      },
      option,
      editable,
    );

    expect(markdown).toBe(`[Griffin (CEO)](${buildAgentMentionHref("agent-1", null)}) 我们`);
    editable.remove();
  });

  it("moves typed text outside a mention when the boundary space was deleted", () => {
    const label = "Griffin (CEO)";
    const inserted: Array<{ pos: number; content: unknown }> = [];
    const tr = {
      delete() {
        return this;
      },
      insert(pos: number, content: unknown) {
        inserted.push({ pos, content });
        return this;
      },
      insertText() {
        return this;
      },
      replaceWith() {
        return this;
      },
      setSelection() {
        return this;
      },
      setStoredMarks() {
        return this;
      },
    };
    const doc = {
      content: { size: label.length },
      descendants(callback: (node: {
        isText?: boolean;
        nodeSize: number;
        text?: string;
        marks?: Array<{ type?: { name?: string }; attrs?: { href?: string | null } }>;
      }, pos: number) => boolean | void) {
        callback({
          isText: true,
          nodeSize: label.length,
          text: label,
          marks: [{ type: { name: "link" }, attrs: { href: "agent://agent-1" } }],
        }, 0);
      },
      textBetween() {
        return "";
      },
    };
    const view = {
      state: {
        doc,
        schema: {
          marks: {},
          text: (text: string) => ({ text, marks: [] }),
        },
        selection: { empty: true, from: label.length, to: label.length },
        tr,
      },
      dispatch: () => undefined,
    };

    expect(insertTextAfterRudderTokenBoundary(view, "我")).toBe(true);
    expect(inserted).toEqual([{ pos: label.length, content: { text: " 我", marks: [] } }]);
  });

  it("restores a missing space after input when text lands next to a mention token", () => {
    const label = "Griffin (CEO)";
    const inserted: Array<{ pos: number; content: unknown }> = [];
    const tr = {
      delete() {
        return this;
      },
      insert(pos: number, content: unknown) {
        inserted.push({ pos, content });
        return this;
      },
      insertText() {
        return this;
      },
      replaceWith() {
        return this;
      },
      setSelection() {
        return this;
      },
      setStoredMarks() {
        return this;
      },
    };
    const doc = {
      content: { size: label.length + 1 },
      descendants(callback: (node: {
        isText?: boolean;
        nodeSize: number;
        text?: string;
        marks?: Array<{ type?: { name?: string }; attrs?: { href?: string | null } }>;
      }, pos: number) => boolean | void) {
        callback({
          isText: true,
          nodeSize: label.length,
          text: label,
          marks: [{ type: { name: "link" }, attrs: { href: "agent://agent-1" } }],
        }, 0);
      },
      textBetween(from: number, to: number) {
        return from === label.length && to === label.length + 1 ? "我" : "";
      },
    };
    const view = {
      state: {
        doc,
        schema: {
          marks: {},
          text: (text: string) => ({ text, marks: [] }),
        },
        selection: { empty: true, from: label.length + 1, to: label.length + 1 },
        tr,
      },
      dispatch: () => undefined,
    };

    expect(insertMissingRudderTokenBoundarySpaces(view)).toBe(true);
    expect(inserted).toEqual([{ pos: label.length, content: { text: " ", marks: [] } }]);
  });

  it("does not insert a boundary space before punctuation typed after a mention", () => {
    const label = "Griffin (CEO)";
    const inserted: Array<{ pos: number; content: unknown }> = [];
    const tr = {
      delete() {
        return this;
      },
      insert(pos: number, content: unknown) {
        inserted.push({ pos, content });
        return this;
      },
      insertText() {
        return this;
      },
      replaceWith() {
        return this;
      },
      setSelection() {
        return this;
      },
      setStoredMarks() {
        return this;
      },
    };
    const doc = {
      content: { size: label.length },
      descendants(callback: (node: {
        isText?: boolean;
        nodeSize: number;
        text?: string;
        marks?: Array<{ type?: { name?: string }; attrs?: { href?: string | null } }>;
      }, pos: number) => boolean | void) {
        callback({
          isText: true,
          nodeSize: label.length,
          text: label,
          marks: [{ type: { name: "link" }, attrs: { href: "agent://agent-1" } }],
        }, 0);
      },
      textBetween() {
        return "";
      },
    };
    const view = {
      state: {
        doc,
        schema: {
          marks: {},
          text: (text: string) => ({ text, marks: [] }),
        },
        selection: { empty: true, from: label.length, to: label.length },
        tr,
      },
      dispatch: () => undefined,
    };

    expect(insertTextAfterRudderTokenBoundary(view, "，")).toBe(true);
    expect(inserted).toEqual([{ pos: label.length, content: { text: "，", marks: [] } }]);
  });

  it("moves composition input to an editable boundary before the token text changes", () => {
    const label = "Wesley (Engineer)";
    const inserted: Array<{ pos: number; content: unknown }> = [];
    const tr = {
      delete() {
        return this;
      },
      insert(pos: number, content: unknown) {
        inserted.push({ pos, content });
        return this;
      },
      insertText() {
        return this;
      },
      replaceWith() {
        return this;
      },
      setSelection() {
        return this;
      },
      setStoredMarks() {
        return this;
      },
    };
    const doc = {
      content: { size: label.length },
      descendants(callback: (node: {
        isText?: boolean;
        nodeSize: number;
        text?: string;
        marks?: Array<{ type?: { name?: string }; attrs?: { href?: string | null } }>;
      }, pos: number) => boolean | void) {
        callback({
          isText: true,
          nodeSize: label.length,
          text: label,
          marks: [{ type: { name: "link" }, attrs: { href: "agent://agent-1" } }],
        }, 0);
      },
      textBetween() {
        return "";
      },
    };
    const view = {
      state: {
        doc,
        schema: {
          marks: {},
          text: (text: string) => ({ text, marks: [] }),
        },
        selection: { empty: true, from: 1, to: 1 },
        tr,
      },
      dispatch: () => undefined,
    };

    expect(moveSelectionAfterRudderTokenBoundary(view)).toBe(true);
    expect(inserted).toEqual([{ pos: label.length, content: { text: " ", marks: [] } }]);
  });

  it("copies selected Rudder token links as canonical Markdown", () => {
    const fragment = document.createDocumentFragment();
    fragment.append("Ask ");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "agent://agent-1");
    anchor.textContent = "Jade";
    fragment.append(anchor);
    fragment.append(" today");

    expect(readCanonicalFragmentMarkdown(fragment)).toBe("Ask [Jade](agent://agent-1) today");
  });

  it("copies selected list fragments as valid Markdown bullets", () => {
    const fragment = document.createDocumentFragment();
    const list = document.createElement("ul");
    for (const text of [
      "Comment on in_progress work before exiting.",
      "Exit cleanly if no assignments.",
    ]) {
      const item = document.createElement("li");
      item.textContent = text;
      list.append(item);
    }
    const itemWithCode = document.createElement("li");
    itemWithCode.append("Reviewer work is not closed by a free-form accept/reject comment; use ");
    const code = document.createElement("code");
    code.textContent = "rudder issue review";
    itemWithCode.append(code);
    itemWithCode.append(".");
    list.insertBefore(itemWithCode, list.lastChild);
    fragment.append(list);

    expect(readCanonicalFragmentMarkdown(fragment)).toBe([
      "- Comment on in_progress work before exiting.",
      "- Reviewer work is not closed by a free-form accept/reject comment; use `rudder issue review`.",
      "- Exit cleanly if no assignments.",
    ].join("\n"));
  });

  it("copies bare list-item fragments as valid Markdown bullets", () => {
    const fragment = document.createDocumentFragment();
    for (const text of [
      "Comment on in_progress work before exiting.",
      "Exit cleanly if no assignments.",
    ]) {
      const item = document.createElement("li");
      item.textContent = text;
      fragment.append(item);
    }

    expect(readCanonicalFragmentMarkdown(fragment)).toBe([
      "- Comment on in_progress work before exiting.",
      "- Exit cleanly if no assignments.",
    ].join("\n"));
  });

  it("copies bare ordered-list item fragments with ordered markers", () => {
    const fragment = document.createDocumentFragment();
    for (const text of [
      "Read today's plan from memory.",
      "Review planned items.",
    ]) {
      const item = document.createElement("li");
      item.textContent = text;
      fragment.append(item);
    }

    expect(readCanonicalFragmentMarkdown(fragment, { bareListKind: "ordered", bareListStart: 2 })).toBe([
      "2. Read today's plan from memory.",
      "3. Review planned items.",
    ].join("\n"));
  });

  it("preserves canonical Rudder links inside copied list fragments", () => {
    const fragment = document.createDocumentFragment();
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.append("Ask ");
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "agent://agent-1");
    anchor.textContent = "Jade";
    item.append(anchor);
    item.append(" to review.");
    list.append(item);
    fragment.append(list);

    expect(readCanonicalFragmentMarkdown(fragment)).toBe("- Ask [Jade](agent://agent-1) to review.");
  });

  it("preserves ordinary links and emphasis inside copied list fragments", () => {
    const fragment = document.createDocumentFragment();
    const list = document.createElement("ul");
    const item = document.createElement("li");
    const strong = document.createElement("strong");
    strong.textContent = "Read";
    item.append(strong);
    item.append(" the ");
    const link = document.createElement("a");
    link.setAttribute("href", "https://example.com/spec");
    link.textContent = "spec";
    item.append(link);
    item.append(" with ");
    const emphasis = document.createElement("em");
    emphasis.textContent = "care";
    item.append(emphasis);
    item.append(".");
    list.append(item);
    fragment.append(list);

    expect(readCanonicalFragmentMarkdown(fragment)).toBe("- **Read** the [spec](https://example.com/spec) with *care*.");
  });

  it("preserves nested list structure inside copied list fragments", () => {
    const fragment = document.createDocumentFragment();
    const list = document.createElement("ul");
    const item = document.createElement("li");
    item.append("Parent item");
    const nested = document.createElement("ul");
    const nestedItem = document.createElement("li");
    nestedItem.textContent = "Nested item";
    nested.append(nestedItem);
    item.append(nested);
    list.append(item);
    fragment.append(list);

    expect(readCanonicalFragmentMarkdown(fragment)).toBe([
      "- Parent item",
      "  - Nested item",
    ].join("\n"));
  });

  it("resolves special Rudder references to app navigation paths", () => {
    expect(rudderTokenNavigationPath(buildAgentMentionHref("agent-1", "bot"))).toBe("/agents/agent-1");
    expect(rudderTokenNavigationPath(buildIssueMentionHref("issue-1", "R-1"))).toBe("/issues/R-1");
    expect(rudderTokenNavigationPath(buildIssueMentionHref("issue-1", "R-1", "comment-1"))).toBe(
      "/issues/R-1#comment-comment-1",
    );
    expect(rudderTokenNavigationPath(buildLibraryFileMentionHref("docs/spec.md", "spec.md"))).toBe(
      "/library?path=docs%2Fspec.md",
    );
    expect(rudderTokenNavigationPath("skill://writer")).toBeNull();
  });

  it("keeps Milkdown token plain-click activation opt-in", () => {
    expect(shouldActivateMilkdownInlineTokenClick({ ctrlKey: false, metaKey: false })).toBe(false);
    expect(shouldActivateMilkdownInlineTokenClick({ ctrlKey: false, metaKey: true })).toBe(true);
    expect(shouldActivateMilkdownInlineTokenClick({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(shouldActivateMilkdownInlineTokenClick({ ctrlKey: false, metaKey: false }, true)).toBe(true);
  });
});
