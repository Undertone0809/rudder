import { describe, expect, it } from "vitest";
import {
  buildAgentMentionHref,
  buildIssueMentionHref,
  buildProjectMentionHref,
  extractAgentMentionIds,
  extractIssueMentionIds,
  extractProjectMentionIds,
  parseAgentMentionHref,
  parseIssueMentionHref,
  parseProjectMentionHref,
} from "./project-mentions.js";
import { PROJECT_COLORS } from "./constants.js";

describe("project-mentions", () => {
  it("round-trips project mentions with color metadata", () => {
    const href = buildProjectMentionHref("project-123", "#336699");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#336699",
    });
    expect(extractProjectMentionIds(`[@Rudder App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips project mentions with gradient metadata", () => {
    const href = buildProjectMentionHref("project-123", PROJECT_COLORS[0]);
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: PROJECT_COLORS[0],
    });
    expect(extractProjectMentionIds(`[@Rudder App](${href})`)).toEqual(["project-123"]);
  });

  it("round-trips agent mentions with icon metadata", () => {
    const href = buildAgentMentionHref("agent-123", "code");
    expect(parseAgentMentionHref(href)).toEqual({
      agentId: "agent-123",
      icon: "code",
    });
    expect(extractAgentMentionIds(`[@CodexCoder](${href})`)).toEqual(["agent-123"]);
  });

  it("round-trips issue mentions with identifier metadata", () => {
    const href = buildIssueMentionHref("issue-123", "PAP-123");
    expect(parseIssueMentionHref(href)).toEqual({
      issueId: "issue-123",
      ref: "PAP-123",
    });
    expect(extractIssueMentionIds(`[@PAP-123](${href})`)).toEqual(["issue-123"]);
  });
});
