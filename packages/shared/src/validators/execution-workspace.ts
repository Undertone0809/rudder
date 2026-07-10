import { z } from "zod";

export const runWorkspaceStatusSchema = z.enum([
  "active",
  "idle",
  "in_review",
  "archived",
  "cleanup_failed",
]);

export const updateRunWorkspaceSchema = z.object({
  status: runWorkspaceStatusSchema.optional(),
  cleanupEligibleAt: z.string().datetime().optional().nullable(),
  cleanupReason: z.string().optional().nullable(),
}).strict();

export type UpdateRunWorkspace = z.infer<typeof updateRunWorkspaceSchema>;

/** @deprecated Use runWorkspaceStatusSchema. */
export const executionWorkspaceStatusSchema = runWorkspaceStatusSchema;
/** @deprecated Use updateRunWorkspaceSchema. */
export const updateExecutionWorkspaceSchema = updateRunWorkspaceSchema;
/** @deprecated Use UpdateRunWorkspace. */
export type UpdateExecutionWorkspace = UpdateRunWorkspace;
