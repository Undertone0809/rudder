import { Component, type ErrorInfo, type ReactNode } from "react";
import { readDesktopShell } from "@/lib/desktop-shell";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
  info: ErrorInfo | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = {
    error: null,
    info: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, info: null };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[rudder-ui] unrecoverable render error", error, info);
    this.setState({ error, info });
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
    const diagnostic = [
      this.state.error?.stack ?? this.state.error?.message ?? "Unknown render error",
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
