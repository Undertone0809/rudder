import { describe, expect, it } from "vitest";
import { defaultCreateValues } from "../../components/agent-config-defaults";
import { buildHermesGatewayConfig } from "./build-config";

describe("buildHermesGatewayConfig", () => {
  it("uses local Hermes by default and ignores server credentials on that path", () => {
    const config = buildHermesGatewayConfig({
      ...defaultCreateValues,
      agentRuntimeType: "hermes_gateway",
      hermesConnectionMode: "local",
      url: "http://127.0.0.1:8642",
      apiKey: "must-not-be-persisted-for-local-mode",
      payloadTemplateJson: '{"metadata":{"draft":"custom-only"}}',
    });

    expect(config).toMatchObject({
      hermesConnectionMode: "local",
      sessionKeyStrategy: "issue",
    });
    expect(config.hermesChatBackend).toBeUndefined();
    expect(config.url).toBeUndefined();
    expect(config.apiKey).toBeUndefined();
    expect(config.payloadTemplate).toBeUndefined();
  });

  it("requires an explicit custom mode to select Hermes HTTP and credentials", () => {
    const config = buildHermesGatewayConfig({
      ...defaultCreateValues,
      agentRuntimeType: "hermes_gateway",
      hermesConnectionMode: "custom",
      url: "http://127.0.0.1:18642",
      apiKey: "custom-secret",
      payloadTemplateJson: '{"metadata":{"draft":"custom-only"}}',
    });

    expect(config).toMatchObject({
      hermesConnectionMode: "custom",
      hermesChatBackend: "native_runs_http",
      url: "http://127.0.0.1:18642",
      apiKey: "custom-secret",
      payloadTemplate: { metadata: { draft: "custom-only" } },
    });
  });

  it("isolates a retained custom draft on local submit without clearing it", () => {
    const values = {
      ...defaultCreateValues,
      agentRuntimeType: "hermes_gateway" as const,
      hermesConnectionMode: "custom" as const,
      url: "http://127.0.0.1:18642",
      apiKey: "custom-secret",
      payloadTemplateJson: '{"metadata":{"draft":"custom-only"}}',
    };
    const before = { ...values };
    const local = buildHermesGatewayConfig({ ...values, hermesConnectionMode: "local" });
    expect(local.url).toBeUndefined();
    expect(local.apiKey).toBeUndefined();
    expect(local.payloadTemplate).toBeUndefined();
    expect(values).toEqual(before);
    expect(buildHermesGatewayConfig(values).payloadTemplate).toEqual({ metadata: { draft: "custom-only" } });
  });
});
