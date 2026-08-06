import { z } from "zod";
import {
  GOAL_ACTIVITY_KINDS,
  GOAL_CONTINUATION_KINDS,
  GOAL_EVALUATOR_KINDS,
  GOAL_FEEDBACK_KINDS,
  GOAL_OBJECTIVE_MODES,
} from "../constants.js";

const jsonRecord = z.record(z.string(), z.unknown());
const evidenceRefSchema = z.string().trim().min(1).regex(
  /^[a-z][a-z0-9+.-]*:[^\s]+$/i,
  "Evidence references must use a URI-like scheme",
);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "Expected a SHA-256 hex digest");
const criterionSchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1),
  evaluator: z.enum(GOAL_EVALUATOR_KINDS),
  evidenceRequirements: z.array(evidenceRefSchema).optional(),
});

const continuationSchema = z.object({
  kind: z.enum(GOAL_CONTINUATION_KINDS),
  summary: z.string().trim().min(1),
  wakeCondition: z.string().trim().min(1).optional().nullable(),
});

const planPayloadSchema = z.object({
  summary: z.string().trim().min(1),
  hypotheses: z.array(z.unknown()).optional().default([]),
  selectedPaths: z.array(z.unknown()).optional().default([]),
  rejectedPaths: z.array(z.unknown()).optional().default([]),
  sequencing: z.array(z.unknown()).optional().default([]),
  budgetAllocations: jsonRecord.optional().default({}),
  invalidationConditions: z.array(z.unknown()).optional().default([]),
});

export const createGoalSchema = z.object({
  title: z.string().trim().min(1),
  description: z.string().optional().nullable(),
  alignmentQuestion: z.string().trim().min(1).optional().nullable(),
  /** Accepted for legacy clients but intentionally ignored by the canonical create command. */
  level: z.string().optional(),
  status: z.string().optional(),
  parentId: z.string().uuid().optional().nullable(),
  ownerAgentId: z.string().uuid().optional().nullable(),
});

export type CreateGoal = z.infer<typeof createGoalSchema>;

export const updateGoalSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional().nullable(),
  alignmentQuestion: z.string().trim().min(1).optional().nullable(),
}).strict();

export type UpdateGoal = z.infer<typeof updateGoalSchema>;

export const activateGoalSchema = z.object({
  confirmed: z.literal(true),
  ownerAgentId: z.string().uuid(),
  outcomeStatement: z.string().trim().min(1),
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
  const criterionIds = new Set<string>();
  for (const [index, criterion] of value.criteria.entries()) {
    if (criterionIds.has(criterion.id)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["criteria", index, "id"], message: "Criterion IDs must be unique" });
    }
    criterionIds.add(criterion.id);
  }
});

export type ActivateGoal = z.infer<typeof activateGoalSchema>;
export type ActivateGoalInput = z.input<typeof activateGoalSchema>;

const goalStartPacketSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().min(1),
  description: z.string().nullable(),
  ownerAgentId: z.string().uuid(),
  activation: activateGoalSchema,
}).strict().superRefine((value, ctx) => {
  if (value.ownerAgentId !== value.activation.ownerAgentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activation", "ownerAgentId"],
      message: "Activation owner must match the packet owner",
    });
  }
});

export const previewGoalStartSchema = z.object({
  title: z.string().trim().min(1),
  context: z.string().nullable(),
  ownerAgentId: z.string().uuid().nullable(),
  targetTime: z.coerce.date().nullable(),
}).strict();
export type PreviewGoalStart = z.infer<typeof previewGoalStartSchema>;

export const startGoalSchema = z.object({
  requestKey: z.string().trim().min(1),
  packetHash: sha256HexSchema,
  packet: goalStartPacketSchema,
  draftGoalId: z.string().uuid().optional(),
}).strict();
export type StartGoal = z.infer<typeof startGoalSchema>;

export const updateGoalPlanSchema = planPayloadSchema;
export type UpdateGoalPlan = z.infer<typeof updateGoalPlanSchema>;

export const createGoalActivitySchema = z.object({
  summary: z.string().trim().min(1),
  activityKind: z.enum(GOAL_ACTIVITY_KINDS).optional().nullable(),
  commitmentRef: z.string().trim().min(1).optional().nullable(),
  runRef: z.string().uuid().optional().nullable(),
  evidenceRefs: z.array(evidenceRefSchema).optional().default([]),
  idempotencyKey: z.string().trim().min(1).optional().nullable(),
  occurredAt: z.coerce.date().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.activityKind === "closeout" && !value.runRef) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["runRef"], message: "Closeout Activity requires a Run reference" });
  }
});
export type CreateGoalActivity = z.infer<typeof createGoalActivitySchema>;

export const assignGoalOwnerSchema = z.object({
  agentId: z.string().uuid(),
  authorityRef: z.string().trim().min(1).optional().nullable(),
}).strict();
export type AssignGoalOwner = z.infer<typeof assignGoalOwnerSchema>;

const goalFeedbackAttachmentSchema = z.object({
  name: z.string().trim().min(1),
  uri: evidenceRefSchema,
  mimeType: z.string().trim().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
}).strict();

export const createGoalFeedbackSchema = z.object({
  body: z.string().trim().min(1),
  attachments: z.array(goalFeedbackAttachmentSchema).optional().default([]),
  feedbackKind: z.enum(GOAL_FEEDBACK_KINDS).optional().default("ordinary"),
  idempotencyKey: z.string().trim().min(1),
}).strict();
export type CreateGoalFeedback = z.infer<typeof createGoalFeedbackSchema>;

const goalContractPatchSchema = z.object({
  outcomeStatement: z.string().trim().min(1).optional(),
  objectiveMode: z.enum(GOAL_OBJECTIVE_MODES).optional(),
  criteria: z.array(criterionSchema).min(1).optional(),
  autonomyEnvelope: jsonRecord.optional(),
  humanAuthorities: jsonRecord.optional(),
  evaluationPolicy: jsonRecord.optional(),
  actionDeadline: z.coerce.date().nullable().optional(),
  evaluationDeadline: z.coerce.date().nullable().optional(),
}).strict().superRefine((value, ctx) => {
  if (Object.keys(value).length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "At least one Contract field must change" });
  }
  if (value.evaluationDeadline && value.actionDeadline && value.evaluationDeadline < value.actionDeadline) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evaluationDeadline"],
      message: "Evaluation deadline must not precede action deadline",
    });
  }
});

export const createGoalChangeProposalSchema = z.object({
  expectedContractRevision: z.number().int().positive(),
  afterContract: goalContractPatchSchema,
  rationale: z.string().trim().min(1),
  evidenceRefs: z.array(evidenceRefSchema).optional().default([]),
  approvalId: z.string().uuid().optional().nullable(),
  idempotencyKey: z.string().trim().min(1),
}).strict();
export type CreateGoalChangeProposal = z.infer<typeof createGoalChangeProposalSchema>;

export const decideGoalChangeProposalSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().min(1).optional().nullable(),
}).strict();
export type DecideGoalChangeProposal = z.infer<typeof decideGoalChangeProposalSchema>;

const goalEvaluationCandidateFields = {
  criteria: z.array(z.object({
    id: z.string().min(1),
    status: z.enum(["met", "unmet", "breached", "unknown"]),
  })).optional().default([]),
  resultValue: z.union([z.string().trim().min(1), z.number().finite(), z.boolean()]).optional(),
  decision: z.string().trim().min(1).optional(),
  resultPayload: jsonRecord.optional().default({}),
};

const goalEvaluationCandidateSchema = z.object({
  evidenceRefs: z.array(evidenceRefSchema).min(1),
  ...goalEvaluationCandidateFields,
}).strict();

export const createGoalResultProposalSchema = z.object({
  evidenceRefs: z.array(evidenceRefSchema),
  ...goalEvaluationCandidateFields,
  contractRevision: z.number().int().positive(),
  riskSummary: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1),
}).strict();
export type CreateGoalResultProposal = z.infer<typeof createGoalResultProposalSchema>;

export const acceptGoalResultProposalSchema = z.object({
  idempotencyKey: z.string().trim().min(1),
}).strict();
export type AcceptGoalResultProposal = z.infer<typeof acceptGoalResultProposalSchema>;

export const rejectGoalResultProposalSchema = z.object({
  idempotencyKey: z.string().trim().min(1),
  feedback: z.string().trim().min(1),
}).strict();
export type RejectGoalResultProposal = z.infer<typeof rejectGoalResultProposalSchema>;

export const evaluateGoalSchema = goalEvaluationCandidateSchema.extend({
  resultProposalId: z.string().uuid().optional(),
});
export type EvaluateGoal = z.infer<typeof evaluateGoalSchema>;

export const setGoalFocusSchema = z.object({
  focus: z.boolean(),
}).strict();
export type SetGoalFocus = z.infer<typeof setGoalFocusSchema>;
