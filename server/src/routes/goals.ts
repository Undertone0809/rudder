import type { Db } from "@rudderhq/db";
import type {
  GoalAgentContext,
  GoalAgentListLifecycle,
  GoalAgentListResponse,
  GoalCriterion,
  GoalWorkspaceCard,
  GoalWorkspaceFacet,
} from "@rudderhq/shared";
import {
  GOAL_WORKSPACE_FACETS,
  acceptGoalResultProposalSchema,
  activateGoalSchema,
  assignGoalOwnerSchema,
  createGoalActivitySchema,
  createGoalChangeProposalSchema,
  createGoalCheckpointSchema,
  createGoalFeedbackSchema,
  createGoalResultProposalSchema,
  createGoalSchema,
  decideGoalChangeProposalSchema,
  evaluateGoalSchema,
  isUuidLike,
  previewGoalStartSchema,
  rejectGoalResultProposalSchema,
  setGoalFocusSchema,
  startGoalSchema,
  updateGoalPlanSchema,
  updateGoalSchema,
} from "@rudderhq/shared";
import { Router } from "express";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  publicGoalActivity,
  publicGoalChangeProposal,
  publicGoalCheckpoint,
  publicGoalDetail,
  publicGoalFeedback,
  publicGoalOwnerAssignment,
  publicGoalPlan,
  publicGoalResultProposal,
  publicGoalView,
} from "../services/goals.js";
import { goalService, heartbeatService, logActivity } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function goalRoutes(db: Db) {
  const router = Router();
  const svc = goalService(db);
  const heartbeat = heartbeatService(db);

  async function dispatchGoalWakeup(dispatch: {
    ownerAgentId: string;
    wakeupRequestId: string;
    source: "on_demand";
    triggerDetail: "system";
    reason: "goal_started" | "goal_feedback" | "goal_change_decided" | "goal_continuation";
    payload: Record<string, unknown>;
    contextSnapshot: Record<string, unknown>;
    requestedByActorType: "user" | "agent" | "system";
    requestedByActorId: string | null;
    idempotencyKey: string;
  }) {
    return heartbeat.wakeup(dispatch.ownerAgentId, {
      existingWakeupRequestId: dispatch.wakeupRequestId,
      source: dispatch.source,
      triggerDetail: dispatch.triggerDetail,
      reason: dispatch.reason,
      payload: dispatch.payload,
      contextSnapshot: dispatch.contextSnapshot,
      requestedByActorType: dispatch.requestedByActorType,
      requestedByActorId: dispatch.requestedByActorId,
      idempotencyKey: dispatch.idempotencyKey,
    });
  }

  async function loadAuthorizedGoal(req: Parameters<typeof assertCompanyAccess>[0], id: string) {
    if (!isUuidLike(id)) return null;
    const goal = await svc.getById(id);
    if (!goal) return null;
    assertCompanyAccess(req, goal.orgId);
    return goal;
  }

  function requireRuntimeAgent(req: Parameters<typeof assertCompanyAccess>[0]) {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      throw forbidden("Agent authentication required for Goal runtime context");
    }
    return req.actor.agentId;
  }

  function optionalQueryString(value: unknown) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function parseAssignedGoalFilters(query: Record<string, unknown>) {
    const lifecycleValue = optionalQueryString(query.lifecycle) ?? "active";
    if (!["draft", "active", "closed", "all"].includes(lifecycleValue)) {
      throw badRequest("Goal lifecycle must be draft, active, closed, or all");
    }
    const focusValue = optionalQueryString(query.focus);
    if (focusValue && focusValue !== "true" && focusValue !== "false") {
      throw badRequest("Goal focus must be true or false");
    }
    const facetValue = optionalQueryString(query.facet);
    if (facetValue && !GOAL_WORKSPACE_FACETS.includes(facetValue as GoalWorkspaceFacet)) {
      throw badRequest("Goal facet is invalid");
    }
    const limitValue = optionalQueryString(query.limit);
    const limit = limitValue ? Number(limitValue) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw badRequest("Goal list limit must be between 1 and 100");
    }
    return {
      lifecycle: lifecycleValue as GoalAgentListLifecycle,
      focus: focusValue === null ? null : focusValue === "true",
      facet: facetValue as GoalWorkspaceFacet | null,
      limit,
    };
  }

  router.get("/orgs/:orgId/goals", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    res.json((await svc.list(orgId)).map(publicGoalView));
  });

  router.get("/orgs/:orgId/goals/workspace", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    res.json(await svc.workspaceCards(orgId));
  });

  router.get("/orgs/:orgId/goals/assigned", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const agentId = requireRuntimeAgent(req);
    const filters = parseAssignedGoalFilters(req.query as Record<string, unknown>);
    const assigned = (await svc.workspaceCards(orgId) as GoalWorkspaceCard[]).filter((goal) =>
      goal.ownerAgentId === agentId
      && (filters.lifecycle === "all" || goal.lifecycle === filters.lifecycle)
      && (filters.focus === null || goal.focus === filters.focus)
      && (filters.facet === null || goal.facet === filters.facet));
    const response: GoalAgentListResponse = {
      goals: assigned.slice(0, filters.limit),
      count: assigned.length,
      filters,
    };
    res.json(response);
  });

  router.get("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    const goal = await loadAuthorizedGoal(req, id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    res.json(publicGoalDetail(await svc.detail(id)));
  });

  router.get("/goals/:id/workspace", async (req, res) => {
    const id = req.params.id as string;
    if (!await loadAuthorizedGoal(req, id)) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    res.json(await svc.workspace(id));
  });

  router.get("/goals/:id/agent-context", async (req, res) => {
    const id = req.params.id as string;
    const goal = await loadAuthorizedGoal(req, id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const agentId = requireRuntimeAgent(req);
    if (goal.ownerAgentId !== agentId) {
      throw forbidden("Agents can only read runtime context for Goals they own");
    }
    const [detail, workspace, latestCheckpoint, recentCheckpoints, pendingContinuationWake] = await Promise.all([
      svc.detail(id),
      svc.workspace(id),
      svc.latestCheckpoint(id),
      svc.recentCheckpoints(id),
      svc.pendingContinuationWake(id),
    ]);
    const publicGoal = publicGoalView(detail);
    const response: GoalAgentContext = {
      goal: {
        id: publicGoal.id,
        orgId: publicGoal.orgId,
        title: publicGoal.title,
        description: publicGoal.description,
        lifecycle: publicGoal.lifecycle,
        status: publicGoal.status,
        ownerAgentId: publicGoal.ownerAgentId,
        focus: publicGoal.focus,
        closeReason: publicGoal.closeReason,
        createdAt: publicGoal.createdAt,
        updatedAt: publicGoal.updatedAt,
      },
      contract: {
        revision: detail.contractRevision,
        outcomeStatement: detail.outcomeStatement,
        objectiveMode: detail.objectiveMode as GoalAgentContext["contract"]["objectiveMode"],
        criteria: detail.criteria as GoalCriterion[],
        autonomyEnvelope: detail.autonomyEnvelope,
        humanAuthorities: detail.humanAuthorities,
        evaluationPolicy: detail.evaluationPolicy,
        actionDeadline: detail.actionDeadline,
        evaluationDeadline: detail.evaluationDeadline,
      },
      plan: detail.plan
        ? {
            revision: detail.plan.revision,
            summary: detail.plan.summary,
            hypotheses: detail.plan.hypotheses,
            selectedPaths: detail.plan.selectedPaths,
            rejectedPaths: detail.plan.rejectedPaths,
            sequencing: detail.plan.sequencing,
            budgetAllocations: detail.plan.budgetAllocations,
            invalidationConditions: detail.plan.invalidationConditions,
          }
        : null,
      continuation: detail.continuationKind
        ? {
            kind: detail.continuationKind as "commitment" | "wait" | "decision" | "verification",
            summary: detail.continuationSummary ?? "",
            wakeCondition: detail.wakeCondition,
          }
        : null,
      latestCheckpoint: latestCheckpoint ? publicGoalCheckpoint(latestCheckpoint) : null,
      recentCheckpoints: recentCheckpoints.map(publicGoalCheckpoint),
      pendingContinuationWake,
      state: {
        facet: workspace.facet,
        currentProgress: workspace.currentProgress,
        agentAction: workspace.agentAction,
        nextStep: workspace.nextStep,
        attention: workspace.attention,
      },
      pending: {
        changeProposals: workspace.changeProposals ?? [],
        resultProposals: workspace.resultProposals,
      },
      recentHistory: workspace.timeline.slice(0, 20),
      allowedActions: {
        reportProgress: detail.lifecycle === "active",
        proposeChange: detail.lifecycle === "active",
        proposeResult: detail.lifecycle === "active",
      },
    };
    res.json(response);
  });

  router.get("/goals/:id/history", async (req, res) => {
    const id = req.params.id as string;
    if (!await loadAuthorizedGoal(req, id)) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    res.json(await svc.history(id, { cursor, limit }));
  });

  router.get("/goals/:id/dependencies", async (req, res) => {
    const id = req.params.id as string;
    const goal = await loadAuthorizedGoal(req, id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    res.json(await svc.dependencies(goal));
  });

  router.get("/goals/:id/activities", async (req, res) => {
    const id = req.params.id as string;
    if (!await loadAuthorizedGoal(req, id)) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const goal = await svc.getById(id);
    res.json((await svc.listActivities(id)).map((activity) => publicGoalActivity(activity, {
      runAgentId: goal?.ownerAgentId,
    })));
  });

  router.post("/goals/:id/checkpoint", validate(createGoalCheckpointSchema), async (req, res) => {
    const id = req.params.id as string;
    const goal = await loadAuthorizedGoal(req, id);
    if (!goal) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    if (actor.actorType !== "agent") throw forbidden("Only the Goal Owner Agent can create a checkpoint");
    const result = await svc.checkpoint(id, { ...req.body, goal: id }, actor.agentId!, actor.runId!);
    if (result.dispatch) await dispatchGoalWakeup(result.dispatch);
    await logActivity(db, {
      orgId: goal.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.checkpointed",
      entityType: "goal",
      entityId: id,
      details: { checkpointId: result.checkpoint.id, planRevision: result.checkpoint.planRevisionAfter },
      idempotencyKey: `goal-checkpoint:${req.body.idempotencyKey}`,
    });
    res.status(result.dispatch ? 201 : 200).json(publicGoalCheckpoint(result.checkpoint));
  });

  router.post("/orgs/:orgId/goals", validate(createGoalSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertBoard(req);
    assertCompanyAccess(req, orgId);
    const goal = await svc.create(orgId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.created",
      entityType: "goal",
      entityId: goal.id,
      details: { lifecycle: goal.lifecycle, title: goal.title },
    });
    res.status(201).json(publicGoalView(goal));
  });

  router.post("/orgs/:orgId/goals/start-preview", validate(previewGoalStartSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertBoard(req);
    assertCompanyAccess(req, orgId);
    res.json(await svc.previewStart(orgId, req.body));
  });

  router.post("/orgs/:orgId/goals/start", validate(startGoalSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertBoard(req);
    assertCompanyAccess(req, orgId);
    const actor = getActorInfo(req);
    const { goal, replayed, dispatch } = await svc.start(orgId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
    });
    await dispatchGoalWakeup(dispatch);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.started",
      entityType: "goal",
      entityId: goal.id,
      details: { ownerAgentId: goal.ownerAgentId, packetHash: req.body.packetHash },
      idempotencyKey: `goal-start:${req.body.requestKey}`,
    });
    res.status(replayed ? 200 : 201).json(publicGoalView(goal));
  });

  router.patch("/goals/:id", validate(updateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const goal = await svc.update(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: goal!.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.updated",
      entityType: "goal",
      entityId: id,
      details: req.body,
    });
    res.json(publicGoalView(goal));
  });

  router.post("/goals/:id/activate", validate(activateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const goal = await svc.activate(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: goal.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.activated",
      entityType: "goal",
      entityId: id,
      details: { ownerAgentId: goal.ownerAgentId, objectiveMode: goal.objectiveMode },
    });
    res.json(publicGoalDetail(await svc.detail(id)));
  });

  router.post("/goals/:id/plan", validate(updateGoalPlanSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const plan = await svc.updatePlan(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.plan_updated",
      entityType: "goal",
      entityId: id,
      details: { revision: plan.revision },
    });
    res.status(201).json(publicGoalPlan(plan));
  });

  router.post("/goals/:id/activities", validate(createGoalActivitySchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const activity = await svc.createActivity(
      id,
      actor.runId ? { ...req.body, runRef: actor.runId } : req.body,
      actor.agentId,
    );
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.activity_added",
      entityType: "goal",
      entityId: id,
      details: { activityId: activity?.id, activityKind: activity?.activityKind },
      idempotencyKey: req.body.idempotencyKey ?? null,
    });
    res.status(201).json(publicGoalActivity(activity));
  });

  router.post("/goals/:id/feedback", validate(createGoalFeedbackSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const { feedback, dispatch } = await svc.feedback(id, req.body, actor.actorId);
    await dispatchGoalWakeup(dispatch);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.feedback_added",
      entityType: "goal",
      entityId: id,
      details: { feedbackId: feedback.id, feedbackKind: feedback.feedbackKind },
      idempotencyKey: `goal-feedback:${feedback.id}`,
    });
    res.status(201).json(publicGoalFeedback(feedback));
  });

  router.post("/goals/:id/change-proposals", validate(createGoalChangeProposalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const proposal = await svc.createChangeProposal(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.change_proposed",
      entityType: "goal",
      entityId: id,
      details: { proposalId: proposal.id, expectedContractRevision: proposal.expectedContractRevision },
      idempotencyKey: `goal-change-proposal:${proposal.id}`,
    });
    res.status(201).json(publicGoalChangeProposal(proposal));
  });

  router.post("/goal-change-proposals/:proposalId/decide", validate(decideGoalChangeProposalSchema), async (req, res) => {
    assertBoard(req);
    const proposalId = req.params.proposalId as string;
    const existing = await svc.getChangeProposalById(proposalId);
    if (!existing) {
      res.status(404).json({ error: "Goal change proposal not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const actor = getActorInfo(req);
    const { proposal, dispatch } = await svc.decideChangeProposal(proposalId, req.body, actor.actorId);
    await dispatchGoalWakeup(dispatch);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: req.body.decision === "approve" ? "goal.change_approved" : "goal.change_rejected",
      entityType: "goal",
      entityId: existing.goalId,
      details: { proposalId, status: proposal.status, appliedRevision: proposal.appliedRevision },
      idempotencyKey: `goal-change-decision:${proposalId}:${req.body.decision}`,
    });
    res.json(publicGoalChangeProposal(proposal));
  });

  router.post("/goals/:id/result-proposals", validate(createGoalResultProposalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const proposal = await svc.createResultProposal(id, req.body, actor.agentId, actor.runId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.result_proposed",
      entityType: "goal",
      entityId: id,
      details: { proposalId: proposal.id, status: proposal.status, outcome: proposal.preflight.outcome },
      idempotencyKey: `goal-result-proposal:${proposal.id}`,
    });
    res.status(201).json(publicGoalResultProposal(proposal));
  });

  router.post("/goal-result-proposals/:proposalId/accept", validate(acceptGoalResultProposalSchema), async (req, res) => {
    assertBoard(req);
    const proposalId = req.params.proposalId as string;
    const existing = await svc.getResultProposalById(proposalId);
    if (!existing) {
      res.status(404).json({ error: "Goal Result Proposal not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const actor = getActorInfo(req);
    const goal = await svc.acceptResultProposal(proposalId, req.body, actor.actorId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.result_accepted",
      entityType: "goal",
      entityId: existing.goalId,
      details: { proposalId, outcome: goal.evaluationResult },
      idempotencyKey: `goal-result-accept:${proposalId}:${req.body.idempotencyKey}`,
    });
    res.json(publicGoalView(goal));
  });

  router.post("/goal-result-proposals/:proposalId/reject", validate(rejectGoalResultProposalSchema), async (req, res) => {
    assertBoard(req);
    const proposalId = req.params.proposalId as string;
    const existing = await svc.getResultProposalById(proposalId);
    if (!existing) {
      res.status(404).json({ error: "Goal Result Proposal not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    const actor = getActorInfo(req);
    const { proposal, dispatch } = await svc.rejectResultProposal(proposalId, req.body, actor.actorId);
    if (dispatch) await dispatchGoalWakeup(dispatch);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.result_rejected",
      entityType: "goal",
      entityId: existing.goalId,
      details: { proposalId, status: proposal.status },
      idempotencyKey: `goal-result-reject:${proposalId}:${req.body.idempotencyKey}`,
    });
    res.json(publicGoalResultProposal(proposal));
  });

  router.post("/goals/:id/owner", validate(assignGoalOwnerSchema), async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const assignment = await svc.assignOwner(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.owner_reassigned",
      entityType: "goal",
      entityId: id,
      details: { agentId: assignment.agentId, assignmentRevision: assignment.assignmentRevision },
    });
    res.json(publicGoalOwnerAssignment(assignment));
  });

  router.post("/goals/:id/focus", validate(setGoalFocusSchema), async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const goal = await svc.setFocus(id, req.body.focus, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.focus_changed",
      entityType: "goal",
      entityId: id,
      details: { focus: goal?.focus ?? false },
    });
    await heartbeat.resumePendingWakeupRequests({ orgId: existing.orgId });
    res.json(publicGoalView(goal));
  });

  router.post("/goals/:id/evaluate", validate(evaluateGoalSchema), async (req, res) => {
    const id = req.params.id as string;
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const actor = getActorInfo(req);
    const goal = await svc.evaluate(id, req.body, actor.agentId);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.evaluated",
      entityType: "goal",
      entityId: id,
      details: { result: goal.evaluationResult, lifecycle: goal.lifecycle },
    });
    res.json(publicGoalView(goal));
  });

  router.delete("/goals/:id", async (req, res) => {
    const id = req.params.id as string;
    assertBoard(req);
    const existing = await loadAuthorizedGoal(req, id);
    if (!existing) {
      res.status(404).json({ error: "Goal not found" });
      return;
    }
    const goal = await svc.remove(id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: goal!.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "goal.deleted",
      entityType: "goal",
      entityId: id,
    });
    res.json(publicGoalView(goal));
  });

  return router;
}
