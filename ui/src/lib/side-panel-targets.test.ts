import {
  buildAutomationMentionHref,
  buildChatMentionHref,
  buildIssueMentionHref,
  buildLibraryDirectoryMentionHref,
  buildLibraryDocMentionHref,
  buildLibraryEntryMentionHref,
  buildLibraryFileMentionHref,
} from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import {
  sideChatGenerationScopeKey,
  sidePanelFullPageHref,
  sidePanelTargetFromHref,
  sidePanelTargetKey,
  sidePanelTargetSupportsSavedView,
  type SidePanelTarget,
} from "./side-panel-targets";

describe("side panel targets", () => {
  it("parses supported mention hrefs into global side panel targets", () => {
    expect(sidePanelTargetFromHref(buildIssueMentionHref("issue-1", "RUD-1", "comment-1"), "RUD-1")).toEqual({
      kind: "issue",
      issueId: "issue-1",
      ref: "RUD-1",
      commentId: "comment-1",
      label: "RUD-1",
    });
    expect(sidePanelTargetFromHref(buildAutomationMentionHref("automation-1", "Daily report"))).toEqual({
      kind: "automation",
      automationId: "automation-1",
      label: "Daily report",
    });
    expect(sidePanelTargetFromHref(`${buildChatMentionHref("chat-1")}?messageId=message-2`, "Planning chat")).toEqual({
      kind: "chat",
      conversationId: "chat-1",
      messageId: "message-2",
      label: "Planning chat",
    });
    expect(sidePanelTargetFromHref(buildLibraryDocMentionHref("doc-1"), "Runbook")).toEqual({
      kind: "library_document",
      documentId: "doc-1",
      label: "Runbook",
    });
    expect(sidePanelTargetFromHref(buildLibraryEntryMentionHref("entry-1", "Spec", "projects/rudder/spec.md"))).toEqual({
      kind: "library_entry",
      entryId: "entry-1",
      path: "projects/rudder/spec.md",
      label: "projects/rudder/spec.md",
    });
    expect(sidePanelTargetFromHref(buildLibraryFileMentionHref("docs/spec.md"))).toEqual({
      kind: "library_file",
      filePath: "docs/spec.md",
      label: "spec.md",
    });
    expect(sidePanelTargetFromHref(buildLibraryDirectoryMentionHref("docs"))).toEqual({
      kind: "library_directory",
      directoryPath: "docs",
      label: "docs",
    });
  });

  it("parses internal app routes without requiring chat-local state", () => {
    expect(sidePanelTargetFromHref("/automations/automation-1?t=Daily%20report")).toMatchObject({
      kind: "automation",
      automationId: "automation-1",
      label: "Daily report",
    });
    expect(sidePanelTargetFromHref("/issues/issue-1#comment-comment-2", "RUD-1")).toEqual({
      kind: "issue",
      issueId: "issue-1",
      ref: "RUD-1",
      commentId: "comment-2",
      label: "RUD-1",
    });
    expect(sidePanelTargetFromHref("/messenger/chat/chat-1?messageId=message-1")).toMatchObject({
      kind: "chat",
      conversationId: "chat-1",
      messageId: "message-1",
    });
    expect(sidePanelTargetFromHref("/library?document=doc-1&t=Runbook")).toEqual({
      kind: "library_document",
      documentId: "doc-1",
      label: "Runbook",
    });
    expect(sidePanelTargetFromHref("/library?path=docs%2Fspec.md")).toEqual({
      kind: "library_file",
      filePath: "docs/spec.md",
      label: "spec.md",
    });
    expect(sidePanelTargetFromHref("/library?skill=skill-1&skillFile=SKILL.md", "browser")).toEqual({
      kind: "organization_skill_file",
      skillId: "skill-1",
      filePath: "SKILL.md",
      label: "browser",
    });
  });

  it("generates stable keys and full page hrefs", () => {
    expect(sidePanelTargetKey({
      kind: "terminal",
      organizationId: "org-1",
      agentId: "agent-1",
      sessionId: "session-1",
      label: "Terminal",
    })).toBe("terminal:org-1:agent-1:session-1");
    const issueTarget = sidePanelTargetFromHref(buildIssueMentionHref("issue-1", "RUD-1", "comment-1"), "RUD-1")!;
    expect(sidePanelTargetKey(issueTarget)).toBe("issue:issue-1:comment-1");
    expect(sidePanelFullPageHref(issueTarget)).toBe("/issues/issue-1#comment-comment-1");

    const libraryDocumentTarget = sidePanelTargetFromHref(buildLibraryDocMentionHref("doc-1"), "Runbook")!;
    expect(sidePanelTargetKey(libraryDocumentTarget)).toBe("library-document:doc-1");
    expect(sidePanelFullPageHref(libraryDocumentTarget)).toBe("/library?document=doc-1");

    const browserTarget = { kind: "browser", url: "https://example.com", label: "example.com", tabId: "browser-1" } as const;
    expect(sidePanelTargetKey(browserTarget)).toBe("browser-tab:browser-1");
    expect(sidePanelFullPageHref(browserTarget)).toBe("https://example.com");

    const localFileTarget = { kind: "local_file", filePath: "/tmp/evidence.md", label: "evidence.md" } as const;
    expect(sidePanelTargetKey(localFileTarget)).toBe("local-file:/tmp/evidence.md");
    expect(sidePanelFullPageHref(localFileTarget)).toBeNull();

    const issueProposalTarget = {
      kind: "issue_proposal",
      conversationId: "chat-1",
      messageId: "proposal-1",
      label: "Issue proposal",
    } as const;
    expect(sidePanelTargetKey(issueProposalTarget)).toBe("issue-proposal:chat-1:proposal-1");
    expect(sidePanelFullPageHref(issueProposalTarget)).toBeNull();
    expect(sidePanelTargetSupportsSavedView(issueProposalTarget)).toBe(false);

    const subagentsTarget = {
      kind: "subagents",
      conversationId: "chat-1",
      label: "Subagents",
    } as const;
    expect(sidePanelTargetKey(subagentsTarget)).toBe("subagents:chat-1");
    expect(sidePanelFullPageHref(subagentsTarget)).toBeNull();

    const subagentTarget: SidePanelTarget = {
      kind: "subagent",
      callId: "call-2",
      threadId: "thread-shared",
      avatarSeed: "avatar-2",
      label: "Verifier",
      senderLabel: "Main agent",
      prompt: "Verify the work",
      model: "gpt-5.6",
      reasoningEffort: "high",
      status: "running",
      response: null,
      entries: [],
    };
    expect(sidePanelTargetKey(subagentTarget)).toBe("subagent:thread-shared");
    expect(sidePanelTargetKey({ ...subagentTarget, callId: "call-latest", status: "completed" }))
      .toBe("subagent:thread-shared");

    const skillFileTarget = {
      kind: "organization_skill_file",
      skillId: "skill-1",
      filePath: "SKILL.md",
      label: "browser",
    } as const;
    expect(sidePanelTargetKey(skillFileTarget)).toBe("organization-skill-file:skill-1:SKILL.md");
    expect(sidePanelFullPageHref(skillFileTarget)).toBe("/library?skill=skill-1&skillFile=SKILL.md");
    expect(sidePanelTargetSupportsSavedView(skillFileTarget)).toBe(false);

    const issuePlaceholder = { kind: "placeholder", targetKind: "issue", label: "Issue" } as const;
    expect(sidePanelTargetKey(issuePlaceholder)).toBe("placeholder:issue");
    expect(sidePanelFullPageHref(issuePlaceholder)).toBe("/issues");

    const automationPlaceholder = { kind: "placeholder", targetKind: "automation", label: "Automation" } as const;
    expect(sidePanelTargetKey(automationPlaceholder)).toBe("placeholder:automation");
    expect(sidePanelFullPageHref(automationPlaceholder)).toBe("/automations");

    const chatPlaceholder = { kind: "placeholder", targetKind: "chat", label: "Chat" } as const;
    expect(sidePanelTargetKey(chatPlaceholder)).toBe("placeholder:chat");
    expect(sidePanelFullPageHref(chatPlaceholder)).toBe("/messenger/chat");

    const provisionalSideChat = {
      kind: "side_chat",
      sourceConversationId: "chat-1",
      sourceMessageId: "message-1",
      sourcePreview: "Anchored answer",
      conversationId: null,
      clientMutationId: "mutation-1",
      label: "Side Chat",
    } as const;
    expect(sidePanelTargetKey(provisionalSideChat)).toBe("side-chat:draft:chat-1:mutation-1");
    expect(sideChatGenerationScopeKey("org-1", provisionalSideChat)).toBe("side-chat:org-1:chat-1:mutation-1");
    expect(sideChatGenerationScopeKey("org-2", provisionalSideChat)).not.toBe(
      sideChatGenerationScopeKey("org-1", provisionalSideChat),
    );
    expect(sidePanelFullPageHref(provisionalSideChat)).toBe("/messenger/chat/chat-1?messageId=message-1");

    const persistedSideChat = { ...provisionalSideChat, conversationId: "side-chat-1" };
    expect(sidePanelTargetKey(persistedSideChat)).toBe("side-chat:side-chat-1");
    expect(sidePanelFullPageHref(persistedSideChat)).toBe("/messenger/chat/side-chat-1");

    const goalChatDraft = {
      kind: "goal_chat",
      organizationId: "org-1",
      goalId: "goal-1",
      agentId: "agent-1",
      conversationId: null,
      clientMutationId: "goal-chat-mutation-1",
      body: "",
      label: "Ship Goal v2",
    } as const;
    expect(sidePanelTargetKey(goalChatDraft)).toBe("goal-chat:org-1:goal-1");
    expect(sidePanelFullPageHref(goalChatDraft)).toBeNull();
    const goalChatConversation = { ...goalChatDraft, conversationId: "goal-chat-1" };
    expect(sidePanelTargetKey(goalChatConversation)).toBe("goal-chat:org-1:goal-1");
    expect(sidePanelFullPageHref(goalChatConversation)).toBe("/messenger/chat/goal-chat-1");
  });

  it("keeps explicit Saved View instances distinct from the canonical resource", () => {
    const first = {
      kind: "library_file",
      filePath: "docs/spec.md",
      label: "spec.md",
      viewInstanceId: "view-first",
    } as const;
    const second = { ...first, viewInstanceId: "view-second" };

    expect(sidePanelTargetKey(first)).toBe("library-file:docs/spec.md:view:view-first");
    expect(sidePanelTargetKey(second)).toBe("library-file:docs/spec.md:view:view-second");
  });

  it("keeps Local App catalog state separate from collision-free saved view instances", () => {
    const catalog = { kind: "local_apps", label: "Local apps" } as const;
    const first = {
      kind: "local_app",
      desktopInstallationId: "install:a",
      appPublicId: "app%3Apublic",
      localBindingId: "binding/one",
      label: "Command center",
      viewInstanceId: "view-first",
    } as const;
    const second = { ...first, viewInstanceId: "view-second" };

    expect(sidePanelTargetKey(catalog)).toBe("local-apps");
    expect(sidePanelTargetSupportsSavedView(catalog)).toBe(false);
    expect(sidePanelFullPageHref(catalog)).toBeNull();
    expect(sidePanelTargetKey(first)).toBe(
      "local-app:install%3Aa:app%253Apublic:binding%2Fone:view:view-first",
    );
    expect(sidePanelTargetKey(second)).toBe(
      "local-app:install%3Aa:app%253Apublic:binding%2Fone:view:view-second",
    );
    expect(sidePanelTargetSupportsSavedView(first)).toBe(true);
    expect(sidePanelFullPageHref(first)).toBeNull();
  });

  it("ignores unsupported or external hrefs unless they are browser targets", () => {
    expect(sidePanelTargetFromHref("https://example.com")).toBeNull();
    expect(sidePanelTargetFromHref("mailto:hello@example.com")).toBeNull();
    expect(sidePanelTargetFromHref("/unknown/path")).toBeNull();
  });
});
