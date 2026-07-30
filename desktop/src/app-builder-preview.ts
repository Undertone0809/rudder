import { realpath, stat } from "node:fs/promises";

import {
  parseAppBuilderManifest,
  type AppBuilderManifest,
} from "./app-builder-manifest.js";
import type { LocalAppsController } from "./local-apps-controller.js";
import {
  type LocalAppDefinition,
  type LocalAppDefinitionDraft,
  type LocalAppRegistry,
} from "./local-apps-registry.js";
import type { LocalAppRuntimeView } from "./local-apps-runtime.js";

type ManagedLocalAppsController = Pick<
  LocalAppsController,
  "createDefinition" | "updateDefinition" | "start" | "stop" | "status" | "attestedTarget"
>;

export interface AppBuilderPreviewBinding {
  desktopInstallationId: string;
  definitionId: string;
  appPublicId: string;
  localBindingId: string;
}

export interface AppBuilderPreviewControllerOptions {
  registry: LocalAppRegistry;
  localApps: ManagedLocalAppsController;
  runnerExecutable: string;
  buildRunnerArgv: (input: {
    appRoot: string;
    manifest: AppBuilderManifest;
  }) => string[];
  inheritedEnvNames?: string[];
}

function sameManagedDefinition(
  definition: LocalAppDefinition,
  draft: LocalAppDefinitionDraft,
): boolean {
  return definition.title === draft.title
    && definition.executable === draft.executable
    && definition.cwd === draft.cwd
    && JSON.stringify(definition.argv) === JSON.stringify(draft.argv)
    && JSON.stringify(definition.inheritedEnvNames) === JSON.stringify(draft.inheritedEnvNames)
    && JSON.stringify(definition.readiness) === JSON.stringify(draft.readiness)
    && definition.openPath === draft.openPath;
}

export class AppBuilderPreviewController {
  private readonly registry: LocalAppRegistry;
  private readonly localApps: ManagedLocalAppsController;
  private readonly runnerExecutable: string;
  private readonly buildRunnerArgv: AppBuilderPreviewControllerOptions["buildRunnerArgv"];
  private readonly inheritedEnvNames: string[];
  private readonly appOperations = new Map<string, Promise<void>>();

  constructor(options: AppBuilderPreviewControllerOptions) {
    this.registry = options.registry;
    this.localApps = options.localApps;
    this.runnerExecutable = options.runnerExecutable;
    this.buildRunnerArgv = options.buildRunnerArgv;
    this.inheritedEnvNames = [...new Set(options.inheritedEnvNames ?? [])].sort();
  }

  private async withAppOperation<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.appOperations.get(appId) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    this.appOperations.set(appId, settled);
    try {
      return await result;
    } finally {
      if (this.appOperations.get(appId) === settled) {
        this.appOperations.delete(appId);
      }
    }
  }

  private async managedDraft(
    appRoot: string,
    manifestInput: unknown,
  ): Promise<{ manifest: AppBuilderManifest; draft: LocalAppDefinitionDraft }> {
    const manifest = parseAppBuilderManifest(manifestInput);
    const canonicalAppRoot = await realpath(appRoot);
    if (!(await stat(canonicalAppRoot)).isDirectory()) {
      throw new Error("App Builder app root must be a directory");
    }
    return {
      manifest,
      draft: {
        title: manifest.app.name,
        executable: this.runnerExecutable,
        argv: this.buildRunnerArgv({ appRoot: canonicalAppRoot, manifest }),
        cwd: canonicalAppRoot,
        inheritedEnvNames: this.inheritedEnvNames,
        readiness: {
          path: manifest.runtime.readinessPath,
          timeoutMs: manifest.runtime.readinessTimeoutMs,
        },
        openPath: manifest.runtime.openPath,
      },
    };
  }

  private async requireBinding(binding: AppBuilderPreviewBinding): Promise<LocalAppDefinition> {
    const definition = await this.registry.getDefinition(binding.definitionId);
    if (
      definition.desktopInstallationId !== binding.desktopInstallationId
      || definition.appPublicId !== binding.appPublicId
      || definition.localBindingId !== binding.localBindingId
      || definition.desktopInstallationId !== this.registry.installationId
    ) {
      throw new Error("App Builder preview binding does not match this Desktop installation");
    }
    return definition;
  }

  async assertBinding(
    binding: AppBuilderPreviewBinding,
    expectedAppRoot?: string,
  ): Promise<LocalAppDefinition> {
    const definition = await this.requireBinding(binding);
    if (expectedAppRoot && definition.cwd !== await realpath(expectedAppRoot)) {
      throw new Error("App Builder preview binding belongs to another app root");
    }
    return definition;
  }

  /**
   * Creates or refreshes a trusted, Rudder-managed Local App binding.
   * This method must remain reachable only from Desktop main; renderer input
   * must never select the runner executable or arguments.
   */
  async ensureBinding(options: {
    appRoot: string;
    manifest: unknown;
    binding?: AppBuilderPreviewBinding | null;
    allowManagedAutoApproval?: boolean;
  }): Promise<AppBuilderPreviewBinding> {
    const { manifest, draft } = await this.managedDraft(options.appRoot, options.manifest);
    return this.withAppOperation(manifest.app.slug, async () => {
      let definition: LocalAppDefinition;
      if (options.binding) {
        definition = await this.requireBinding(options.binding);
        if (definition.cwd !== draft.cwd) {
          throw new Error("App Builder preview binding belongs to another app root");
        }
        const prepared = await this.registry.prepareDefinition(draft);
        if (!sameManagedDefinition(definition, prepared)) {
          definition = await this.localApps.updateDefinition(definition.id, prepared);
        }
      } else {
        if (options.allowManagedAutoApproval) {
          definition = await this.registry.createDefinition(draft);
          definition = await this.registry.approveDefinition(
            definition.id,
            definition.trustFingerprint,
          );
        } else {
          definition = await this.localApps.createDefinition(draft);
        }
      }

      return {
        desktopInstallationId: definition.desktopInstallationId,
        definitionId: definition.id,
        appPublicId: definition.appPublicId,
        localBindingId: definition.localBindingId,
      };
    });
  }

  async start(binding: AppBuilderPreviewBinding): Promise<{
    runtime: LocalAppRuntimeView;
    target: { origin: string; openPath: string; partition: string };
  }> {
    await this.requireBinding(binding);
    const runtime = await this.localApps.start(binding.definitionId);
    const target = await this.localApps.attestedTarget(binding.definitionId);
    if (!target) {
      await this.localApps.stop(binding.definitionId).catch(() => undefined);
      throw new Error("App Builder preview started without an attested target");
    }
    return { runtime, target };
  }

  async stop(binding: AppBuilderPreviewBinding): Promise<LocalAppRuntimeView> {
    await this.requireBinding(binding);
    return this.localApps.stop(binding.definitionId);
  }

  async status(binding: AppBuilderPreviewBinding): Promise<LocalAppRuntimeView> {
    await this.requireBinding(binding);
    return this.localApps.status(binding.definitionId);
  }
}
