import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { BootScreenState } from "./boot-screen.js";

contextBridge.exposeInMainWorld("rudderBoot", {
  getState: () => ipcRenderer.invoke("desktop:get-recovery-state") as Promise<BootScreenState>,
  onState: (listener: (state: BootScreenState) => void) => {
    const wrapped = (_event: IpcRendererEvent, state: BootScreenState) => listener(state);
    ipcRenderer.on("desktop:recovery-state", wrapped);
    return () => ipcRenderer.removeListener("desktop:recovery-state", wrapped);
  },
  retryStartup: () => ipcRenderer.invoke("desktop:retry-startup") as Promise<void>,
  openSupportDraft: () => ipcRenderer.invoke("desktop:send-feedback") as Promise<void>,
  openBugReport: () => ipcRenderer.invoke("desktop:open-bug-report") as Promise<void>,
  copySupportEmail: () => ipcRenderer.invoke("desktop:copy-support-email") as Promise<void>,
  copyBugReportUrl: () => ipcRenderer.invoke("desktop:copy-bug-report-url") as Promise<void>,
  copyDiagnostic: () => ipcRenderer.invoke("desktop:copy-recovery-diagnostic") as Promise<void>,
  openInstanceFolder: () => ipcRenderer.invoke("desktop:open-recovery-instance-folder") as Promise<void>,
});

declare global {
  interface Window {
    rudderBoot: {
      getState(): Promise<BootScreenState>;
      onState(listener: (state: BootScreenState) => void): () => void;
      retryStartup(): Promise<void>;
      openSupportDraft(): Promise<void>;
      openBugReport(): Promise<void>;
      copySupportEmail(): Promise<void>;
      copyBugReportUrl(): Promise<void>;
      copyDiagnostic(): Promise<void>;
      openInstanceFolder(): Promise<void>;
    };
  }
}
