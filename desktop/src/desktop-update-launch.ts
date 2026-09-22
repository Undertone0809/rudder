import path from "node:path";
import { DESKTOP_CLI_FLAG } from "./cli-link.js";

export const DESKTOP_UPDATE_QUIT_ARG = "--rudder-update-quit";
export const DESKTOP_UPDATE_FORCE_ARG = "--rudder-update-force";

export function resolveDesktopUpdateChildLaunch(options: {
  cliArgs: string[];
  childEnv: NodeJS.ProcessEnv;
  execPath?: string;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
}): {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const command = options.execPath ?? process.execPath;
  if ((options.platform ?? process.platform) !== "darwin") {
    return {
      command,
      args: [DESKTOP_CLI_FLAG, ...options.cliArgs],
      env: options.childEnv,
    };
  }
  const resourcesPathModule = path.posix;
  const resourcesPath = options.resourcesPath
    ?? resourcesPathModule.resolve(resourcesPathModule.dirname(command), "..", "Resources");
  return {
    command,
    args: [
      resourcesPathModule.join(resourcesPath, "server-package", "desktop-cli-runner.js"),
      ...options.cliArgs,
    ],
    env: {
      ...options.childEnv,
      ELECTRON_RUN_AS_NODE: "1",
    },
  };
}
