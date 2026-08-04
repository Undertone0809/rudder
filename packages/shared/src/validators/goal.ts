import { z } from "zod";
import {
  GOAL_ACTIVITY_KINDS,
  GOAL_CONTINUATION_KINDS,
  GOAL_EVALUATOR_KINDS,
  GOAL_OBJECTIVE_MODES,
} from "../constants.js";

const jsonRecord = z.record(z.string(), z.unknown());
const evidenceRefSchema = z.string().trim().min(1).regex(
  /^[a-z][a-z0-9+.-]*:[^\s]+$/i,
  "Evidence references must use a URI-like scheme",
);
const criterionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  evaluator: z.enum(GOAL_EVALUATOR_KINDS),
  evidenceRequirements: z.array(evidenceRefSchema).optional(),
});

const continuationSchema = z.object({
  kind: z.enum(GOAL_CONTINUATION_KINDS),
  summary: z.string().min(1),
  wakeCondition: z.string().min(1).optional().nullable(),
});

const planPayloadSchema = z.object({
  summary: z.string().min(1),
  hypotheses: z.array(z.unknown()).optional().default([]),
  selectedPaths: z.array(z.unknown()).optional().default([]),
  rejectedPaths: z.array(z.unknown()).optional().default([]),
  sequencing: z.array(z.unknown()).optional().default([]),
  budgetAllocations: jsonRecord.optional().default({}),
  invalidationConditions: z.array(z.unknown()).optional().default([]),
});

export const createGoalSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  /** Accepted for legacy clients but intentionally ignored by the canonical create command. */
  level: z.string().optional(),
  status: z.string().optional(),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional().nullable(),
}).strict();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;

export const activateGoalSchema = z.object({
  confirmed: z.literal(true),
  ownerAgentId: z.string().uuid(),
  outcomeStatement: z.string().min(1),
  objectiveMode: z.enum(GOAL_OBJECTIVE_MODES),
  criteria: z.array(criterionSchema).min(1),
  autonomyEnvelope: jsonRecord.optional().default({}),
  humanAuthorities: jsonRecord.optional().default({}),
  evaluationPolicy: jsonRecord.optional().default({}),
  actionDeadline: z.coerce.date().optional().nullable(),
  evaluationDeadline: z.coerce.date().optional().nullable(),
  initialContinuation: continuationSchema,
  initialPlan: planPayloadSchema,
}).superRefine((value, ctx) => {
  if (value.evaluationDeadline && value.actionDeadline && value.evaluationDeadline < value.actionDeadline) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["evaluationDeadline"], message: "Evaluation deadline must not precede action deadline" });
  }
});

export type ActivateGoal = z.infer<typeof activateGoalSchema>;

export const updateGoalPlanSchema = planPayloadSchema;
export type UpdateGoalPlan = z.infer<typeof updateGoalPlanSchema>;

export const createGoalActivitySchema = z.object({
  summary: z.string().min(1),
  activityKind: z.enum(GOAL_ACTIVITY_KINDS).optional().nullable(),
  commitmentRef: z.string().min(1).optional().nullable(),
  runRef: z.string().uuid().optional().nullable(),
  evidenceRefs: z.array(evidenceRefSchema).optional().default([]),
  idempotencyKey: z.string().min(1).optional().nullable(),
  occurredAt: z.coerce.date().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.activityKind === "closeout" && !value.runRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runRef"], message: "Closeout Activity requires a Run reference" });
  }
});
export type CreateGoalActivity = z.infer<typeof createGoalActivitySchema>;

export const assignGoalOwnerSchema = z.object({
  agentId: z.string().uuid(),
  authorityRef: z.string().min(1).optional().nullable(),
}).strict();
export type AssignGoalOwner = z.infer<typeof assignGoalOwnerSchema>;

export const evaluateGoalSchema = z.object({
  evidenceRefs: z.array(evidenceRefSchema).min(1),
  criteria: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["met", "unmet", "breached", "unknown"]),
  })).optional().default([]),
  resultValue: z.union([z.string().trim().min(1), z.number().finite(), z.boolean()]).optional(),
  decision: z.string().trim().min(1).optional(),
  resultPayload: jsonRecord.optional().default({}),
}).strict();
export type EvaluateGoal = z.infer<typeof evaluateGoalSchema>;

export const setGoalFocusSchema = z.object({
  focus: z.boolean(),
}).strict();
export type SetGoalFocus = z.infer<typeof setGoalFocusSchema>;
