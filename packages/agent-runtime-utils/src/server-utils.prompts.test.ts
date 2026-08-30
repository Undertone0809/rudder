import { describe, expect, it } from "vitest";
import {
  AGENT_ISSUE_CREATION_PROMPT_TEMPLATE,
  COMMENT_MENTION_PROMPT_TEMPLATE,
  DEFAULT_AGENT_PROMPT_TEMPLATE,
  GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE,
  GOAL_CONTINUATION_PROMPT_TEMPLATE,
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
    expect(rendered).toContain("rudder_issue_create");
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
      GOAL_CONTINUATION_PROMPT_TEMPLATE,
    ]) {
      expect(template).toContain("This is a Rudder product Goal, not a Codex internal goal.");
      expect(template).toContain("Do not call Codex `create_goal`, `update_goal`, or `get_goal`");
      expect(template).toContain("call `rudder_goal_context` once");
      expect(template).toContain("contract, current Plan, continuation");
      expect(template).toContain("call that typed tool directly");
      expect(template).toContain("Do not load `rudder-docs`, inspect skill files, or run discovery commands");
      expect(template).toContain("Do not use shell, Bash, curl, or the `rudder` CLI");
      expect(template).toContain("`rudder_goal_progress`");
      expect(template).toContain("`rudder_goal_change_propose`");
      expect(template).toContain("`rudder_goal_result_propose`");
      expect(template).toContain("automatically attributes progress to this Run");
      expect(template).toContain("A human must accept every terminal Goal result.");
      expect(template).toContain("Never claim that a Plan, wait, review, Checkpoint, proposal, or transition was persisted");
    }
  });

  it("drives every Goal wake through the complete advancement phase router", () => {
    for (const template of [
      GOAL_STARTED_PROMPT_TEMPLATE,
      GOAL_FEEDBACK_PROMPT_TEMPLATE,
      GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE,
      GOAL_CONTINUATION_PROMPT_TEMPLATE,
    ]) {
      expect(template).toContain("## Goal Advancement Protocol");
      expect(template).toContain("### Phase 1 - Reconstruct the current state");
      expect(template).toContain("### Phase 2 - Check that the Goal is executable");
      expect(template).toContain("### Phase 3 - Plan or Replan");
      expect(template).toContain("### Phase 4 - Run an optional Plan or Replan review");
      expect(template).toContain("### Phase 5 - Execute one bounded commitment");
      expect(template).toContain("### Phase 6 - Observe and checkpoint");
      expect(template).toContain("When `rudder_goal_checkpoint` is available, call `rudder_goal_checkpoint` exactly once for this bounded Run");
      expect(template).toContain("### Phase 7 - Choose exactly one primary continuation route");
      expect(template).toContain("### Phase 8 - Audit a possible block");
      expect(template).toContain("### Phase 9 - Review and propose the result");
      expect(template).toContain("### Required turn closeout");
    }
  });

  it("keeps Plan ownership, review authority, Contract changes, and result acceptance distinct", () => {
    for (const template of [
      GOAL_STARTED_PROMPT_TEMPLATE,
      GOAL_FEEDBACK_PROMPT_TEMPLATE,
      GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE,
      GOAL_CONTINUATION_PROMPT_TEMPLATE,
    ]) {
      expect(template).toContain("Plan and Replan changes remain Agent-owned");
      expect(template).toContain("They do not silently revise the Goal Contract.");
      expect(template).toContain("label the proposed strategy as Run-local and unpersisted");
      expect(template).toContain("do not imply that Rudder will resume it automatically");
      expect(template).toContain("Invoke a Plan/Replan review only when the Contract, continuation, risk policy, or explicit human instruction requires it");
      expect(template).toContain("A Reviewer returns findings; it does not become the Goal Owner");
      expect(template).toContain("If review is required but no review mechanism is available, report that exact unpersisted gate.");
      expect(template).toContain("Continue under the existing Contract until a human-applied decision says otherwise.");
      expect(template).toContain("Stop execution while a Result Proposal is ready for human Acceptance.");
    }
  });

  it("requires a materially different Replan before a three-turn blocked conclusion", () => {
    for (const template of [
      GOAL_STARTED_PROMPT_TEMPLATE,
      GOAL_FEEDBACK_PROMPT_TEMPLATE,
      GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE,
      GOAL_CONTINUATION_PROMPT_TEMPLATE,
    ]) {
      expect(template).toContain("Do not mark or claim the Goal blocked the first time a blocker appears.");
      expect(template).toContain("If the same blocker persists for three consecutive Goal turns, first perform a Replan audit");
      expect(template).toContain("If Replan finds a viable path, continue through that path.");
      expect(template).toContain("Resuming after a blocked conclusion starts a fresh three-turn audit.");
      expect(template).toContain("no blocker fingerprint schema is required");
      expect(template).toContain("Missing context is not by itself a validated blocked conclusion.");
    }
  });

  it("gives each real Goal wake a concrete entry and same-turn advancement rule", () => {
    expect(GOAL_STARTED_PROMPT_TEMPLATE).toContain("## Wake Entry - Goal Started");
    expect(GOAL_STARTED_PROMPT_TEMPLATE).toContain("Start at Plan/Replan because activation already confirmed the Contract.");
    expect(GOAL_STARTED_PROMPT_TEMPLATE).toContain("Do not finish by merely restating the Goal or producing a Plan");

    expect(GOAL_FEEDBACK_PROMPT_TEMPLATE).toContain("## Wake Entry - Goal Feedback");
    expect(GOAL_FEEDBACK_PROMPT_TEMPLATE).toContain("new fact or Evidence -> observe and checkpoint");
    expect(GOAL_FEEDBACK_PROMPT_TEMPLATE).toContain("Do not merely acknowledge feedback");

    expect(GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE).toContain("## Wake Entry - Goal Change Decision");
    expect(GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE).toContain("If the decision is approved and applied");
    expect(GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE).toContain("If the proposal was rejected, preserve the current Contract");
    expect(GOAL_CHANGE_DECIDED_PROMPT_TEMPLATE).toContain("Acknowledging the decision alone is not advancement");

    expect(GOAL_CONTINUATION_PROMPT_TEMPLATE).toContain("## Wake Entry - Goal Continuation");
    expect(GOAL_CONTINUATION_PROMPT_TEMPLATE).toContain("persisted a checkpoint");
    expect(GOAL_CONTINUATION_PROMPT_TEMPLATE).toContain("Do not replay the prior action blindly");
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
      goalPlan: {
        revision: 1,
        summary: "Verify the public installer before proposing a result.",
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
    expect(rendered).toContain('"revision":1');
    expect(rendered).toContain("Verify the public installer before proposing a result.");
    expect(rendered).toContain("action: Run the public installation verification.");
    expect(rendered).toContain("Validate and use the persisted initial Plan before replacing it.");
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
      goalPlan: {
        revision: 4,
        summary: "Exercise restart recovery and compare the runtime identity.",
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
    expect(rendered).toContain('"revision":4');
    expect(rendered).toContain("Exercise restart recovery and compare the runtime identity.");
    expect(rendered).toContain("verification: Repeat the restart acceptance run.");
    expect(rendered).toContain("**Feedback ID:** feedback-77");
    expect(rendered).toContain("Verify the restart path before proposing completion.");
    expect(rendered).not.toContain("Continue your Rudder work.");
  });

  it("routes a continuation wake with checkpoint facts into the same advancement protocol", () => {
    const context = {
      wakeReason: "goal_continuation",
      goal: {
        id: "goal-continuation-1",
        title: "Verify the next bounded release step",
        outcomeStatement: "The release remains verifiable across runs.",
        contractRevision: 2,
      },
      goalPlan: { revision: 3, summary: "Run the recovery verification." },
      goalContinuation: { kind: "verification", summary: "Repeat the recovery check.", wakeCondition: null },
      goalCheckpoint: {
        id: "checkpoint-9",
        summary: "Persisted recovery evidence and queued the next verification.",
        evidenceRefs: ["artifact://release/recovery"],
        planRevision: 3,
      },
    };

    const template = selectPromptTemplate(undefined, context);
    const rendered = renderTemplate(template, {
      agent: { id: "agent-continuation-owner", name: "Owner" },
      context,
    });

    expect(template).toContain("## Wake Entry - Goal Continuation");
    expect(rendered).toContain("## Wake Entry - Goal Continuation");
    expect(rendered).toContain("Persisted recovery evidence and queued the next verification.");
    expect(rendered).toContain('"revision":3');
    expect(rendered).toContain("Repeat the recovery check.");
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
      goalPlan: {
        revision: 2,
        summary: "Verify installation and rollback against the accepted candidate.",
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
    expect(rendered).toContain('"revision":2');
    expect(rendered).toContain("Verify installation and rollback against the accepted candidate.");
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

  it("uses managed Goal context for missing wake facts without inventing a blocked conclusion", () => {
    const rendered = renderTemplate(selectPromptTemplate(undefined, {
      wakeReason: "goal_feedback",
      goal: { id: "goal-missing-context" },
    }), {
      agent: { id: "agent-missing-context", name: "Fallback Guard" },
      context: {},
    });

    expect(rendered).toContain("load managed Goal context once; otherwise report the missing outcome");
    expect(rendered).toContain("load managed Goal context once; otherwise report the missing current Plan");
    expect(rendered).toContain("load managed Goal context once; otherwise report the missing continuation");
    expect(rendered).toContain("load managed Goal context once; otherwise report the missing feedback body");
    expect(rendered).toContain("Missing context is not by itself a validated blocked conclusion.");
    expect(rendered).not.toContain("load the Goal's current");
    expect(rendered).not.toContain("load the triggering feedback entry");
    expect(rendered).toContain("Do not use shell, Bash, curl, or the `rudder` CLI to read or mutate Goal state");
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

  it("bounds Issue transport fallback across typed MCP, CLI, and direct API probes", () => {
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain(
      "treat typed Rudder MCP and the `rudder issue` CLI as one backend failure domain",
    );
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain("make at most one recorded fallback through the CLI");
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain("do not switch profiles, repeat either surface, or call the API directly");
    expect(RUDDER_AGENT_OPERATING_CONTRACT).toContain("keep Issue ownership, reviewer, and lifecycle state unchanged");
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
