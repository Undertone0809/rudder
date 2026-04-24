import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import { promisify } from "node:util";
import type { InstancePathPickerSelectionType } from "@rudderhq/shared";

const execFileAsync = promisify(execFile);

type ExecFileAsync = (
  file: string,
  args: string[],
  options?: ExecFileOptionsWithStringEncoding,
) => Promise<{ stdout: string; stderr: string }>;

export class NativePathPickerUnsupportedError extends Error {
  constructor(message = "Native path picker is unavailable in this environment.") {
    super(message);
    this.name = "NativePathPickerUnsupportedError";
  }
}

function isCancellationError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("user canceled")
    || message.includes("user cancelled")
    || message.includes("cancelled");
}

function isHeadlessLinuxError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("cannot open display")
    || message.includes("no display")
    || message.includes("display")
    || message.includes("wayland");
}

function normalizeSelectedPath(stdout: string) {
  const next = stdout.trim();
  return next.length > 0 ? next : null;
}

async function pickMacPath(
  selectionType: InstancePathPickerSelectionType,
  exec: ExecFileAsync,
) {
  const chooser = selectionType === "directory" ? "choose folder" : "choose file";
  const script = `POSIX path of (${chooser} with prompt "Select ${selectionType}")`;
  try {
    const { stdout } = await exec("osascript", ["-e", script], { encoding: "utf8" });
    return normalizeSelectedPath(stdout);
  } catch (error) {
    if (isCancellationError(error)) return null;
    throw new NativePathPickerUnsupportedError("macOS path picker is unavailable.");
  }
}

async function pickWindowsPath(
  selectionType: InstancePathPickerSelectionType,
  exec: ExecFileAsync,
) {
  const script =
    selectionType === "directory"
      ? [
          "Add-Type -AssemblyName System.Windows.Forms",
          "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
          '$dialog.Description = "Select folder"',
          "$result = $dialog.ShowDialog()",
          'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath; exit 0 }',
          "exit 2",
        ].join("; ")
      : [
          "Add-Type -AssemblyName System.Windows.Forms",
          "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
          '$dialog.Title = "Select file"',
          "$dialog.CheckFileExists = $true",
          "$result = $dialog.ShowDialog()",
          'if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName; exit 0 }',
          "exit 2",
        ].join("; ");

  try {
    const { stdout } = await exec(
      "powershell.exe",
      ["-NoProfile", "-STA", "-Command", script],
      { encoding: "utf8" },
    );
    return normalizeSelectedPath(stdout);
  } catch (error: unknown) {
    const maybeCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
    if (maybeCode === 2 || isCancellationError(error)) return null;
    throw new NativePathPickerUnsupportedError("Windows path picker is unavailable.");
  }
}

async function runLinuxPicker(
  file: string,
  args: string[],
  exec: ExecFileAsync,
) {
  try {
    return await exec(file, args, { encoding: "utf8" });
  } catch (error: unknown) {
    const maybeCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : null;
    if (maybeCode === "ENOENT") return null;
    if (maybeCode === 1 || maybeCode === 255 || isCancellationError(error)) {
      return { stdout: "", stderr: "" };
    }
    if (isHeadlessLinuxError(error)) {
      throw new NativePathPickerUnsupportedError("Linux path picker needs a desktop session.");
    }
    throw error;
  }
}

async function pickLinuxPath(
  selectionType: InstancePathPickerSelectionType,
  exec: ExecFileAsync,
  env: NodeJS.ProcessEnv,
) {
  const zenityArgs = selectionType === "directory"
    ? ["--file-selection", "--directory", "--title=Select folder"]
    : ["--file-selection", "--title=Select file"];
  const zenityResult = await runLinuxPicker("zenity", zenityArgs, exec);
  if (zenityResult) return normalizeSelectedPath(zenityResult.stdout);

  const home = env.HOME ?? "";
  const kdialogArgs = selectionType === "directory"
    ? ["--getexistingdirectory", home, "--title", "Select folder"]
    : ["--getopenfilename", home, "--title", "Select file"];
  const kdialogResult = await runLinuxPicker("kdialog", kdialogArgs, exec);
  if (kdialogResult) return normalizeSelectedPath(kdialogResult.stdout);

  throw new NativePathPickerUnsupportedError("Linux path picker requires zenity or kdialog.");
}

export function createNativePathPicker(options?: {
  platform?: NodeJS.Platform;
  execFileAsync?: ExecFileAsync;
  env?: NodeJS.ProcessEnv;
}) {
  const platform = options?.platform ?? process.platform;
  const exec = options?.execFileAsync ?? execFileAsync;
  const env = options?.env ?? process.env;

  return {
    async pick(selectionType: InstancePathPickerSelectionType) {
      if (platform === "darwin") return pickMacPath(selectionType, exec);
      if (platform === "win32") return pickWindowsPath(selectionType, exec);
      if (platform === "linux") return pickLinuxPath(selectionType, exec, env);
      throw new NativePathPickerUnsupportedError(`Native path picker is unsupported on platform "${platform}".`);
    },
  };
}
