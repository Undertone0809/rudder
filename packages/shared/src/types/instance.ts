export type InstanceLocale = "en" | "zh-CN";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  locale: InstanceLocale;
}

export interface InstanceNotificationSettings {
  desktopInboxNotifications: boolean;
  desktopDockBadge: boolean;
}

export interface InstanceLangfuseSettings {
  enabled: boolean;
  baseUrl: string;
  publicKey: string;
  environment: string;
  secretKeyConfigured: boolean;
  managedByEnv: boolean;
}

export interface OperatorProfileSettings {
  nickname: string;
  moreAboutYou: string;
}

export interface InstanceExperimentalSettings {
  autoRestartDevServerWhenIdle: boolean;
}

export type InstancePathPickerSelectionType = "file" | "directory";

export interface InstancePathPickerRequest {
  selectionType: InstancePathPickerSelectionType;
}

export interface InstancePathPickerResult {
  path: string | null;
  cancelled: boolean;
}

export interface InstanceSettings {
  id: string;
  general: InstanceGeneralSettings;
  notifications: InstanceNotificationSettings;
  experimental: InstanceExperimentalSettings;
  createdAt: Date;
  updatedAt: Date;
}
