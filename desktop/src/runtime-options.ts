import { resolveDesktopRustFoundationRuntimeOverrides } from "./rust-foundation-runtime.js";

export type DesktopServerBootstrapEvent = {
  stage: string;
  message: string;
};

export type DesktopBootStateUpdate = DesktopServerBootstrapEvent & {
  detail: string;
};

export type DesktopServerRuntimeOptions = {
  printBanner: false;
  openOnListen: false;
  runtimeOverrides: Record<string, unknown>;
  onEvent: (event: DesktopServerBootstrapEvent) => void;
};

function resolveBootstrapDetail(stage: string): string {
  switch (stage) {
    case "database":
      return "Preparing the embedded database.";
    case "app":
      return "Booting the shared board UI and API.";
    case "listening":
      return "Opening the shared local board.";
    case "shutdown":
      return "Stopping the owned local runtime.";
    default:
      return "Preparing the embedded database and board UI.";
  }
}

export function createDesktopServerRuntimeOptions(options: {
  isPackaged: boolean;
  resourcesPath?: string;
  env: NodeJS.ProcessEnv;
  onEvent: (event: DesktopBootStateUpdate) => void;
}): DesktopServerRuntimeOptions {
  return {
    printBanner: false,
    openOnListen: false,
    runtimeOverrides: {
      host: "127.0.0.1",
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      ...resolveDesktopRustFoundationRuntimeOverrides({
        isPackaged: options.isPackaged,
        memberDirectoryMode: options.env.RUDDER_RUST_MEMBER_DIRECTORY_MODE,
        configuredBinaryPath: options.env.RUDDER_SERVER_FOUNDATION_PATH,
        resourcesPath: options.resourcesPath,
      }),
      serveUi: true,
      uiDevMiddleware: false,
    },
    onEvent: (event) => {
      options.onEvent({
        stage: event.stage,
        message: event.message,
        detail: resolveBootstrapDetail(event.stage),
      });
    },
  };
}
