import type { Writable } from "node:stream";

export interface ByteProgressState {
  receivedBytes: number;
  totalBytes?: number | null;
  width?: number;
}

export interface ByteProgressOptions {
  stream?: Writable;
  isTty?: boolean;
  width?: number;
  minIntervalMs?: number;
  now?: () => number;
}

export interface ByteProgressReporter {
  start(totalBytes?: number | null): void;
  update(receivedBytes: number, totalBytes?: number | null): void;
  finish(receivedBytes?: number, totalBytes?: number | null): void;
  fail(): void;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) return `${Math.round(value)} ${BYTE_UNITS[unitIndex]}`;
  return `${value.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
}

function normalizeTotalBytes(totalBytes: number | null | undefined): number | null {
  if (typeof totalBytes !== "number" || !Number.isFinite(totalBytes) || totalBytes <= 0) {
    return null;
  }
  return totalBytes;
}

export function formatByteProgress(state: ByteProgressState): string {
  const width = Math.max(4, state.width ?? 20);
  const receivedBytes = Math.max(0, state.receivedBytes);
  const totalBytes = normalizeTotalBytes(state.totalBytes);

  if (totalBytes === null) {
    return `[downloaded ${formatBytes(receivedBytes)}]`;
  }

  const ratio = Math.max(0, Math.min(1, receivedBytes / totalBytes));
  const filled = Math.round(ratio * width);
  const percent = Math.floor(ratio * 100);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${percent}% ${formatBytes(receivedBytes)}/${formatBytes(totalBytes)}`;
}

function progressSummary(receivedBytes: number, totalBytes: number | null | undefined): string {
  const total = normalizeTotalBytes(totalBytes);
  if (total === null) return formatBytes(receivedBytes);
  return `${formatBytes(receivedBytes)}/${formatBytes(total)}`;
}

export function createByteProgress(label: string, options: ByteProgressOptions = {}): ByteProgressReporter {
  const stream = options.stream ?? process.stdout;
  const isTty = options.isTty ?? Boolean((stream as Writable & { isTTY?: boolean }).isTTY);
  const width = options.width ?? 20;
  const minIntervalMs = options.minIntervalMs ?? 80;
  const now = options.now ?? (() => Date.now());

  let started = false;
  let finished = false;
  let lastRenderAt = 0;
  let lastLineLength = 0;
  let latestReceivedBytes = 0;
  let latestTotalBytes: number | null | undefined = null;

  function render(receivedBytes: number, totalBytes: number | null | undefined, force = false): void {
    if (finished) return;
    latestReceivedBytes = receivedBytes;
    latestTotalBytes = totalBytes;

    if (!isTty) return;

    const currentTime = now();
    const total = normalizeTotalBytes(totalBytes);
    const complete = total !== null && receivedBytes >= total;
    if (!force && currentTime - lastRenderAt < minIntervalMs && !complete) return;

    const line = `${label} ${formatByteProgress({ receivedBytes, totalBytes, width })}`;
    const padding = lastLineLength > line.length ? " ".repeat(lastLineLength - line.length) : "";
    stream.write(`\r${line}${padding}`);
    lastLineLength = line.length;
    lastRenderAt = currentTime;
  }

  function start(totalBytes?: number | null): void {
    if (started || finished) return;
    started = true;
    latestTotalBytes = totalBytes;
    if (isTty) {
      render(0, totalBytes, true);
    } else {
      stream.write(`${label}...\n`);
    }
  }

  function update(receivedBytes: number, totalBytes?: number | null): void {
    if (!started) start(totalBytes);
    render(receivedBytes, totalBytes, false);
  }

  function finish(receivedBytes = latestReceivedBytes, totalBytes = latestTotalBytes): void {
    if (finished) return;
    if (!started) start(totalBytes);
    if (isTty) {
      render(receivedBytes, totalBytes, true);
      stream.write("\n");
    } else {
      stream.write(`${label} complete (${progressSummary(receivedBytes, totalBytes)}).\n`);
    }
    finished = true;
  }

  function fail(): void {
    if (finished) return;
    if (isTty && started) {
      stream.write("\n");
    } else if (!isTty && started) {
      stream.write(`${label} failed.\n`);
    }
    finished = true;
  }

  return {
    start,
    update,
    finish,
    fail,
  };
}
