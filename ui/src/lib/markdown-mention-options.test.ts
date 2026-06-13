import type { MentionOption } from "@/components/MarkdownEditor";
import { describe, expect, it } from "vitest";
import { buildMarkdownMentionOptions } from "./markdown-mention-options";

describe("buildMarkdownMentionOptions", () => {
  it("orders @ mention categories as agents, skills, projects, issues, then chats", () => {
    const skillOption: MentionOption = {
      id: "skill:build-advisor",
      name: "build-advisor",
      kind: "skill",
      skillRefLabel: "build-advisor",
      skillMarkdownTarget: "/skills/build-advisor/SKILL.md",
    };

    const options = buildMarkdownMentionOptions({
      agents: [
        {
          id: "agent-1",
          name: "Wesley",
          role: "engineer",
          title: null,
          icon: null,
          status: "active",
        },
      ],
      skillMentionOptions: [skillOption],
      projects: [
        {
          id: "project-1",
          name: "Rudder dev",
          description: null,
          color: "#3b82f6",
          icon: "folder",
        },
      ],
      issues: [
        {
          id: "issue-1",
          identifier: "RUD-1",
          title: "Mention menu",
          status: "todo",
          projectId: "project-1",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
      chats: [
        {
          id: "chat-1",
          orgId: "org-1",
          status: "active",
          title: "Launch planning",
          summary: null,
          latestReplyPreview: null,
          latestUserMessagePreview: null,
          userMessageCount: 0,
          preferredAgentId: null,
          routedAgentId: null,
          primaryIssueId: null,
          primaryIssue: null,
          issueCreationMode: "manual_approval",
          planMode: false,
          createdByUserId: null,
          lastMessageAt: null,
          lastReadAt: null,
          isPinned: false,
          isUnread: false,
          unreadCount: 0,
          needsAttention: false,
          resolvedAt: null,
          contextLinks: [],
          chatRuntime: {
            sourceType: "unconfigured",
            sourceLabel: "Unconfigured",
            runtimeAgentId: null,
            agentRuntimeType: null,
            model: null,
            available: false,
            error: null,
          },
          createdAt: new Date("2026-05-20T00:00:00Z"),
          updatedAt: new Date("2026-05-20T00:00:00Z"),
        },
      ],
    });

    expect(options.map((option) => option.id)).toEqual([
      "agent:agent-1",
      "skill:build-advisor",
      "project:project-1",
      "issue:issue-1",
      "chat:chat-1",
    ]);
  });

  it("includes chat conversations as mentionable entities", () => {
    const options = buildMarkdownMentionOptions({
      chats: [
        {
          id: "chat-1",
          orgId: "org-1",
          status: "active",
          title: "Launch planning",
          summary: "Coordinate launch work",
          latestReplyPreview: null,
          latestUserMessagePreview: null,
          userMessageCount: 0,
          preferredAgentId: null,
          routedAgentId: null,
          primaryIssueId: null,
          primaryIssue: null,
          issueCreationMode: "manual_approval",
          planMode: false,
          createdByUserId: null,
          lastMessageAt: new Date("2026-05-20T00:05:00Z"),
          lastReadAt: null,
          isPinned: false,
          isUnread: false,
          unreadCount: 0,
          needsAttention: false,
          resolvedAt: null,
          contextLinks: [],
          chatRuntime: {
            sourceType: "unconfigured",
            sourceLabel: "Unconfigured",
            runtimeAgentId: null,
            agentRuntimeType: null,
            model: null,
            available: false,
            error: null,
          },
          createdAt: new Date("2026-05-20T00:00:00Z"),
          updatedAt: new Date("2026-05-20T00:00:00Z"),
        },
      ],
    });

    expect(options).toContainEqual(expect.objectContaining({
      id: "chat:chat-1",
      name: "Launch planning",
      kind: "chat",
      chatConversationId: "chat-1",
      searchText: expect.stringContaining("Coordinate launch work"),
      chatUpdatedAt: new Date("2026-05-20T00:05:00Z"),
    }));
  });

  it("includes Library directories as mentionable entities", () => {
    const options = buildMarkdownMentionOptions({
      libraryFiles: [
        {
          name: "rudder-mkt",
          displayLabel: "Rudder marketing",
          path: "projects/rudder-mkt",
          isDirectory: true,
        },
        {
          name: "narrative.md",
          path: "projects/rudder-mkt/narrative.md",
          isDirectory: false,
        },
      ],
    });

    expect(options).toContainEqual(expect.objectContaining({
      id: "library-directory:projects/rudder-mkt",
      name: "Rudder marketing",
      kind: "library_directory",
      libraryDirectoryPath: "projects/rudder-mkt",
      libraryFilePath: null,
    }));
    expect(options).toContainEqual(expect.objectContaining({
      id: "library-file:projects/rudder-mkt/narrative.md",
      kind: "library_file",
      libraryFilePath: "projects/rudder-mkt/narrative.md",
      libraryDirectoryPath: null,
    }));
  });
});
