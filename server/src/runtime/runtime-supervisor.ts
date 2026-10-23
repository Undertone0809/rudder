import { AsyncLocalStorage } from "node:async_hooks";

export type RuntimeDisposer = () => void | Promise<void>;

type RuntimeResource = {
  name: string;
  dispose: RuntimeDisposer;
  critical: boolean;
};

type RuntimeSupervisorOptions = {
  onDisposeError?: (failure: { name: string; error: unknown }) => void;
};

export class RuntimeSupervisor {
  private readonly resources: RuntimeResource[] = [];
  private readonly onDisposeError?: RuntimeSupervisorOptions["onDisposeError"];
  private readonly disposerContext = new AsyncLocalStorage<symbol>();
  private readonly activeDisposerTokens = new Set<symbol>();
  private disposeInFlight: Promise<void> | null = null;

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.onDisposeError = options.onDisposeError;
  }

  own(name: string, dispose: RuntimeDisposer, options: { critical?: boolean } = {}): void {
    if (this.disposeInFlight) {
      throw new Error("Cannot own runtime resource after disposal has started");
    }
    this.resources.push({ name, dispose, critical: options.critical === true });
  }

  dispose(): Promise<void> {
    const disposerToken = this.disposerContext.getStore();
    if (disposerToken && this.activeDisposerTokens.has(disposerToken)) {
      return Promise.resolve();
    }
    if (this.disposeInFlight) return this.disposeInFlight;

    this.disposeInFlight = Promise.resolve().then(() => this.disposeResources());
    return this.disposeInFlight;
  }

  private async disposeResources(): Promise<void> {
    const criticalFailures: unknown[] = [];
    try {
      while (this.resources.length > 0) {
        const resource = this.resources.pop();
        if (!resource) continue;
        const disposerToken = Symbol(resource.name);
        this.activeDisposerTokens.add(disposerToken);
        try {
          await this.disposerContext.run(disposerToken, resource.dispose);
        } catch (error) {
          if (resource.critical) criticalFailures.push(error);
          try {
            this.onDisposeError?.({ name: resource.name, error });
          } catch {
            // Cleanup reporting must never interrupt the remaining disposers.
          }
        } finally {
          this.activeDisposerTokens.delete(disposerToken);
        }
      }
    } finally {
      this.activeDisposerTokens.clear();
      this.disposerContext.disable();
    }
    if (criticalFailures.length > 0) {
      throw new AggregateError(criticalFailures, "Critical runtime cleanup failed");
    }
  }
}

export async function supervisedStart<T>(
  supervisor: RuntimeSupervisor,
  start: () => Promise<T>,
): Promise<T> {
  try {
    return await start();
  } catch (error) {
    try {
      await supervisor.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Startup failed and runtime cleanup was not confirmed");
    }
    throw error;
  }
}
