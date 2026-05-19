import { describe, expect, it, vi } from "vitest";
import {
  readWorkspaceLaunchTargetIconDataUrl,
  resolveDarwinAppBundleIconPath,
} from "./workspace-launch-icons.js";

function image(dataUrl: string, empty = false) {
  return {
    isEmpty: () => empty,
    resize: vi.fn(() => ({
      isEmpty: () => empty,
      resize: vi.fn(),
      toDataURL: () => dataUrl,
    })),
    toDataURL: () => dataUrl,
  };
}

describe("resolveDarwinAppBundleIconPath", () => {
  it("resolves extensionless bundle icon names to .icns resources", async () => {
    await expect(resolveDarwinAppBundleIconPath("/Applications/Warp.app", {
      platform: "darwin",
      readPlistRawValue: async () => "AppIcon",
      pathExists: (targetPath) => targetPath === "/Applications/Warp.app/Contents/Resources/AppIcon.icns",
    })).resolves.toBe("/Applications/Warp.app/Contents/Resources/AppIcon.icns");
  });

  it("returns null outside macOS app bundles", async () => {
    await expect(resolveDarwinAppBundleIconPath("/usr/bin/code", {
      platform: "linux",
      readPlistRawValue: async () => "Code",
      pathExists: () => true,
    })).resolves.toBeNull();
  });
});

describe("readWorkspaceLaunchTargetIconDataUrl", () => {
  it("uses bundle resources for macOS app icons without calling the native file icon API", async () => {
    const getFileIcon = vi.fn(async () => image("data:image/png;base64,file"));
    const createImageFromPath = vi.fn(() => image("data:image/png;base64,bundle"));

    await expect(readWorkspaceLaunchTargetIconDataUrl({
      id: "vscode",
      label: "VS Code",
      kind: "ide",
      iconPath: "/Applications/Visual Studio Code.app",
    }, {
      platform: "darwin",
      getFileIcon,
      createImageFromPath,
      resolveBundleIconPath: async () => "/Applications/Visual Studio Code.app/Contents/Resources/Code.icns",
    })).resolves.toBe("data:image/png;base64,bundle");

    expect(getFileIcon).not.toHaveBeenCalled();
    expect(createImageFromPath).toHaveBeenCalledWith(
      "/Applications/Visual Studio Code.app/Contents/Resources/Code.icns",
    );
  });

  it("falls back to the native file icon API for non-app targets", async () => {
    const getFileIcon = vi.fn(async () => image("data:image/png;base64,file"));
    const createImageFromPath = vi.fn(() => image("data:image/png;base64,bundle"));

    await expect(readWorkspaceLaunchTargetIconDataUrl({
      id: "vscode",
      label: "VS Code",
      kind: "ide",
      iconPath: "/usr/local/bin/code",
    }, {
      platform: "darwin",
      getFileIcon,
      createImageFromPath,
    })).resolves.toBe("data:image/png;base64,file");

    expect(getFileIcon).toHaveBeenCalledWith("/usr/local/bin/code", { size: "large" });
    expect(createImageFromPath).not.toHaveBeenCalled();
  });

  it("does not call the native file icon API when a macOS app bundle icon is missing", async () => {
    const getFileIcon = vi.fn(async () => image("", true));
    const createImageFromPath = vi.fn(() => image("data:image/png;base64,bundle"));

    await expect(readWorkspaceLaunchTargetIconDataUrl({
      id: "terminal",
      label: "Terminal",
      kind: "terminal",
      iconPath: "/System/Applications/Utilities/Terminal.app",
    }, {
      platform: "darwin",
      getFileIcon,
      createImageFromPath,
      resolveBundleIconPath: async () => null,
    })).resolves.toBeUndefined();

    expect(getFileIcon).not.toHaveBeenCalled();
    expect(createImageFromPath).not.toHaveBeenCalled();
  });
});
