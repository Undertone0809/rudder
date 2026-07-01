import { describe, expect, it } from "vitest";
import {
  renderTemplate,
  RUDDER_AGENT_HEARTBEAT_INSTRUCTION,
  RUDDER_AGENT_OPERATING_CONTRACT,
  selectPromptTemplate,
} from "./server-utils.js";

describe("server-utils prompt contracts", () => {
  it("renders explicit issue ownership and timestamp metadata for issue-aware wakes", () => {
    const issue = {
      id: "issue-575",
      title: "Improve agent instruction behavior",
      status: "blocked",
      priority: "medium",
      description: "Harden comment-triggered agent behavior.",
      assigneeLabel: "none",
      reviewerLabel: "none",
      createdAt: "2026-06-19T08:15:00.000Z",
      updatedAt: "2026-06-19T10:30:00.000Z",
    };
    const comment = {
      id: "comment-575",
      authorKind: "user",
      authorLabel: "Zeeland",
      body: "Please verify who owns and reviews this.",
    };

    const rendered = renderTemplate(
      selectPromptTemplate(undefined, {
        wakeReason: "issue_comment_mentioned",
        wakeSource: "comment.mention",
        issue,
        comment,
      }),
      {
        agent: { id: "agent-575", name: "Wesley" },
        context: {
          wakeReason: "issue_comment_mentioned",
          wakeSource: "comment.mention",
          issue,
          comment,
        },
        issue,
        comment,
      },
    );

    expect(rendered).toContain("**Issue:** Improve agent instruction behavior");
    expect(rendered).toContain("**ID:** issue-575");
    expect(rendered).toContain("**Status:** blocked");
    expect(rendered).toContain("**Assignee:** none");
    expect(rendered).toContain("**Reviewer:** none");
    expect(rendered).toContain("**Created At:** 2026-06-19T08:15:00.000Z");
    expect(rendered).toContain("**Updated At:** 2026-06-19T10:30:00.000Z");
    expect(rendered).toContain("**Issue Description:**");
  });

  it("renders fallback issue metadata instead of blanks for legacy issue snapshots", () => {
    const issue = {
      id: "issue-legacy",
      title: "Legacy issue shape",
      status: "todo",
      priority: "medium",
      description: "This snapshot predates explicit routing metadata.",
    };

    const rendered = renderTemplate(
      selectPromptTemplate(undefined, {
        wakeReason: "issue_assigned",
        issue,
      }),
      {
        agent: { id: "agent-legacy", name: "Legacy Runner" },
        context: { wakeReason: "issue_assigned", issue },
        issue,
      },
    );

    expect(rendered).toContain("**Assignee:** none");
    expect(rendered).toContain("**Reviewer:** none");
    expect(rendered).toContain("**Created At:** unknown");
    expect(rendered).toContain("**Updated At:** unknown");
    expect(rendered).not.toContain("**Assignee:** \n");
    expect(rendered).not.toContain("**Reviewer:** \n");
    expect(rendered).not.toContain("**Created At:** \n");
    expect(rendered).not.toContain("**Updated At:** \n");
  });

  it("renders issue metadata and review instructions for reviewer wakes", () => {
    const issue = {
      id: "issue-review",
      title: "Review prompt metadata",
      status: "in_review",
      priority: "high",
      description: "Check the assignee's output.",
      assigneeLabel: "Wesley (agent)",
      reviewerLabel: "Holden (agent)",
      createdAt: "2026-06-19T08:15:00.000Z",
      updatedAt: "2026-06-19T10:30:00.000Z",
    };
    const context = {
      wakeSource: "review",
      wakeReason: "issue_review_requested",
      issue,
      reviewInstructions: "Record one structured reviewer decision before exiting.",
    };

    const rendered = renderTemplate(selectPromptTemplate(undefined, context), {
      agent: { id: "agent-reviewer", name: "Holden" },
      context,
      issue,
    });

    expect(rendered).toContain("You have been asked to review an issue.");
    expect(rendered).toContain("**Issue:** Review prompt metadata");
    expect(rendered).toContain("**Status:** in_review");
    expect(rendered).toContain("**Assignee:** Wesley (agent)");
    expect(rendered).toContain("**Reviewer:** Holden (agent)");
    expect(rendered).toContain("**Created At:** 2026-06-19T08:15:00.000Z");
    expect(rendered).toContain("**Updated At:** 2026-06-19T10:30:00.000Z");
    expect(rendered).toContain("**Review Instructions:**");
    expect(rendered).toContain("Record one structured reviewer decision before exiting.");
    expect(rendered).not.toContain("Continue your Rudder work.");
  });

  it("keeps non-assignee comment mention wakes scoped to the comment unless explicitly delegated", () => {
    const issue = {
      id: "issue-575",
      title: "Improve agent instruction behavior",
      status: "in_progress",
      priority: "medium",
      description: "Harden comment-triggered agent behavior.",
      assigneeAgentId: "other-agent",
      assigneeUserId: null,
    };
    const comment = {
      id: "comment-575",
      authorKind: "user",
      authorLabel: "Zeeland",
      body: "I was asking a question, not asking you to change code.",
    };
    const context = {
      wakeReason: "issue_comment_mentioned",
      wakeSource: "comment.mention",
      issue,
      comment,
    };

    const rendered = renderTemplate(selectPromptTemplate(undefined, context), {
      agent: { id: "agent-575", name: "Wesley" },
      context,
      issue,
      comment,
    });

    expect(rendered).toContain("You were mentioned in a comment and your attention is needed.");
    expect(rendered).toContain("If the issue is not assigned to you, including user-owned or unassigned issues");
    expect(rendered).toContain("strictly respond to the comment's content");
    expect(rendered).toContain("instead of broadening the wake into issue execution");
    expect(rendered).toContain("handle only the narrow action explicitly requested by the comment");
  });

  it("injects the non-assignee comment wake boundary into shared runtime instructions", () => {
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain("If a comment wakes you on an issue not assigned to you");
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain("including user-owned or unassigned issues");
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain("strictly respond to the comment's content");
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain("handle only the narrow action the comment explicitly requests");
    expect(RUDDER_AGENT_HEARTBEAT_INSTRUCTION).toContain("If the issue is not assigned to you");
    expect(RUDDER_AGENT_HEARTBEAT_INSTRUCTION).toContain("including user-owned or unassigned issues");
    expect(RUDDER_AGENT_HEARTBEAT_INSTRUCTION).toContain("respond to the comment itself instead of executing the whole issue");
  });

  it("uses the assignee comment prompt for issue reopen comment wakes", () => {
    const issue = {
      id: "issue-685",
      title: "Resume issue from comment",
      status: "todo",
      priority: "medium",
      description: "A closed issue was reopened by a comment.",
    };
    const comment = {
      id: "comment-685",
      authorKind: "user",
      authorLabel: "Zeeland",
      body: "This still needs the reopen path covered.",
    };
    const context = {
      wakeReason: "issue_reopened_via_comment",
      issue,
      comment,
    };

    const rendered = renderTemplate(selectPromptTemplate(undefined, context), {
      agent: { id: "agent-685", name: "Wesley" },
      context,
      issue,
      comment,
    });

    expect(rendered).toContain("There is a new comment on an issue you own.");
    expect(rendered).toContain("Resume issue from comment");
    expect(rendered).toContain("From: Zeeland (user)");
    expect(rendered).toContain("This still needs the reopen path covered.");
    expect(rendered).not.toContain("Continue your Rudder work.");
  });
});
