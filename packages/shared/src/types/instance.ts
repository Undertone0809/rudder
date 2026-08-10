export type InstanceLocale = "en" | "zh-CN";

export interface InstanceBrowserSettings {
  enabled: boolean;
  openLinksIn: "built_in" | "default_browser";
}

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  showDeveloperDiagnostics: boolean;
  experimentalPluginsEnabled: boolean;
  experimentalSitesEnabled: boolean;
  experimentalGoalsEnabled: boolean;
  locale: InstanceLocale;
  productAnalyticsMode: "off" | "anonymous" | "account_linked";
  productAnalyticsConsentEpoch: number;
}

export interface InstanceNotificationSettings {
  desktopInboxNotifications: boolean;
  desktopDockBadge: boolean;
  desktopIssueNotifications: boolean;
  desktopChatNotifications: boolean;
}

export interface OperatorProfileSettings {
  nickname: string;
  moreAboutYou: string;
}

export type KeyboardShortcutActionId =
  | "commandPalette.open"
  | "settings.open"
  | "chat.create"
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
  browser: InstanceBrowserSettings;
  general: InstanceGeneralSettings;
  notifications: InstanceNotificationSettings;
  createdAt: Date;
  updatedAt: Date;
}
