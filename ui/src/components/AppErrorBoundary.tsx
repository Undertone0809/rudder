import { Component, type ErrorInfo, type ReactNode } from "react";
import { readDesktopShell } from "@/lib/desktop-shell";
import { ConsoleRingBuffer } from "@/lib/console-ring-buffer";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
  info: ErrorInfo | null;
  autoReloading: boolean;
};

const AUTO_RELOADABLE_ERROR_MESSAGES = [
  "React.Children.only expected to receive a single React element child.",
];
const AUTO_RECOVERY_STORAGE_KEY = "rudder:app-error-boundary:auto-recovery.v1";
const AUTO_RECOVERY_WINDOW_MS = 30_000;

function isAutoReloadableRenderError(error: Error): boolean {
  return AUTO_RELOADABLE_ERROR_MESSAGES.includes(error.message);
}

function currentRouteKey(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = {
    error: null,
    info: null,
    autoReloading: false,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, info: null, autoReloading: isAutoReloadableRenderError(error) };
  }

  override componentDidMount(): void {
    if (!this.state.error) {
      this.clearAutoRecoveryAttempt();
    }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const autoReloading = isAutoReloadableRenderError(error) && this.reserveAutoRecoveryAttempt(error);
    if (autoReloading) {
      console.warn("[rudder-ui] recoverable render error; reloading UI once", error, info);
      this.setState({ error, info, autoReloading });
      this.reloadUi();
      return;
    }

    console.error("[rudder-ui] unrecoverable render error", error, info);
    this.setState({ error, info, autoReloading: false });
  }

  private reloadUi = () => {
    const desktopShell = readDesktopShell();
    if (desktopShell?.reloadApp) {
      void desktopShell.reloadApp().catch(() => {
        window.location.reload();
      });
      return;
    }
    window.location.reload();
  };

  private reserveAutoRecoveryAttempt(error: Error): boolean {
    try {
      const now = Date.now();
      const route = currentRouteKey();
      const raw = window.sessionStorage.getItem(AUTO_RECOVERY_STORAGE_KEY);
      const previous = raw ? JSON.parse(raw) as { attemptedAt?: unknown; message?: unknown; route?: unknown } : null;
      if (
        previous
        && previous.message === error.message
        && previous.route === route
        && typeof previous.attemptedAt === "number"
        && now - previous.attemptedAt < AUTO_RECOVERY_WINDOW_MS
      ) {
        return false;
      }

      window.sessionStorage.setItem(AUTO_RECOVERY_STORAGE_KEY, JSON.stringify({
        attemptedAt: now,
        message: error.message,
        route,
      }));
      return true;
    } catch {
      return false;
    }
  }

  private clearAutoRecoveryAttempt(): void {
    try {
      window.sessionStorage.removeItem(AUTO_RECOVERY_STORAGE_KEY);
    } catch {
      // Ignore unavailable sessionStorage; the fallback surface still works.
    }
  }

  private restartRudder = () => {
    const desktopShell = readDesktopShell();
    if (desktopShell) {
      void desktopShell.restart().catch(() => {
        window.location.reload();
      });
      return;
    }
    window.location.reload();
  };

  private copyDiagnostic = () => {
    const recentConsole = ConsoleRingBuffer.formatRecent(20);
    const diagnostic = [
      this.state.error?.stack ?? this.state.error?.message ?? "Unknown render error",
      `Route: ${window.location.href}`,
      `Time: ${new Date().toISOString()}`,
      `User agent: ${navigator.userAgent}`,
      recentConsole ? `Recent console:\n${recentConsole}` : "",
      this.state.info?.componentStack ?? "",
    ].filter(Boolean).join("\n\n");
    const desktopShell = readDesktopShell();
    if (desktopShell) {
      void desktopShell.copyText(diagnostic);
      return;
    }
    void navigator.clipboard?.writeText(diagnostic);
  };

  override render() {
    if (!this.state.error) return this.props.children;
    if (this.state.autoReloading) {
      return (
        <main className="min-h-screen bg-background text-foreground">
          <div className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-6 py-12">
            <div className="text-sm font-medium text-muted-foreground">
              Rudder is refreshing the UI...
            </div>
          </div>
        </main>
      );
    }

    const isDesktopShell = readDesktopShell() !== null;

    return (
      <main className="min-h-screen bg-background text-foreground">
        <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-12">
          <div className="rounded-[var(--radius-lg)] border border-border bg-card p-6 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.04em] text-destructive">
              UI recovery
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-normal">
              Rudder hit a UI failure.
            </h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">
              Your local runtime may still be running. Reload the UI first; restart Rudder if the problem continues.
            </p>
            <pre className="mt-4 max-h-40 overflow-auto rounded-[var(--radius-md)] border border-border bg-muted/40 p-3 text-xs text-muted-foreground">
              {this.state.error.message}
            </pre>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
                onClick={this.reloadUi}
              >
                Reload UI
              </button>
              {isDesktopShell ? (
                <button
                  type="button"
                  className="rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground"
                  onClick={this.restartRudder}
                >
                  Restart Rudder
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-full border border-border px-4 py-2 text-sm font-medium text-foreground"
                onClick={this.copyDiagnostic}
              >
                Copy diagnostic
              </button>
            </div>
          </div>
        </div>
      </main>
    );
  }
}
