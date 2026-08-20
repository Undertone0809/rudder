// @vitest-environment jsdom

import { Schema } from "@milkdown/kit/prose/model";
import { EditorState, TextSelection } from "@milkdown/kit/prose/state";
import {
  buildAgentMentionHref,
  buildAutomationMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryFileMentionHref,
  buildProjectMentionHref,
} from "@rudderhq/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __clearWebsiteIconFailureCacheForTests } from "../lib/website-icon-cache";
import { __clearWebsiteMetadataCacheForTests } from "../lib/website-metadata-cache";
import { normalizeRelaxedMarkdownSyntax } from "../lib/markdown-normalize";
import type { MentionOption } from "./MarkdownEditor";
import {
  applyMention,
  createMilkdownWebsiteIconElement,
  fragmentContainsRudderToken,
  getMilkdownProseMirrorView,
  hasRudderMarkdownReference,
  imageFilesFromFileList,
  insertMissingRudderTokenBoundarySpaces,
  insertTextAfterRudderTokenBoundary,
  isMilkdownEditableUnexpectedlyBlank,
  isRudderTokenHref,
  issueMentionsFromMarkdown,
  mentionMarkdown,
  milkdownMentionDecorationAttrs,
  milkdownWebsiteLinkRanges,
  milkdownWebsiteUrlFromHref,
  moveSelectionAfterRudderTokenBoundary,
  readCanonicalFragmentMarkdown,
  refreshMilkdownMentionTokenStyles,
  rudderTokenNavigationPath,
  shouldActivateMilkdownInlineTokenClick,
  shouldCopySelectionAsMarkdown,
  shouldParsePastedMarkdown,
  stabilizeRudderTokenBoundary,
} from "./MilkdownMarkdownEditor";

const websiteMetadataMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("../api/websiteMetadata", () => ({
  websiteMetadataApi: websiteMetadataMocks,
}));

beforeEach(() => {
  websiteMetadataMocks.get.mockReset();
  __clearWebsiteIconFailureCacheForTests();
  __clearWebsiteMetadataCacheForTests();
});

afterEach(() => {
  __clearWebsiteIconFailureCacheForTests();
  __clearWebsiteMetadataCacheForTests();
});

function websiteTextNode(text: string, href: string) {
  return {
    isText: true,
    nodeSize: text.length,
    text,
    marks: [{ type: { name: "link" }, attrs: { href } }],
  };
}

describe("Milkdown website link icons", () => {
  it("accepts displayable HTTP(S) URLs and filters unsafe or same-origin targets", () => {
    expect(milkdownWebsiteUrlFromHref("https://example.com/docs#intro")?.href)
      .toBe("https://example.com/docs#intro");
    expect(milkdownWebsiteUrlFromHref("mailto:hello@example.com")).toBeNull();
    expect(milkdownWebsiteUrlFromHref("http://127.0.0.1:8080/private")?.href)
      .toBe("http://127.0.0.1:8080/private");
    expect(milkdownWebsiteUrlFromHref("https://user:password@example.com/private")).toBeNull();
    expect(milkdownWebsiteUrlFromHref(`${window.location.origin}/issues/R-1`)).toBeNull();
  });

  it("merges adjacent text nodes for one website link and excludes non-website marks", () => {
    const doc = {
      content: { size: 40 },
      descendants(callback: (node: ReturnType<typeof websiteTextNode>, pos: number) => void) {
        callback(websiteTextNode("GitHub", "https://github.com/rudder"), 1);
        callback(websiteTextNode(" docs", "https://github.com/rudder"), 7);
        callback(websiteTextNode("Example", "https://example.com/docs"), 20);
        callback(websiteTextNode("private", "http://127.0.0.1/private"), 28);
        callback(websiteTextNode("R-1", "issue://issue-1?ref=R-1"), 36);
      },
    } as Parameters<typeof milkdownWebsiteLinkRanges>[0];

    expect(milkdownWebsiteLinkRanges(doc)).toEqual([
      { from: 1, to: 12, href: "https://github.com/rudder" },
      { from: 20, to: 27, href: "https://example.com/docs" },
      { from: 28, to: 35, href: "http://127.0.0.1/private" },
    ]);
  });

  it("keeps private links on the generic placeholder without requesting metadata", () => {
    const host = createMilkdownWebsiteIconElement("http://127.0.0.1:8080/private");

    expect(websiteMetadataMocks.get).not.toHaveBeenCalled();
    expect(host.dataset.websiteIcon).toBe("generic");
    expect(host.querySelector("img[src]")).toBeNull();
  });

  it("loads known icons without metadata and keeps a stable generic placeholder until load", () => {
    const host = createMilkdownWebsiteIconElement("https://github.com/rudder");
    const image = host.querySelector<HTMLImageElement>("img.rudder-website-link-logo");

    expect(websiteMetadataMocks.get).not.toHaveBeenCalled();
    expect(host.dataset.websiteIcon).toBe("generic");
    expect(image?.getAttribute("src")).toMatch(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u);
    expect(image?.style.visibility).toBe("hidden");

    image?.dispatchEvent(new Event("load"));

    expect(host.dataset.websiteIcon).toBe("metadata");
    expect(image?.style.visibility).toBe("visible");
  });

  it("falls back to the generic icon and avoids retrying a failed metadata icon", async () => {
    const href = "https://metadata.example.test/article";
    const iconUrl = "/api/website-metadata/icon?url=https%3A%2F%2Fmetadata.example.test%2Ffavicon.ico";
    websiteMetadataMocks.get.mockResolvedValue({
      url: href,
      siteName: "Metadata Example",
      pageTitle: null,
      iconUrl,
    });

    const firstHost = createMilkdownWebsiteIconElement(href);
    await vi.waitFor(() => {
      expect(websiteMetadataMocks.get).toHaveBeenCalledWith(href, "preview");
      expect(firstHost.querySelector("img")?.getAttribute("src")).toBe(iconUrl);
    });
    const firstImage = firstHost.querySelector<HTMLImageElement>("img");
    firstImage?.dispatchEvent(new Event("error"));

    expect(firstHost.dataset.websiteIcon).toBe("generic");
    expect(firstImage?.getAttribute("src")).toBeNull();

    const secondHost = createMilkdownWebsiteIconElement(href);
    await Promise.resolve();
    expect(secondHost.querySelector("img")?.getAttribute("src")).toBeNull();
    expect(websiteMetadataMocks.get).toHaveBeenCalledTimes(1);
  });
});

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

describe("getMilkdownProseMirrorView", () => {
  it("does not throw while Milkdown has not injected editorView yet", () => {
    const ctx = {
      get: () => {
        throw new Error("Context editorView not found");
      },
    };

    expect(getMilkdownProseMirrorView(ctx)).toBeNull();
  });
});

describe("MilkdownMarkdownEditor mention serialization", () => {
  it("extracts unique issue mentions that need live editor metadata", () => {
    const unresolvedHref = buildIssueMentionHref("issue-1", "R-6");
    const secondHref = buildIssueMentionHref("issue-2", "R-7");

    expect(issueMentionsFromMarkdown([
      `[R-6](${unresolvedHref})`,
      `[duplicate](${unresolvedHref})`,
      `[R-7](${secondHref})`,
      "[External](https://example.com)",
    ].join("\n"))).toEqual([
      expect.objectContaining({ issueId: "issue-1", ref: "R-6", status: null }),
      expect.objectContaining({ issueId: "issue-2", ref: "R-7", status: null }),
    ]);
  });

  it("normalizes relaxed markdown before Milkdown parses Library documents", () => {
    expect(normalizeRelaxedMarkdownSyntax([
      "[https://github.com/Undertone0809/rudder/releases?page=5](https://github.com/Undertone0809/rudder/releases?",
      "page=5)",
      "",
      "-[]1",
      "-\\[]1",
    ].join("\n"))).toBe([
      "[https://github.com/Undertone0809/rudder/releases?page=5](https://github.com/Undertone0809/rudder/releases?page=5)",
      "",
      "- [ ] 1",
      "- \\[]1",
    ].join("\n"));
  });

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
          id: "automation:automation-1",
          name: "Daily automation review",
          kind: "automation",
          automationId: "automation-1",
          automationTitle: "Daily automation review",
        },
        expected: `[Daily automation review](${buildAutomationMentionHref("automation-1", "Daily automation review")}) `,
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
    const href = buildIssueMentionHref("issue-1", "R-6", "comment-1", "todo");
    const attrs = milkdownMentionDecorationAttrs({
      kind: "issue",
      issueId: "issue-1",
      ref: "R-6",
      commentId: "comment-1",
      status: "todo",
    }, "R-6", href);

    expect(attrs.class).toContain("rudder-mention-chip--issue");
    expect(attrs.class).toContain("rudder-mention-chip--with-status-icon");
    expect(attrs["data-mention-kind"]).toBe("issue");
    expect(attrs["data-mention-comment"]).toBe("true");
    expect(attrs["data-mention-status"]).toBe("todo");
    expect(attrs["data-mention-href"]).toBe(href);
  });

  it("keeps Milkdown link wrappers transparent when a decoration span renders the mention chip", () => {
    const href = buildIssueMentionHref("issue-1", "R-6", null, "todo");
    const root = document.createElement("div");
    root.innerHTML = [
      `<a href="${href}"`,
      ' class="rudder-mention-chip rudder-mention-chip--issue rudder-mention-chip--with-status-icon"',
      ' data-mention-kind="issue" data-mention-status="todo">',
      '<span class="rudder-mention-chip rudder-mention-chip--issue rudder-mention-chip--with-status-icon"',
      ` data-mention-kind="issue" data-mention-status="todo" data-mention-href="${href}">R-6</span>`,
      "</a>",
    ].join("");
    const wrapper = root.querySelector("a") as HTMLAnchorElement;
    const visualChip = root.querySelector("span") as HTMLSpanElement;

    refreshMilkdownMentionTokenStyles(root, [{
      id: "issue:issue-1",
      name: "R-6 Markdown consistency",
      kind: "issue",
      issueId: "issue-1",
      issueIdentifier: "R-6",
      issueStatus: "blocked",
    }]);

    expect(wrapper.classList.contains("rudder-mention-chip")).toBe(false);
    expect(wrapper.classList.contains("rudder-mention-chip--with-status-icon")).toBe(false);
    expect(wrapper.dataset.mentionKind).toBeUndefined();
    expect(wrapper.dataset.mentionStatus).toBeUndefined();
    expect(visualChip.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
    expect(visualChip.dataset.mentionStatus).toBe("blocked");
  });

  it("refreshes existing issue token status from current mention options", () => {
    const href = buildIssueMentionHref("issue-1", "R-6");
    const root = document.createElement("div");
    root.innerHTML = [
      `<a href="${href}"`,
      ' class="rudder-mention-chip rudder-mention-chip--issue"',
      ' data-mention-kind="issue"',
      ` data-mention-href="${href}">R-6</a>`,
    ].join("");
    const token = root.querySelector("a") as HTMLAnchorElement;

    refreshMilkdownMentionTokenStyles(root, [{
      id: "issue:issue-1",
      name: "R-6 改回 AGENT HOME",
      kind: "issue",
      issueId: "issue-1",
      issueIdentifier: "R-6",
      issueStatus: "blocked",
    }]);

    expect(token.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
    expect(token.dataset.mentionStatus).toBe("blocked");
  });

  it("refreshes existing issue comment token semantics from its canonical href", () => {
    const href = buildIssueMentionHref("issue-1", "R-6", "comment-1");
    const root = document.createElement("div");
    root.innerHTML = [
      `<a href="${href}"`,
      ' class="rudder-mention-chip rudder-mention-chip--issue"',
      ' data-mention-kind="issue"',
      ` data-mention-href="${href}">Issue comment comment-1</a>`,
    ].join("");
    const token = root.querySelector("a") as HTMLAnchorElement;

    refreshMilkdownMentionTokenStyles(root, [{
      id: "issue:issue-1",
      name: "R-6 Markdown consistency",
      kind: "issue",
      issueId: "issue-1",
      issueIdentifier: "R-6",
      issueStatus: "backlog",
    }]);

    expect(token.dataset.mentionComment).toBe("true");
    expect(token.dataset.mentionStatus).toBe("backlog");
    expect(token.classList.contains("rudder-mention-chip--with-status-icon")).toBe(true);
  });

  it("refreshes existing automation token labels from title metadata and current mention options", () => {
    const href = buildAutomationMentionHref("automation-1", "Daily automation review");
    const root = document.createElement("div");
    root.innerHTML = [
      `<a href="${href}"`,
      ' class="rudder-mention-chip rudder-mention-chip--automation"',
      ' data-mention-kind="automation"',
      ` data-mention-href="${href}">0d232c68</a>`,
    ].join("");
    const token = root.querySelector("a") as HTMLAnchorElement;

    refreshMilkdownMentionTokenStyles(root, [{
      id: "automation:automation-1",
      name: "Current daily automation review",
      kind: "automation",
      automationId: "automation-1",
      automationTitle: "Current daily automation review",
      automationStatus: "active",
    }]);

    expect(token.dataset.mentionKind).toBe("automation");
    expect(token.textContent).toBe("Current daily automation review");
    expect(token.classList.contains("rudder-mention-chip--automation")).toBe(true);
  });

  it("removes stale issue status semantics when refreshed options no longer include status", () => {
    const href = buildIssueMentionHref("issue-1", "R-6");
    const root = document.createElement("div");
    root.innerHTML = [
      `<a href="${href}"`,
      ' class="rudder-mention-chip rudder-mention-chip--issue rudder-mention-chip--with-status-icon"',
      ' data-mention-kind="issue"',
      ' data-mention-status="blocked"',
      ` data-mention-href="${href}">R-6</a>`,
    ].join("");
    const token = root.querySelector("a") as HTMLAnchorElement;

    refreshMilkdownMentionTokenStyles(root, []);

    expect(token.dataset.mentionStatus).toBeUndefined();
    expect(token.classList.contains("rudder-mention-chip--with-status-icon")).toBe(false);
  });

  it("recognizes Rudder mention and skill links as token links", () => {
    expect(isRudderTokenHref("agent://agent-1", "Jade")).toBe(true);
    expect(isRudderTokenHref("issue://issue-1?ref=R-1", "R-1")).toBe(true);
    expect(isRudderTokenHref("chat://chat-1?t=Launch", "Launch")).toBe(true);
    expect(isRudderTokenHref("project://project-1", "Project")).toBe(true);
    expect(isRudderTokenHref("library-doc://doc-1?t=Spec", "Spec")).toBe(true);
    expect(isRudderTokenHref("library-file://file?p=docs%2Fspec.md&t=spec.md", "spec.md")).toBe(true);
    expect(isRudderTokenHref("skill://writer", "$writer")).toBe(true);
    expect(isRudderTokenHref("skill://org/skill-1?ref=writer", "")).toBe(true);
    expect(isRudderTokenHref("/workspace/skills/build-advisor/SKILL.md", "$build-advisor")).toBe(true);
    expect(isRudderTokenHref("https://example.com", "Example")).toBe(false);
  });

  it("detects pasted canonical Rudder markdown references", () => {
    expect(hasRudderMarkdownReference("[Winter](agent://agent-1?i=bot)")).toBe(true);
    expect(hasRudderMarkdownReference("[](skill://org/skill-1?ref=build-advisor)")).toBe(true);
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

  it("keeps every image file from a multi-file clipboard payload", () => {
    const first = new File(["first"], "first.png", { type: "image/png" });
    const second = new File(["second"], "second.jpg", { type: "image/jpeg" });
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    const third = new File(["third"], "third.webp", { type: "image/webp" });

    expect(imageFilesFromFileList([first, second, text, third])).toEqual([first, second, third]);
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

  it("keeps the caret outside a Library entry reference before typing continues", () => {
    const label = "product-brief.md";
    const href = "library-entry://entry-1?p=docs%2Fproduct-brief.md";
    let focused = false;
    const schema = new Schema({
      nodes: {
        doc: { content: "paragraph+" },
        paragraph: {
          content: "inline*",
          group: "block",
          toDOM: () => ["p", 0],
        },
        text: { group: "inline" },
      },
      marks: {
        link: {
          attrs: { href: {} },
          toDOM: (mark) => ["a", { href: mark.attrs.href }, 0],
        },
      },
    });
    const link = schema.marks.link.create({ href });
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text(label, [link]),
        schema.text(" "),
      ]),
    ]);
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, label.length + 2),
    });
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: typeof state.tr) {
        state = state.apply(transaction);
      },
      focus: () => {
        focused = true;
      },
    };
    const proseMirrorView = view as unknown as Parameters<typeof stabilizeRudderTokenBoundary>[0];

    expect(stabilizeRudderTokenBoundary(proseMirrorView)).toBe(true);
    expect(state.selection.from).toBe(label.length + 2);
    expect(state.storedMarks).toEqual([]);
    expect(focused).toBe(true);

    expect(insertTextAfterRudderTokenBoundary(proseMirrorView, "继续输入")).toBe(true);
    expect(state.doc.textContent).toBe(`${label} 继续输入`);
    expect(state.doc.firstChild?.firstChild?.text).toBe(label);
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

  it("copies selected decorated skill tokens as canonical Markdown", () => {
    const fragment = document.createDocumentFragment();
    fragment.append("Use ");
    const token = document.createElement("span");
    token.dataset.skillToken = "true";
    token.dataset.skillHref = "skill://org/skill-1?ref=boundary-skill";
    token.textContent = "boundary-skill";
    fragment.append(token);
    fragment.append(" here");

    expect(fragmentContainsRudderToken(fragment)).toBe(true);
    expect(readCanonicalFragmentMarkdown(fragment)).toBe(
      "Use [boundary-skill](skill://org/skill-1?ref=boundary-skill) here",
    );
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

  it("only upgrades multi-line text selections to markdown clipboard text", () => {
    expect(shouldCopySelectionAsMarkdown("Ask Jade today")).toBe(false);
    expect(shouldCopySelectionAsMarkdown("Ask Jade today\n")).toBe(false);
    expect(shouldCopySelectionAsMarkdown("Ask Jade today\n\n")).toBe(false);
    expect(shouldCopySelectionAsMarkdown("Ask Jade today\nReview the plan")).toBe(true);
    expect(shouldCopySelectionAsMarkdown("Ask Jade today\n\nReview the plan")).toBe(true);
  });

  it("resolves special Rudder references to app navigation paths", () => {
    expect(rudderTokenNavigationPath(buildAgentMentionHref("agent-1", "bot"))).toBe("/agents/agent-1");
    expect(rudderTokenNavigationPath(buildIssueMentionHref("issue-1", "R-1"))).toBe("/issues/issue-1");
    expect(rudderTokenNavigationPath(buildIssueMentionHref("issue-1", "R-1", "comment-1"))).toBe(
      "/issues/issue-1#comment-comment-1",
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
