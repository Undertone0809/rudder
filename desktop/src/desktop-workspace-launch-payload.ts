import { app, nativeImage } from "electron";
import type { DesktopWorkspaceLaunchTarget } from "./ide-opener.js";
import { readWorkspaceLaunchTargetIconDataUrl } from "./workspace-launch-icons.js";

export type DesktopWorkspaceLaunchTargetPayload = Omit<DesktopWorkspaceLaunchTarget, "iconPath"> & {
  iconDataUrl?: string;
};

export async function toWorkspaceLaunchTargetPayload(
  target: DesktopWorkspaceLaunchTarget,
): Promise<DesktopWorkspaceLaunchTargetPayload> {
  const iconDataUrl = await readWorkspaceLaunchTargetIconDataUrl(target, {
    platform: process.platform,
    getFileIcon: app.getFileIcon.bind(app),
    createImageFromPath: nativeImage.createFromPath,
  });
  return {
    id: target.id,
    label: target.label,
    kind: target.kind,
    ...(iconDataUrl ? { iconDataUrl } : {}),
  };
}
