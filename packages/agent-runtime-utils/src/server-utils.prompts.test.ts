import { describe, expect, it } from "vitest";
import {
  AGENT_ISSUE_CREATION_PROMPT_TEMPLATE,
  COMMENT_MENTION_PROMPT_TEMPLATE,
  DEFAULT_AGENT_PROMPT_TEMPLATE,
  GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE,
  GOAL_FEEDBACK_PROMPT_TEMPLATE,
  GOAL_STARTED_PROMPT_TEMPLATE,
  ISSUE_ASSIGN_PROMPT_TEMPLATE,
  ISSUE_ASSIGNEE_EXECUTION_RAIL,
  ISSUE_CHANGES_REQUESTED_PROMPT_TEMPLATE,
  ISSUE_COMMENTED_PROMPT_TEMPLATE,
  ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE,
  ISSUE_RECOVERY_PROMPT_TEMPLATE,
  ISSUE_REVIEW_PROMPT_TEMPLATE,
  ISSUE_REVIEW_RECOVERY_PROMPT_TEMPLATE,
  RECOVERY_PROMPT_TEMPLATE,
  renderTemplate,
  RUDDER_AGENT_HEARTBEAT_INSTRUCTION,
  RUDDER_AGENT_OPERATING_CONTRACT,
  selectPromptTemplate,
} from "./server-utils.js";

describe("server-utils prompt contracts", () => {
  it("selects the dedicated single-issue prompt for Agent Issue creation wakes", () => {
    const context = {
      wakeReason: "agent_issue_creation_requested",
      wakeSource: "on_demand",
      targetType: "agent_issue_creation",
      targetId: "request-1",
      agentIssueCreationRequestId: "request-1",
      agentIssueCreationRequest: {
        id: "request-1",
        requestedByUserId: "user-1",
        projectId: "project-1",
        goalId: null,
        parentId: null,
        instruction: "Track the browser recovery regression.",
      },
    };

    expect(selectPromptTemplate("custom template", context)).toBe(AGENT_ISSUE_CREATION_PROMPT_TEMPLATE);

    const rendered = renderTemplate(selectPromptTemplate(undefined, context), {
      agent: { id: "agent-1", name: "Builder" },
      context: {
        ...context,
        rudderWorkspace: { orgResourcesPrompt: "" },
      },
    });
    expect(rendered).toContain("Request ID: request-1");
    expect(rendered).toContain("Track the browser recovery regression.");
    expect(rendered).toContain("exactly one real Rudder Issue");
    expect(rendered).toContain("rudder issue create");
  });

  it("keeps the dedicated prompt on retries when the authoritative request identity is preserved", () => {
    const request = {
      id: "request-retry",
      requestedByUserId: "user-1",
      projectId: null,
      goalId: null,
      parentId: null,
      instruction: "Create the retry regression issue.",
    };

    expect(selectPromptTemplate("custom template", {
      wakeReason: "process_lost_retry",
      wakeSource: "on_demand",
      targetType: "agent_issue_creation",
      targetId: request.id,
      agentIssueCreationRequestId: request.id,
      agentIssueCreationRequest: request,
    })).toBe(AGENT_ISSUE_CREATION_PROMPT_TEMPLATE);
  });

  it("does not treat unverified request-shaped context as an Agent Issue creation wake", () => {
    const request = {
      id: "request-spoof",
      instruction: "Do not use this as an issue request.",
    };

    expect(selectPromptTemplate("custom template", {
      wakeReason: "agent_issue_creation_requested",
      wakeSource: "on_demand",
      agentIssueCreationRequest: request,
    })).toBe("custom template");

    expect(selectPromptTemplate(undefined, {
      wakeReason: "agent_issue_creation_requested",
      wakeSource: "on_demand",
      targetType: "agent_issue_creation",
      targetId: "different-request",
      agentIssueCreationRequestId: request.id,
      agentIssueCreationRequest: request,
    })).toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
  });

  it("keeps Rudder Goal wakes away from Codex internal Goal tools and preserves human acceptance", () => {
    for (const template of [
      GOAL_STARTED_PROMPT_TEMPLATE,
      GOAL_FEEDBACK_PROMPT_TEMPLATE,
      GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE,
    ]) {
      expect(template).toContain("This is a Rudder product Goal, not a Codex internal goal.");
      expect(template).toContain("Do not call Codex `create_goal`, `update_goal`, or `get_goal`");
      expect(template).toContain("call that typed tool directly");
      expect(template).toContain("Do not load `rudder-docs`, inspect skill files, or run discovery commands");
      expect(template).toContain("instead of using shell, Bash, curl, or the `rudder` CLI");
      expect(template).toContain("`rudder_goal_progress`");
      expect(template).toContain("`rudder_goal_change_propose`");
      expect(template).toContain("`rudder_goal_result_propose`");
      expect(template).toContain("automatically attributes progress to this Run");
      expect(template).toContain("A human must accept every terminal Goal result.");
    }
  });

  it("renders a Goal start wake with the outcome, current contract, and continuation", () => {
    const context = {
      wakeReason: "goal_started",
      goal: {
        id: "goal-started-1",
        title: "Publish a verified release",
        outcomeStatement: "Customers can install the verified release.",
        contractRevision: 3,
        criteria: [{ id: "install", label: "Public install succeeds", evaluator: "human" }],
        autonomyEnvelope: { allowed: ["prepare_candidate"] },
      },
      goalContinuation: {
        kind: "action",
        summary: "Run the public installation verification.",
        wakeCondition: null,
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-goal-owner", name: "Wesley" },
      context,
    });

    expect(GOAL_STARTED_PROMPT_TEMPLATE).toContain("**Goal outcome:**");
    expect(template).not.toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
    expect(rendered).toContain("A Goal has started and you are responsible for advancing it.");
    expect(rendered).toContain("**Goal ID:** goal-started-1");
    expect(rendered).toContain("Customers can install the verified release.");
    expect(rendered).toContain('"contractRevision":3');
    expect(rendered).toContain("action: Run the public installation verification.");
    expect(rendered).not.toContain("Continue your Rudder work.");
  });

  it("renders a Goal feedback wake with runtime feedback body and id", () => {
    const context = {
      wakeReason: "goal_feedback",
      goal: {
        id: "goal-feedback-1",
        title: "Keep activation reliable",
        outcomeStatement: "Goal activation remains reliable after restart.",
        contractRevision: 5,
        criteria: ["Restart preserves activation"],
        autonomyEnvelope: { allowed: ["verify"] },
      },
      goalContinuation: {
        kind: "verification",
        summary: "Repeat the restart acceptance run.",
        wakeCondition: null,
      },
      goalFeedback: {
        id: "feedback-77",
        body: "Verify the restart path before proposing completion.",
        kind: "course_correction",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-feedback-owner", name: "Kepler" },
      context,
    });

    expect(GOAL_FEEDBACK_PROMPT_TEMPLATE).toContain("**Feedback body:**");
    expect(template).not.toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
    expect(rendered).toContain("New feedback requires your review on a Goal you own.");
    expect(rendered).toContain("Goal activation remains reliable after restart.");
    expect(rendered).toContain('"contractRevision":5');
    expect(rendered).toContain("verification: Repeat the restart acceptance run.");
    expect(rendered).toContain("**Feedback ID:** feedback-77");
    expect(rendered).toContain("Verify the restart path before proposing completion.");
    expect(rendered).not.toContain("Continue your Rudder work.");
  });

  it("selects the Goal prompt when only a nested payload indicates the wake kind", () => {
    const context = {
      payload: {
        event: "goal_feedback",
        goal: {
          id: "goal-payload-1",
          title: "Payload Goal",
          outcomeStatement: "Payload-only wakes preserve Goal context.",
          currentContract: { contractRevision: 2 },
        },
        goalContinuation: {
          kind: "action",
          summary: "Continue from the payload packet.",
        },
        goalFeedback: {
          id: "feedback-payload-1",
          body: "Use the payload feedback body.",
        },
      },
    };

    const rendered = renderTemplate(selectPromptTemplate(undefined, context), {
      agent: { id: "agent-payload", name: "Payload Runner" },
      context,
    });

    expect(rendered).toContain("Payload-only wakes preserve Goal context.");
    expect(rendered).toContain("action: Continue from the payload packet.");
    expect(rendered).toContain("**Feedback ID:** feedback-payload-1");
    expect(rendered).toContain("Use the payload feedback body.");
    expect(rendered).not.toContain("Continue your Rudder work.");
  });

  it("renders a Goal change decision with the latest contract and human note", () => {
    const context = {
      wakeReason: "goal_change_decided",
      goal: {
        id: "goal-decision-1",
        title: "Ship the verified release",
        outcomeStatement: "Customers can install the verified release.",
        contractRevision: 4,
        criteria: [{ id: "install", label: "Public install succeeds", evaluator: "artifact" }],
      },
      goalContinuation: {
        kind: "action",
        summary: "Continue with the approved release boundary.",
      },
      goalDecision: {
        proposalId: "proposal-1",
        decision: "approve",
        status: "applied",
        note: "Keep rollback evidence visible in the final result.",
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-decision-owner", name: "Ada" },
      context,
    });

    expect(template).not.toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
    expect(GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE).toContain("## Goal Change Decision");
    expect(rendered).toContain("A human decided a proposed change");
    expect(rendered).toContain('"contractRevision":4');
    expect(rendered).toContain("**Decision:** approve");
    expect(rendered).toContain("**Decision status:** applied");
    expect(rendered).toContain("Keep rollback evidence visible in the final result.");
    expect(rendered).toContain("action: Continue with the approved release boundary.");
  });

  it("keeps unrelated heartbeat payloads on the generic fallback", () => {
    expect(selectPromptTemplate(undefined, {
      wakeReason: "heartbeat_timer",
      payload: { event: "daily_check" },
    })).toBe(DEFAULT_AGENT_PROMPT_TEMPLATE);
  });

  it("turns missing Goal context into a named blocker instead of a retrieval instruction", () => {
    const rendered = renderTemplate(selectPromptTemplate(undefined, {
      wakeReason: "goal_feedback",
      goal: { id: "goal-missing-context" },
    }), {
      agent: { id: "agent-missing-context", name: "Fallback Guard" },
      context: {},
    });

    expect(rendered).toContain("report the missing outcome as a named blocker");
    expect(rendered).toContain("report the missing continuation as a named blocker");
    expect(rendered).toContain("report the missing feedback body as a named blocker");
    expect(rendered).not.toContain("load the Goal's current");
    expect(rendered).not.toContain("load the triggering feedback entry");
  });

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
    expect(rendered).toContain(
      "Only checkout or self-assign when the comment explicitly asks you to take ownership",
    );
    expect(rendered).toContain("Before doing issue-scoped execution as the assignee");
  });

  it.each(["in_review", "done", "cancelled"])(
    "lets the current assignee handle an explicit mention while preserving %s",
    (status) => {
      const issue = {
        id: `issue-assignee-${status}`,
        title: "Continue explicit assignee work",
        status,
        priority: "medium",
        description: "The lifecycle state must not revoke explicit work authority.",
      };
      const comment = {
        id: `comment-assignee-${status}`,
        authorKind: "user",
        authorLabel: "Zeeland",
        body: "Please merge the prepared change into local main.",
      };
      const context = {
        wakeReason: "issue_comment_mentioned",
        wakeSource: "comment.mention",
        relationship: "assignee",
        issue,
        comment,
      };

      const rendered = renderTemplate(selectPromptTemplate(undefined, context), {
        agent: { id: "agent-assignee", name: "Noah" },
        context,
        issue,
        comment,
      });

      expect(rendered).toContain("You were mentioned in a comment and your attention is needed.");
      expect(rendered).toContain("You are the issue's current assignee");
      expect(rendered).toContain("do not check out the issue");
      expect(rendered).toContain("preserve its current status");
      expect(rendered).not.toContain("Before doing issue-scoped execution as the assignee");
      expect(rendered).not.toContain("If checkout returns `409`");
    },
  );

  it.each(["in_review", "done", "cancelled"])(
    "lets the current reviewer handle an ordinary explicit mention while preserving %s",
    (status) => {
      const issue = {
        id: `issue-reviewer-${status}`,
        title: "Continue explicit reviewer work",
        status,
        priority: "medium",
        description: "An ordinary mention is not a formal review route.",
      };
      const comment = {
        id: `comment-reviewer-${status}`,
        authorKind: "user",
        authorLabel: "Zeeland",
        body: "Please verify the local merge result.",
      };
      const context = {
        wakeReason: "issue_comment_mentioned",
        wakeSource: "comment.mention",
        relationship: "reviewer",
        issue,
        comment,
      };

      const rendered = renderTemplate(selectPromptTemplate(undefined, context), {
        agent: { id: "agent-reviewer", name: "Kepler" },
        context,
        issue,
        comment,
      });

      expect(rendered).toContain("You were mentioned in a comment and your attention is needed.");
      expect(rendered).toContain("You are the issue's current reviewer");
      expect(rendered).toContain("do not check out the issue");
      expect(rendered).toContain("preserve its current status");
      expect(rendered).not.toContain("You have been asked to review an issue.");
      expect(rendered).not.toContain("Before doing issue-scoped execution as the assignee");
    },
  );

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

  it("injects the checkout conflict rail only into assignee-capable issue scenes", () => {
    const assigneeCapableTemplates = [
      ISSUE_ASSIGN_PROMPT_TEMPLATE,
      ISSUE_COMMENTED_PROMPT_TEMPLATE,
      ISSUE_CHANGES_REQUESTED_PROMPT_TEMPLATE,
      ISSUE_RECOVERY_PROMPT_TEMPLATE,
      ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE,
    ];

    for (const template of assigneeCapableTemplates) {
      expect(template).toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
      expect(template).toContain("If checkout returns `409`, do not retry");
    }

    const collaboratorMention = selectPromptTemplate(undefined, {
      wakeSource: "comment.mention",
      wakeReason: "issue_comment_mentioned",
      relationship: "collaborator",
    });
    expect(COMMENT_MENTION_PROMPT_TEMPLATE).not.toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
    expect(collaboratorMention).toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);

    expect(ISSUE_REVIEW_PROMPT_TEMPLATE).not.toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
    expect(ISSUE_REVIEW_RECOVERY_PROMPT_TEMPLATE).not.toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
    expect(RECOVERY_PROMPT_TEMPLATE).not.toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
    expect(DEFAULT_AGENT_PROMPT_TEMPLATE).not.toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
    expect(RUDDER_AGENT_HEARTBEAT_INSTRUCTION).not.toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
  });

  it("keeps Rudder Docs usage conditional and out of the global operating contract", () => {
    expect(RUDDER_AGENT_OPERATING_CONTRACT).not.toContain("You can use `rudder` skill");
    expect(RUDDER_AGENT_OPERATING_CONTRACT).not.toContain("`rudder-docs`");
    expect(RUDDER_AGENT_HEARTBEAT_INSTRUCTION).toContain("may consult the bundled `rudder-docs` skill");
    expect(RUDDER_AGENT_HEARTBEAT_INSTRUCTION).toContain(
      "Do not load it merely because this is a heartbeat",
    );
    expect(RUDDER_AGENT_HEARTBEAT_INSTRUCTION).not.toContain("bundled `rudder` skill");
  });

  it("keeps reviewer recovery scoped to review without the assignee rail", () => {
    const context = {
      wakeSource: "recovery.manual",
      wakeReason: "retry_failed_run",
      role: "reviewer",
      recovery: {
        originalRunId: "run-review-failed",
        failureKind: "process_exit",
        failureSummary: "The reviewer process exited before recording a decision.",
        recoveryTrigger: "manual",
        recoveryMode: "continue",
      },
      issue: {
        id: "issue-review-retry",
        title: "Retry reviewer work",
        status: "in_review",
      },
    };

    const template = selectPromptTemplate(undefined, context);

    expect(template).toBe(ISSUE_REVIEW_RECOVERY_PROMPT_TEMPLATE);
    expect(template).toContain("This is a reviewer recovery run");
    expect(template).toContain("Record the requested structured reviewer decision");
    expect(template).toContain("do not take over the assignee's implementation");
    expect(template).not.toContain(ISSUE_ASSIGNEE_EXECUTION_RAIL);
  });

  it("composes the issue execution rail after custom assignee templates", () => {
    const custom = "Follow the operator's custom assignment workflow.";

    const assignment = selectPromptTemplate(custom, {
      wakeSource: "assignment",
      wakeReason: "issue_assigned",
      issue: { id: "issue-custom" },
    });
    const reviewer = selectPromptTemplate(custom, {
      wakeSource: "review",
      wakeReason: "issue_review_requested",
      role: "reviewer",
      issue: { id: "issue-review" },
    });
    const reviewerRecovery = selectPromptTemplate(custom, {
      wakeSource: "recovery.manual",
      wakeReason: "retry_failed_run",
      role: "reviewer",
      recovery: { originalRunId: "run-review" },
      issue: { id: "issue-review" },
    });
    const generic = selectPromptTemplate(custom, { wakeSource: "chat" });

    expect(assignment).toBe(`${custom}\n\n${ISSUE_ASSIGNEE_EXECUTION_RAIL}`);
    expect(reviewer).toBe(custom);
    expect(reviewerRecovery).toBe(custom);
    expect(generic).toBe(custom);
  });

  it("composes the Goal runtime rail after a custom agent persona", () => {
    const custom = "Use the release operator persona and preserve rollback evidence.";
    const context = {
      wakeReason: "goal_feedback",
      goal: {
        id: "goal-custom-owner",
        title: "Publish a verified release",
        outcomeStatement: "Customers can install the verified release.",
        contractRevision: 6,
      },
      goalContinuation: {
        kind: "verification",
        summary: "Verify the public package before proposing completion.",
      },
      goalFeedback: {
        id: "feedback-custom-owner",
        body: "Include rollback evidence in the result proposal.",
      },
    };

    const template = selectPromptTemplate(custom, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-custom-owner", name: "Release Operator" },
      context,
    });

    expect(template.indexOf(custom)).toBeLessThan(template.indexOf("New feedback requires"));
    expect(rendered).toContain(custom);
    expect(rendered).toContain("**Goal ID:** goal-custom-owner");
    expect(rendered).toContain("Customers can install the verified release.");
    expect(rendered).toContain("Include rollback evidence in the result proposal.");
    expect(rendered).toContain("A human must accept every terminal Goal result.");
  });

  it("gives reviewer context precedence over stale assignee wake reasons", () => {
    const mixedReviewerContexts = [
      { wakeReason: "issue_passive_followup" },
      { wakeReason: "issue_changes_requested" },
      { wakeSource: "assignment", wakeReason: "issue_assigned" },
      { wakeSource: "comment.mention", wakeReason: "issue_comment_mentioned" },
    ];

    for (const mixedContext of mixedReviewerContexts) {
      const context = {
        ...mixedContext,
        role: "reviewer",
        issue: { id: "issue-mixed-reviewer" },
      };

      expect(selectPromptTemplate(undefined, context)).toBe(ISSUE_REVIEW_PROMPT_TEMPLATE);
      expect(selectPromptTemplate("Custom reviewer workflow.", context)).toBe(
        "Custom reviewer workflow.",
      );
    }
  });
});
