import { describe, expect, it } from "vitest";
import {
  buildJoinDefaultsPayloadForAccept,
  normalizeAgentDefaultsForJoin,
} from "../routes/access.js";

describe("buildJoinDefaultsPayloadForAccept (openclaw_gateway)", () => {
  it("leaves non-gateway payloads unchanged", () => {
    const defaultsPayload = { command: "echo hello" };
    const result = buildJoinDefaultsPayloadForAccept({
      agentRuntimeType: "process",
      defaultsPayload,
      inboundOpenClawAuthHeader: "ignored-token",
    });

    expect(result).toEqual(defaultsPayload);
  });

  it("normalizes wrapped x-openclaw-token header", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": {
            value: "gateway-token-1234567890",
          },
        },
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      url: "ws://127.0.0.1:18789",
      headers: {
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });

  it("accepts inbound x-openclaw-token for gateway joins", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
      },
      inboundOpenClawTokenHeader: "gateway-token-1234567890",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      headers: {
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });

  it("derives x-openclaw-token from authorization header", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          authorization: "Bearer gateway-token-1234567890",
        },
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      headers: {
        authorization: "Bearer gateway-token-1234567890",
        "x-openclaw-token": "gateway-token-1234567890",
      },
    });
  });

  it("normalizes request-level rudderApiUrl into gateway defaults", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
      },
      rudderApiUrl: "https://rudder.example.com",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      rudderApiUrl: "https://rudder.example.com",
    });
    expect(result).not.toHaveProperty("paperclipApiUrl");
  });

  it("keeps legacy paperclipApiUrl as a read-only alias for older join clients", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
      },
      paperclipApiUrl: "https://legacy-rudder.example.com",
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      rudderApiUrl: "https://legacy-rudder.example.com",
    });
    expect(result).not.toHaveProperty("paperclipApiUrl");
  });

  it("normalizes legacy paperclipApiUrl from nested agent defaults", () => {
    const result = buildJoinDefaultsPayloadForAccept({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        paperclipApiUrl: "https://nested-legacy-rudder.example.com",
      },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      rudderApiUrl: "https://nested-legacy-rudder.example.com",
    });
    expect(result).not.toHaveProperty("paperclipApiUrl");
  });
});

describe("normalizeAgentDefaultsForJoin (openclaw_gateway)", () => {
  it("generates persistent device key when device auth is enabled", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
        disableDeviceAuth: false,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.disableDeviceAuth).toBe(false);
    expect(typeof normalized.normalized?.devicePrivateKeyPem).toBe("string");
    expect((normalized.normalized?.devicePrivateKeyPem as string).length).toBeGreaterThan(64);
  });

  it("does not generate device key when disableDeviceAuth=true", () => {
    const normalized = normalizeAgentDefaultsForJoin({
      agentRuntimeType: "openclaw_gateway",
      defaultsPayload: {
        url: "ws://127.0.0.1:18789",
        headers: {
          "x-openclaw-token": "gateway-token-1234567890",
        },
        disableDeviceAuth: true,
      },
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    });

    expect(normalized.fatalErrors).toEqual([]);
    expect(normalized.normalized?.disableDeviceAuth).toBe(true);
    expect(normalized.normalized?.devicePrivateKeyPem).toBeUndefined();
  });
});
