import { z } from "zod";

export const workspaceBackupTriggerSourceSchema = z.enum(["manual", "scheduled", "pre_restore"]);

export const createWorkspaceBackupSchema = z.object({
  triggerSource: workspaceBackupTriggerSourceSchema.optional().default("manual"),
}).strict();

export const restoreWorkspaceBackupSchema = z.object({
  confirm: z.literal(true),
}).strict();

export type CreateWorkspaceBackup = z.infer<typeof createWorkspaceBackupSchema>;
export type RestoreWorkspaceBackup = z.infer<typeof restoreWorkspaceBackupSchema>;
