import { z } from "zod";

export const instanceLocaleSchema = z.enum(["en", "zh-CN"]);

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  locale: instanceLocaleSchema.default("en"),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceNotificationSettingsSchema = z.object({
  desktopInboxNotifications: z.boolean().default(true),
  desktopDockBadge: z.boolean().default(true),
  desktopIssueNotifications: z.boolean().default(true),
  desktopChatNotifications: z.boolean().default(true),
}).strict();

export const patchInstanceNotificationSettingsSchema = instanceNotificationSettingsSchema.partial();

export const instanceLangfuseSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default("http://localhost:3000"),
  publicKey: z.string().default(""),
  environment: z.string().default(""),
  secretKeyConfigured: z.boolean().default(false),
  managedByEnv: z.boolean().default(false),
}).strict();

export const patchInstanceLangfuseSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  baseUrl: z.string().url().optional(),
  publicKey: z.string().optional(),
  secretKey: z.string().optional(),
  environment: z.string().optional(),
  clearSecretKey: z.boolean().optional(),
}).strict();

export const operatorProfileSettingsSchema = z.object({
  nickname: z.string().max(80).default(""),
  moreAboutYou: z.string().max(2000).default(""),
}).strict();

export const patchOperatorProfileSettingsSchema = operatorProfileSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  autoRestartDevServerWhenIdle: z.boolean().default(false),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export const instancePathPickerSelectionTypeSchema = z.enum(["file", "directory"]);

export const instancePathPickerRequestSchema = z.object({
  selectionType: instancePathPickerSelectionTypeSchema,
}).strict();

export const instancePathPickerResultSchema = z.object({
  path: z.string().nullable(),
  cancelled: z.boolean(),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceLangfuseSettings = z.infer<typeof instanceLangfuseSettingsSchema>;
export type PatchInstanceLangfuseSettings = z.infer<typeof patchInstanceLangfuseSettingsSchema>;
export type InstanceLocale = z.infer<typeof instanceLocaleSchema>;
export type OperatorProfileSettings = z.infer<typeof operatorProfileSettingsSchema>;
export type PatchOperatorProfileSettings = z.infer<typeof patchOperatorProfileSettingsSchema>;
export type InstanceNotificationSettings = z.infer<typeof instanceNotificationSettingsSchema>;
export type PatchInstanceNotificationSettings = z.infer<typeof patchInstanceNotificationSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type InstancePathPickerSelectionType = z.infer<typeof instancePathPickerSelectionTypeSchema>;
export type InstancePathPickerRequest = z.infer<typeof instancePathPickerRequestSchema>;
export type InstancePathPickerResult = z.infer<typeof instancePathPickerResultSchema>;
