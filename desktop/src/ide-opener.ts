import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

export type DesktopIdeId = "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";

export type DesktopIdeTarget = {
  id: DesktopIdeId;
  label: string;
};

type DesktopIdeDetection = DesktopIdeTarget & {
  strategy:
    | {
      kind: "darwin-app";
      appPath: string;
    }
    | {
      kind: "command";
      command: string;
    };
};

type DetectAvailableIdesOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  pathExists?: (targetPath: string) => Promise<boolean>;
  commandExists?: (command: string, platform: NodeJS.Platform) => Promise<boolean>;
};

type OpenWorkspaceFileInIdeOptions = DetectAvailableIdesOptions & {
  openDarwinApp?: (appPath: string, absolutePath: string) => Promise<void>;
  runCommand?: (command: string, absolutePath: string, platform: NodeJS.Platform) => Promise<void>;
};

type DesktopIdeSpec = {
  id: DesktopIdeId;
  label: string;
  macAppNames: string[];
  commands: string[];
};

const IDE_SPECS: DesktopIdeSpec[] = [
  { id: "cursor", label: "Cursor", macAppNames: ["Cursor"], commands: ["cursor"] },
  { id: "vscode", label: "VS Code", macAppNames: ["Visual Studio Code"], commands: ["code"] },
  { id: "windsurf", label: "Windsurf", macAppNames: ["Windsurf"], commands: ["windsurf"] },
  { id: "zed", label: "Zed", macAppNames: ["Zed"], commands: ["zed"] },
  { id: "webstorm", label: "WebStorm", macAppNames: ["WebStorm"], commands: ["webstorm"] },
  { id: "intellij", label: "IntelliJ IDEA", macAppNames: ["IntelliJ IDEA"], commands: ["idea"] },
];

function execFilePromise(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function defaultPathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function defaultCommandExists(command: string, platform: NodeJS.Platform) {
  try {
    await execFilePromise(platform === "win32" ? "where" : "which", [command]);
    return true;
  } catch {
    return false;
  }
}

function macAppCandidates(appName: string, homeDir: string) {
  return [
    path.join("/Applications", `${appName}.app`),
    path.join(homeDir, "Applications", `${appName}.app`),
  ];
}

async function detectAvailableIdeTargetsInternal(options: DetectAvailableIdesOptions = {}): Promise<DesktopIdeDetection[]> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const pathExists = options.pathExists ?? defaultPathExists;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const available: DesktopIdeDetection[] = [];

  for (const spec of IDE_SPECS) {
    if (platform === "darwin") {
      let matchedAppPath: string | null = null;
      for (const appName of spec.macAppNames) {
        for (const candidate of macAppCandidates(appName, homeDir)) {
          if (await pathExists(candidate)) {
            matchedAppPath = candidate;
            break;
          }
        }
        if (matchedAppPath) break;
      }
      if (matchedAppPath) {
        available.push({
          id: spec.id,
          label: spec.label,
          strategy: {
            kind: "darwin-app",
            appPath: matchedAppPath,
          },
        });
        continue;
      }
    }

    for (const command of spec.commands) {
      if (await commandExists(command, platform)) {
        available.push({
          id: spec.id,
          label: spec.label,
          strategy: {
            kind: "command",
            command,
          },
        });
        break;
      }
    }
  }

  return available;
}

export async function listAvailableIdeTargets(options: DetectAvailableIdesOptions = {}): Promise<DesktopIdeTarget[]> {
  const detections = await detectAvailableIdeTargetsInternal(options);
  return detections.map(({ id, label }) => ({ id, label }));
}

function defaultOpenDarwinApp(appPath: string, absolutePath: string) {
  return execFilePromise("open", ["-a", appPath, absolutePath]);
}

function defaultRunCommand(command: string, absolutePath: string, platform: NodeJS.Platform) {
  if (platform === "win32") {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, [absolutePath], {
        shell: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => resolve());
      child.unref();
    });
  }
  return execFilePromise(command, [absolutePath]);
}

export function resolveWorkspaceFileAbsolutePath(rootPath: string, filePath: string) {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedTarget = path.resolve(resolvedRoot, filePath);
  const relativePath = path.relative(resolvedRoot, resolvedTarget);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Workspace file path must stay inside the workspace root.");
  }

  return resolvedTarget;
}

export async function openWorkspaceFileInIde(
  rootPath: string,
  filePath: string,
  ideId?: DesktopIdeId,
  options: OpenWorkspaceFileInIdeOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const openDarwinApp = options.openDarwinApp ?? defaultOpenDarwinApp;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const absolutePath = resolveWorkspaceFileAbsolutePath(rootPath, filePath);
  const detections = await detectAvailableIdeTargetsInternal(options);
  if (detections.length === 0) {
    throw new Error("No supported local IDE was detected.");
  }

  const target = ideId
    ? detections.find((entry) => entry.id === ideId)
    : detections[0];
  if (!target) {
    throw new Error(`The requested IDE is not available: ${ideId}`);
  }

  if (target.strategy.kind === "darwin-app") {
    await openDarwinApp(target.strategy.appPath, absolutePath);
  } else {
    await runCommand(target.strategy.command, absolutePath, platform);
  }

  return {
    id: target.id,
    label: target.label,
    absolutePath,
  };
}
