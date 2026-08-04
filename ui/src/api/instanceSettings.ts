import type {
  InstanceBrowserSettings,
  InstanceGeneralSettings,
  InstanceNotificationSettings,
  InstancePathPickerRequest,
  InstancePathPickerResult,
  KeyboardShortcutSettings,
  OperatorProfileSettings,
  PatchInstanceBrowserSettings,
  PatchInstanceGeneralSettings,
  PatchInstanceNotificationSettings,
  PatchKeyboardShortcutSettings,
  PatchOperatorProfileSettings,
} from "@rudderhq/shared";
import { api } from "./client";

export type ProductAnalyticsSettings = {
  mode: "off" | "anonymous" | "account_linked";
  consentVersion: string;
  consentEpoch: number;
  maskedInstallationId: string | null;
  pendingCount: number;
  lastAttemptedAt: string | null;
  lastSucceededAt: string | null;
  lastErrorCode: string | null;
  coverageGap: boolean;
  lastPayloadAt: string | null;
  lastPayload: Array<Record<string, unknown>> | null;
  disclosure: { collected: string[]; excluded: string[] };
};

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
  getProductAnalytics: () =>
    api.get<ProductAnalyticsSettings>("/instance/settings/product-analytics"),
  updateProductAnalytics: (mode: ProductAnalyticsSettings["mode"]) =>
    api.patch<{ mode: ProductAnalyticsSettings["mode"]; consentEpoch: number }>("/instance/settings/product-analytics", { mode }),
  getNotifications: () =>
    api.get<InstanceNotificationSettings>("/instance/settings/notifications"),
  updateNotifications: (patch: PatchInstanceNotificationSettings) =>
    api.patch<InstanceNotificationSettings>("/instance/settings/notifications", patch),
  pickPath: (input: InstancePathPickerRequest) =>
    api.post<InstancePathPickerResult>("/instance/path-picker", input),
};
