import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFeishuMarkdownCardPayload,
  createFeishuRestOutboundSender,
} from "../services/integrations/feishu/runtime.js";

describe("Feishu integration runtime outbound sender", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Feishu outbound replies as markdown cards by default", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        code: 0,
        data: { message_id: "om_markdown_card" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sender = createFeishuRestOutboundSender();
    await expect(sender.sendText({
      region: "feishu_cn",
      appId: "cli_app",
      tenantAccessToken: "tenant-token",
      chatId: "oc_chat",
      text: "## Progress\n\n**Done**\n- ZST-613",
    })).resolves.toEqual({ messageId: "om_markdown_card" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual(expect.objectContaining({
      Authorization: "Bearer tenant-token",
      "Content-Type": "application/json",
    }));
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      receive_id: "oc_chat",
      msg_type: "interactive",
    });
    expect(JSON.parse(String(body.content))).toEqual(buildFeishuMarkdownCardPayload("## Progress\n\n**Done**\n- ZST-613"));
  });

  it("falls back to plain Feishu text when markdown card delivery is rejected", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          code: 99991663,
          msg: "card content invalid",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { message_id: "om_text_fallback" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sender = createFeishuRestOutboundSender();
    await expect(sender.sendText({
      region: "feishu_cn",
      appId: "cli_app",
      tenantAccessToken: "tenant-token",
      chatId: "oc_chat",
      text: "**fallback**",
    })).resolves.toEqual({ messageId: "om_text_fallback" });

    expect(calls).toHaveLength(2);
    const cardBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    const fallbackBody = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(cardBody).toMatchObject({
      receive_id: "oc_chat",
      msg_type: "interactive",
    });
    expect(fallbackBody).toEqual({
      receive_id: "oc_chat",
      msg_type: "text",
      content: JSON.stringify({ text: "**fallback**" }),
    });
  });

  it("does not fall back when Feishu rejects the card request for auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        code: 99991672,
        msg: "unauthorized",
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sender = createFeishuRestOutboundSender();
    await expect(sender.sendText({
      region: "feishu_cn",
      appId: "cli_app",
      tenantAccessToken: "bad-token",
      chatId: "oc_chat",
      text: "**do not duplicate**",
    })).rejects.toThrow("Failed to send Feishu message: unauthorized");

    expect(calls).toHaveLength(1);
    const cardBody = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(cardBody).toMatchObject({
      receive_id: "oc_chat",
      msg_type: "interactive",
    });
  });

  it("does not fall back when Feishu returns a semantic auth error with HTTP 200", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({
        code: 99991672,
        msg: "unauthorized",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sender = createFeishuRestOutboundSender();
    await expect(sender.sendText({
      region: "feishu_cn",
      appId: "cli_app",
      tenantAccessToken: "bad-token",
      chatId: "oc_chat",
      text: "**do not duplicate**",
    })).rejects.toThrow("Failed to send Feishu message: unauthorized");

    expect(calls).toHaveLength(1);
  });

  it("falls back on HTTP card payload rejection when the provider message is explicit", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (calls.length === 1) {
        return new Response(JSON.stringify({
          code: 0,
          msg: "interactive card payload invalid",
        }), {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        code: 0,
        data: { message_id: "om_text_fallback" },
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const sender = createFeishuRestOutboundSender();
    await expect(sender.sendText({
      region: "feishu_cn",
      appId: "cli_app",
      tenantAccessToken: "tenant-token",
      chatId: "oc_chat",
      text: "**fallback**",
    })).resolves.toEqual({ messageId: "om_text_fallback" });

    expect(calls).toHaveLength(2);
    const fallbackBody = JSON.parse(String(calls[1]?.init.body)) as Record<string, unknown>;
    expect(fallbackBody).toEqual({
      receive_id: "oc_chat",
      msg_type: "text",
      content: JSON.stringify({ text: "**fallback**" }),
    });
  });

  it("does not fall back after ambiguous card delivery failures", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      throw new Error("connection reset after write");
    });

    const sender = createFeishuRestOutboundSender();
    await expect(sender.sendText({
      region: "feishu_cn",
      appId: "cli_app",
      tenantAccessToken: "tenant-token",
      chatId: "oc_chat",
      text: "**ambiguous**",
    })).rejects.toThrow("connection reset after write");

    expect(calls).toHaveLength(1);
  });
});
