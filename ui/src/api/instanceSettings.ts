import type {
  InstanceGeneralSettings,
  InstanceLangfuseSettings,
  InstanceNotificationSettings,
  InstancePathPickerRequest,
  InstancePathPickerResult,
  OperatorProfileSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceLangfuseSettings,
  PatchInstanceNotificationSettings,
  PatchOperatorProfileSettings,
} from "@rudderhq/shared";
import { api } from "./client";

export const instanceSettingsApi = {
  getProfile: () =>
    api.get<OperatorProfileSettings>("/instance/settings/profile"),
  updateProfile: (patch: PatchOperatorProfileSettings) =>
    api.patch<OperatorProfileSettings>("/instance/settings/profile", patch),
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
  updateLangfuse: (patch: PatchInstanceLangfuseSettings) =>
    api.patch<InstanceLangfuseSettings>("/instance/settings/langfuse", patch),
  pickPath: (input: InstancePathPickerRequest) =>
    api.post<InstancePathPickerResult>("/instance/path-picker", input),
};
