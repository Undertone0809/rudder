// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { app, dialog, type BrowserWindow } from "electron";
import { buildDesktopApiRequestUrl } from "./api-url.js";
import { DESKTOP_UPDATE_QUIT_ARG } from "./desktop-update-flow.js";

type DesktopOrganization = { id: string; name: string };
type DesktopLiveRun = { id: string; status: string; agentName: string; issueId?: string | null };
type ActiveRunSummary = { totalRuns: number; organizations: Array<{ id: string; name: string; runs: DesktopLiveRun[] }> };

export function createDesktopQuitFlow(context: {
  appName: string;
  getMainWindow: () => BrowserWindow | null;
  setMainWindow: (value: BrowserWindow | null) => void;
  getServerHandle: () => { apiUrl: string; runtime: { mode: "owned" | "attached" } } | null;
  stopLocalRudder: () => Promise<void>;
  destroyResidentTray: () => void;
}) {
  let quitInFlight: Promise<void> | null = null;
  let quitRequested = false;
  let quitting = false;
  let quitExceptionGuardInstalled = false;

  async function desktopApiRequest<T>(apiPath: string, init?: RequestInit): Promise<T> {
    const apiBase = context.getServerHandle()?.apiUrl;
    if (!apiBase) {
      throw new Error("Local Rudder runtime is not ready");
    }

    const headers = new Headers(init?.headers ?? undefined);
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }

    const response = await fetch(buildDesktopApiRequestUrl(apiBase, apiPath), {
      ...init,
      headers,
    });

    if (!response.ok) {
      throw new Error(`Desktop API request failed (${response.status} ${response.statusText}) for ${apiPath}`);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  async function listActiveRunsForQuit(): Promise<ActiveRunSummary> {
    if (!context.getServerHandle()) {
      return {
        totalRuns: 0,
        organizations: [],
      };
    }

    const organizations = await desktopApiRequest<DesktopOrganization[]>("/orgs");
    const summaries = await Promise.all(organizations.map(async (organization) => {
      const runs = await desktopApiRequest<DesktopLiveRun[]>(
        `/orgs/${encodeURIComponent(organization.id)}/live-runs`,
      );
      return {
        id: organization.id,
        name: organization.name,
        runs,
      };
    }));

    const activeOrganizations = summaries.filter((organization) => organization.runs.length > 0);
    return {
      totalRuns: activeOrganizations.reduce((total, organization) => total + organization.runs.length, 0),
      organizations: activeOrganizations,
    };
  }

  function formatQuitRunDetail(summary: ActiveRunSummary): string {
    const lines = summary.organizations.map((organization) => {
      const runningCount = organization.runs.filter((run) => run.status === "running").length;
      const queuedCount = organization.runs.filter((run) => run.status === "queued").length;
      const parts: string[] = [];
      if (runningCount > 0) parts.push(`${runningCount} running`);
      if (queuedCount > 0) parts.push(`${queuedCount} queued`);
      if (parts.length === 0) parts.push(`${organization.runs.length} active`);
      return `${organization.name}: ${parts.join(", ")}`;
    });

    const maxVisibleLines = 6;
    const visible = lines.slice(0, maxVisibleLines);
    if (lines.length > maxVisibleLines) {
      visible.push(`+${lines.length - maxVisibleLines} more organizations`);
    }

    return visible.join("\n");
  }

  async function promptForQuitBehavior(summary: ActiveRunSummary): Promise<"cancel" | "quit" | "stop-runs"> {
    const runtimeMode = context.getServerHandle()?.runtime.mode;
    const attachedRuntime = runtimeMode === "attached";
    const window = context.getMainWindow() && !context.getMainWindow()!.isDestroyed() ? context.getMainWindow()! : undefined;
    const detail = formatQuitRunDetail(summary);

    if (attachedRuntime) {
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        title: context.appName,
        buttons: ["Keep Runs Running", "Stop Runs and Quit", "Cancel"],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
        message: summary.totalRuns === 1
          ? "There is 1 active run."
          : `There are ${summary.totalRuns} active runs.`,
        detail:
          "Rudder is attached to an existing local runtime. You can quit the desktop app and leave those runs running, or stop them first.\n\n"
          + detail,
      };
      const result = window
        ? await dialog.showMessageBox(window, options)
        : await dialog.showMessageBox(options);

      if (result.response === 0) return "quit";
      if (result.response === 1) return "stop-runs";
      return "cancel";
    }

    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: context.appName,
      buttons: ["Stop Runs and Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: summary.totalRuns === 1
        ? "There is 1 active run. Quitting will stop it."
        : `There are ${summary.totalRuns} active runs. Quitting will stop them.`,
      detail:
        "This desktop app currently owns the local runtime, so quitting will stop any active work.\n\n"
        + detail,
    };
    const result = window
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

    return result.response === 0 ? "stop-runs" : "cancel";
  }

  async function cancelActiveRunsBeforeQuit(summary: ActiveRunSummary): Promise<void> {
    const runIds = summary.organizations.flatMap((organization) => organization.runs.map((run) => run.id));
    if (runIds.length === 0) return;

    const results = await Promise.allSettled(runIds.map((runId) =>
      desktopApiRequest(`/heartbeat-runs/${encodeURIComponent(runId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      })));

    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length > 0) {
      console.warn(
        `[rudder-desktop] failed to cancel ${failed.length}/${runIds.length} active runs before quit`,
        failed.map((result) => result.status === "rejected" ? result.reason : null),
      );
    }
  }

  function isThreadStreamWorkerExitError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const text = `${error.message}\n${error.stack ?? ""}`.toLowerCase();
    return text.includes("the worker has exited") || text.includes("thread-stream");
  }

  function installQuitExceptionGuard(): void {
    if (quitExceptionGuardInstalled) return;
    quitExceptionGuardInstalled = true;

    process.on("uncaughtException", (error) => {
      if (isThreadStreamWorkerExitError(error)) {
        console.warn("[rudder-desktop] suppressed shutdown-time logging transport error", error);
        return;
      }

      console.error("[rudder-desktop] uncaught exception while quitting", error);
      app.exit(1);
    });
  }

  async function finalizeQuit(options: { forceExit?: boolean } = {}): Promise<void> {
    if (quitting) return;
    quitting = true;
    quitRequested = true;
    installQuitExceptionGuard();

    try {
      const mainWindow = context.getMainWindow();
      if (options.forceExit && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
        context.setMainWindow(null);
      }
      await context.stopLocalRudder();
    } finally {
      context.destroyResidentTray();
      if (options.forceExit) {
        app.exit(0);
        return;
      }
      app.quit();
    }
  }

  async function beginQuitFlow(): Promise<void> {
    if (quitting) return;
    if (quitInFlight) {
      await quitInFlight;
      return;
    }

    quitInFlight = (async () => {
      try {
        let activeRuns: ActiveRunSummary = { totalRuns: 0, organizations: [] };
        try {
          activeRuns = await listActiveRunsForQuit();
        } catch (error) {
          console.warn("[rudder-desktop] failed to inspect active runs before quit; continuing with normal quit", error);
        }

        if (activeRuns.totalRuns > 0) {
          const decision = await promptForQuitBehavior(activeRuns);
          if (decision === "cancel") {
            return;
          }
          if (decision === "stop-runs") {
            await cancelActiveRunsBeforeQuit(activeRuns);
          }
        }

        await finalizeQuit();
      } finally {
        quitInFlight = null;
        if (!quitting) {
          quitRequested = false;
        }
      }
    })();

    await quitInFlight;
  }

  function resolveUpdateQuitResponsePath(argv: string[] = process.argv): string | null {
    const inline = argv.find((arg) => arg.startsWith(`${DESKTOP_UPDATE_QUIT_ARG}=`));
    if (inline) return inline.slice(`${DESKTOP_UPDATE_QUIT_ARG}=`.length).trim() || null;

    const flagIndex = argv.indexOf(DESKTOP_UPDATE_QUIT_ARG);
    if (flagIndex === -1) return null;
    return argv[flagIndex + 1]?.trim() || null;
  }

  function writeUpdateQuitResponse(responsePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(responsePath), { recursive: true });
    fs.writeFileSync(responsePath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  function hideWindowForUpdateQuit(): void {
    const mainWindow = context.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide();
    }
  }

  async function handleUpdateQuitRequest(responsePath: string): Promise<void> {
    try {
      let activeRuns: ActiveRunSummary = { totalRuns: 0, organizations: [] };
      try {
        activeRuns = await listActiveRunsForQuit();
      } catch (error) {
        console.warn("[rudder-desktop] failed to inspect active runs for update quit; continuing with quit", error);
      }

      if (activeRuns.totalRuns > 0) {
        writeUpdateQuitResponse(responsePath, {
          ok: false,
          status: "active_runs",
          totalRuns: activeRuns.totalRuns,
        });
        return;
      }

      hideWindowForUpdateQuit();
      writeUpdateQuitResponse(responsePath, { ok: true, status: "quitting", pid: process.pid });
      await finalizeQuit({ forceExit: true });
    } catch (error) {
      writeUpdateQuitResponse(responsePath, {
        ok: false,
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }


  return {
    listActiveRunsForQuit,
    formatQuitRunDetail,
    beginQuitFlow,
    resolveUpdateQuitResponsePath,
    writeUpdateQuitResponse,
    handleUpdateQuitRequest,
    isQuitting: () => quitting,
    isQuitRequested: () => quitRequested,
  };
}
