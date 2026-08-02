export interface ConditionalFileSaveRequest {
  filePath: string;
  content: string;
  expectedContent: string;
}

export interface ConditionalFileSaveFailure extends ConditionalFileSaveRequest {
  error: unknown;
}

interface ConditionalFileSaveQueueOptions<Result> {
  save: (request: ConditionalFileSaveRequest) => Promise<Result>;
  savedContent: (result: Result, request: ConditionalFileSaveRequest) => string;
  onSaving?: (request: ConditionalFileSaveRequest) => void;
  onSaved?: (
    result: Result,
    request: ConditionalFileSaveRequest,
    savedContent: string,
  ) => void;
  onError?: (failure: ConditionalFileSaveFailure) => void;
  isConflict?: (error: unknown) => boolean;
}

interface PendingSave {
  content: string;
  initialExpectedContent: string;
}

/**
 * Serializes conditional writes while coalescing each file to its latest draft.
 * A later save for the same file always uses the successful prior write as its
 * expected baseline, so a local autosave and a tab-switch flush cannot conflict
 * with each other.
 */
export class ConditionalFileSaveQueue<Result> {
  private readonly baselines = new Map<string, string>();
  private readonly pending = new Map<string, PendingSave>();
  private readonly conflicts = new Set<string>();
  private readonly failedContent = new Map<string, string>();
  private readonly localDrafts = new Map<string, string>();
  private drainPromise: Promise<void> | null = null;
  private inFlightFilePath: string | null = null;

  constructor(private readonly options: ConditionalFileSaveQueueOptions<Result>) {}

  seed(filePath: string, content: string) {
    if (
      this.inFlightFilePath === filePath
      || this.pending.has(filePath)
      || this.conflicts.has(filePath)
      || this.localDrafts.has(filePath)
    ) {
      return;
    }
    this.baselines.set(filePath, content);
  }

  enqueue(filePath: string, content: string, expectedContent: string) {
    this.enqueueSave(filePath, content, expectedContent, false);
  }

  retry(filePath: string, content: string, expectedContent: string) {
    this.enqueueSave(filePath, content, expectedContent, true);
  }

  private enqueueSave(
    filePath: string,
    content: string,
    expectedContent: string,
    retryFailed: boolean,
  ) {
    if (this.conflicts.has(filePath)) return;
    if (!retryFailed && this.failedContent.get(filePath) === content) return;
    this.failedContent.delete(filePath);
    if (!this.baselines.has(filePath)) {
      this.baselines.set(filePath, expectedContent);
    }
    this.localDrafts.set(filePath, content);
    this.pending.set(filePath, { content, initialExpectedContent: expectedContent });
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = null;
        if (this.pending.size > 0) this.enqueueDrain();
      });
    }
  }

  resolveWithServer(filePath: string, content: string) {
    this.pending.delete(filePath);
    this.conflicts.delete(filePath);
    this.failedContent.delete(filePath);
    this.localDrafts.delete(filePath);
    this.baselines.set(filePath, content);
  }

  localContent(filePath: string | null) {
    return filePath ? this.localDrafts.get(filePath) ?? null : null;
  }

  isConflicted(filePath: string | null) {
    return Boolean(filePath && this.conflicts.has(filePath));
  }

  async whenIdle() {
    while (this.drainPromise) await this.drainPromise;
  }

  private enqueueDrain() {
    if (this.drainPromise || this.pending.size === 0) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.pending.size > 0) this.enqueueDrain();
    });
  }

  private async drain() {
    while (this.pending.size > 0) {
      const entry = this.pending.entries().next().value as
        | [string, PendingSave]
        | undefined;
      if (!entry) return;
      const [filePath, pending] = entry;
      this.pending.delete(filePath);
      const expectedContent = this.baselines.get(filePath)
        ?? pending.initialExpectedContent;
      if (pending.content === expectedContent) {
        this.failedContent.delete(filePath);
        this.localDrafts.delete(filePath);
        continue;
      }
      const request = {
        filePath,
        content: pending.content,
        expectedContent,
      };
      this.inFlightFilePath = filePath;
      this.options.onSaving?.(request);
      try {
        const result = await this.options.save(request);
        const savedContent = this.options.savedContent(result, request);
        this.baselines.set(filePath, savedContent);
        this.failedContent.delete(filePath);
        if (!this.pending.has(filePath)) this.localDrafts.delete(filePath);
        this.options.onSaved?.(result, request, savedContent);
      } catch (error) {
        const latest = this.pending.get(filePath);
        this.pending.delete(filePath);
        const latestContent = latest?.content ?? request.content;
        if (this.options.isConflict?.(error)) {
          this.conflicts.add(filePath);
        } else {
          this.failedContent.set(filePath, latestContent);
        }
        this.localDrafts.set(filePath, latestContent);
        this.options.onError?.({
          ...request,
          content: latestContent,
          error,
        });
      } finally {
        this.inFlightFilePath = null;
      }
    }
  }
}
