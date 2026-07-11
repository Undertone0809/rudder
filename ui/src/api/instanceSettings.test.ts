import { beforeEach, describe, expect, it, vi } from "vitest";
import { instanceSettingsApi } from "./instanceSettings";

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("./client", () => ({
  api: {
    get: clientMocks.get,
    patch: clientMocks.patch,
  },
}));

describe("instanceSettingsApi browser settings", () => {
  beforeEach(() => {
    clientMocks.get.mockReset();
    clientMocks.patch.mockReset();
  });

  it("gets and patches the instance Browser settings resource", async () => {
    await instanceSettingsApi.getBrowser();
    await instanceSettingsApi.updateBrowser({
      enabled: false,
      openLinksIn: "default_browser",
    });

    expect(clientMocks.get).toHaveBeenCalledWith("/instance/settings/browser");
    expect(clientMocks.patch).toHaveBeenCalledWith("/instance/settings/browser", {
      enabled: false,
      openLinksIn: "default_browser",
    });
  });
});
