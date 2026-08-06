import { agents, calendarEvents, goalActivities, goalOwnerAssignments, goalPlans, goals, heartbeatRuns } from "@rudderhq/db";
import {
  activateGoalSchema,
  createGoalActivitySchema,
  evaluateGoalSchema,
  previewGoalStartSchema,
  startGoalSchema,
  updateGoalSchema,
} from "@rudderhq/shared";
import { describe, expect, it } from "vitest";
import { compileGoalStartPreview, goalService, reduceGoalEvaluation, stableGoalHash } from "../services/goals.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG_ID = "22222222-2222-4222-8222-222222222222";
const GOAL_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_GOAL_ID = "44444444-4444-4444-8444-444444444444";
const OWNER_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_ORG_OWNER_ID = "66666666-6666-4666-8666-666666666666";
const RUN_ID = "77777777-7777-4777-8777-777777777777";

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
    runs: [{ id: RUN_ID, orgId: ORG_ID, status: "running" }],
    calendarEvents: [] as Array<Record<string, unknown>>,
    activities: [] as Array<Record<string, unknown>>,
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
      where() {
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit() {
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
    transaction: async (callback: (tx: any) => unknown) => callback(db),
  };
  return { db, state };
}

function evaluationInput(overrides: Record<string, unknown> = {}) {
  return evaluateGoalSchema.parse({ evidenceRefs: ["artifact://result"], ...overrides });
}

describe("Goal contract", () => {
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
    expect(preview.alignmentQuestion).toMatch(/observable result or decision/i);
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

  it("rejects an available same-organization Agent whose capabilities do not cover the Goal", () => {
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

    expect(preview.valid).toBe(false);
    expect(preview.packet).toBeNull();
    expect(preview.alignmentQuestion).toMatch(/better-matched Agent/i);
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
    expect(() => updateGoalSchema.parse({ ownerAgentId: OWNER_ID })).toThrow();
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

  it("rejects non-owner Agent commands and incomplete legacy active Goals", async () => {
    const { db } = createGoalDb(makeGoal({ lifecycle: "active", status: "active", ownerAgentId: OWNER_ID, planRevision: 1 }));
    const svc = goalService(db);
    await expect(svc.update(GOAL_ID, { title: "Unauthorized rename" }, OTHER_ORG_OWNER_ID)).rejects.toMatchObject({ status: 403 });
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
