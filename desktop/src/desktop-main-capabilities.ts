import { Notification, app } from "electron";
import type { DesktopCapabilities } from "./desktop-capabilities.js";

export function resolveDesktopCapabilities(): DesktopCapabilities {
  let notifications = false;
  try {
    notifications = Notification.isSupported();
  } catch {
    notifications = false;
  }
  return {
    badgeCount: typeof app.setBadgeCount === "function",
    notifications,
  };
}
