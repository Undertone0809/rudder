import { z } from "zod";

export const instanceLocaleSchema = z.enum(["en", "zh-CN"]);

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  showDeveloperDiagnostics: z.boolean().default(false),
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

export const OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH = 8000;

export const operatorProfileSettingsSchema = z.object({
  nickname: z.string().max(80).default(""),
  moreAboutYou: z.string().max(OPERATOR_PROFILE_MORE_ABOUT_YOU_MAX_LENGTH).default(""),
}).strict();

export const patchOperatorProfileSettingsSchema = operatorProfileSettingsSchema.partial();

export const KEYBOARD_SHORTCUT_ACTION_IDS = [
  "commandPalette.open",
  "settings.open",
  "issue.create",
  "sidebar.toggle",
  "panel.toggle",
] as const;

export const keyboardShortcutActionIdSchema = z.enum(KEYBOARD_SHORTCUT_ACTION_IDS);

export const keyboardShortcutBindingSchema = z.object({
  key: z.string().trim().min(1).max(64),
  code: z.string().trim().min(1).max(80).optional(),
  metaKey: z.boolean().optional(),
  ctrlKey: z.boolean().optional(),
  altKey: z.boolean().optional(),
  shiftKey: z.boolean().optional(),
}).strict();

export const keyboardShortcutPreferenceSchema = z.object({
  actionId: keyboardShortcutActionIdSchema,
  bindings: z.array(keyboardShortcutBindingSchema).max(4).optional(),
  disabled: z.boolean().optional(),
}).strict();

export const keyboardShortcutSettingsSchema = z.object({
  shortcuts: z.array(keyboardShortcutPreferenceSchema).max(KEYBOARD_SHORTCUT_ACTION_IDS.length).default([]),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  value.shortcuts.forEach((shortcut, index) => {
    if (seen.has(shortcut.actionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate shortcut action id: ${shortcut.actionId}`,
        path: ["shortcuts", index, "actionId"],
      });
      return;
    }
    seen.add(shortcut.actionId);
  });
});

export const patchKeyboardShortcutSettingsSchema = keyboardShortcutSettingsSchema;

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
export type KeyboardShortcutActionId = z.infer<typeof keyboardShortcutActionIdSchema>;
export type KeyboardShortcutBinding = z.infer<typeof keyboardShortcutBindingSchema>;
export type KeyboardShortcutPreference = z.infer<typeof keyboardShortcutPreferenceSchema>;
export type KeyboardShortcutSettings = z.infer<typeof keyboardShortcutSettingsSchema>;
export type PatchKeyboardShortcutSettings = z.infer<typeof patchKeyboardShortcutSettingsSchema>;
export type InstanceNotificationSettings = z.infer<typeof instanceNotificationSettingsSchema>;
export type PatchInstanceNotificationSettings = z.infer<typeof patchInstanceNotificationSettingsSchema>;
export type InstancePathPickerSelectionType = z.infer<typeof instancePathPickerSelectionTypeSchema>;
export type InstancePathPickerRequest = z.infer<typeof instancePathPickerRequestSchema>;
export type InstancePathPickerResult = z.infer<typeof instancePathPickerResultSchema>;
