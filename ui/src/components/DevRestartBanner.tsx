import { useEffect, useRef } from "react";
import type { ToastInput } from "@/context/ToastContext";
import { useToast } from "@/context/ToastContext";
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

function buildRestartToast(devServer: DevServerHealthStatus): ToastInput {
  const changedAt = formatRelativeTimestamp(devServer.lastChangedAt);
  const details: string[] = [];

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
    title: "Restart required",
    body: `${describeReason(devServer)} ${details.join(" ")}`.trim(),
    tone: "warn",
    ttlMs: 10_000,
  };
}

function fingerprintRestartStatus(devServer: DevServerHealthStatus): string {
  return JSON.stringify({
    reason: devServer.reason,
    lastChangedAt: devServer.lastChangedAt,
    changedPathCount: devServer.changedPathCount,
    changedPathsSample: devServer.changedPathsSample,
    pendingMigrations: devServer.pendingMigrations,
    lastRestartAt: devServer.lastRestartAt,
  });
}

export function DevRestartBanner({ devServer }: { devServer?: DevServerHealthStatus }) {
  const { pushToast } = useToast();
  const lastToastKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!devServer?.enabled || !devServer.restartRequired) {
      lastToastKeyRef.current = null;
      return;
    }

    const nextKey = fingerprintRestartStatus(devServer);
    if (lastToastKeyRef.current === nextKey) {
      return;
    }
    lastToastKeyRef.current = nextKey;

    pushToast({
      ...buildRestartToast(devServer),
      dedupeKey: `dev-restart:${nextKey}`,
    });
  }, [devServer, pushToast]);

  return null;
}
