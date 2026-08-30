import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_FLUSH_DELAY_MS = 50;

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

export function boundedLocalAppLogTail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

export class LocalAppRuntimeLogStore {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly flushDelayMs: number;
  private readonly pending = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(options: { directory: string; maxBytes: number; flushDelayMs?: number }) {
    this.directory = options.directory;
    this.maxBytes = options.maxBytes;
    this.flushDelayMs = Math.max(1, options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS);
  }

  private filePath(id: string): string {
    const digest = createHash("sha256").update(id).digest("hex");
    return path.join(this.directory, `${digest}.log`);
  }

  async read(id: string): Promise<string> {
    try {
      return boundedLocalAppLogTail(await readFile(this.filePath(id), "utf8"), this.maxBytes);
    } catch (error) {
      if (isMissingFile(error)) return "";
      throw error;
    }
  }

  schedule(id: string, text: string): void {
    this.pending.set(id, boundedLocalAppLogTail(text, this.maxBytes));
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.flushPending(id).catch(() => undefined);
    }, this.flushDelayMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  async clear(id: string): Promise<void> {
    this.pending.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    await this.enqueue(id, () => rm(this.filePath(id), { force: true }));
  }

  async flush(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    await this.flushPending(id);
    await (this.writes.get(id) ?? Promise.resolve());
    if (this.pending.has(id)) await this.flush(id);
  }

  async flushAll(): Promise<void> {
    const ids = new Set([...this.pending.keys(), ...this.timers.keys(), ...this.writes.keys()]);
    await Promise.all([...ids].map((id) => this.flush(id)));
  }

  private async flushPending(id: string): Promise<void> {
    const text = this.pending.get(id);
    if (text === undefined) return;
    this.pending.delete(id);
    await this.enqueue(id, () => this.writeSnapshot(id, text));
  }

  private async enqueue(id: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writes.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.writes.set(id, current);
    try {
      await current;
    } finally {
      if (this.writes.get(id) === current) this.writes.delete(id);
    }
  }

  private async writeSnapshot(id: string, text: string): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const destination = this.filePath(id);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
      await file.close();
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
