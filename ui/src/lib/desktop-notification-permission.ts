export type DesktopNotificationPermissionState =
  | NotificationPermission
  | "unsupported";

export function readDesktopNotificationPermission(): DesktopNotificationPermissionState {
  if (typeof Notification === "undefined") return "unsupported";
  const permission = Notification.permission;
  return permission === "granted" || permission === "denied" || permission === "default"
    ? permission
    : "unsupported";
}

export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermissionState> {
  if (typeof Notification === "undefined" || typeof Notification.requestPermission !== "function") {
    return "unsupported";
  }

  if (Notification.permission === "granted" || Notification.permission === "denied") {
    return Notification.permission;
  }

  const permission = await Notification.requestPermission();
  return permission === "granted" || permission === "denied" || permission === "default"
    ? permission
    : "unsupported";
}

export function formatDesktopNotificationPermission(permission: DesktopNotificationPermissionState): string {
  switch (permission) {
    case "granted":
      return "Allowed";
    case "denied":
      return "Blocked";
    case "default":
      return "Not asked";
    default:
      return "Unsupported";
  }
}
