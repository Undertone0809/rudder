import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { resolveRoundedWindowShapeRects } from "./desktop-window-effects.js";

type MainFrameAssertion = (event: IpcMainInvokeEvent, action: string) => void;

function syncWindowsRoundedWindowShape(window: BrowserWindow): void {
  if (process.platform !== "win32" || window.isDestroyed()) return;
  if (window.isMaximized() || window.isFullScreen()) {
    window.setShape([]);
    return;
  }

  const { width, height } = window.getContentBounds();
  window.setShape(resolveRoundedWindowShapeRects(width, height));
}

export function installWindowsRoundedWindowShape(window: BrowserWindow): void {
  if (process.platform !== "win32") return;

  const sync = () => syncWindowsRoundedWindowShape(window);
  window.once("ready-to-show", sync);
  window.on("resize", sync);
  window.on("maximize", sync);
  window.on("unmaximize", sync);
  window.on("enter-full-screen", sync);
  window.on("leave-full-screen", sync);
}

export function registerWindowsWindowIpcHandlers(assertCurrentMainFrame: MainFrameAssertion): void {
  ipcMain.handle("desktop:minimize-window", async (event) => {
    assertCurrentMainFrame(event, "Desktop window minimize");
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.handle("desktop:toggle-maximize-window", async (event): Promise<boolean> => {
    assertCurrentMainFrame(event, "Desktop window maximize");
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    window.isMaximized() ? window.unmaximize() : window.maximize();
    return window.isMaximized();
  });
  ipcMain.handle("desktop:close-window", async (event) => {
    assertCurrentMainFrame(event, "Desktop window close");
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.handle("desktop:is-window-maximized", async (event): Promise<boolean> => {
    assertCurrentMainFrame(event, "Desktop window maximize state");
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
}
