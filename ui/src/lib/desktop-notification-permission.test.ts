import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDesktopNotificationPermission,
  readDesktopNotificationPermission,
  requestDesktopNotificationPermission,
} from "./desktop-notification-permission";

const originalNotification = globalThis.Notification;

afterEach(() => {
  if (originalNotification === undefined) {
    Reflect.deleteProperty(globalThis as typeof globalThis & { Notification?: typeof Notification }, "Notification");
  } else {
    globalThis.Notification = originalNotification;
  }
  vi.restoreAllMocks();
});

describe("desktop notification permission helpers", () => {
  it("returns unsupported when Notifications are unavailable", () => {
    Reflect.deleteProperty(globalThis as typeof globalThis & { Notification?: typeof Notification }, "Notification");
    expect(readDesktopNotificationPermission()).toBe("unsupported");
  });

  it("reads the browser notification permission state", () => {
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "granted",
        requestPermission: vi.fn(),
      },
    });

    expect(readDesktopNotificationPermission()).toBe("granted");
  });

  it("requests permission only when the state is still default", async () => {
    const requestPermission = vi.fn().mockResolvedValue("granted");
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "default",
        requestPermission,
      },
    });

    await expect(requestDesktopNotificationPermission()).resolves.toBe("granted");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("formats the permission state for the about page", () => {
    expect(formatDesktopNotificationPermission("granted")).toBe("Allowed");
    expect(formatDesktopNotificationPermission("denied")).toBe("Blocked");
    expect(formatDesktopNotificationPermission("default")).toBe("Not asked");
    expect(formatDesktopNotificationPermission("unsupported")).toBe("Unsupported");
  });
});
