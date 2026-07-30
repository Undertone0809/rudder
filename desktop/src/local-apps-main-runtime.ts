import { dialog, type BrowserWindow, type OpenDialogOptions } from "electron";
import path from "node:path";
import { LocalAppsController } from "./local-apps-controller.js";
import {
  LocalAppRegistry,
  type PreparedLocalAppDefinition,
} from "./local-apps-registry.js";
import { LocalAppRuntimeManager } from "./local-apps-runtime.js";

function confirmationDetail(definition: PreparedLocalAppDefinition): string {
  const argumentsDetail = definition.argv.length > 0
    ? definition.argv.map((argument) => JSON.stringify(argument)).join(" ")
    : "(none)";
  const environmentDetail = definition.inheritedEnvNames.length > 0
    ? definition.inheritedEnvNames.join(", ")
    : "(none)";
  return [
    `Working directory: ${definition.cwd}`,
    `Executable: ${definition.executable}`,
    `Arguments: ${argumentsDetail}`,
    `Inherited environment variable names: ${environmentDetail}`,
    `Readiness: ${definition.readiness.path} (${definition.readiness.timeoutMs} ms)`,
    `Open path: ${definition.openPath}`,
    "",
    "Selected project code and commands may modify local files or data.",
    "Rudder itself will not install dependencies, build assets, or run migrations.",
  ].join("\n");
}

export function createDesktopLocalAppsRuntime(options: {
  installationId: string;
  appName: string;
  userDataPath: string;
  getOwner(): BrowserWindow | null;
}) {
  const registry = new LocalAppRegistry({
    registryPath: path.join(options.userDataPath, "local-apps", "registry.json"),
    installationId: options.installationId,
  });
  const runtime = new LocalAppRuntimeManager({ registry });
  const controller = new LocalAppsController({
    registry,
    runtime,
    featureEnabled: false,
    selectFolder: async () => {
      const dialogOptions: OpenDialogOptions = {
        title: "Choose a local app folder",
        buttonLabel: "Review App",
        properties: ["openDirectory"],
      };
      const owner = options.getOwner();
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    confirmDefinition: async (definition, action) => {
      const owner = options.getOwner();
      const confirmLabel = action === "start" ? "Start App" : "Approve App";
      const dialogOptions = {
        type: "warning" as const,
        title: `${options.appName} Local App`,
        buttons: [confirmLabel, "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        message: action === "start"
          ? `Start “${definition.title}”?`
          : `${action === "create" ? "Add" : "Update"} “${definition.title}”?`,
        detail: confirmationDetail(definition),
      };
      const result = owner
        ? await dialog.showMessageBox(owner, dialogOptions)
        : await dialog.showMessageBox(dialogOptions);
      return result.response === 0;
    },
  });
  return { controller, registry, runtime };
}
