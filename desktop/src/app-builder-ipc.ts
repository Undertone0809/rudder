import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  type AppBuilderDataManager,
  type AppBuilderDataSnapshot,
} from "./app-builder-data.js";
import {
  normalizeAppBuilderRelativePath,
  parseAppBuilderManifest,
  readAppBuilderManifest,
  resolveAppBuilderPath,
  type AppBuilderManifest,
} from "./app-builder-manifest.js";
import {
  type AppBuilderPreviewBinding,
  type AppBuilderPreviewController,
} from "./app-builder-preview.js";
import {
  copyOfficialAppBuilderScaffold,
  type CopyOfficialAppBuilderScaffoldOptions,
} from "./app-builder-scaffold.js";

export const APP_BUILDER_IPC_CHANNELS = {
  inspect: "desktop:app-builder:inspect",
  scaffold: "desktop:app-builder:scaffold",
  ensurePreview: "desktop:app-builder:ensure-preview",
  startPreview: "desktop:app-builder:start-preview",
  stopPreview: "desktop:app-builder:stop-preview",
  previewStatus: "desktop:app-builder:preview-status",
  snapshot: "desktop:app-builder:snapshot",
  exportSnapshot: "desktop:app-builder:export-snapshot",
  importData: "desktop:app-builder:import-data",
  promoteRelease: "desktop:app-builder:promote-release",
  restoreSnapshot: "desktop:app-builder:restore-snapshot",
  rollbackRelease: "desktop:app-builder:rollback-release",
} as const;

type IpcEvent = { sender: unknown; senderFrame: unknown };
type Renderer = { mainFrame: unknown };
type IpcMainLike = {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
};

export interface AppBuilderControllerOptions {
  templateRoot: string;
  resolveProjectRoot: (projectId: string) => Promise<string>;
  preview: AppBuilderPreviewController;
  data: AppBuilderDataManager;
  selectExportDirectory: (input: {
    appId: string;
    snapshotId: string;
  }) => Promise<string | null>;
  selectImportPackage: (input: { appId: string }) => Promise<string | null>;
  migrateRelease?: (input: {
    appRoot: string;
    releaseRoot: string;
    stagedDataRoot: string;
    manifest: AppBuilderManifest;
  }) => Promise<void>;
}

interface AppLocation {
  projectRoot: string;
  appRoot: string;
  manifest: AppBuilderManifest;
}

export class AppBuilderController {
  private readonly templateRoot: string;
  private readonly resolveProjectRoot: AppBuilderControllerOptions["resolveProjectRoot"];
  private readonly preview: AppBuilderPreviewController;
  private readonly data: AppBuilderDataManager;
  private readonly selectExportDirectory: AppBuilderControllerOptions["selectExportDirectory"];
  private readonly selectImportPackage: AppBuilderControllerOptions["selectImportPackage"];
  private readonly migrateRelease: AppBuilderControllerOptions["migrateRelease"];
  private readonly freshScaffoldRoots = new Set<string>();

  constructor(options: AppBuilderControllerOptions) {
    this.templateRoot = options.templateRoot;
    this.resolveProjectRoot = options.resolveProjectRoot;
    this.preview = options.preview;
    this.data = options.data;
    this.selectExportDirectory = options.selectExportDirectory;
    this.selectImportPackage = options.selectImportPackage;
    this.migrateRelease = options.migrateRelease;
  }

  private async location(projectId: string, appDirectory: string): Promise<AppLocation> {
    const projectRoot = await realpath(await this.resolveProjectRoot(projectId));
    const normalizedDirectory = normalizeAppBuilderRelativePath(
      appDirectory,
      "app directory",
      { allowDot: true },
    );
    const appRoot = await resolveAppBuilderPath(
      projectRoot,
      normalizedDirectory,
      { mustExist: true, allowDot: true },
    );
    return {
      projectRoot,
      appRoot,
      manifest: await readAppBuilderManifest(appRoot),
    };
  }

  private async dataRoot(location: AppLocation): Promise<string> {
    const developmentDirectory = path.posix.dirname(location.manifest.data.developmentPath);
    return resolveAppBuilderPath(
      location.appRoot,
      developmentDirectory,
      { mustExist: true },
    );
  }

  private async stopForDataMutation(
    location: AppLocation,
    binding: AppBuilderPreviewBinding,
  ): Promise<void> {
    await this.preview.assertBinding(binding, location.appRoot);
    const runtime = await this.preview.status(binding);
    if (runtime.status === "running") {
      await this.preview.stop(binding);
      return;
    }
    if (["starting", "stopping", "orphaned_unverified"].includes(runtime.status)) {
      throw new Error("App Builder data cannot change during an unresolved preview transition");
    }
  }

  async inspect(projectId: string, appDirectory: string): Promise<{ manifest: AppBuilderManifest }> {
    return { manifest: (await this.location(projectId, appDirectory)).manifest };
  }

  async scaffold(
    projectId: string,
    targetDirectory: string,
    appId: string,
    title: string,
  ): Promise<{ manifest: AppBuilderManifest; appDirectory: string }> {
    const projectRoot = await realpath(await this.resolveProjectRoot(projectId));
    const normalizedTarget = normalizeAppBuilderRelativePath(targetDirectory, "target directory");
    const templateManifest = await readAppBuilderManifest(this.templateRoot);
    const manifest = parseAppBuilderManifest({
      ...templateManifest,
      app: { slug: appId, name: title },
    });
    const result = await copyOfficialAppBuilderScaffold({
      templateRoot: this.templateRoot,
      workspaceRoot: projectRoot,
      targetDirectory: normalizedTarget,
      manifest,
    });
    const response = {
      manifest,
      appDirectory: normalizedTarget,
    };
    this.freshScaffoldRoots.add(await realpath(result.appRoot));
    return response;
  }

  async ensurePreview(
    projectId: string,
    appDirectory: string,
    binding?: AppBuilderPreviewBinding | null,
    authorizeManagedStart = false,
  ): Promise<AppBuilderPreviewBinding> {
    const location = await this.location(projectId, appDirectory);
    const allowManagedAutoApproval = !binding
      && (authorizeManagedStart || this.freshScaffoldRoots.has(location.appRoot));
    try {
      return await this.preview.ensureBinding({
        appRoot: location.appRoot,
        manifest: location.manifest,
        binding,
        allowManagedAutoApproval,
      });
    } finally {
      if (allowManagedAutoApproval) this.freshScaffoldRoots.delete(location.appRoot);
    }
  }

  async startPreview(
    projectId: string,
    appDirectory: string,
    binding: AppBuilderPreviewBinding,
  ) {
    const ensured = await this.ensurePreview(projectId, appDirectory, binding);
    return this.preview.start(ensured);
  }

  async stopPreview(
    projectId: string,
    appDirectory: string,
    binding: AppBuilderPreviewBinding,
  ) {
    const location = await this.location(projectId, appDirectory);
    await this.preview.assertBinding(binding, location.appRoot);
    return this.preview.stop(binding);
  }

  async previewStatus(
    projectId: string,
    appDirectory: string,
    binding: AppBuilderPreviewBinding,
  ) {
    const location = await this.location(projectId, appDirectory);
    await this.preview.assertBinding(binding, location.appRoot);
    return this.preview.status(binding);
  }

  async snapshot(
    projectId: string,
    appDirectory: string,
    binding: AppBuilderPreviewBinding,
  ): Promise<Pick<AppBuilderDataSnapshot, "id" | "manifest">> {
    const location = await this.location(projectId, appDirectory);
    await this.stopForDataMutation(location, binding);
    const { id, manifest } = await this.data.snapshot(
      binding.localBindingId,
      location.manifest.app.slug,
      await this.dataRoot(location),
    );
    return { id, manifest };
  }

  async exportSnapshot(
    projectId: string,
    appDirectory: string,
    snapshotId: string,
    binding: AppBuilderPreviewBinding,
  ): Promise<{ canceled: boolean }> {
    const location = await this.location(projectId, appDirectory);
    await this.preview.assertBinding(binding, location.appRoot);
    const snapshot = await this.data.getSnapshot(
      binding.localBindingId,
      location.manifest.app.slug,
      snapshotId,
    );
    const destination = await this.selectExportDirectory({
      appId: location.manifest.app.slug,
      snapshotId,
    });
    if (!destination) return { canceled: true };
    await this.data.exportSnapshot(snapshot.root, destination);
    return { canceled: false };
  }

  async importData(
    projectId: string,
    appDirectory: string,
    binding: AppBuilderPreviewBinding,
  ): Promise<{
      canceled: true;
    } | {
      canceled: false;
      rollbackSnapshot: Pick<AppBuilderDataSnapshot, "id" | "manifest">;
    }> {
    const location = await this.location(projectId, appDirectory);
    const packageRoot = await this.selectImportPackage({ appId: location.manifest.app.slug });
    if (!packageRoot) return { canceled: true };
    await this.stopForDataMutation(location, binding);
    const rollback = await this.data.importPackage({
      appKey: binding.localBindingId,
      appId: location.manifest.app.slug,
      packageRoot,
      dataRoot: await this.dataRoot(location),
    });
    return {
      canceled: false,
      rollbackSnapshot: { id: rollback.id, manifest: rollback.manifest },
    };
  }

  async promoteRelease(
    projectId: string,
    appDirectory: string,
    releaseId: string,
    releaseDirectory: string,
    binding: AppBuilderPreviewBinding,
  ) {
    const location = await this.location(projectId, appDirectory);
    await this.stopForDataMutation(location, binding);
    const releaseRoot = await resolveAppBuilderPath(
      location.appRoot,
      normalizeAppBuilderRelativePath(releaseDirectory, "release directory"),
      { mustExist: true },
    );
    const promoted = await this.data.promoteRelease({
      appKey: binding.localBindingId,
      appId: location.manifest.app.slug,
      releaseId,
      releaseSourceRoot: releaseRoot,
      dataRoot: await this.dataRoot(location),
      migrate: this.migrateRelease
        ? (stagedDataRoot, stagedReleaseRoot) => this.migrateRelease!({
            appRoot: location.appRoot,
            releaseRoot: stagedReleaseRoot,
            stagedDataRoot,
            manifest: location.manifest,
          })
        : undefined,
    });
    return {
      releaseId,
      rollbackSnapshot: {
        id: promoted.rollbackSnapshot.id,
        manifest: promoted.rollbackSnapshot.manifest,
      },
    };
  }

  async restoreSnapshot(
    projectId: string,
    appDirectory: string,
    snapshotId: string,
    binding: AppBuilderPreviewBinding,
  ) {
    const location = await this.location(projectId, appDirectory);
    await this.stopForDataMutation(location, binding);
    const restored = await this.data.restoreSnapshot({
      appKey: binding.localBindingId,
      appId: location.manifest.app.slug,
      snapshotId,
      dataRoot: await this.dataRoot(location),
    });
    return {
      restoredSnapshotId: snapshotId,
      safetySnapshot: {
        id: restored.safetySnapshot.id,
        manifest: restored.safetySnapshot.manifest,
      },
    };
  }

  async rollbackRelease(
    projectId: string,
    appDirectory: string,
    snapshotId: string,
    targetReleaseId: string | null,
    binding: AppBuilderPreviewBinding,
  ) {
    const location = await this.location(projectId, appDirectory);
    await this.stopForDataMutation(location, binding);
    const restored = await this.data.rollbackRelease({
      appKey: binding.localBindingId,
      appId: location.manifest.app.slug,
      snapshotId,
      targetReleaseId,
      dataRoot: await this.dataRoot(location),
    });
    return {
      targetReleaseId,
      restoredSnapshotId: snapshotId,
      safetySnapshot: {
        id: restored.safetySnapshot.id,
        manifest: restored.safetySnapshot.manifest,
      },
    };
  }
}

function assertCurrentMainFrame(event: IpcEvent, getMainRenderer: () => Renderer | null): void {
  const renderer = getMainRenderer();
  if (!renderer || event.sender !== renderer || event.senderFrame !== renderer.mainFrame) {
    throw new Error("Desktop App Builder IPC is restricted to the current renderer main frame");
  }
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const object = value as Record<string, unknown>;
  const actualKeys = Object.keys(object).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} contains unsupported or missing fields`);
  }
  return object;
}

function boundedString(value: unknown, label: string, maxLength = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function opaqueId(value: unknown, label: string): string {
  const id = boundedString(value, label, 128);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid ${label}`);
  return id;
}

function bindingPayload(value: unknown): AppBuilderPreviewBinding {
  const object = exactObject(
    value,
    ["desktopInstallationId", "definitionId", "appPublicId", "localBindingId"],
    "App Builder preview binding",
  );
  const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
  for (const key of ["desktopInstallationId", "definitionId", "appPublicId", "localBindingId"] as const) {
    if (typeof object[key] !== "string" || !idPattern.test(object[key])) {
      throw new Error("Invalid App Builder preview binding");
    }
  }
  return object as unknown as AppBuilderPreviewBinding;
}

function optionalBindingPayload(value: unknown): AppBuilderPreviewBinding | null {
  return value === null || value === undefined ? null : bindingPayload(value);
}

function locationPayload(
  value: unknown,
  extraKeys: readonly string[] = [],
): Record<string, unknown> & { projectId: string; appDirectory: string } {
  const object = exactObject(value, ["projectId", "appDirectory", ...extraKeys], "App Builder command");
  return {
    ...object,
    projectId: opaqueId(object.projectId, "project id"),
    appDirectory: boundedString(object.appDirectory, "app directory"),
  };
}

export function registerAppBuilderIpcHandlers(
  ipcMain: IpcMainLike,
  options: {
    getMainRenderer: () => Renderer | null;
    controller: AppBuilderController;
    assertEnabled?: () => Promise<void>;
  },
): void {
  const register = (
    channel: string,
    handler: (event: IpcEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertCurrentMainFrame(event, options.getMainRenderer);
      await options.assertEnabled?.();
      return await handler(event, ...args);
    });
  };

  const onePayload = (args: unknown[], label: string): unknown => {
    if (args.length !== 1) throw new Error(`${label} requires exactly one payload`);
    return args[0];
  };

  register(APP_BUILDER_IPC_CHANNELS.inspect, (_event, ...args) => {
    const payload = onePayload(args, "App Builder inspect");
    const input = locationPayload(payload);
    return options.controller.inspect(input.projectId, input.appDirectory);
  });
  register(APP_BUILDER_IPC_CHANNELS.scaffold, (_event, ...args) => {
    const input = exactObject(
      onePayload(args, "App Builder scaffold"),
      ["projectId", "targetDirectory", "appId", "title"],
      "App Builder scaffold",
    );
    return options.controller.scaffold(
      opaqueId(input.projectId, "project id"),
      boundedString(input.targetDirectory, "target directory"),
      boundedString(input.appId, "app id", 63),
      boundedString(input.title, "app title", 120),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.ensurePreview, (_event, ...args) => {
    const payload = onePayload(args, "App Builder ensure preview");
    const input = locationPayload(payload, ["binding", "authorizeManagedStart"]);
    if (typeof input.authorizeManagedStart !== "boolean") {
      throw new Error("Invalid App Builder managed-start authorization");
    }
    return options.controller.ensurePreview(
      input.projectId,
      input.appDirectory,
      optionalBindingPayload(input.binding),
      input.authorizeManagedStart,
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.startPreview, (_event, ...args) => {
    const payload = onePayload(args, "App Builder start preview");
    const input = locationPayload(payload, ["binding"]);
    return options.controller.startPreview(
      input.projectId,
      input.appDirectory,
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.stopPreview, (_event, ...args) => {
    const payload = onePayload(args, "App Builder stop preview");
    const input = locationPayload(payload, ["binding"]);
    return options.controller.stopPreview(
      input.projectId,
      input.appDirectory,
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.previewStatus, (_event, ...args) => {
    const payload = onePayload(args, "App Builder preview status");
    const input = locationPayload(payload, ["binding"]);
    return options.controller.previewStatus(
      input.projectId,
      input.appDirectory,
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.snapshot, (_event, ...args) => {
    const payload = onePayload(args, "App Builder snapshot");
    const input = locationPayload(payload, ["binding"]);
    return options.controller.snapshot(
      input.projectId,
      input.appDirectory,
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.exportSnapshot, (_event, ...args) => {
    const payload = onePayload(args, "App Builder export snapshot");
    const input = locationPayload(payload, ["snapshotId", "binding"]);
    return options.controller.exportSnapshot(
      input.projectId,
      input.appDirectory,
      boundedString(input.snapshotId, "snapshot id", 160),
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.importData, (_event, ...args) => {
    const payload = onePayload(args, "App Builder import data");
    const input = locationPayload(payload, ["binding"]);
    return options.controller.importData(
      input.projectId,
      input.appDirectory,
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.promoteRelease, (_event, ...args) => {
    const payload = onePayload(args, "App Builder promote release");
    const input = locationPayload(payload, ["releaseId", "releaseDirectory", "binding"]);
    return options.controller.promoteRelease(
      input.projectId,
      input.appDirectory,
      boundedString(input.releaseId, "release id", 128),
      boundedString(input.releaseDirectory, "release directory"),
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.restoreSnapshot, (_event, ...args) => {
    const payload = onePayload(args, "App Builder restore snapshot");
    const input = locationPayload(payload, ["snapshotId", "binding"]);
    return options.controller.restoreSnapshot(
      input.projectId,
      input.appDirectory,
      boundedString(input.snapshotId, "snapshot id", 160),
      bindingPayload(input.binding),
    );
  });
  register(APP_BUILDER_IPC_CHANNELS.rollbackRelease, (_event, ...args) => {
    const payload = onePayload(args, "App Builder rollback release");
    const input = locationPayload(payload, ["snapshotId", "targetReleaseId", "binding"]);
    return options.controller.rollbackRelease(
      input.projectId,
      input.appDirectory,
      boundedString(input.snapshotId, "snapshot id", 160),
      input.targetReleaseId === null
        ? null
        : boundedString(input.targetReleaseId, "target release id", 128),
      bindingPayload(input.binding),
    );
  });
}

export type AppBuilderScaffoldLimits = CopyOfficialAppBuilderScaffoldOptions["limits"];
