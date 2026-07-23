import {
  resolveDesktopBrowserShortcutInput,
  type DesktopBrowserShortcutAction,
} from "./browser-shortcuts.js";

export type DesktopCloseShortcutInput = {
  type?: string;
  key?: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export function isSidePanelCloseShortcutInput(
  input: DesktopCloseShortcutInput,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (input.type === "keyUp") return false;
  const key = input.key?.toLowerCase();
  const isCloseKey = key === "w" || input.code === "KeyW";
  if (!isCloseKey || input.alt || input.shift) return false;
  if (platform === "darwin") return Boolean(input.meta) && !input.control;
  return Boolean(input.control) && !input.meta;
}

export type ProtectedDesktopShortcutRoute =
  | { kind: "close_browser_owner_tab" }
  | { kind: "close_side_panel_tab" }
  | { kind: "browser"; action: DesktopBrowserShortcutAction };

export function resolveProtectedDesktopShortcutRoute(
  input: DesktopCloseShortcutInput,
  context: {
    sidePanelCloseActive: boolean;
    browserSurfaceActive: boolean;
    operatorBrowserGuest: boolean;
  },
  platform: NodeJS.Platform = process.platform,
): ProtectedDesktopShortcutRoute | null {
  if (isSidePanelCloseShortcutInput(input, platform)) {
    if (context.operatorBrowserGuest) {
      return { kind: "close_browser_owner_tab" };
    }
    if (context.sidePanelCloseActive) {
      return { kind: "close_side_panel_tab" };
    }
  }
  const action = resolveDesktopBrowserShortcutInput(input, platform);
  if (!action || (!context.browserSurfaceActive && !context.operatorBrowserGuest)) return null;
  return { kind: "browser", action };
}
