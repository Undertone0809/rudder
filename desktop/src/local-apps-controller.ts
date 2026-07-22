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
>;

type ConfirmationAction = "create" | "update" | "start";

type ControllerOptions = {
  registry: LocalAppRegistry;
  runtime: RuntimeController;
  selectFolder: () => Promise<string | null>;
  confirmDefinition: (definition: PreparedLocalAppDefinition | LocalAppDefinition, action: ConfirmationAction) => Promise<boolean>;
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
  private readonly bindingOperations = new Map<string, Promise<void>>();

  constructor(options: ControllerOptions) {
    this.registry = options.registry;
    this.runtime = options.runtime;
    this.selectFolder = options.selectFolder;
    this.confirmDefinition = options.confirmDefinition;
  }

  async listDefinitions(): Promise<LocalAppDefinition[]> {
    return this.registry.listDefinitions();
  }

  async pickAndDiscover(): Promise<{ canceled: true } | { canceled: false; draft: PreparedLocalAppDefinition }> {
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

  async createDefinition(input: unknown): Promise<LocalAppDefinition> {
    const prepared = await this.registry.prepareDefinition(rendererDraft(input));
    await this.requireNativeConfirmation(prepared, "create");
    const created = await this.registry.createDefinition(prepared);
    return this.withBindingOperation(created.id, () =>
      this.registry.approveDefinition(created.id, prepared.trustFingerprint));
  }

  async updateDefinition(id: string, input: unknown): Promise<LocalAppDefinition> {
    return this.withBindingOperation(id, async () => {
      ensureInactive((await this.runtime.status(id)).status, "update");
      const prepared = await this.registry.prepareDefinition(rendererDraft(input));
      const previous = await this.registry.getDefinition(id);
      const requiresReview = previous.trustFingerprint !== prepared.trustFingerprint
        || previous.approvedFingerprint !== prepared.trustFingerprint;
      if (requiresReview) await this.requireNativeConfirmation(prepared, "update");
      const updated = await this.registry.updateDefinition(id, prepared);
      return requiresReview
        ? this.registry.approveDefinition(updated.id, updated.trustFingerprint)
        : updated;
    });
  }

  async deleteDefinition(id: string): Promise<void> {
    await this.withBindingOperation(id, async () => {
      ensureInactive((await this.runtime.status(id)).status, "delete");
      await this.registry.deleteDefinition(id);
    });
  }

  async start(id: string): Promise<LocalAppRuntimeView> {
    return this.withBindingOperation(id, async () => {
      const definition = await this.registry.getDefinition(id);
      if (definition.approvedFingerprint !== definition.trustFingerprint) {
        await this.requireNativeConfirmation(definition, "start");
        await this.registry.approveDefinition(id, definition.trustFingerprint);
      }
      return this.runtime.start(id);
    });
  }

  async stop(id: string): Promise<LocalAppRuntimeView> {
    return this.withBindingOperation(id, () => this.runtime.stop(id));
  }

  async status(id: string): Promise<LocalAppRuntimeView> {
    return this.runtime.status(id);
  }

  async logs(id: string): Promise<string[]> {
    return this.runtime.logs(id);
  }

  async attestedTarget(id: string): Promise<{ origin: string; openPath: string; partition: string } | null> {
    return this.runtime.attestedTarget(id);
  }

  async shutdown(): Promise<void> {
    await this.runtime.shutdown();
  }
}
