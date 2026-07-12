import type {
  InstanceBrowserSettings,
  InstanceGeneralSettings,
  InstanceLangfuseSettings,
  InstanceNotificationSettings,
  InstancePathPickerRequest,
  InstancePathPickerResult,
  KeyboardShortcutSettings,
  OperatorProfileSettings,
  PatchInstanceBrowserSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceLangfuseSettings,
  PatchInstanceNotificationSettings,
  PatchKeyboardShortcutSettings,
  PatchOperatorProfileSettings,
} from "@rudderhq/shared";
import { api } from "./client";

export const instanceSettingsApi = {
  getBrowser: () =>
    api.get<InstanceBrowserSettings>("/instance/settings/browser"),
  updateBrowser: (patch: PatchInstanceBrowserSettings) =>
    api.patch<InstanceBrowserSettings>("/instance/settings/browser", patch),
  getProfile: () =>
    api.get<OperatorProfileSettings>("/instance/settings/profile"),
  updateProfile: (patch: PatchOperatorProfileSettings) =>
    api.patch<OperatorProfileSettings>("/instance/settings/profile", patch),
  getShortcuts: () =>
    api.get<KeyboardShortcutSettings>("/instance/settings/shortcuts"),
  updateShortcuts: (patch: PatchKeyboardShortcutSettings) =>
    api.patch<KeyboardShortcutSettings>("/instance/settings/shortcuts", patch),
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getNotifications: () =>
    api.get<InstanceNotificationSettings>("/instance/settings/notifications"),
  updateNotifications: (patch: PatchInstanceNotificationSettings) =>
    api.patch<InstanceNotificationSettings>("/instance/settings/notifications", patch),
  getLangfuse: () =>
    api.get<InstanceLangfuseSettings>("/instance/settings/langfuse"),
  installLangfuse: () =>
    api.post<InstanceLangfuseSettings>("/instance/settings/langfuse/install", {}),
  updateLangfuse: (patch: PatchInstanceLangfuseSettings) =>
    api.patch<InstanceLangfuseSettings>("/instance/settings/langfuse", patch),
  pickPath: (input: InstancePathPickerRequest) =>
    api.post<InstancePathPickerResult>("/instance/path-picker", input),
};
