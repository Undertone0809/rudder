import { z } from "zod";

export const learningCandidateClassificationSchema = z.enum([
  "core_behavior",
  "contextual_preference",
  "one_off_correction",
  "conflicting_signal",
  "open_question",
]);

export const learningCandidateStatusSchema = z.enum(["pending", "approved", "rejected", "one_off", "applied"]);
export const learningRiskLevelSchema = z.enum(["low", "medium", "high"]);

export const createRunFeedbackSessionSchema = z.object({
  targetAgentId: z.string().uuid(),
  targetSkillId: z.string().uuid().nullable().optional(),
});

export const createRunFeedbackItemSchema = z.object({
  runId: z.string().uuid(),
  issueId: z.string().uuid().nullable().optional(),
  sourceKind: z.string().min(1).max(80),
  sourceId: z.string().max(200).nullable().optional(),
  eventId: z.string().max(200).nullable().optional(),
  eventSeq: z.number().int().nonnegative().nullable().optional(),
  logRef: z.string().max(500).nullable().optional(),
  logByteStart: z.number().int().nonnegative().nullable().optional(),
  logByteEnd: z.number().int().nonnegative().nullable().optional(),
  transcriptEntryKey: z.string().max(200).nullable().optional(),
  selectedTextSnapshot: z.string().max(8000).nullable().optional(),
  contentHash: z.string().max(128).nullable().optional(),
  body: z.string().trim().min(1).max(8000),
  feedbackType: z.string().min(1).max(80).optional(),
  severity: z.string().min(1).max(40).optional(),
});

export const updateLearningCandidateSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  instruction: z.string().trim().min(1).max(4000).optional(),
  appliesWhenJson: z.record(z.unknown()).optional(),
  mustNot: z.string().trim().max(2000).nullable().optional(),
  targetSkillId: z.string().uuid().nullable().optional(),
  classification: learningCandidateClassificationSchema.optional(),
  riskLevel: learningRiskLevelSchema.optional(),
  validationChecksJson: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
  status: learningCandidateStatusSchema.optional(),
});

export type CreateRunFeedbackSession = z.infer<typeof createRunFeedbackSessionSchema>;
export type CreateRunFeedbackItem = z.infer<typeof createRunFeedbackItemSchema>;
export type UpdateLearningCandidate = z.infer<typeof updateLearningCandidateSchema>;
