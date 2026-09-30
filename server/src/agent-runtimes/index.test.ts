import { HERMES_PRODUCT_RPC_TRANSPORT } from "@rudderhq/agent-runtime-hermes-gateway/server";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  RuntimeProviderCapabilityResolution,
  RuntimeProviderCapabilityResolverContext,
} from "../services/runtime-kernel/provider-capabilities.js";
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
  it("passes the host-authorized history profile to live and historical readers", () => {
    const runtimeConfig = {
      url: "http://127.0.0.1:43123",
      apiKey: "hermes-test-key",
      providerVersion: "0.19.1",
      hermesHistoryPythonCommand: "/opt/hermes/bin/python3",
      hermesHistorySourcePath: "/opt/hermes/source",
      hermesHome: "/var/lib/hermes",
    };
    const resolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "hermes_gateway",
      runtimeConfig,
    });

    const resolved = resolver("hermes_gateway", binding, { session: httpSession });
    const readRange = (resolved as { adapter: { transcript?: { readRange?: (input: unknown) => Promise<unknown> } } }).adapter.transcript?.readRange;

    expect(resolved).toMatchObject({
      profileResolved: true,
      adapter: {
        transcript: {
          evidence: {
            status: "supported",
            profileBound: true,
            transport: "hermes-session-db-read-only",
          },
        },
      },
    });
    expect(readRange).toBeTypeOf("function");
  });

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

describe("Hermes Product Gateway profile resolver", () => {
  it("uses the host-authorized Product profile for persisted Product sessions and preserves ACP routing", () => {
    const runtimeConfig = {
      command: "hermes",
      cwd: "/workspace",
      providerVersion: "0.21.0",
      hermesPythonCommand: "/opt/hermes/bin/python3",
      hermesSourcePath: "/opt/hermes/source",
      hermesHome: "/var/lib/hermes",
    };
    const resolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "hermes_gateway",
      runtimeConfig,
      resolutionMode: "historical",
    });
    const resolveTransport = (transport: string) => resolver("hermes_gateway", binding, {
      session: {
        sessionId: "hermes-session",
        sessionDisplayId: "hermes-session",
        sessionParams: { transport },
      },
    });

    expect(resolveTransport(HERMES_PRODUCT_RPC_TRANSPORT)).toMatchObject({
      profileResolved: true,
      adapter: {
        sessionResume: {
          evidence: {
            status: "supported",
            transport: HERMES_PRODUCT_RPC_TRANSPORT,
            profileBound: true,
            profileRequired: true,
          },
        },
      },
    });
    expect(resolveTransport("hermes-acp-stdio")).toMatchObject({
      profileResolved: true,
      adapter: {
        sessionResume: {
          evidence: {
            status: "supported",
            transport: "hermes-acp-stdio",
            profileBound: true,
          },
        },
      },
    });
  });
});

describe("OpenCode historical profile resolver", () => {
  const runId = "run-opencode-history";
  const managedHome = "/managed/opencode-home";
  const hostEnv = {
    HOME: "/operator",
    XDG_CONFIG_HOME: path.join(managedHome, ".config"),
    XDG_DATA_HOME: path.join(managedHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(managedHome, ".cache"),
  };
  const binding = { hostId: "local", profileId: "opencode-profile" };

  function contextWithEnv(exportEnv: Record<string, string>): RuntimeProviderCapabilityResolverContext {
    return {
      session: {
        sessionId: "opencode-session",
        sessionDisplayId: "opencode-session",
        sessionParams: { exportEnv },
      },
      readerInput: { run: { id: runId } } as RuntimeProviderCapabilityResolverContext["readerInput"],
    };
  }

  function createResolver() {
    return createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "opencode_local",
      resolutionMode: "historical",
      cwd: "/workspace",
      runtimeConfig: {
        serverCommand: "opencode",
        exportCommand: "opencode",
        serverUrl: "http://127.0.0.1:43123",
        providerVersion: "1.2.3",
        exportEnv: hostEnv,
      },
    });
  }

  it("accepts the adapter-generated config path and rejects later reader env drift", async () => {
    const generatedConfigPath = path.join(managedHome, "runtime-tmp", runId, "opencode.json");
    const context = contextWithEnv({ ...hostEnv, OPENCODE_CONFIG: generatedConfigPath });
    const resolved = createResolver()("opencode_local", binding, context);

    expect(resolved).toMatchObject({
      profileResolved: true,
      adapter: { transcript: { evidence: { status: "supported", profileBound: true } } },
    });

    const readRange = (resolved as {
      adapter: {
        transcript?: {
          readRange?: (input: {
            runtimeType: string;
            session: NonNullable<RuntimeProviderCapabilityResolverContext["session"]>;
            binding: typeof binding;
          }) => Promise<unknown>;
        };
      };
    }).adapter.transcript?.readRange;
    const result = await readRange!({
      runtimeType: "opencode_local",
      session: {
        ...context.session!,
        sessionParams: { exportEnv: { ...hostEnv, OPENCODE_CONFIG: generatedConfigPath, PATH: "/tmp/untrusted/bin" } },
      },
      binding,
    });
    expect(result).toMatchObject({
      availability: "incompatible",
      revision: "incompatible:OpenCode persisted export environment does not match the host profile.",
    });
  });

  it("reads an isolated data profile while accepting only the selected Run's managed config", () => {
    const exportEnv = {
      ...hostEnv,
      XDG_DATA_HOME: path.join(managedHome, "provider-data", "a".repeat(32)),
    };
    const resolver = createProfileBoundRuntimeProviderCapabilityResolverFromConfig({
      runtimeType: "opencode_local", resolutionMode: "historical", cwd: "/workspace",
      runtimeConfig: {
        serverCommand: "opencode", exportCommand: "opencode",
        serverUrl: "http://127.0.0.1:43123", providerVersion: "1.15.11", exportEnv,
      },
    });
    const currentConfig = path.join(managedHome, "runtime-tmp", runId, "opencode.json");
    expect(resolver("opencode_local", binding, contextWithEnv({ ...exportEnv, OPENCODE_CONFIG: currentConfig })))
      .toMatchObject({ profileResolved: true, adapter: { transcript: { evidence: { status: "supported" } } } });
    for (const configPath of [
      path.join(managedHome, "runtime-tmp", "another-run", "opencode.json"),
      "/tmp/untrusted/opencode.json",
    ]) {
      expect(resolver("opencode_local", binding, contextWithEnv({ ...exportEnv, OPENCODE_CONFIG: configPath })))
        .toBeNull();
    }
  });

  it("binds a Reader call to the Run's persisted environment, not an older segment config", async () => {
    const currentConfig = path.join(managedHome, "runtime-tmp", runId, "opencode.json");
    const olderConfig = path.join(managedHome, "runtime-tmp", "previous-run", "opencode.json");
    const context = contextWithEnv({ ...hostEnv, OPENCODE_CONFIG: currentConfig });
    const olderEnv = { ...hostEnv, OPENCODE_CONFIG: olderConfig };
    context.readerInput = {
      orgId: "org-1",
      run: {
        id: runId,
        orgId: "org-1",
        contextSnapshot: { runtimeProviderProfile: { runtimeType: "opencode_local", exportEnv: hostEnv } },
      },
      binding: { id: "binding-1", orgId: "org-1" },
      segment: {
        id: "segment-1",
        orgId: "org-1",
        bindingId: "binding-1",
        nativeSessionId: "opencode-session",
        providerStateJson: { exportEnv: olderEnv },
      },
      span: {
        id: "span-1",
        orgId: "org-1",
        runId,
        bindingId: "binding-1",
        segmentId: "segment-1",
      },
    } as unknown as RuntimeProviderCapabilityResolverContext["readerInput"];
    const resolved = createResolver()("opencode_local", binding, context) as RuntimeProviderCapabilityResolution | null;
    expect(resolved).not.toBeNull();
    // The provider cannot export from this fixture; rejection must reach the
    // provider rather than fail the host-profile environment guard.
    const readRange = resolved!.adapter.transcript!.readRange!;
    const input = {
      runtimeType: "opencode_local",
      session: {
        ...context.session!,
        sessionParams: { exportEnv: olderEnv },
      },
      binding,
    } as Parameters<typeof readRange>[0];
    const result = await readRange(input).catch((error: unknown) => error);
    expect(result).not.toMatchObject({
      revision: "incompatible:OpenCode persisted export environment does not match the host profile.",
    });
    const changedEnv = await readRange({
      ...input,
      session: {
        ...input.session,
        sessionParams: { exportEnv: { ...olderEnv, PATH: "/tmp/untrusted/bin" } },
      },
    });
    expect(changedEnv).toMatchObject({
      availability: "incompatible",
      revision: "incompatible:OpenCode persisted export environment does not match the host profile.",
    });
    const unrelated = await readRange({
      ...input,
      session: { ...input.session, sessionId: "foreign-session" },
    });
    expect(unrelated).toMatchObject({ availability: "incompatible" });
  });

  it.each([
    ["an arbitrary OpenCode config path", { ...hostEnv, OPENCODE_CONFIG: "/tmp/untrusted/opencode.json" }],
    ["an extra environment key", { ...hostEnv, PATH: "/tmp/untrusted/bin" }],
    ["a mismatched host environment value", { ...hostEnv, XDG_CONFIG_HOME: "/tmp/untrusted/config" }],
  ])("rejects persisted env containing %s", (_description, exportEnv) => {
    const resolved = createResolver()("opencode_local", binding, contextWithEnv(exportEnv));
    expect(resolved).toBeNull();
  });

});
