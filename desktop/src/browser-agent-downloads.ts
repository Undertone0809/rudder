import path from "node:path";

type DownloadEvent = {
  preventDefault(): void;
};

type DownloadWebContents = object;

type DownloadItem = {
  cancel(): void;
  getFilename(): string;
  getURL(): string;
  getReceivedBytes(): number;
  getTotalBytes(): number;
  setSavePath(path: string): void;
  on(event: "done" | "updated", listener: (_event: unknown, state: string) => void): unknown;
};

type PendingDownload = {
  directory: string;
  resolve(value: BrowserAgentDownloadResult): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
};

export type BrowserAgentDownloadResult = {
  filename: string;
  path: string;
  url: string;
  state: "completed";
  receivedBytes: number;
  totalBytes: number;
};

const pendingByContents = new WeakMap<DownloadWebContents, PendingDownload>();
const activeByContents = new WeakMap<DownloadWebContents, Set<{ item: DownloadItem; pending: PendingDownload }>>();
const MAX_DOWNLOAD_BYTES = 25_000_000;

function safeFilename(value: string): string {
  const basename = path.basename(value).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180);
  return basename && basename !== "." && basename !== ".." ? basename : "download.bin";
}

export function armAgentBrowserDownload(
  contents: DownloadWebContents,
  directory: string,
  timeoutMs: number,
): Promise<BrowserAgentDownloadResult> {
  const existing = pendingByContents.get(contents);
  if (existing) {
    throw new Error("A Browser download is already pending for this tab.");
  }
  return new Promise<BrowserAgentDownloadResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingByContents.delete(contents);
      reject(new Error("Browser download timed out."));
    }, timeoutMs);
    pendingByContents.set(contents, { directory, resolve, reject, timeout });
  });
}

export function cancelAgentBrowserDownload(contents: DownloadWebContents): void {
  const pending = pendingByContents.get(contents);
  if (pending) {
    pendingByContents.delete(contents);
    clearTimeout(pending.timeout);
    pending.reject(new Error("Browser download was cancelled."));
  }
  const active = activeByContents.get(contents);
  if (!active) return;
  activeByContents.delete(contents);
  for (const record of active) {
    record.item.cancel();
    record.pending.reject(new Error("Browser download was cancelled."));
  }
}

export function handleAgentBrowserDownload(
  event: DownloadEvent,
  item: DownloadItem,
  contents: DownloadWebContents,
): boolean {
  const pending = pendingByContents.get(contents);
  if (!pending) {
    event.preventDefault();
    return false;
  }
  pendingByContents.delete(contents);
  clearTimeout(pending.timeout);
  const filename = safeFilename(item.getFilename());
  const outputPath = path.join(pending.directory, filename);
  item.setSavePath(outputPath);
  const active = activeByContents.get(contents) ?? new Set();
  const record = { item, pending };
  active.add(record);
  activeByContents.set(contents, active);
  let settled = false;
  const reject = (message: string) => {
    if (settled) return;
    settled = true;
    active.delete(record);
    if (active.size === 0) activeByContents.delete(contents);
    pending.reject(new Error(message));
  };
  item.on("updated", () => {
    if (item.getReceivedBytes() <= MAX_DOWNLOAD_BYTES
      && (item.getTotalBytes() <= 0 || item.getTotalBytes() <= MAX_DOWNLOAD_BYTES)) return;
    item.cancel();
    reject("Browser download exceeded the size limit.");
  });
  item.on("done", (_doneEvent, state) => {
    if (settled) return;
    settled = true;
    active.delete(record);
    if (active.size === 0) activeByContents.delete(contents);
    if (state !== "completed") {
      pending.reject(new Error("Browser download did not complete."));
      return;
    }
    pending.resolve({
      filename,
      path: outputPath,
      url: item.getURL().slice(0, 8_192),
      state: "completed",
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
    });
  });
  return true;
}
