import { describe, expect, it } from "vitest";
import { createProfileBoundRuntimeProviderCapabilityResolverFromConfig } from "./index.js";

const binding = {
  hostId: "local",
  profileId: "hermes-http-profile",
};

const httpSession = {
  sessionId: "hermes-session",
  sessionDisplayId: "hermes-session",
  sessionParams: { transport: "hermes-http-sse" },
};

describe("Hermes HTTP profile resolver", () => {
  it.each(["url", "baseUrl", "hermesBaseUrl", "gatewayUrl"] as const)(
    "resolves %s consistently for live and historical reads",
    (urlField) => {
      const runtimeConfig = {
        [urlField]: "http://127.0.0.1:43123",
        apiKey: "hermes-test-key",
        providerVersion: "0.19.1",
      };
      const liveResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
        runtimeType: "hermes_gateway",
        runtimeConfig,
      });
      const historicalResolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
        runtimeType: "hermes_gateway",
        runtimeConfig,
        resolutionMode: "historical",
      });

      const live = liveResolver("hermes_gateway", binding, { session: httpSession });
      const historical = historicalResolver("hermes_gateway", binding, { session: httpSession });

      expect(live).toMatchObject({
        profileResolved: true,
        adapter: {
          transcript: {
            evidence: {
              status: "supported",
              transport: "hermes-http-sse",
              profileBound: true,
            },
          },
        },
      });
      expect(historical).toMatchObject({
        profileResolved: true,
        adapter: {
          transcript: {
            evidence: {
              status: "supported",
              transport: "hermes-http-sse",
              profileBound: true,
            },
          },
        },
      });
      expect(
        (historical as { adapter: { transcript?: { evidence: unknown } } }).adapter.transcript?.evidence,
      ).toEqual(
        (live as { adapter: { transcript?: { evidence: unknown } } }).adapter.transcript?.evidence,
      );
    },
  );
});
