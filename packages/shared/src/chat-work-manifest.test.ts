import { describe, expect, it } from "vitest";
import {
  extractVisibleChatWorkTargets,
  normalizeChatWorkExternalUrl,
  preferChatWorkManifestCategory,
} from "./chat-work-manifest.js";

describe("chat work manifest extraction", () => {
  it("extracts visible markdown and bare links and deduplicates canonical URLs", () => {
    expect(extractVisibleChatWorkTargets([
      "Read the [Google guide](https://Developers.Google.com:443/search/docs/guide#overview).",
      "The same guide is https://developers.google.com/search/docs/guide#details.",
      "Also inspect https://example.com/path?q=one.",
    ].join("\n"))).toEqual([
      {
        targetType: "external_url",
        targetKey: "url:https://developers.google.com/search/docs/guide",
        title: "Google guide",
        url: "https://developers.google.com/search/docs/guide",
        metadata: { hostname: "developers.google.com" },
      },
      {
        targetType: "external_url",
        targetKey: "url:https://example.com/path?q=one",
        title: "example.com",
        url: "https://example.com/path?q=one",
        metadata: { hostname: "example.com" },
      },
    ]);
  });

  it("excludes code, image markdown, unsafe schemes, and trailing prose punctuation", () => {
    expect(extractVisibleChatWorkTargets([
      "`https://hidden.example/inline`",
      "```text\nhttps://hidden.example/fenced\n```",
      "![preview](https://images.example/preview.png)",
      "[mail](mailto:test@example.com)",
      "Visible: https://visible.example/report).",
    ].join("\n"))).toEqual([
      {
        targetType: "external_url",
        targetKey: "url:https://visible.example/report",
        title: "visible.example",
        url: "https://visible.example/report",
        metadata: { hostname: "visible.example" },
      },
    ]);
  });

  it("extracts Library entry and file targets with readable titles", () => {
    expect(extractVisibleChatWorkTargets([
      "[Research report](library-entry://entry-1?p=artifacts%2F2026-07-12%2Fresearch%2Freport.md)",
      "[Project brief](library-file://file?p=projects%2Frudder%2Fbrief.md)",
    ].join("\n"))).toEqual([
      {
        targetType: "library_entry",
        targetKey: "library-entry:entry-1:artifacts/2026-07-12/research/report.md",
        title: "Research report",
        url: null,
        metadata: {
          entryId: "entry-1",
          filePath: "artifacts/2026-07-12/research/report.md",
        },
      },
      {
        targetType: "library_file",
        targetKey: "library-file:projects/rudder/brief.md",
        title: "Project brief",
        url: null,
        metadata: { filePath: "projects/rudder/brief.md" },
      },
    ]);
  });

  it("extracts visible Rudder entity references", () => {
    expect(extractVisibleChatWorkTargets([
      "[ZST-772](issue://issue-1?r=ZST-772&c=comment-1)",
      "[Daily report](automation://automation-1?t=Daily%20report)",
      "[Planning chat](chat://chat-1?messageId=message-1)",
      "`[Hidden](issue://issue-hidden)`",
    ].join("\n"))).toEqual([
      {
        targetType: "issue_comment",
        targetKey: "issue-comment:issue-1:comment-1",
        title: "ZST-772",
        url: null,
        metadata: { issueId: "issue-1", ref: "ZST-772", commentId: "comment-1" },
      },
      {
        targetType: "automation",
        targetKey: "automation:automation-1",
        title: "Daily report",
        url: null,
        metadata: { automationId: "automation-1" },
      },
      {
        targetType: "chat_conversation",
        targetKey: "chat:chat-1:message-1",
        title: "Planning chat",
        url: null,
        metadata: { conversationId: "chat-1", messageId: "message-1" },
      },
    ]);
  });

  it("normalizes only HTTP(S) URLs and removes fragments and default ports", () => {
    expect(normalizeChatWorkExternalUrl("HTTPS://Example.COM:443/a/../guide?q=1#part")).toBe(
      "https://example.com/guide?q=1",
    );
    expect(normalizeChatWorkExternalUrl("http://Example.COM:80/")).toBe("http://example.com/");
    expect(normalizeChatWorkExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeChatWorkExternalUrl("https://user:secret@example.com/private")).toBeNull();
  });

  it("uses output then source then reference category precedence", () => {
    expect(preferChatWorkManifestCategory("reference", "source")).toBe("source");
    expect(preferChatWorkManifestCategory("source", "output")).toBe("output");
    expect(preferChatWorkManifestCategory("output", "reference")).toBe("output");
  });
});
