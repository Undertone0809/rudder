import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

export type DesktopIdeId = "cursor" | "vscode" | "windsurf" | "zed" | "webstorm" | "intellij";
export type DesktopWorkspaceLaunchTargetId =
  | "vscode"
  | "cursor"
  | "xcode"
  | "windsurf"
  | "zed"
  | "webstorm"
  | "intellij"
  | "terminal"
  | "warp"
  | "finder";

export type DesktopIdeTarget = {
  id: DesktopIdeId;
  label: string;
};

export type DesktopWorkspaceLaunchTarget = {
  id: DesktopWorkspaceLaunchTargetId;
  label: string;
  kind: "ide" | "terminal" | "folder";
  iconPath?: string;
  iconDataUrl?: string;
};

type DesktopWorkspaceLaunchDetection = DesktopWorkspaceLaunchTarget & {
  strategy:
    | {
      kind: "darwin-app";
      appPath: string;
    }
    | {
      kind: "command";
      command: string;
    }
    | {
      kind: "folder";
    };
};

type DetectAvailableWorkspaceLaunchTargetsOptions = {
  platform?: NodeJS.Platform;
  homeDir?: string;
  pathExists?: (targetPath: string) => Promise<boolean>;
  commandExists?: (command: string, platform: NodeJS.Platform) => Promise<boolean>;
};

type OpenWorkspaceOptions = DetectAvailableWorkspaceLaunchTargetsOptions & {
  openDarwinApp?: (appPath: string, absolutePath: string) => Promise<void>;
  openFolder?: (absolutePath: string, platform: NodeJS.Platform) => Promise<void>;
  runCommand?: (command: string, absolutePath: string, platform: NodeJS.Platform) => Promise<void>;
  runTerminalCommand?: (command: string, cwd: string, platform: NodeJS.Platform) => Promise<void>;
};

type OpenWorkspaceFileInIdeOptions = DetectAvailableWorkspaceLaunchTargetsOptions & {
  openDarwinApp?: (appPath: string, absolutePath: string) => Promise<void>;
  runCommand?: (command: string, absolutePath: string, platform: NodeJS.Platform) => Promise<void>;
};

type DesktopWorkspaceLaunchSpec = {
  id: DesktopWorkspaceLaunchTargetId;
  label: string;
  kind: "ide" | "terminal";
  macAppNames: string[];
  commands: string[];
};

const WORKSPACE_LAUNCH_SPECS: DesktopWorkspaceLaunchSpec[] = [
  { id: "vscode", label: "VS Code", kind: "ide", macAppNames: ["Visual Studio Code"], commands: ["code"] },
  { id: "cursor", label: "Cursor", kind: "ide", macAppNames: ["Cursor"], commands: ["cursor"] },
  { id: "xcode", label: "Xcode", kind: "ide", macAppNames: ["Xcode"], commands: ["xed"] },
  { id: "terminal", label: "Terminal", kind: "terminal", macAppNames: ["Terminal"], commands: [] },
  { id: "warp", label: "Warp", kind: "terminal", macAppNames: ["Warp"], commands: ["warp"] },
  { id: "windsurf", label: "Windsurf", kind: "ide", macAppNames: ["Windsurf"], commands: ["windsurf"] },
  { id: "zed", label: "Zed", kind: "ide", macAppNames: ["Zed"], commands: ["zed"] },
  { id: "webstorm", label: "WebStorm", kind: "ide", macAppNames: ["WebStorm"], commands: ["webstorm"] },
  { id: "intellij", label: "IntelliJ IDEA", kind: "ide", macAppNames: ["IntelliJ IDEA"], commands: ["idea"] },
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
    path.join("/System/Applications", `${appName}.app`),
    path.join("/System/Applications/Utilities", `${appName}.app`),
  ];
}

function folderLaunchDetection(platform: NodeJS.Platform): DesktopWorkspaceLaunchDetection {
  const finderPath = "/System/Library/CoreServices/Finder.app";
  return {
    id: "finder",
    label: platform === "darwin" ? "Finder" : "Folder",
    kind: "folder",
    iconPath: platform === "darwin" ? finderPath : undefined,
    strategy: {
      kind: "folder",
    },
  };
}

async function detectAvailableWorkspaceLaunchTargetsInternal(
  options: DetectAvailableWorkspaceLaunchTargetsOptions = {},
): Promise<DesktopWorkspaceLaunchDetection[]> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const pathExists = options.pathExists ?? defaultPathExists;
  const commandExists = options.commandExists ?? defaultCommandExists;
  const available: DesktopWorkspaceLaunchDetection[] = [];

  for (const spec of WORKSPACE_LAUNCH_SPECS) {
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
          kind: spec.kind,
          iconPath: matchedAppPath,
          strategy: {
            kind: "darwin-app",
            appPath: matchedAppPath,
          },
        });
        if (spec.id === "warp") {
          available.push(folderLaunchDetection(platform));
        }
        continue;
      }
    }

    for (const command of spec.commands) {
      if (await commandExists(command, platform)) {
        available.push({
          id: spec.id,
          label: spec.label,
          kind: spec.kind,
          strategy: {
            kind: "command",
            command,
          },
        });
        break;
      }
    }

    if (spec.id === "warp") {
      available.push(folderLaunchDetection(platform));
    }
  }

  return available;
}

export async function listWorkspaceLaunchTargets(
  options: DetectAvailableWorkspaceLaunchTargetsOptions = {},
): Promise<DesktopWorkspaceLaunchTarget[]> {
  const detections = await detectAvailableWorkspaceLaunchTargetsInternal(options);
  return detections.map(({ id, label, kind, iconPath }) => ({ id, label, kind, iconPath }));
}

export async function listAvailableIdeTargets(
  options: DetectAvailableWorkspaceLaunchTargetsOptions = {},
): Promise<DesktopIdeTarget[]> {
  const detections = await detectAvailableWorkspaceLaunchTargetsInternal(options);
  return detections
    .filter((entry): entry is DesktopWorkspaceLaunchDetection & { id: DesktopIdeId; kind: "ide" } =>
      entry.kind === "ide" && entry.id !== "xcode"
    )
    .map(({ id, label }) => ({ id, label }));
}

function defaultOpenDarwinApp(appPath: string, absolutePath: string) {
  return execFilePromise("open", ["-a", appPath, absolutePath]);
}

function defaultOpenFolder(absolutePath: string, platform: NodeJS.Platform) {
  if (platform === "win32") return execFilePromise("explorer", [absolutePath]);
  if (platform === "darwin") return execFilePromise("open", [absolutePath]);
  return execFilePromise("xdg-open", [absolutePath]);
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

function defaultRunTerminalCommand(command: string, cwd: string, platform: NodeJS.Platform) {
  if (platform === "darwin") {
    return execFilePromise("open", ["-a", command, cwd]);
  }
  if (platform === "win32") {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, [], {
        cwd,
        shell: true,
        stdio: "ignore",
        windowsHide: false,
        detached: true,
      });
      child.once("error", reject);
      child.once("spawn", () => resolve());
      child.unref();
    });
  }
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, [], {
      cwd,
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => resolve());
    child.unref();
  });
}

export async function resolveWorkspaceRootDirectory(rootPath: string) {
  const resolvedRoot = path.resolve(rootPath);
  let stat;
  try {
    stat = await fs.stat(resolvedRoot);
  } catch {
    throw new Error("Workspace root does not exist.");
  }
  if (!stat.isDirectory()) {
    throw new Error("Workspace root must be a directory.");
  }
  return resolvedRoot;
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

export async function openWorkspace(
  rootPath: string,
  targetId?: DesktopWorkspaceLaunchTargetId,
  options: OpenWorkspaceOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const openDarwinApp = options.openDarwinApp ?? defaultOpenDarwinApp;
  const openFolder = options.openFolder ?? defaultOpenFolder;
  const runCommand = options.runCommand ?? defaultRunCommand;
  const runTerminalCommand = options.runTerminalCommand ?? defaultRunTerminalCommand;
  const absolutePath = await resolveWorkspaceRootDirectory(rootPath);
  const detections = await detectAvailableWorkspaceLaunchTargetsInternal(options);
  const target = targetId
    ? detections.find((entry) => entry.id === targetId)
    : detections[0];

  if (!target) {
    throw new Error(`The requested workspace launcher is not available: ${targetId}`);
  }

  if (target.strategy.kind === "folder") {
    await openFolder(absolutePath, platform);
  } else if (target.kind === "terminal") {
    if (target.strategy.kind === "darwin-app") {
      await runTerminalCommand(target.strategy.appPath, absolutePath, platform);
    } else {
      await runTerminalCommand(target.strategy.command, absolutePath, platform);
    }
  } else if (target.strategy.kind === "darwin-app") {
    await openDarwinApp(target.strategy.appPath, absolutePath);
  } else {
    await runCommand(target.strategy.command, absolutePath, platform);
  }

  return {
    id: target.id,
    label: target.label,
    kind: target.kind,
    absolutePath,
  };
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
  const detections = (await detectAvailableWorkspaceLaunchTargetsInternal(options)).filter(
    (entry): entry is DesktopWorkspaceLaunchDetection & { id: DesktopIdeId; kind: "ide" } =>
      entry.kind === "ide" && entry.id !== "xcode",
  );
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
  } else if (target.strategy.kind === "command") {
    await runCommand(target.strategy.command, absolutePath, platform);
  } else {
    throw new Error(`The requested IDE is not available: ${ideId}`);
  }

  return {
    id: target.id,
    label: target.label,
    absolutePath,
  };
}
