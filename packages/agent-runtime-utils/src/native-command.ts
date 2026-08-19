export type NativeCommand = {
  command: string;
  args: string[];
};

/**
 * Keep test and development script fixtures shell-free on Windows. Native
 * production binaries continue to execute directly, while Node scripts are
 * launched through the current Node runtime instead of relying on a POSIX
 * shebang that Windows cannot execute.
 */
export function resolveNativeCommand(
  executable: string,
  args: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): NativeCommand {
  if (platform === "win32" && /\.(?:cjs|js|mjs)$/iu.test(executable)) {
    return { command: process.execPath, args: [executable, ...args] };
  }
  return { command: executable, args: [...args] };
}
