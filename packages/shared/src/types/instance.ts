export type InstanceLocale = "en" | "zh-CN";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  showDeveloperDiagnostics: boolean;
  locale: InstanceLocale;
}

export interface InstanceNotificationSettings {
  desktopInboxNotifications: boolean;
  desktopDockBadge: boolean;
  desktopIssueNotifications: boolean;
  desktopChatNotifications: boolean;
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

export type KeyboardShortcutActionId =
  | "commandPalette.open"
  | "settings.open"
  | "issue.create"
  | "sidebar.toggle"
  | "panel.toggle";

export interface KeyboardShortcutBinding {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface KeyboardShortcutPreference {
  actionId: KeyboardShortcutActionId;
  bindings?: KeyboardShortcutBinding[];
  disabled?: boolean;
}

export interface KeyboardShortcutSettings {
  shortcuts: KeyboardShortcutPreference[];
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
  createdAt: Date;
  updatedAt: Date;
}
