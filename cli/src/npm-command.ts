export interface NpmCommandInvocation {
  command: string;
  args: string[];
}

export function resolveNpmCommandInvocation(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NpmCommandInvocation {
  if (platform !== "win32") {
    return { command: "npm", args: [] };
  }

  return {
    command: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd"],
  };
}
