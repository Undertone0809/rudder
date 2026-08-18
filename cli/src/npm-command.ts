export interface NpmCommandInvocation {
  command: string;
  args: string[];
}

export function resolveNpmCommandInvocation(): NpmCommandInvocation {
  if (process.platform !== "win32") {
    return { command: "npm", args: [] };
  }

  return {
    command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", "npm.cmd"],
  };
}
