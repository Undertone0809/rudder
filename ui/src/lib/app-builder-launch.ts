import { appBuilderApi } from "@/api/app-builder";
import { ApiError } from "@/api/client";
import type {
  DesktopAppBuilderBinding,
  DesktopLocalAppDefinition,
  DesktopShellApi,
} from "@/lib/desktop-shell";
import type { AppBuilderApp } from "@rudderhq/shared";

function bindingForApp(
  app: AppBuilderApp,
  definitions: DesktopLocalAppDefinition[],
): DesktopAppBuilderBinding | null {
  if (!app.desktopInstallationId || !app.appPublicId || !app.localBindingId) return null;
  const definition = definitions.find((candidate) => (
    candidate.desktopInstallationId === app.desktopInstallationId
    && candidate.appPublicId === app.appPublicId
    && candidate.localBindingId === app.localBindingId
  ));
  if (!definition) return null;
  return {
    desktopInstallationId: app.desktopInstallationId,
    definitionId: definition.id,
    appPublicId: app.appPublicId,
    localBindingId: app.localBindingId,
  };
}

async function beforeDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  message: string,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(message);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), remainingMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function startPreviewWithRuntimeRecovery(input: {
  desktopAppBuilder: NonNullable<DesktopShellApi["appBuilder"]>;
  localApps: NonNullable<DesktopShellApi["localApps"]>;
  projectId: string;
  appDirectory: string;
  binding: DesktopAppBuilderBinding;
  readinessTimeoutMs: number;
}): Promise<void> {
  const {
    desktopAppBuilder,
    localApps,
    projectId,
    appDirectory,
    binding,
    readinessTimeoutMs,
  } = input;
  let settled = false;
  const preview = desktopAppBuilder.startPreview({
    projectId,
    appDirectory,
    binding,
  });
  const recoverFromRuntime = (async () => {
    const deadline = Date.now() + Math.max(1, readinessTimeoutMs);
    const timeoutMessage = "The App runtime did not finish starting before its readiness deadline.";
    while (!settled && Date.now() < deadline) {
      const runtime = await beforeDeadline(
        localApps.status(binding.definitionId),
        deadline,
        timeoutMessage,
      );
      if (runtime.status === "running") {
        const target = await beforeDeadline(
          localApps.attestedTarget(binding.definitionId),
          deadline,
          timeoutMessage,
        );
        if (target) return;
      }
      if (runtime.status === "failed") {
        throw new Error(runtime.error ?? "The App runtime failed before it was ready.");
      }
      await beforeDeadline(
        new Promise((resolve) => setTimeout(resolve, 150)),
        deadline,
        timeoutMessage,
      );
    }
    if (!settled) {
      throw new Error(timeoutMessage);
    }
  })();

  try {
    await Promise.race([preview.then(() => undefined), recoverFromRuntime]);
  } finally {
    settled = true;
  }
}

export async function launchManagedApp(input: {
  app: AppBuilderApp;
  desktopShell: DesktopShellApi;
  expectedStatus: "verified_source_ready" | "launch_failed";
}): Promise<DesktopAppBuilderBinding | null> {
  const { app, desktopShell, expectedStatus } = input;
  const desktopAppBuilder = desktopShell.appBuilder;
  const localApps = desktopShell.localApps;
  if (!desktopAppBuilder?.supported || !localApps?.supported) {
    throw new Error("This App can open automatically in Rudder Desktop.");
  }

  const definitions = await localApps.list();
  const existingDefinitionIds = new Set(definitions.map((definition) => definition.id));
  const existingBinding = bindingForApp(app, definitions);
  let binding: DesktopAppBuilderBinding | null = null;
  let ownsLaunch = false;
  let serverBound = false;

  try {
    await appBuilderApi.updateBuild(app.orgId, app.id, {
      status: "verifying",
      expectedStatus,
      runKind: "verification",
    });
    ownsLaunch = true;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return null;
    throw error;
  }

  try {
    const inspection = await desktopAppBuilder.inspect({
      projectId: app.orgId,
      appDirectory: app.sourceRoot,
    });
    binding = await desktopAppBuilder.ensurePreview({
      projectId: app.orgId,
      appDirectory: app.sourceRoot,
      binding: existingBinding,
      authorizeManagedStart: existingBinding === null,
    });
    await startPreviewWithRuntimeRecovery({
      desktopAppBuilder,
      localApps,
      projectId: app.orgId,
      appDirectory: app.sourceRoot,
      binding,
      readinessTimeoutMs: inspection.manifest.runtime.readinessTimeoutMs,
    });
    await appBuilderApi.bindLocalRuntime(app.orgId, app.id, {
      desktopInstallationId: binding.desktopInstallationId,
      appPublicId: binding.appPublicId,
      localBindingId: binding.localBindingId,
    });
    serverBound = true;
    await appBuilderApi.updateBuild(app.orgId, app.id, {
      status: "ready",
      expectedStatus: "verifying",
      runKind: "verification",
    });
    ownsLaunch = false;
    return binding;
  } catch (error) {
    if (binding) {
      await desktopAppBuilder.stopPreview({
        projectId: app.orgId,
        appDirectory: app.sourceRoot,
        binding,
      }).catch(() => undefined);
      if (!existingDefinitionIds.has(binding.definitionId)) {
        await localApps.delete(binding.definitionId).catch(() => undefined);
      }
    }
    if (serverBound && existingBinding === null) {
      await appBuilderApi.clearLocalRuntime(app.orgId, app.id).catch(() => undefined);
    }
    if (ownsLaunch) {
      await appBuilderApi.updateBuild(app.orgId, app.id, {
        status: "launch_failed",
        expectedStatus: "verifying",
        runKind: "verification",
      }).catch(() => undefined);
    }
    throw error;
  }
}
