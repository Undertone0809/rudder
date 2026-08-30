import { discoverLocalAppDefinition } from "./local-apps-discovery.js";
import {
  type LocalAppDefinition,
  type LocalAppDefinitionDraft,
  type LocalAppRegistry,
  type PreparedLocalAppDefinition,
} from "./local-apps-registry.js";
import type { LocalAppRuntimeManager, LocalAppRuntimeView } from "./local-apps-runtime.js";

type RuntimeController = Pick<
  LocalAppRuntimeManager,
  "start" | "stop" | "status" | "logs" | "attestedTarget" | "shutdown"
> & Partial<Pick<LocalAppRuntimeManager, "discardPersistedState">>;

type ConfirmationAction = "create" | "update" | "start";

type ControllerOptions = {
  registry: LocalAppRegistry;
  runtime: RuntimeController;
  selectFolder: () => Promise<string | null>;
  confirmDefinition: (definition: PreparedLocalAppDefinition | LocalAppDefinition, action: ConfirmationAction) => Promise<boolean>;
  featureEnabled?: boolean;
  shutdownDrainTimeoutMs?: number;
};

const DEFINITION_KEYS = new Set([
  "title",
  "executable",
  "argv",
  "cwd",
  "inheritedEnvNames",
  "readiness",
  "openPath",
  "trustFingerprint",
]);

function rendererDraft(value: unknown): LocalAppDefinitionDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Local App definition");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !DEFINITION_KEYS.has(key))) {
    throw new Error("Local App definition contains an unsupported field");
  }
  const readiness = input.readiness;
  if (!readiness || typeof readiness !== "object" || Array.isArray(readiness)
    || Object.keys(readiness).some((key) => key !== "path" && key !== "timeoutMs")) {
    throw new Error("Invalid Local App readiness definition");
  }
  return {
    title: input.title as string,
    executable: input.executable as string,
    argv: input.argv as string[],
    cwd: input.cwd as string,
    inheritedEnvNames: input.inheritedEnvNames as string[],
    readiness: {
      path: (readiness as Record<string, unknown>).path as string,
      timeoutMs: (readiness as Record<string, unknown>).timeoutMs as number,
    },
    openPath: input.openPath as string,
  };
}

function ensureInactive(status: LocalAppRuntimeView["status"], action: string): void {
  if (["starting", "running", "stopping", "orphaned_unverified"].includes(status)) {
    throw new Error(`Cannot ${action} an active or unverified Local App`);
  }
}

export class LocalAppsController {
  private readonly registry: LocalAppRegistry;
  private readonly runtime: RuntimeController;
  private readonly selectFolder: () => Promise<string | null>;
  private readonly confirmDefinition: ControllerOptions["confirmDefinition"];
  private readonly shutdownDrainTimeoutMs: number;
  private readonly bindingOperations = new Map<string, Promise<void>>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private featureEnabled: boolean;
  private acceptingOperations = true;
  private shutdownPromise: Promise<void> | null = null;

  constructor(options: ControllerOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.selectFolder = options.selectFolder;
    this.confirmDefinition = options.confirmDefinition;
    this.featureEnabled = options.featureEnabled ?? true;
    this.shutdownDrainTimeoutMs = Math.max(1, options.shutdownDrainTimeoutMs ?? 2_000);
  }

  async listDefinitions(): Promise<LocalAppDefinition[]> {
    const definitions = await this.registry.listDefinitions();
    const groups = new Map<string, LocalAppDefinition[]>();
    for (const definition of definitions) {
      const group = groups.get(definition.cwd) ?? [];
      group.push(definition);
      groups.set(definition.cwd, group);
    }
    const visible: LocalAppDefinition[] = [];
    for (const group of groups.values()) {
      if (group.length === 1) {
        visible.push(group[0]!);
        continue;
      }
      const candidates = await Promise.all(group.map(async (definition) => ({
        definition,
        status: await this.runtime.status(definition.id).then((view) => view.status).catch(() => null),
      })));
      const guarded = candidates.filter(({ status }) => status === null || !["stopped", "failed"].includes(status));
      const selectable = guarded.length > 0 ? guarded : candidates;
      selectable.sort((left, right) => right.definition.updatedAt.localeCompare(left.definition.updatedAt));
      visible.push(selectable[0]!.definition);
    }
    return visible;
  }

  async pickAndDiscover(): Promise<{ canceled: true } | { canceled: false; draft: PreparedLocalAppDefinition }> {
    this.ensureFeatureEnabled();
    const folder = await this.selectFolder();
    if (!folder) return { canceled: true };
    const discovered = await discoverLocalAppDefinition(folder);
    return { canceled: false, draft: await this.registry.prepareDefinition(discovered) };
  }

  private async requireNativeConfirmation(
    definition: PreparedLocalAppDefinition | LocalAppDefinition,
    action: ConfirmationAction,
  ): Promise<void> {
    if (!await this.confirmDefinition(definition, action)) {
      throw new Error("Local App native confirmation was canceled");
    }
  }

  private async withBindingOperation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.bindingOperations.get(id) ?? Promise.resolve();
    const result = previous.then(operation);
    const completion = result.then(() => undefined, () => undefined);
    this.bindingOperations.set(id, completion);
    try {
      return await result;
    } finally {
      if (this.bindingOperations.get(id) === completion) this.bindingOperations.delete(id);
    }
  }

  private ensureAcceptingOperations(): void {
    if (!this.acceptingOperations) throw new Error("Local Apps are shutting down");
  }

  private ensureFeatureEnabled(): void {
    if (!this.featureEnabled) {
      throw new Error("Plugins is disabled in Experimental settings");
    }
  }

  private withAdmittedOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.ensureAcceptingOperations();
    const result = Promise.resolve().then(operation);
    this.activeOperations.add(result);
    void result.then(
      () => this.activeOperations.delete(result),
      () => this.activeOperations.delete(result),
    );
    return result;
  }

  private async drainActiveOperations(): Promise<void> {
    while (this.activeOperations.size > 0) {
      await Promise.allSettled([...this.activeOperations]);
    }
  }

  private boundedActiveOperationDrain(): Promise<void> {
    const drain = this.drainActiveOperations();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => {
        finish(new Error(
          `Timed out after ${this.shutdownDrainTimeoutMs}ms waiting for Local App controller operations to drain`,
        ));
      }, this.shutdownDrainTimeoutMs);
      timeout.unref();
      void drain.then(() => finish(), (error) => finish(error));
    });
  }

  async createDefinition(input: unknown): Promise<LocalAppDefinition> {
    return this.withAdmittedOperation(async () => {
      this.ensureFeatureEnabled();
      const prepared = await this.registry.prepareDefinition(rendererDraft(input));
      const existing = await this.registry.findDefinitionByCwd(prepared.cwd);
      if (existing) {
        return this.withBindingOperation(existing.id, async () => {
          ensureInactive((await this.runtime.status(existing.id)).status, "update");
          this.ensureAcceptingOperations();
          this.ensureFeatureEnabled();
          await this.requireNativeConfirmation(prepared, "create");
          this.ensureAcceptingOperations();
          this.ensureFeatureEnabled();
          const updated = await this.registry.updateDefinition(existing.id, prepared);
          return this.registry.approveDefinition(updated.id, updated.trustFingerprint);
        });
      }
      this.ensureAcceptingOperations();
      this.ensureFeatureEnabled();
      await this.requireNativeConfirmation(prepared, "create");
      this.ensureAcceptingOperations();
      this.ensureFeatureEnabled();
      const created = await this.registry.createDefinition(prepared);
      return this.withBindingOperation(created.id, () =>
        this.registry.approveDefinition(created.id, prepared.trustFingerprint));
    });
  }

  async updateDefinition(id: string, input: unknown): Promise<LocalAppDefinition> {
    return this.withAdmittedOperation(() =>
      this.withBindingOperation(id, async () => {
        this.ensureAcceptingOperations();
        this.ensureFeatureEnabled();
        ensureInactive((await this.runtime.status(id)).status, "update");
        const prepared = await this.registry.prepareDefinition(rendererDraft(input));
        const previous = await this.registry.getDefinition(id);
        const requiresReview = previous.trustFingerprint !== prepared.trustFingerprint
          || previous.approvedFingerprint !== prepared.trustFingerprint;
        this.ensureAcceptingOperations();
        this.ensureFeatureEnabled();
        if (requiresReview) await this.requireNativeConfirmation(prepared, "update");
        this.ensureAcceptingOperations();
        this.ensureFeatureEnabled();
        const updated = await this.registry.updateDefinition(id, prepared);
        return requiresReview
          ? this.registry.approveDefinition(updated.id, updated.trustFingerprint)
          : updated;
      }));
  }

  async deleteDefinition(id: string): Promise<void> {
    await this.withAdmittedOperation(() =>
      this.withBindingOperation(id, async () => {
        this.ensureAcceptingOperations();
        this.ensureFeatureEnabled();
        ensureInactive((await this.runtime.status(id)).status, "delete");
        this.ensureAcceptingOperations();
        await this.registry.deleteDefinition(id);
        await this.runtime.discardPersistedState?.(id);
      }));
  }

  async start(id: string): Promise<LocalAppRuntimeView> {
    return this.withAdmittedOperation(() =>
      this.withBindingOperation(id, async () => {
        this.ensureAcceptingOperations();
        this.ensureFeatureEnabled();
        const definition = await this.registry.getDefinition(id);
        this.ensureAcceptingOperations();
        if (definition.approvedFingerprint !== definition.trustFingerprint) {
          await this.requireNativeConfirmation(definition, "start");
          this.ensureAcceptingOperations();
          this.ensureFeatureEnabled();
          await this.registry.approveDefinition(id, definition.trustFingerprint);
        }
        this.ensureAcceptingOperations();
        this.ensureFeatureEnabled();
        return this.runtime.start(id);
      }));
  }

  async stop(id: string): Promise<LocalAppRuntimeView> {
    return this.withAdmittedOperation(() =>
      this.withBindingOperation(id, async () => {
        this.ensureAcceptingOperations();
        return this.runtime.stop(id);
      }));
  }

  async status(id: string): Promise<LocalAppRuntimeView> {
    return this.runtime.status(id);
  }

  async logs(id: string): Promise<string[]> {
    return this.runtime.logs(id);
  }

  async attestedTarget(id: string): Promise<{ origin: string; openPath: string; partition: string } | null> {
    this.ensureFeatureEnabled();
    return this.runtime.attestedTarget(id);
  }

  async setFeatureEnabled(enabled: boolean): Promise<void> {
    if (this.featureEnabled === enabled) return;
    this.featureEnabled = enabled;
    if (enabled) return;

    await this.drainActiveOperations();
    const definitions = await this.registry.listDefinitions();
    await Promise.all(definitions.map((definition) =>
      this.withBindingOperation(definition.id, async () => {
        const status = await this.runtime.status(definition.id);
        if (["starting", "running", "stopping"].includes(status.status)) {
          await this.runtime.stop(definition.id);
        }
      })));
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.acceptingOperations = false;
    let runtimeCleanup: Promise<void>;
    try {
      runtimeCleanup = this.runtime.shutdown();
    } catch (error) {
      runtimeCleanup = Promise.reject(error);
    }
    const operationDrain = this.boundedActiveOperationDrain();
    this.shutdownPromise = Promise.allSettled([runtimeCleanup, operationDrain]).then((results) => {
      const errors = results.flatMap((result, index) => result.status === "rejected"
        ? [new Error(
            index === 0
              ? "Local App runtime cleanup failed"
              : "Local App controller operation drain failed",
            { cause: result.reason },
          )]
        : []);
      if (errors.length > 0) throw new AggregateError(errors, "Local App controller shutdown failed");
    });
    return this.shutdownPromise;
  }
}
