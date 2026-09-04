import { clearTimeout, setTimeout } from "node:timers";
import type { ByteProgressReporter } from "../utils/progress.js";

export type DesktopUpdateProgressPhase =
  | "starting"
  | "preparing_runtime"
  | "resolving_release"
  | "downloading_checksums"
  | "downloading_asset"
  | "verifying_checksum"
  | "prepared"
  | "ready_to_install"
  | "waiting_for_active_runs"
  | "preparing_restart"
  | "closing"
  | "failed";

type DesktopUpdateProgressEvent = {
  source: "rudder-desktop-update";
  phase: DesktopUpdateProgressPhase;
  message: string;
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  totalRuns?: number;
  error?: string;
  assetName?: string;
  assetChecksum?: string;
  assetKind?: "full" | "shell";
  releaseDigest?: string;
  stagedArtifactPath?: string;
  stagedArtifactDigest?: string;
  at: string;
};

function normalizeProgressTotal(totalBytes: number | null | undefined): number | null {
  return typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null;
}

export function writeDesktopProgress(event: Omit<DesktopUpdateProgressEvent, "source" | "at">): void {
  const payload: DesktopUpdateProgressEvent = {
    source: "rudder-desktop-update",
    ...event,
    at: new Date().toISOString(),
  };
  try {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    if (code !== "EPIPE") throw error;
  }
}

function desktopDownloadPhase(label: string): DesktopUpdateProgressPhase {
  return label.toLowerCase().includes("shasums")
    ? "downloading_checksums"
    : "downloading_asset";
}

export function createDesktopProgressFactory(): (label: string) => ByteProgressReporter {
  return (label: string) => {
    const phase = desktopDownloadPhase(label);
    let latestReceivedBytes = 0;
    let latestTotalBytes: number | null | undefined = null;

    function emitByteProgress(
      message: string,
      receivedBytes: number,
      totalBytes: number | null | undefined,
    ): void {
      const total = normalizeProgressTotal(totalBytes);
      writeDesktopProgress({
        phase,
        message,
        transferredBytes: Math.max(0, receivedBytes),
        ...(total === null
          ? {}
          : {
            totalBytes: total,
            percent: Math.max(0, Math.min(100, Math.floor((Math.max(0, receivedBytes) / total) * 100))),
          }),
      });
    }

    return {
      start(totalBytes?: number | null) {
        latestReceivedBytes = 0;
        latestTotalBytes = totalBytes;
        emitByteProgress(label, 0, totalBytes);
      },
      update(receivedBytes: number, totalBytes?: number | null) {
        latestReceivedBytes = receivedBytes;
        latestTotalBytes = totalBytes;
        emitByteProgress(label, receivedBytes, totalBytes);
      },
      finish(receivedBytes = latestReceivedBytes, totalBytes = latestTotalBytes) {
        latestReceivedBytes = receivedBytes;
        latestTotalBytes = totalBytes;
        emitByteProgress(`${label} complete`, receivedBytes, totalBytes);
      },
      fail() {
        writeDesktopProgress({
          phase,
          message: `${label} failed`,
          transferredBytes: Math.max(0, latestReceivedBytes),
          error: `${label} failed`,
        });
      },
    };
  };
}

export function createDesktopApplySignalController(): {
  waitForInitialSignal: () => Promise<{ force: boolean }>;
  waitForForceRequest: (timeoutMs: number) => Promise<boolean>;
  close: () => void;
} {
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  let buffer = "";
  let closed = false;
  let initialSettled = false;
  let forceRequested = false;
  let resolveInitial!: (value: { force: boolean }) => void;
  let rejectInitial!: (error: Error) => void;
  const forceWaiters = new Set<(force: boolean) => void>();
  const initialSignal = new Promise<{ force: boolean }>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });

  const settleForceWaiters = (force: boolean) => {
    for (const resolve of forceWaiters) resolve(force);
    forceWaiters.clear();
  };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    process.stdin.off("data", onData);
    process.stdin.off("end", onEnd);
    process.stdin.off("error", onError);
    settleForceWaiters(false);
  };
  const onData = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const command of lines.map((line) => line.trim())) {
      if (command === "force-apply") {
        forceRequested = true;
        if (!initialSettled) {
          initialSettled = true;
          resolveInitial({ force: true });
        }
        settleForceWaiters(true);
      } else if (command === "apply" && !initialSettled) {
        initialSettled = true;
        resolveInitial({ force: false });
      }
    }
  };
  const onEnd = () => {
    if (!initialSettled) {
      initialSettled = true;
      rejectInitial(new Error("Desktop update apply signal ended before confirmation."));
    }
    cleanup();
  };
  const onError = (error: Error) => {
    if (!initialSettled) {
      initialSettled = true;
      rejectInitial(error);
    }
    cleanup();
  };

  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  process.stdin.on("error", onError);
  return {
    waitForInitialSignal: () => initialSignal,
    waitForForceRequest: async (timeoutMs: number) => {
      if (forceRequested) return true;
      if (closed) return false;
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (force: boolean) => {
          if (settled) return;
          settled = true;
          forceWaiters.delete(finish);
          clearTimeout(timer);
          resolve(force);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        timer.unref?.();
        forceWaiters.add(finish);
      });
    },
    close: cleanup,
  };
}
