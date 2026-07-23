import type {
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { auth } from "@modelcontextprotocol/client";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PersistentMcpOAuthClientProvider,
  resolveMcpOAuthRedirectUri,
  type ManagedMcpOAuthMaterial,
} from "../services/mcp/oauth-provider.js";
import { createSecureMcpFetch } from "../services/mcp/pinned-fetch.js";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

async function startOAuthServer() {
  const requests: Array<{ method: string; url: string; body: string }> = [];
  let origin = "";
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    requests.push({ method: req.method ?? "GET", url: req.url ?? "/", body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/oauth-protected-resource/mcp") {
      res.end(JSON.stringify({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ["read"],
      }));
      return;
    }
    if (req.url === "/.well-known/oauth-authorization-server") {
      res.end(JSON.stringify({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
      }));
      return;
    }
    if (req.url === "/register" && req.method === "POST") {
      res.statusCode = 201;
      res.end(JSON.stringify({
        client_id: "registered-client",
        redirect_uris: ["http://127.0.0.1:4310/api/mcp/oauth/callback"],
        token_endpoint_auth_method: "none",
      }));
      return;
    }
    if (req.url === "/token" && req.method === "POST") {
      res.end(JSON.stringify({
        access_token: "snake-access-token",
        refresh_token: "snake-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read",
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests };
}

describe("managed MCP OAuth provider", () => {
  it("derives the callback only from trusted deployment configuration", () => {
    expect(resolveMcpOAuthRedirectUri({
      deploymentMode: "local_trusted",
      serverPort: 4310,
    })).toBe("http://127.0.0.1:4310/api/mcp/oauth/callback");

    expect(resolveMcpOAuthRedirectUri({
      deploymentMode: "authenticated",
      serverPort: 4310,
      authPublicBaseUrl: "https://rudder.example.com/base",
    })).toBe("https://rudder.example.com/api/mcp/oauth/callback");

    expect(() => resolveMcpOAuthRedirectUri({
      deploymentMode: "authenticated",
      serverPort: 4310,
    })).toThrow("canonical HTTPS");
    expect(() => resolveMcpOAuthRedirectUri({
      deploymentMode: "authenticated",
      serverPort: 4310,
      authPublicBaseUrl: "http://rudder.example.com",
    })).toThrow("canonical HTTPS");
    expect(() => resolveMcpOAuthRedirectUri({
      deploymentMode: "authenticated",
      serverPort: 4310,
      authPublicBaseUrl: "https://rudder.example.com?redirect=https://attacker.example",
    })).toThrow("canonical HTTPS");
  });

  it("persists DCR, tokens, PKCE, discovery state, and resource URL without exposing state", async () => {
    let material: ManagedMcpOAuthMaterial = {};
    const save = vi.fn(async (next: ManagedMcpOAuthMaterial) => {
      material = structuredClone(next);
    });
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "raw-state-visible-only-to-the-provider",
      material,
      save,
    });
    const clientInformation = {
      client_id: "registered-client",
      client_secret: "registered-secret",
      issuer: "https://oauth.example.com",
    } satisfies StoredOAuthClientInformation;
    const tokens = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "read offline_access",
      issuer: "https://oauth.example.com",
    } satisfies StoredOAuthTokens;
    const discoveryState = {
      authorizationServerUrl: "https://oauth.example.com",
      authorizationServerMetadata: {
        issuer: "https://oauth.example.com",
        authorization_endpoint: "https://oauth.example.com/authorize",
        token_endpoint: "https://oauth.example.com/token",
      },
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
    } satisfies OAuthDiscoveryState;

    await provider.saveClientInformation(clientInformation);
    await provider.saveTokens(tokens);
    await provider.saveCodeVerifier("pkce-verifier");
    await provider.saveDiscoveryState(discoveryState);
    await provider.saveResourceUrl("https://mcp.example.com/mcp");
    await provider.saveAuthorizationServerUrl("https://oauth.example.com");

    expect(await provider.state()).toBe("raw-state-visible-only-to-the-provider");
    expect(await provider.clientInformation()).toEqual(clientInformation);
    expect(await provider.tokens()).toEqual(tokens);
    expect(await provider.codeVerifier()).toBe("pkce-verifier");
    expect(await provider.discoveryState()).toEqual(discoveryState);
    expect(await provider.resourceUrl()).toBe("https://mcp.example.com/mcp");
    expect(await provider.authorizationServerUrl()).toBe("https://oauth.example.com");
    expect(material).toEqual(expect.objectContaining({
      clientInformation,
      tokens,
      codeVerifier: "pkce-verifier",
      discoveryState,
      resourceUrl: "https://mcp.example.com/mcp",
      authorizationServerUrl: "https://oauth.example.com",
    }));
    expect(JSON.stringify(material)).not.toContain("raw-state-visible");
    expect(save).toHaveBeenCalledTimes(6);
  });

  it("captures the validated authorization URL instead of performing a redirect", async () => {
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "raw-state",
      material: {},
      save: async () => undefined,
    });
    await provider.redirectToAuthorization(new URL("https://oauth.example.com/authorize?state=x"));
    expect(provider.authorizationUrl?.href)
      .toBe("https://oauth.example.com/authorize?state=x");
  });

  it("does not mutate its in-memory material when durable persistence fails", async () => {
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "raw-state",
      material: { codeVerifier: "old-verifier" },
      save: async () => {
        throw new Error("durable save failed");
      },
    });

    await expect(provider.saveCodeVerifier("new-verifier"))
      .rejects.toThrow("durable save failed");
    expect(await provider.codeVerifier()).toBe("old-verifier");
  });

  it("preserves the prior refresh token when a refresh response omits it", async () => {
    let material: ManagedMcpOAuthMaterial = {
      tokens: {
        access_token: "old-access",
        refresh_token: "keep-this-refresh-token",
        token_type: "Bearer",
      },
    };
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "refresh-state",
      material,
      save: async (next) => {
        material = structuredClone(next);
      },
    });

    await provider.saveTokens({
      access_token: "new-access",
      token_type: "Bearer",
    });
    expect(material.tokens).toEqual(expect.objectContaining({
      access_token: "new-access",
      refresh_token: "keep-this-refresh-token",
    }));
  });

  it("uses the pinned fetch for RFC9728, AS metadata, DCR, PKCE, and token exchange", async () => {
    const { origin, requests } = await startOAuthServer();
    let material: ManagedMcpOAuthMaterial = {};
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "one-time-oauth-state",
      material,
      save: async (next) => {
        material = structuredClone(next);
      },
    });
    const fetchFn = createSecureMcpFetch({
      allowedOrigins: [origin],
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    await expect(auth(provider, {
      serverUrl: `${origin}/mcp`,
      scope: "read",
      fetchFn,
    })).resolves.toBe("REDIRECT");

    const authorizationUrl = provider.authorizationUrl;
    expect(authorizationUrl?.origin).toBe(origin);
    expect(authorizationUrl?.searchParams.get("state")).toBe("one-time-oauth-state");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.clientInformation).toEqual(expect.objectContaining({
      client_id: "registered-client",
    }));
    expect(material.codeVerifier).toBeTruthy();
    expect(material.discoveryState).toEqual(expect.objectContaining({
      authorizationServerUrl: origin,
    }));

    const callbackProvider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "unused-after-callback",
      material,
      save: async (next) => {
        material = structuredClone(next);
      },
    });
    const mixedIssuerProvider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "unused-after-callback",
      material,
      save: async () => undefined,
    });
    await expect(auth(mixedIssuerProvider, {
      serverUrl: `${origin}/mcp`,
      authorizationCode: "must-not-reach-token-endpoint",
      iss: `${origin}/attacker`,
      scope: "read",
      fetchFn,
    })).rejects.toThrow();
    expect(requests.filter((item) => item.url === "/token")).toHaveLength(0);

    await expect(auth(callbackProvider, {
      serverUrl: `${origin}/mcp`,
      authorizationCode: "one-time-code",
      iss: origin,
      scope: "read",
      fetchFn,
    })).resolves.toBe("AUTHORIZED");

    expect(material.tokens).toEqual(expect.objectContaining({
      access_token: "snake-access-token",
      refresh_token: "snake-refresh-token",
    }));
    const registration = requests.find((item) => item.url === "/register");
    expect(JSON.parse(registration?.body ?? "{}")).toEqual(expect.objectContaining({
      redirect_uris: ["http://127.0.0.1:4310/api/mcp/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
    }));
    const token = requests.find((item) => item.url === "/token");
    const tokenBody = new URLSearchParams(token?.body);
    expect(tokenBody.get("code")).toBe("one-time-code");
    expect(tokenBody.get("code_verifier")).toBe(material.codeVerifier);
  });
});
