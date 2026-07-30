import type { ToastInput } from "@/context/ToastContext";
import { useToast } from "@/context/ToastContext";
import { ANNOTATION_RUNTIME_RESTART_TOAST_ID } from "@/lib/chat-annotation-runtime";
import { readDesktopShell } from "@/lib/desktop-shell";
import { useEffect, useRef } from "react";
import type { DevServerHealthStatus } from "../api/health";

function formatRelativeTimestamp(value: string | null): string | null {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return null;

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "just now";
  const deltaMinutes = Math.round(deltaMs / 60_000);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `${deltaDays}d ago`;
}

function describeReason(devServer: DevServerHealthStatus): string {
  if (devServer.envFileChanged && devServer.reason === "backend_changes_and_pending_migrations") {
    return "Environment configuration changed and migrations are pending.";
  }
  if (devServer.envFileChanged) {
    return "Environment configuration changed since this server booted.";
  }
  if (devServer.reason === "backend_changes_and_pending_migrations") {
    return "Backend files changed and migrations are pending.";
  }
  if (devServer.reason === "pending_migrations") {
    return "Pending migrations need a fresh boot.";
  }
  return "Backend files changed since this server booted.";
}

function buildRestartToast(
  devServer: DevServerHealthStatus,
  pushToast: (input: ToastInput) => string | null,
): ToastInput {
  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const details: string[] = [];
  const desktopShell = readDesktopShell();

  if (changedAt) {
    details.push(`Updated ${changedAt}.`);
  }

  details.push("Restart pnpm dev after the active work is safe to interrupt.");

  if (devServer.changedPathsSample.length > 0) {
    const sample = devServer.changedPathsSample.slice(0, 2).join(", ");
    const extra = devServer.changedPathCount > 2 ? ` +${devServer.changedPathCount - 2} more` : "";
    details.push(`Changed: ${sample}${extra}.`);
  }

  if (devServer.pendingMigrations.length > 0) {
    const pending = devServer.pendingMigrations.slice(0, 2).join(", ");
    const extra = devServer.pendingMigrations.length > 2 ? ` +${devServer.pendingMigrations.length - 2} more` : "";
    details.push(`Pending migrations: ${pending}${extra}.`);
  }

  return {
    id: ANNOTATION_RUNTIME_RESTART_TOAST_ID,
    title: "Restart required",
    body: `${describeReason(devServer)} ${details.join(" ")}`.trim(),
    tone: "warn",
    persistent: true,
    ...(desktopShell
      ? {
        action: {
          label: "Restart Rudder",
          onClick: async () => {
            try {
              await desktopShell.restart();
            } catch (error) {
              pushToast({
                title: "Could not restart Rudder",
                body: error instanceof Error ? error.message : "Try restarting Rudder manually.",
                tone: "error",
              });
              throw error;
            }
          },
        },
      }
      : {}),
  };
}

function fingerprintRestartStatus(devServer: DevServerHealthStatus): string {
  return JSON.stringify({
    reason: devServer.reason,
    lastChangedAt: devServer.lastChangedAt,
    changedPathCount: devServer.changedPathCount,
    changedPathsSample: devServer.changedPathsSample,
    envFileChanged: devServer.envFileChanged,
    pendingMigrations: devServer.pendingMigrations,
    lastRestartAt: devServer.lastRestartAt,
  });
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const { dismissToast, pushToast } = useToast();
  const toastIdRef = useRef<string | null>(null);
  const restartKey = devServer?.enabled && devServer.restartRequired
    ? fingerprintRestartStatus(devServer)
    : null;

  useEffect(() => {
    if (!devServer || !restartKey) {
      dismissToast(ANNOTATION_RUNTIME_RESTART_TOAST_ID);
      toastIdRef.current = null;
      return;
    }

    if (toastIdRef.current) dismissToast(toastIdRef.current);
    toastIdRef.current = pushToast({
      ...buildRestartToast(devServer, pushToast),
      dedupeKey: `dev-restart:${restartKey}`,
    });
    return () => {
      dismissToast(ANNOTATION_RUNTIME_RESTART_TOAST_ID);
      toastIdRef.current = null;
    };
  }, [restartKey, dismissToast, pushToast]);

  return null;
}
