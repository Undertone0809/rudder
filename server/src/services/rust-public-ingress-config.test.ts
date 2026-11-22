import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFoundationChildEnvironment,
  nativeIssueAssetStorageEnvironment,
  nativeLocalAccountLifecycleEnvironment,
  nativeSessionAuthEnvironment,
  resolveNativeChatProviderHostFields,
  type RustIssueAssetStorage,
  type RustNativeChatHost,
  type RustNativeSessionAuthOptions,
} from "./rust-public-ingress-config.js";

afterEach(() => vi.unstubAllEnvs());

const local: RustNativeSessionAuthOptions = {
  kind: "local_account", secret: "test-only", secureCookie: false, assertionKey: "test-proof",
};

describe("native execution startup transport", () => {
  const identityAuth = {
    assertionKey: "test-identity-proof", agentJwtSecret: "test-jwt-secret",
    agentJwtIssuer: "rudder", agentJwtAudience: "rudder-agent", localImplicitEnabled: false,
  };
  const ingress = {
    listenAddr: "127.0.0.1:3100", nodeUpstream: "http://127.0.0.1:3101", authorizationKey: "test-only",
    publicApiUrl: "https://rudder.example", authPublicBaseUrl: "https://auth.example",
    identityAuth,
  };
  const nativeChatHost: RustNativeChatHost = {
    instanceId: "test", instanceRoot: "/tmp/rudder-test-instance", workspaceHome: "/tmp/rudder-test-workspace",
    operatorHome: "/tmp/rudder-test-operator", executableSearchPath: "/opt/rudder/bin",
    friendlyWorkspaceHome: false, deploymentMode: "authenticated", deploymentExposure: "private",
    authRequirement: "required", trustedOrigins: [ingress.publicApiUrl],
  };
  const startup = { databaseUrl: "postgres://test", actorEnvelopeKey: "test-actor", secretsMasterKeyFile: "/tmp/test-master.key" };

  it("keeps auth-only ingress from activating execution without installation facts", () => {
    const environment = createFoundationChildEnvironment({ ...startup, publicIngress: ingress });

    expect(environment).toMatchObject({
      RUDDER_NATIVE_IDENTITY_AUTH_MODE: "required",
      RUDDER_NATIVE_HOST_API_URL: ingress.publicApiUrl,
      RUDDER_NATIVE_HOST_AUTH_PUBLIC_BASE_URL: ingress.authPublicBaseUrl,
    });
    expect(environment).not.toHaveProperty("RUDDER_NATIVE_CHAT_HOST");
    expect(environment).not.toHaveProperty("RUDDER_NATIVE_HOST_RUNTIME_ENVIRONMENT");
    expect(environment).not.toHaveProperty("RUDDER_NATIVE_HOST_BUNDLED_SKILL_ROOTS");
  });

  it("activates execution only with identity authority and explicit installation facts", () => {
    vi.stubEnv("RUDDER_TEST_OPERATOR_VARIABLE", "test-runtime-fact");
    const environment = createFoundationChildEnvironment({ ...startup, publicIngress: { ...ingress, nativeChatHost } });

    expect(JSON.parse(environment.RUDDER_NATIVE_CHAT_HOST)).toEqual(nativeChatHost);
    expect(JSON.parse(environment.RUDDER_NATIVE_HOST_RUNTIME_ENVIRONMENT))
      .toHaveProperty("RUDDER_TEST_OPERATOR_VARIABLE", "test-runtime-fact");
    expect(JSON.parse(environment.RUDDER_NATIVE_HOST_BUNDLED_SKILL_ROOTS)).toHaveLength(2);
    expect(environment.PATH).toBe(nativeChatHost.executableSearchPath);

    const withoutIdentity = createFoundationChildEnvironment({
      ...startup, publicIngress: { ...ingress, nativeChatHost, identityAuth: undefined },
    });
    expect(withoutIdentity).not.toHaveProperty("RUDDER_NATIVE_HOST_RUNTIME_ENVIRONMENT");
  });
});

describe("native WebSocket session fallback configuration", () => {
  it("rejects ambiguous local-account credential precedence before starting Rust", () => {
    expect(() => nativeSessionAuthEnvironment(local)).toThrow("explicit WebSocket cookie fallback");
  });

  it.each(["session", "local_implicit"] as const)("passes the explicit %s fallback", (fallback) => {
    expect(nativeSessionAuthEnvironment({ ...local, websocketCookieFallback: fallback }))
      .toHaveProperty("RUDDER_NATIVE_WEBSOCKET_COOKIE_FALLBACK", fallback);
  });

  it("preserves configurations without local-account sessions", () => {
    expect(nativeSessionAuthEnvironment()).toEqual({});
    expect(nativeSessionAuthEnvironment({ ...local, kind: "better_auth" }))
      .not.toHaveProperty("RUDDER_NATIVE_WEBSOCKET_COOKIE_FALLBACK");
  });
});

describe("native local-account lifecycle transport", () => {
  const lifecycle = {
    installationId: "test-installation", expectedIssuer: "https://identity.example",
    identityOrigin: "https://identity.example", audience: "test-audience",
  };
  const ingress = { listenAddr: "127.0.0.1:3100", nodeUpstream: "http://127.0.0.1:3101", authorizationKey: "test-only" };

  it("passes only lifecycle configuration and leaves session secrets in their dedicated transport", () => {
    const env = nativeLocalAccountLifecycleEnvironment({ ...ingress, sessionAuth: local, localAccountLifecycle: lifecycle });
    expect(JSON.parse(env.RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG)).toEqual(lifecycle);
    expect(env.RUDDER_NATIVE_LOCAL_ACCOUNT_AUTH_CONFIG).not.toContain(local.secret);
  });

  it("rejects lifecycle authority without the matching local-account session mode", () => {
    expect(() => nativeLocalAccountLifecycleEnvironment({ ...ingress, localAccountLifecycle: lifecycle })).toThrow();
    expect(() => nativeLocalAccountLifecycleEnvironment({ ...ingress, sessionAuth: { ...local, kind: "better_auth" }, localAccountLifecycle: lifecycle })).toThrow();
    expect(nativeLocalAccountLifecycleEnvironment(ingress)).toEqual({});
  });
});

describe("native provider installation facts", () => {
  it("passes only explicit Pi launcher paths to Rust", () => {
    const previousNode = process.env.RUDDER_PI_NODE_EXECUTABLE;
    const previousEntry = process.env.RUDDER_PI_CLI_ENTRY;
    process.env.RUDDER_PI_NODE_EXECUTABLE = "/opt/rudder/node/bin/node";
    process.env.RUDDER_PI_CLI_ENTRY = "/opt/rudder/pi/cli.js";
    try {
      expect(resolveNativeChatProviderHostFields()).toMatchObject({
        piNodeExecutable: "/opt/rudder/node/bin/node",
        piCliEntry: "/opt/rudder/pi/cli.js",
      });
    } finally {
      if (previousNode === undefined) delete process.env.RUDDER_PI_NODE_EXECUTABLE;
      else process.env.RUDDER_PI_NODE_EXECUTABLE = previousNode;
      if (previousEntry === undefined) delete process.env.RUDDER_PI_CLI_ENTRY;
      else process.env.RUDDER_PI_CLI_ENTRY = previousEntry;
    }
  });
});

describe("native Issue asset storage transport", () => {
  const localStorage: RustIssueAssetStorage = {
    provider: "local_disk",
    localDiskBaseDir: "/tmp/rudder-issue-assets",
  };
  const s3Storage: RustIssueAssetStorage = {
    provider: "s3",
    bucket: "rudder-test",
    region: "us-east-1",
    prefix: "test-prefix",
    forcePathStyle: true,
  };

  it("passes local disk configuration without forwarding ambient AWS credentials", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "must-not-reach-local-storage");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "must-not-reach-local-storage");
    vi.stubEnv("RUDDER_SECRETS_MASTER_KEY", "must-not-reach-foundation");

    const environment = nativeIssueAssetStorageEnvironment(localStorage);

    expect(JSON.parse(environment.RUDDER_NATIVE_ISSUE_ASSET_STORAGE_CONFIG)).toEqual(localStorage);
    expect(environment).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(environment).not.toHaveProperty("RUDDER_SECRETS_MASTER_KEY");
  });

  it("forwards only selected AWS credential and profile settings outside the JSON config", () => {
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("AWS_PROFILE", "rudder-test-profile");
    vi.stubEnv("AWS_CONFIG_FILE", "/tmp/aws-config");
    vi.stubEnv("RUDDER_SECRETS_MASTER_KEY", "must-not-reach-foundation");
    vi.stubEnv("AWS_UNRELATED_SETTING", "must-not-reach-foundation");

    const environment = nativeIssueAssetStorageEnvironment(s3Storage);

    expect(JSON.parse(environment.RUDDER_NATIVE_ISSUE_ASSET_STORAGE_CONFIG)).toEqual(s3Storage);
    expect(environment.RUDDER_NATIVE_ISSUE_ASSET_STORAGE_CONFIG).not.toContain("test-secret-key");
    expect(environment).toMatchObject({
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      AWS_PROFILE: "rudder-test-profile",
      AWS_CONFIG_FILE: "/tmp/aws-config",
    });
    expect(environment).not.toHaveProperty("RUDDER_SECRETS_MASTER_KEY");
    expect(environment).not.toHaveProperty("AWS_UNRELATED_SETTING");
  });
});
