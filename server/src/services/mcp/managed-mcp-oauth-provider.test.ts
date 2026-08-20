import { describe, expect, it, vi } from "vitest";
import { PersistentMcpOAuthClientProvider } from "./oauth-provider.js";

describe("PersistentMcpOAuthClientProvider static clients", () => {
  it("uses static client information without persisting it through saveClientInformation", async () => {
    const save = vi.fn();
    const provider = new PersistentMcpOAuthClientProvider({
      redirectUri: "http://127.0.0.1:4310/api/mcp/oauth/callback",
      state: "oauth-state",
      material: {},
      staticClient: {
        clientId: "test-github-client",
        clientSecret: "test-github-secret",
        issuer: "https://github.example.test/oauth",
      },
      save,
    });

    expect(provider.clientInformation()).toMatchObject({
      client_id: "test-github-client",
      client_secret: "test-github-secret",
      issuer: "https://github.example.test/oauth",
      redirect_uris: ["http://127.0.0.1:4310/api/mcp/oauth/callback"],
      token_endpoint_auth_method: "client_secret_post",
    });
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post");

    await provider.saveClientInformation({
      client_id: "discovered-client",
      client_secret: "discovered-secret",
      issuer: "https://discovered.example.test/oauth",
    });

    expect(save).not.toHaveBeenCalled();
  });
});
