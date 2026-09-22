import { describe, expect, it, vi } from "vitest";
import { createDesktopServerRuntimeOptions } from "./runtime-options.js";

describe("Desktop server runtime options", () => {
  it("builds the packaged Rust foundation defaults without probing the asset", () => {
    const onEvent = vi.fn();

    const options = createDesktopServerRuntimeOptions({
      isPackaged: true,
      resourcesPath: "/tmp/codex-missing-resources",
      env: {},
      onEvent,
    });

    expect(options).toMatchObject({
      printBanner: false,
      openOnListen: false,
      runtimeOverrides: {
        host: "127.0.0.1",
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        rustFoundationMode: "required",
        rustFoundationBinaryPath:
          "/tmp/codex-missing-resources/native/aarch64-apple-darwin/rudder-server-foundation",
        serveUi: true,
        uiDevMiddleware: false,
      },
    });
  });

  it("keeps explicit member-directory compatibility settings and configured paths", () => {
    const options = createDesktopServerRuntimeOptions({
      isPackaged: true,
      resourcesPath: "/tmp/codex-missing-resources",
      env: {
        RUDDER_RUST_MEMBER_DIRECTORY_MODE: "off",
        RUDDER_SERVER_FOUNDATION_PATH: " /custom/rudder-server-foundation ",
      },
      onEvent: vi.fn(),
    });

    expect(options.runtimeOverrides).toMatchObject({
      host: "127.0.0.1",
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      serveUi: true,
      uiDevMiddleware: false,
    });
    expect(options.runtimeOverrides).not.toHaveProperty("rustFoundationMode");
    expect(options.runtimeOverrides).not.toHaveProperty("rustFoundationBinaryPath");
  });

  it.each([
    ["database", "Preparing the embedded database."],
    ["app", "Booting the shared board UI and API."],
    ["listening", "Opening the shared local board."],
    ["shutdown", "Stopping the owned local runtime."],
    ["other", "Preparing the embedded database and board UI."],
  ])("maps the %s bootstrap stage to the existing boot detail", (stage, detail) => {
    const onEvent = vi.fn();
    const options = createDesktopServerRuntimeOptions({
      isPackaged: false,
      env: {},
      onEvent,
    });

    options.onEvent({ stage, message: "server message" });

    expect(onEvent).toHaveBeenCalledWith({
      stage,
      message: "server message",
      detail,
    });
  });
});
