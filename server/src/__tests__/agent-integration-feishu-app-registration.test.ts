import { describe, expect, it, vi } from "vitest";

const mockRegisterApp = vi.hoisted(() => vi.fn());

vi.mock("@larksuiteoapi/node-sdk", () => ({
  registerApp: mockRegisterApp,
}));

describe("Feishu app registration", () => {
  it("requests message receive/send and reaction permissions for newly registered apps", async () => {
    const { createFeishuNodeSdkAppRegistrar } = await import("../services/integrations/feishu/app-registration.js");
    mockRegisterApp.mockImplementationOnce(async (input: {
      onQRCodeReady: (info: { url: string; expireIn: number }) => void;
      onStatusChange: (info: { status: string }) => void;
    }) => {
      input.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher", expireIn: 600 });
      input.onStatusChange({ status: "authorized" });
      return {
        client_id: "cli_registered",
        client_secret: "secret_registered",
        user_info: {
          open_id: "ou_installer",
          union_id: "on_installer",
        },
      };
    });

    const registrar = createFeishuNodeSdkAppRegistrar();
    await expect(registrar.register({
      providerRegion: "feishu_cn",
      suggestedBotName: "Builder - Rudder",
      source: "rudder/agent-integrations",
      signal: new AbortController().signal,
      onSetupUrl: vi.fn(),
      onStatusChange: vi.fn(),
    })).resolves.toMatchObject({
      appId: "cli_registered",
      appSecret: "secret_registered",
      installerUserId: "ou_installer",
      installerUnionId: "on_installer",
    });

    expect(mockRegisterApp).toHaveBeenCalledWith(expect.objectContaining({
      addons: {
        scopes: {
          tenant: ["im:message:send_as_bot", "im:message.reactions:write_only"],
        },
        events: {
          items: {
            tenant: ["im.message.receive_v1"],
          },
        },
      },
    }));
  });
});
