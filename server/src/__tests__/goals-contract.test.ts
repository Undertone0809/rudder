import { agents, calendarEvents, goalActivities, goalChangeProposals, goalOwnerAssignments, goalPlans, goalResultProposals, goals, heartbeatRuns } from "@rudderhq/db";
import {
  activateGoalSchema,
  createGoalActivitySchema,
  evaluateGoalSchema,
  previewGoalStartSchema,
  startGoalSchema,
  updateGoalSchema,
} from "@rudderhq/shared";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { goalRoutes } from "../routes/goals.js";
import {
  compileGoalStartPreview,
  goalService,
  publicGoalActivitySummary,
  publicGoalChangeProposal,
  publicGoalResultProposal,
  publicGoalText,
  publicGoalView,
  publicRunSummary,
  reduceGoalEvaluation,
  stableGoalHash,
} from "../services/goals.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const GOAL_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_GOAL_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ORG_OWNER_ID = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "77777777-7777-4777-8777-777777777777";
const SECOND_OWNER_ID = "88888888-8888-4888-8888-888888888888";

type PreviewOwner = NonNullable<Parameters<typeof compileGoalStartPreview>[1]>;

function makePreviewOwner(overrides: Partial<PreviewOwner> = {}): PreviewOwner {
  return {
    id: OWNER_ID,
    orgId: ORG_ID,
    name: "Goal owner",
    status: "idle",
    role: "engineer",
    title: null,
    capabilities: "Plan and execute end-to-end software releases with verifiable evidence.",
    ...overrides,
  };
}

function makeGoal(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-08-04T00:00:00.000Z");
  return {
    id: GOAL_ID,
    orgId: ORG_ID,
    title: "Ship the verified result",
    description: null,
    outcomeStatement: "The verified result is available",
    objectiveMode: "target",
    lifecycle: "draft",
    contractRevision: 1,
    criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
    autonomyEnvelope: {},
    humanAuthorities: {},
    evaluationPolicy: {},
    actionDeadline: null,
    evaluationDeadline: null,
    evaluationResult: null,
    closeReason: null,
    resultPayload: null,
    focus: false,
    planRevision: 0,
    continuationKind: "verification",
    continuationSummary: "Verify the next result",
    wakeCondition: null,
    level: "task",
    status: "planned",
    parentId: null,
    ownerAgentId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createGoalDb(initialGoal = makeGoal()) {
  const state = {
    goals: [initialGoal, makeGoal({ id: SECOND_GOAL_ID, title: "Keep a second focus candidate" })],
    agents: [
      makePreviewOwner(),
      makePreviewOwner({ id: OTHER_ORG_OWNER_ID, orgId: OTHER_ORG_ID }),
    ],
    runs: [{
      id: RUN_ID,
      orgId: ORG_ID,
      agentId: OWNER_ID,
      status: "running",
      goalId: GOAL_ID,
      contextSnapshot: { goalId: GOAL_ID },
      resultJson: null,
      resultSummaryJson: null,
      error: null,
      updatedAt: new Date("2026-08-04T00:01:00.000Z"),
    }],
    calendarEvents: [] as Array<Record<string, unknown>>,
    activities: [] as Array<Record<string, unknown>>,
    changeProposals: [] as Array<Record<string, unknown>>,
    resultProposals: [] as Array<Record<string, unknown>>,
    ownerAssignments: [] as Array<Record<string, unknown>>,
    plans: [] as Array<Record<string, unknown>>,
    selectedGoalId: initialGoal.id,
    rejectOwnerLookup: false,
    pendingActivityInput: null as Record<string, unknown> | null,
    activityLookupCalls: 0,
  };

  function selectBuilder() {
    let table: unknown;
    const builder: any = {
      from(value: unknown) {
        table = value;
        return builder;
      },
      innerJoin() {
        return builder;
      },
      leftJoin() {
        return builder;
      },
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      for() {
        return builder;
      },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        let rows: unknown[] = [];
        if (table === goals) {
          rows = state.goals.filter((goal) => goal.id === state.selectedGoalId);
        } else if (table === agents) {
          rows = state.rejectOwnerLookup ? [] : state.agents;
        } else if (table === heartbeatRuns) {
          rows = state.runs;
        } else if (table === calendarEvents) {
          rows = state.calendarEvents;
        } else if (table === goalActivities) {
          if (state.pendingActivityInput) {
            const lookup = state.pendingActivityInput;
            if (lookup.idempotencyKey && state.activityLookupCalls === 0) {
              rows = state.activities.filter((activity) => activity.goalId === lookup.goalId && activity.idempotencyKey === lookup.idempotencyKey);
            } else {
              rows = state.activities.filter((activity) =>
                activity.goalId === lookup.goalId
                && activity.runRef === lookup.runRef
                && activity.activityKind === "closeout",
              );
            }
            state.activityLookupCalls += 1;
          } else {
            rows = state.activities;
          }
        } else if (table === goalChangeProposals) {
          rows = state.changeProposals;
        } else if (table === goalResultProposals) {
          rows = state.resultProposals;
        }
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return builder;
  }

  function insertBuilder(table: unknown) {
    let values: Record<string, unknown>;
    const execute = () => {
      if (table === goalActivities) {
        state.pendingActivityInput = values;
        state.activityLookupCalls = 0;
        const duplicate = state.activities.find((activity) =>
          (values.idempotencyKey && activity.goalId === values.goalId && activity.idempotencyKey === values.idempotencyKey)
          || (values.activityKind === "closeout" && activity.goalId === values.goalId && activity.runRef === values.runRef && activity.activityKind === "closeout"),
        );
        if (duplicate) return [];
        const activity = { id: `activity-${state.activities.length + 1}`, ...values };
        state.activities.push(activity);
        state.pendingActivityInput = null;
        return [activity];
      }
      if (table === goalOwnerAssignments) {
        const assignment = { id: `assignment-${state.ownerAssignments.length + 1}`, ...values };
        state.ownerAssignments.push(assignment);
        return [assignment];
      }
      if (table === goalPlans) {
        const plan = { id: `plan-${state.plans.length + 1}`, ...values };
        state.plans.push(plan);
        return [plan];
      }
      return [];
    };
    const builder: any = {
      values(next: Record<string, unknown>) {
        values = next;
        return builder;
      },
      onConflictDoNothing() {
        return builder;
      },
      returning() {
        return Promise.resolve(execute());
      },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return builder;
  }

  function updateBuilder(table: unknown) {
    let patch: Record<string, unknown> = {};
    const execute = () => {
      if (table !== goals) return [];
      if (patch.focus === false) {
        for (const goal of state.goals) {
          if (goal.orgId === ORG_ID) Object.assign(goal, patch);
        }
      } else {
        const goal = state.goals.find((candidate) => candidate.id === state.selectedGoalId);
        if (goal) Object.assign(goal, patch);
      }
      return state.goals.filter((goal) => goal.id === state.selectedGoalId);
    };
    const builder: any = {
      set(next: Record<string, unknown>) {
        patch = next;
        return builder;
      },
      where() {
        return builder;
      },
      returning() {
        return Promise.resolve(execute());
      },
      then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return builder;
  }

  const db: any = {
    select: () => selectBuilder(),
    insert: (table: unknown) => insertBuilder(table),
    update: (table: unknown) => updateBuilder(table),
    execute: async () => [],
    transaction: async (callback: (tx: any) => unknown) => callback(db),
  };
  return { db, state };
}

function evaluationInput(overrides: Record<string, unknown> = {}) {
  return evaluateGoalSchema.parse({ evidenceRefs: ["artifact://result"], ...overrides });
}

describe("Goal contract", () => {
  it("returns change proposals as plain-language summaries without Contract fields", () => {
    const proposal = publicGoalChangeProposal({
      id: "change-1",
      status: "pending",
      rationale: "The autonomy envelope and evaluator changed; see artifact://private.",
      evidenceRefs: ["artifact://private"],
      beforeContract: {
        outcomeStatement: "Ship the verified result",
        objectiveMode: "target",
        criteria: [{ id: "result", label: "The result is verified", evaluator: "artifact" }],
        autonomyEnvelope: { allowed: ["bounded_reversible_work"] },
        humanAuthorities: { acceptance: "board_human" },
        evaluationPolicy: { terminalEvidenceRequired: true, humanAcceptanceRequired: true },
        actionDeadline: null,
        evaluationDeadline: "2026-08-20T10:00:00.000Z",
      },
      afterContract: {
        outcomeStatement: "Ship the verified result after restart",
        criteria: [{ id: "result", label: "The result remains verified", evaluator: "artifact" }],
        autonomyEnvelope: {
          allowed: ["bounded_reversible_work"],
          requiresHumanApproval: ["external_publication"],
        },
        humanAuthorities: { acceptance: "board_human", externalPublication: "board_human" },
        evaluationPolicy: { terminalEvidenceRequired: true, humanAcceptanceRequired: true },
        evaluationDeadline: "2026-08-22T10:00:00.000Z",
      },
    } as never);
    const text = JSON.stringify({
      rationale: proposal.rationale,
      beforeSummary: proposal.beforeSummary,
      afterSummary: proposal.afterSummary,
    });
    expect(text).toContain("Ship the verified result after restart");
    expect(text).toContain("publishing externally");
    expect(text).toContain("You decide");
    expect(text).not.toContain("autonomyEnvelope");
    expect(text).not.toContain("objectiveMode");
    expect(text).not.toContain("evaluator");
    expect(text).not.toContain("artifact://");
  });

  it("hashes the canonical Start packet that survives request validation unchanged", () => {
    const preview = compileGoalStartPreview(previewGoalStartSchema.parse({
      title: "Publish a verified Goal Workspace release candidate",
      context: "Keep the result inspectable.",
      ownerAgentId: OWNER_ID,
      targetTime: "2026-08-20T10:00:00.000Z",
    }), makePreviewOwner());
    const parsed = startGoalSchema.parse({
      requestKey: "goal-start-roundtrip",
      packetHash: preview.packetHash,
      packet: preview.packet,
    });

    expect(stableGoalHash(parsed.packet)).toBe(preview.packetHash);
  });

  it("keeps long but ambiguous Goals in alignment", () => {
    const preview = compileGoalStartPreview(previewGoalStartSchema.parse({
      title: "Explore pricing options",
      context: null,
      ownerAgentId: OWNER_ID,
      targetTime: null,
    }), makePreviewOwner());

    expect(preview.valid).toBe(false);
    expect(preview.packet).toBeNull();
    expect(preview.blockers).toEqual([expect.objectContaining({
      code: "outcome_required",
      field: "goal",
    })]);
    expect(preview.alignmentQuestion).toMatch(/observable result or decision/i);
  });

  it("returns an actionable Owner blocker from the same start decision", () => {
    const preview = compileGoalStartPreview(previewGoalStartSchema.parse({
      title: "Publish a verified Goal Workspace release candidate",
      context: null,
      ownerAgentId: null,
      targetTime: null,
    }), null);

    expect(preview.valid).toBe(false);
    expect(preview.blockers).toEqual([expect.objectContaining({
      code: "owner_required",
      field: "ownerAgentId",
    })]);
    expect(preview.alignmentQuestion).toMatch(/which available/i);
  });

  it("uses context in the success criterion and infers objective modes", () => {
    const cases = [
      ["Publish a verified release candidate", "target", "artifact"],
      ["Increase activation rate by 20%", "maximize", "metric"],
      ["Maintain service uptime above 99.9%", "maintain", "policy"],
      ["Decide which pricing model to launch", "decide", "human"],
    ] as const;

    for (const [title, objectiveMode, evaluator] of cases) {
      const preview = compileGoalStartPreview(previewGoalStartSchema.parse({
        title,
        context: "The result must preserve existing customer data.",
        ownerAgentId: OWNER_ID,
        targetTime: null,
      }), makePreviewOwner());

      expect(preview.valid).toBe(true);
      expect(preview.review?.success).toContain("preserve existing customer data");
      expect(preview.packet?.activation.objectiveMode).toBe(objectiveMode);
      expect(preview.packet?.activation.criteria[0]?.evaluator).toBe(evaluator);
    }
  });

  it("accepts a clear desired state without requiring command-style wording", () => {
    const preview = compileGoalStartPreview(previewGoalStartSchema.parse({
      title: "Customers renew without manual support",
      context: null,
      ownerAgentId: OWNER_ID,
      targetTime: null,
    }), makePreviewOwner());

    expect(preview.valid).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.packet?.activation.outcomeStatement).toBe("Customers renew without manual support");
    expect(preview.packet?.activation.initialContinuation.summary).toBe(preview.review?.firstAction);
  });

  it.each([
    "rudder 1k star in Aug",
    "rudder 10k stars in Aug",
  ])("accepts compact measurable target wording: %s", (title) => {
    const preview = compileGoalStartPreview(previewGoalStartSchema.parse({
      title,
      context: null,
      ownerAgentId: OWNER_ID,
      targetTime: "2026-08-31T23:59:00.000Z",
    }), makePreviewOwner());

    expect(preview.valid).toBe(true);
    expect(preview.blockers).toEqual([]);
    expect(preview.packet?.activation.outcomeStatement).toBe(title);
  });

  it.each([
    ["queued", "The Agent is working on this Goal."],
    ["running", "The Agent is working on this Goal."],
    ["succeeded", "The Agent completed its latest action."],
    ["completed", "The Agent completed its latest action."],
    ["failed", "The Agent could not complete its latest action."],
    ["cancelled", "The Agent stopped its latest action."],
    ["timed_out", "The Agent's latest action needs attention."],
  ])("keeps %s run summaries plain-language even when the provider includes an internal identifier", (status, expected) => {
    expect(publicRunSummary({
      status,
      resultJson: { summary: `Agent run 85d206b4 is ${status}.` },
      resultSummaryJson: null,
      error: null,
    })).toBe(expected);
  });

  it("preserves a readable run result without exposing the run concept", () => {
    expect(publicRunSummary({
      status: "succeeded",
      resultJson: { summary: "The linked issue produced a reviewable artifact." },
      resultSummaryJson: null,
      error: null,
    })).toBe("The linked issue produced a reviewable artifact.");
  });

  it("strips the provider result envelope from Goal progress", () => {
    const envelope = "__RUDDER_RESULT_TEST__" + JSON.stringify({
      kind: "message",
      body: "The Agent completed the requested verification.",
      structuredPayload: { internal: "metadata" },
    });
    expect(publicRunSummary({
      status: "succeeded",
      resultJson: { summary: `Streaming reply for chat.\n${envelope}` },
      resultSummaryJson: null,
      error: null,
    })).toBe("The Agent completed the requested verification.");
  });

  it("keeps internal Goal implementation terms out of public progress language", () => {
    expect(publicGoalText(
      "Current Goal contract, objective mode, evaluator, evidence requirements, autonomy envelope, human authorities, continuation, change proposal, result proposal, and runtime evidence are being checked.",
    )).toBe(
      "Current Goal, Goal type, success check, what we need to verify, working boundaries, decisions that need you, next step, Goal update, result review, and supporting evidence are being checked.",
    );
    expect(publicGoalText("The contract and contract revision are ready for review.")).toBe(
      "The agreement and Goal update are ready for review.",
    );
    expect(publicGoalActivitySummary({
      activityKind: "progress",
      summary: "Current Goal contract and runtime evidence are being checked.",
    })).toBe("Current Goal and supporting evidence are being checked.");
    expect(publicGoalActivitySummary({
      activityKind: "progress",
      summary: "Evidence demonstrates that the latest checkpoint is recorded for 85d206b4-6e1f-4f24-9d98-76e3c0f3d1a2.",
    })).toBe("Supporting work shows that the latest checkpoint is recorded for the related item.");
  });

  it("preserves the useful part of an internal run summary", () => {
    expect(publicRunSummary({
      status: "succeeded",
      resultJson: { summary: "Agent run 85d206b4 is succeeded: The linked issue produced a reviewable artifact." },
      resultSummaryJson: null,
      error: null,
    })).toBe("The linked issue produced a reviewable artifact.");
  });

  it("keeps free-form agent progress language user-facing", () => {
    expect(publicRunSummary({
      status: "succeeded",
      resultJson: {
        summary: "I'm reviewing the feedback against contract revision 1 and the recorded continuation. I'll use the `para-memory-files` skill for the required daily-note update.",
      },
      resultSummaryJson: null,
      error: null,
    })).toBe("I'm reviewing the feedback against Goal update 1 and the recorded next step. I'll use shared notes for the required notes update.");
  });

  it("hides provider errors and opaque identifiers from Goal progress", () => {
    expect(publicRunSummary({
      status: "failed",
      resultJson: { error: "DrizzleQueryError: write CONNECTION_ENDED 127.0.0.1:55883" },
      resultSummaryJson: null,
      error: null,
    })).toBe("The Agent could not complete its latest action.");
    expect(publicRunSummary({
      status: "succeeded",
      resultJson: { summary: "Agent run 85d206b4-6e1f-4f24-9d98-76e3c0f3d1a2 is succeeded: DrizzleQueryError: write failed" },
      resultSummaryJson: null,
      error: null,
    })).toBe("The Agent completed its latest action.");
    expect(publicGoalText("Feedback 85d206b4-6e1f-4f24-9d98-76e3c0f3d1a2 is linked to goal-feedback:85d206b4-6e1f-4f24-9d98-76e3c0f3d1a2."))
      .not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
  });

  it("hides process adapter failures from the public Goal workspace", () => {
    expect(publicRunSummary({
      status: "failed",
      resultJson: { error: "Process adapter missing command" },
      resultSummaryJson: null,
      error: null,
    })).toBe("The Agent could not complete its latest action.");
  });

  it("keeps the Goal workspace read model separate from the internal Contract", () => {
    const goal = publicGoalView(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
      focus: true,
      autonomyEnvelope: { allowed: ["bounded_reversible_work"] },
      humanAuthorities: { consequentialChanges: "board_human" },
      evaluationPolicy: { humanAcceptanceRequired: true },
      evaluationResult: { outcome: "achieved", resultPayload: { private: true } },
    }) as any);

    expect(goal).toMatchObject({ id: GOAL_ID, shortRef: "gol_33333333", orgId: ORG_ID, ownerAgentId: OWNER_ID, focus: true });
    expect(goal.criteria).toEqual([{ id: "result", label: "Result exists" }]);
    expect(Object.keys(goal)).not.toEqual(expect.arrayContaining([
      "objectiveMode",
      "contractRevision",
      "autonomyEnvelope",
      "humanAuthorities",
      "evaluationPolicy",
      "resultPayload",
      "planRevision",
      "continuationKind",
    ]));
    expect(goal.evaluationResult).toEqual({ outcome: "achieved" });
  });

  it("keeps result proposals to public outcome fields", () => {
    const proposal = publicGoalResultProposal({
      id: "proposal-1",
      status: "ready",
      riskSummary: "The contract revision is ready; see artifact://private-proof.",
      preflight: {
        outcome: "achieved",
        criteria: [{ id: "result", evaluator: "artifact", status: "met", missingEvidence: [] }],
        resultValue: null,
        decision: null,
      },
      candidate: {
        evidenceRefs: ["artifact://private-proof"],
        resultPayload: { private: true },
      },
      contractRevision: 4,
      candidateHash: "private-hash",
      idempotencyKey: "private-key",
      proposedByAgentId: OWNER_ID,
    } as any);

    expect(proposal).toMatchObject({
      id: "proposal-1",
      status: "ready",
      outcome: "achieved",
      outcomeLabel: "Goal achieved",
      criteria: [{ id: "result", status: "met", missingEvidenceCount: 0 }],
      evidence: [{ label: "Supporting work 1", href: null, external: false }],
      riskSummary: "The Goal update is ready; see supporting work",
    });
    expect(Object.keys(proposal)).not.toEqual(expect.arrayContaining([
      "candidate",
      "candidateHash",
      "preflight",
      "contractRevision",
      "idempotencyKey",
      "proposedByAgentId",
    ]));
  });

  it("keeps the HTTP Goal Workspace response allowlisted", async () => {
    const { db, state } = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
      focus: true,
    }));
    state.resultProposals.push({
      id: "result-1",
      goalId: GOAL_ID,
      status: "ready",
      createdAt: new Date("2026-08-04T00:10:00.000Z"),
      riskSummary: "The contract revision is ready; see artifact://private-proof.",
      preflight: {
        outcome: "achieved",
        criteria: [{ id: "result", status: "met", missingEvidence: [] }],
      },
      candidate: {
        evidenceRefs: ["artifact://private-proof"],
        resultPayload: { private: true },
      },
      contractRevision: 9,
      candidateHash: "private-candidate-hash",
      idempotencyKey: "private-key",
      proposedByAgentId: OWNER_ID,
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "board-user" };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);

    const response = await request(app).get(`/api/goals/${GOAL_ID}/workspace`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.goal).toMatchObject({ id: GOAL_ID, ownerAgentId: OWNER_ID, focus: true });
    expect(Object.keys(response.body.goal)).not.toEqual(expect.arrayContaining([
      "objectiveMode",
      "contractRevision",
      "autonomyEnvelope",
      "humanAuthorities",
      "evaluationPolicy",
      "resultPayload",
      "planRevision",
      "continuationKind",
    ]));
    expect(response.body.agentAction).toBeNull();
    expect(response.body.nextStep).toEqual({ summary: "Review the proposed result above.", wakeCondition: null });
    expect(response.body.resultProposals[0]).toMatchObject({
      id: "result-1",
      status: "ready",
      outcome: "achieved",
      outcomeLabel: "Goal achieved",
    });
    expect(Object.keys(response.body.resultProposals[0])).not.toEqual(expect.arrayContaining([
      "candidate",
      "candidateHash",
      "preflight",
      "contractRevision",
      "idempotencyKey",
      "proposedByAgentId",
    ]));
    expect(JSON.stringify(response.body)).not.toContain("private-candidate-hash");
  });

  it("lets a runtime Agent discover only its owned active Goals", async () => {
    const { db } = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
      focus: true,
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        source: "agent_key",
        orgId: ORG_ID,
        agentId: OWNER_ID,
      };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);

    const response = await request(app).get(`/api/orgs/${ORG_ID}/goals/assigned`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      count: 1,
      filters: { lifecycle: "active", focus: null, facet: null, limit: 20 },
      goals: [{ id: GOAL_ID, ownerAgentId: OWNER_ID, lifecycle: "active" }],
    });
  });

  it("returns the exact owned Goal agreement and operating state to the runtime Agent", async () => {
    const { db } = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
      contractRevision: 7,
      autonomyEnvelope: { allowed: ["bounded_work"] },
      humanAuthorities: { close: "board_human" },
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        source: "agent_key",
        orgId: ORG_ID,
        agentId: OWNER_ID,
      };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);

    const response = await request(app).get(`/api/goals/${GOAL_ID}/agent-context`);

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      goal: { id: GOAL_ID, ownerAgentId: OWNER_ID, lifecycle: "active" },
      contract: {
        revision: 7,
        objectiveMode: "target",
        criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
        autonomyEnvelope: { allowed: ["bounded_work"] },
        humanAuthorities: { close: "board_human" },
      },
      state: { facet: "agent_advancing" },
      allowedActions: { reportProgress: true, proposeChange: true, proposeResult: true },
    });
  });

  it("canonicalizes typed Goal references before reading runtime routes", async () => {
    const { db } = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        source: "agent_key",
        orgId: ORG_ID,
        agentId: OWNER_ID,
      };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);

    const [detail, context] = await Promise.all([
      request(app).get("/api/goals/gol_33333333"),
      request(app).get("/api/goals/gol_33333333/agent-context"),
    ]);

    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(detail.body.id).toBe(GOAL_ID);
    expect(context.status, JSON.stringify(context.body)).toBe(200);
    expect(context.body.goal).toMatchObject({ id: GOAL_ID, ownerAgentId: OWNER_ID });
  });

  it("rejects cross-organization discovery and non-owner Goal context", async () => {
    const { db } = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
    }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        source: "agent_key",
        orgId: ORG_ID,
        agentId: OTHER_ORG_OWNER_ID,
      };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);

    const [crossOrg, nonOwner] = await Promise.all([
      request(app).get(`/api/orgs/${OTHER_ORG_ID}/goals/assigned`),
      request(app).get(`/api/goals/${GOAL_ID}/agent-context`),
    ]);

    expect(crossOrg.status).toBe(403);
    expect(nonOwner.status).toBe(403);
    expect(nonOwner.body.error).toBe("Agents can only read runtime context for Goals they own");
  });

  it("keeps legacy Goal read endpoints on the public read model", async () => {
    const { db, state } = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
    }));
    state.activities.push({
      id: "activity-1",
      orgId: ORG_ID,
      goalId: GOAL_ID,
      activityKind: "progress",
      submittedByAgentId: OWNER_ID,
      evidenceRefs: ["artifact://private-progress"],
      summary: "The Contract revision is backed by runtime evidence.",
      occurredAt: new Date("2026-08-04T00:05:00.000Z"),
      createdAt: new Date("2026-08-04T00:05:00.000Z"),
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "local_implicit", userId: "board-user" };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);

    const detail = await request(app).get(`/api/goals/${GOAL_ID}`);
    const activities = await request(app).get(`/api/goals/${GOAL_ID}/activities`);

    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(activities.status, JSON.stringify(activities.body)).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain("private-progress");
    expect(JSON.stringify(activities.body)).not.toContain("private-progress");
    expect(detail.body).not.toHaveProperty("objectiveMode");
    expect(detail.body).not.toHaveProperty("contractRevision");
    expect(detail.body.activities[0]).toMatchObject({
      id: "activity-1",
      evidence: [{ label: "Supporting work 1", href: null, external: false }],
    });
    expect(detail.body.activities[0]).not.toHaveProperty("evidenceRefs");
    expect(activities.body[0]).not.toHaveProperty("evidenceRefs");
  });

  it("requires board authority to change the organization Focus Goal", async () => {
    const { db } = createGoalDb(makeGoal({ lifecycle: "active", status: "active" }));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        source: "agent_key",
        orgId: ORG_ID,
        agentId: OWNER_ID,
      };
      next();
    });
    app.use("/api", goalRoutes(db));
    app.use(errorHandler);

    const response = await request(app)
      .post(`/api/goals/${GOAL_ID}/focus`)
      .send({ focus: true });

    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(response.body.error).toBe("Board access required");
  });

  it("warns when an available Agent may not cover the Goal without blocking explicit user assignment", () => {
    const preview = compileGoalStartPreview(previewGoalStartSchema.parse({
      title: "Publish a verified software release candidate",
      context: "Run automated tests and preserve existing API behavior.",
      ownerAgentId: OWNER_ID,
      targetTime: null,
    }), makePreviewOwner({
      role: "general",
      title: "Recruiting coordinator",
      capabilities: "Schedules interviews and manages candidate communications.",
    }));

    expect(preview.valid).toBe(true);
    expect(preview.packet).not.toBeNull();
    expect(preview.warning).toMatch(/may not be the best match/i);
    expect(preview.alignmentQuestion).toBeNull();
  });

  it("requires a Run reference for closeout Activities", () => {
    expect(() => createGoalActivitySchema.parse({
      summary: "Unbound closeout",
      activityKind: "closeout",
      evidenceRefs: ["artifact://unbound"],
    })).toThrow(/Run reference/);
  });

  it("requires explicit confirmation, Owner, Contract, Plan, and continuation for activation", () => {
    expect(() => activateGoalSchema.parse({})).toThrow();
    expect(() => activateGoalSchema.parse({ confirmed: false })).toThrow();

    const parsed = activateGoalSchema.parse({
      confirmed: true,
      ownerAgentId: OWNER_ID,
      outcomeStatement: "The verified result is available",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
      initialContinuation: { kind: "verification", summary: "Verify the next result" },
      initialPlan: { summary: "Build and verify the result" },
    });
    expect(parsed.initialPlan.summary).toBe("Build and verify the result");
    expect(parsed.initialContinuation.kind).toBe("verification");
    expect(() => activateGoalSchema.parse({
      confirmed: true,
      ownerAgentId: OWNER_ID,
      outcomeStatement: "The verified result is available",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "legacy" }],
      initialContinuation: { kind: "verification", summary: "Verify the next result" },
      initialPlan: { summary: "Build and verify the result" },
    })).toThrow();
    expect(() => activateGoalSchema.parse({
      confirmed: true,
      ownerAgentId: OWNER_ID,
      outcomeStatement: "   ",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "   ", evaluator: "artifact" }],
      initialContinuation: { kind: "verification", summary: "   " },
      initialPlan: { summary: "   " },
    })).toThrow();
    expect(() => activateGoalSchema.parse({
      confirmed: true,
      ownerAgentId: OWNER_ID,
      outcomeStatement: "The verified result is available",
      objectiveMode: "target",
      criteria: [
        { id: "result", label: "Result exists", evaluator: "artifact" },
        { id: " result ", label: "Result is still inspectable", evaluator: "policy" },
      ],
      initialContinuation: { kind: "verification", summary: "Verify the next result" },
      initialPlan: { summary: "Build and verify the result" },
    })).toThrow(/Criterion IDs must be unique/);
  });

  it.each([
    ["target", { criteria: [{ id: "result", status: "met" }] }, "achieved"],
    ["target", { criteria: [{ id: "result", status: "unmet" }] }, "not_achieved"],
    ["maximize", { criteria: [{ id: "result", status: "met" }], resultValue: 42 }, "completed_with_result"],
    ["maintain", { criteria: [{ id: "result", status: "breached" }] }, "breached"],
    ["maintain", { criteria: [{ id: "result", status: "met" }] }, "maintained"],
    ["decide", { criteria: [{ id: "result", status: "met" }], decision: "Choose path B" }, "decided"],
  ])("reduces %s evaluation to %s", (mode, input, outcome) => {
    const result = reduceGoalEvaluation(
      { objectiveMode: mode as "target" | "maximize" | "maintain" | "decide", criteria: [{ id: "result" }] },
      evaluationInput(input),
    );
    expect(result.outcome).toBe(outcome);
  });

  it("does not produce positive maximize or decide Proof when a criterion fails", () => {
    expect(reduceGoalEvaluation(
      { objectiveMode: "maximize", criteria: [{ id: "result" }, { id: "safety" }] },
      evaluationInput({ resultValue: 42, criteria: [{ id: "result", status: "met" }, { id: "safety", status: "unmet" }] }),
    ).outcome).toBe("inconclusive");
    expect(reduceGoalEvaluation(
      { objectiveMode: "decide", criteria: [{ id: "result" }, { id: "safety" }] },
      evaluationInput({ decision: "Choose path B", criteria: [{ id: "result", status: "met" }, { id: "safety", status: "breached" }] }),
    ).outcome).toBe("inconclusive");
  });

  it("keeps inconclusive maximize and decide evaluations active for more evidence", async () => {
    for (const objectiveMode of ["maximize", "decide"] as const) {
      const { db, state } = createGoalDb(makeGoal({
        objectiveMode,
        lifecycle: "active",
        status: "active",
        ownerAgentId: OWNER_ID,
        planRevision: 1,
        focus: true,
        criteria: [{ id: "result", label: "Result exists", evaluator: objectiveMode === "maximize" ? "metric" : "human" }],
      }));
      const result = await goalService(db).evaluate(GOAL_ID, evaluationInput({
        criteria: [{ id: "result", status: "unknown" }],
      }));
      expect(result.evaluationResult).toMatchObject({ outcome: "inconclusive" });
      expect(result.lifecycle).toBe("active");
      expect(result.status).toBe("active");
      expect(state.goals[0]!.focus).toBe(true);
    }
  });

  it("keeps incomplete evidence inconclusive", () => {
    expect(reduceGoalEvaluation(
      { objectiveMode: "target", criteria: [{ id: "result" }] },
      evaluationInput({ criteria: [{ id: "result", status: "unknown" }] }),
    ).outcome).toBe("inconclusive");
    expect(reduceGoalEvaluation(
      { objectiveMode: "maximize", criteria: [{ id: "result" }] },
      evaluationInput(),
    ).outcome).toBe("inconclusive");
    expect(reduceGoalEvaluation(
      { objectiveMode: "decide", criteria: [{ id: "result" }] },
      evaluationInput(),
    ).outcome).toBe("inconclusive");
  });

  it("does not treat evaluator status as met when its evidence contract is incomplete", () => {
    expect(reduceGoalEvaluation(
      {
        objectiveMode: "maximize",
        criteria: [{ id: "metric", evaluator: "metric" }],
      },
      evaluationInput({ criteria: [{ id: "metric", status: "met" }] }),
    ).criteria[0]).toMatchObject({ status: "unknown", evidenceSatisfied: false });
    expect(reduceGoalEvaluation(
      {
        objectiveMode: "target",
        criteria: [{ id: "artifact", evaluator: "artifact", evidenceRequirements: ["artifact://required"] }],
      },
      evaluationInput({ criteria: [{ id: "artifact", status: "met" }] }),
    ).criteria[0]).toMatchObject({ status: "unknown", missingEvidence: ["artifact://required"] });
    expect(reduceGoalEvaluation(
      {
        objectiveMode: "decide",
        criteria: [{ id: "human", evaluator: "human" }],
      },
      evaluationInput({ criteria: [{ id: "human", status: "met" }] }),
    ).criteria[0]).toMatchObject({ status: "unknown", evidenceSatisfied: false });
    expect(reduceGoalEvaluation(
      {
        objectiveMode: "maintain",
        criteria: [{ id: "policy", evaluator: "policy", evidenceRequirements: ["artifact://boundary"] }],
      },
      evaluationInput({ evidenceRefs: ["artifact://unrelated"], criteria: [{ id: "policy", status: "breached" }] }),
    ).criteria[0]).toMatchObject({ status: "unknown", evidenceSatisfied: false });
  });

  it("requires structured evidence references and meaningful metric results", () => {
    expect(() => evaluateGoalSchema.parse({ evidenceRefs: [null] })).toThrow();
    expect(() => evaluateGoalSchema.parse({ evidenceRefs: ["plain text"] })).toThrow();
    expect(() => evaluateGoalSchema.parse({ evidenceRefs: ["artifact://result"], resultValue: null })).toThrow();
    expect(() => evaluateGoalSchema.parse({ evidenceRefs: ["artifact://result"], resultValue: {} })).toThrow();
    expect(() => createGoalActivitySchema.parse({ summary: "Bad evidence", evidenceRefs: ["plain text"] })).toThrow();
  });

  it("supports metric and human evaluators for every objective mode", () => {
    expect(reduceGoalEvaluation(
      { objectiveMode: "target", criteria: [{ id: "metric", evaluator: "metric" }] },
      evaluationInput({ resultValue: 42, criteria: [{ id: "metric", status: "met" }] }),
    ).outcome).toBe("achieved");
    expect(reduceGoalEvaluation(
      { objectiveMode: "target", criteria: [{ id: "human", evaluator: "human" }] },
      evaluationInput({ decision: "Approve path B", criteria: [{ id: "human", status: "met" }] }),
    ).outcome).toBe("achieved");
  });

  it("does not expose legacy lifecycle fields through Goal updates", () => {
    expect(updateGoalSchema.parse({ title: "Renamed Goal" })).toEqual({ title: "Renamed Goal" });
    expect(() => updateGoalSchema.parse({ status: "achieved" })).toThrow();
    expect(updateGoalSchema.parse({
      ownerAgentId: OWNER_ID,
      targetTime: "2026-08-20T10:00:00.000Z",
    })).toEqual({
      ownerAgentId: OWNER_ID,
      targetTime: new Date("2026-08-20T10:00:00.000Z"),
    });
  });

  it("rejects an Owner from another organization", async () => {
    const { db, state } = createGoalDb();
    state.rejectOwnerLookup = true;
    const svc = goalService(db);
    await expect(svc.activate(GOAL_ID, activateGoalSchema.parse({
      confirmed: true,
      ownerAgentId: OTHER_ORG_OWNER_ID,
      outcomeStatement: "The verified result is available",
      objectiveMode: "target",
      criteria: [{ id: "result", label: "Result exists", evaluator: "artifact" }],
      initialContinuation: { kind: "verification", summary: "Verify the next result" },
      initialPlan: { summary: "Build and verify the result" },
    }))).rejects.toMatchObject({ status: 422 });
  });

  it("clears a Draft Owner's runtime override when ownership changes", async () => {
    const { db, state } = createGoalDb(makeGoal({
      ownerAgentId: OWNER_ID,
      ownerAgentRuntimeOverrides: { agentRuntimeConfig: { model: "gpt-5.6-sol" } },
    }));
    state.agents.push(makePreviewOwner({ id: SECOND_OWNER_ID, name: "Second Goal owner" }));

    const updated = await goalService(db).update(GOAL_ID, { ownerAgentId: SECOND_OWNER_ID });

    expect(updated.ownerAgentId).toBe(SECOND_OWNER_ID);
    expect(updated.ownerAgentRuntimeOverrides).toBeNull();
  });

  it("rejects non-owner Agent commands and incomplete legacy active Goals", async () => {
    const { db } = createGoalDb(makeGoal({ lifecycle: "active", status: "active", ownerAgentId: OWNER_ID, planRevision: 1 }));
    const svc = goalService(db);
    await expect(svc.update(GOAL_ID, { title: "Unauthorized rename" }, OTHER_ORG_OWNER_ID)).rejects.toMatchObject({ status: 403 });
    await expect(svc.update(GOAL_ID, { title: "Silent owner rename" }, OWNER_ID)).rejects.toMatchObject({ status: 403 });
    await expect(svc.updatePlan(GOAL_ID, { summary: "Unauthorized revision" }, OTHER_ORG_OWNER_ID)).rejects.toMatchObject({ status: 403 });

    const incomplete = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      outcomeStatement: null,
      criteria: [],
      ownerAgentId: null,
      planRevision: 0,
      continuationKind: null,
      continuationSummary: null,
    }));
    await expect(goalService(incomplete.db).evaluate(GOAL_ID, evaluationInput({ criteria: [{ id: "result", status: "met" }] }))).rejects.toMatchObject({ status: 409 });
  });

  it("keeps closed Goals immutable and suppresses stale History attention", async () => {
    const { db, state } = createGoalDb(makeGoal({
      lifecycle: "closed",
      status: "achieved",
      ownerAgentId: OWNER_ID,
      planRevision: 1,
    }));
    state.changeProposals.push({
      id: "stale-change-proposal",
      goalId: GOAL_ID,
      status: "pending",
      rationale: "This obsolete decision must not appear in History.",
      createdAt: new Date("2026-08-03T00:00:00.000Z"),
    });
    const svc = goalService(db);

    await expect(svc.update(GOAL_ID, {
      title: "Rewrite an accepted result",
      description: "This must remain immutable.",
    })).rejects.toMatchObject({ status: 409 });
    expect(state.goals[0]!.title).toBe("Ship the verified result");

    const [card] = await svc.workspaceCards(ORG_ID);
    expect(card?.facet).toBe("closed");
    expect(card?.attentionReason).toBeNull();
  });

  it("makes activity submission idempotent and requires a terminal Run for closeout", async () => {
    const { db, state } = createGoalDb(makeGoal({ lifecycle: "active", status: "active", ownerAgentId: OWNER_ID, planRevision: 1 }));
    const svc = goalService(db);

    const first = await svc.createActivity(GOAL_ID, {
      summary: "The same progress update",
      activityKind: "progress",
      evidenceRefs: [],
      idempotencyKey: "progress-1",
    });
    const retry = await svc.createActivity(GOAL_ID, {
      summary: "The same progress update",
      activityKind: "progress",
      evidenceRefs: [],
      idempotencyKey: "progress-1",
    });
    expect(retry?.id).toBe(first?.id);
    expect(state.activities).toHaveLength(1);

    await expect(svc.createActivity(GOAL_ID, {
      summary: "Agent progress without a Run",
      activityKind: "progress",
      evidenceRefs: ["artifact://unbound-progress"],
    }, OWNER_ID)).rejects.toMatchObject({ status: 422 });

    await expect(svc.createActivity(GOAL_ID, {
      summary: "Closeout without a Run",
      activityKind: "closeout",
      evidenceRefs: ["artifact://unbound"],
    })).rejects.toMatchObject({ status: 422 });

    await expect(svc.createActivity(GOAL_ID, {
      summary: "Run is still executing",
      activityKind: "closeout",
      runRef: RUN_ID,
      evidenceRefs: ["run://pending"],
    })).rejects.toMatchObject({ status: 409 });

    state.runs[0]!.status = "succeeded";
    const closeout = await svc.createActivity(GOAL_ID, {
      summary: "Run completed with the verified artifact",
      activityKind: "closeout",
      runRef: RUN_ID,
      evidenceRefs: ["run://completed"],
    });
    expect(closeout?.activityKind).toBe("closeout");
    await expect(svc.createActivity(GOAL_ID, {
      summary: "Duplicate closeout",
      activityKind: "closeout",
      runRef: RUN_ID,
      evidenceRefs: ["run://completed"],
    })).rejects.toMatchObject({ status: 409 });
    await expect(svc.createActivity(GOAL_ID, {
      summary: "Duplicate closeout with a new idempotency key",
      activityKind: "closeout",
      runRef: RUN_ID,
      evidenceRefs: ["run://completed"],
      idempotencyKey: "closeout-retry-1",
    })).rejects.toMatchObject({ status: 409 });
  });

  it("prioritizes an idempotent closeout retry over the Run uniqueness conflict", async () => {
    const { db, state } = createGoalDb(makeGoal({ lifecycle: "active", status: "active", ownerAgentId: OWNER_ID, planRevision: 1 }));
    state.runs[0]!.status = "succeeded";
    const svc = goalService(db);
    const payload = {
      summary: "Run completed with the verified artifact",
      activityKind: "closeout" as const,
      runRef: RUN_ID,
      evidenceRefs: ["run://completed"],
      idempotencyKey: "closeout-1",
    };
    const first = await svc.createActivity(GOAL_ID, payload);
    const retry = await svc.createActivity(GOAL_ID, payload);
    expect(retry?.id).toBe(first?.id);
    expect(state.activities).toHaveLength(1);
  });

  it("rejects Activity attribution to a Run linked to another Goal", async () => {
    const { db, state } = createGoalDb(makeGoal({ lifecycle: "active", status: "active", ownerAgentId: OWNER_ID, planRevision: 1 }));
    state.runs[0]!.goalId = SECOND_GOAL_ID;
    state.runs[0]!.contextSnapshot = { goalId: SECOND_GOAL_ID };

    await expect(goalService(db).createActivity(GOAL_ID, {
      summary: "Progress from another Goal must stay isolated",
      activityKind: "progress",
      runRef: RUN_ID,
      evidenceRefs: ["artifact://other-goal/progress"],
    }, OWNER_ID)).rejects.toMatchObject({ status: 422 });
    expect(state.activities).toHaveLength(0);
  });

  it("blocks deletion when a live Calendar event still references the Goal", async () => {
    const { db, state } = createGoalDb();
    state.calendarEvents.push({
      id: "calendar-event-1",
      orgId: ORG_ID,
      goalId: GOAL_ID,
      title: "Goal review",
      status: "scheduled",
    });
    const dependencies = await goalService(db).dependencies(state.goals[0] as any);
    expect(dependencies.canDelete).toBe(false);
    expect(dependencies.blockers).toContain("calendar_events");
    expect(dependencies.counts.calendarEvents).toBe(1);
    expect(dependencies.previews.calendarEvents).toEqual([{ id: "calendar-event-1", title: "Goal review", subtitle: "scheduled" }]);
  });

  it("keeps Focus when direct terminal evaluation is blocked pending human acceptance", async () => {
    const { db, state } = createGoalDb(makeGoal({
      lifecycle: "active",
      status: "active",
      ownerAgentId: OWNER_ID,
      planRevision: 1,
      focus: true,
    }));
    await expect(goalService(db).evaluate(
      GOAL_ID,
      evaluationInput({ criteria: [{ id: "result", status: "met" }] }),
    )).rejects.toMatchObject({ status: 409 });
    expect(state.goals[0]!.lifecycle).toBe("active");
    expect(state.goals[0]!.focus).toBe(true);
  });

  it("keeps Focus unique within an organization", async () => {
    const firstFixture = createGoalDb(makeGoal({ lifecycle: "active", status: "active", ownerAgentId: OWNER_ID, planRevision: 1, focus: true }));
    const { db, state } = firstFixture;
    state.goals[1]!.lifecycle = "active";
    state.goals[1]!.status = "active";
    state.goals[1]!.ownerAgentId = OWNER_ID;
    state.goals[1]!.planRevision = 1;
    state.goals[1]!.focus = false;
    state.selectedGoalId = SECOND_GOAL_ID;
    const svc = goalService(db);

    await svc.setFocus(SECOND_GOAL_ID, true);

    expect(state.goals.filter((goal) => goal.focus).map((goal) => goal.id)).toEqual([SECOND_GOAL_ID]);
  });
});
