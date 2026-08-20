import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { DeploymentMode } from "@rudderhq/shared";

export interface ManagedMcpOAuthMaterial {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  resourceUrl?: string;
  authorizationServerUrl?: string;
}

export interface ManagedMcpOAuthStaticClient {
  clientId: string;
  clientSecret: string;
  issuer: string;
}

export function resolveMcpOAuthRedirectUri(input: {
  deploymentMode: DeploymentMode;
  serverPort: number;
  authPublicBaseUrl?: string | null;
}): string {
  if (input.deploymentMode === "local_trusted") {
    return `http://127.0.0.1:${input.serverPort}/api/mcp/oauth/callback`;
  }
  let base: URL;
  try {
    base = new URL(input.authPublicBaseUrl ?? "");
  } catch {
    throw new Error("Managed MCP OAuth requires a canonical HTTPS auth public base URL");
  }
  if (
    base.protocol !== "https:"
    || base.username
    || base.password
    || base.search
    || base.hash
  ) {
    throw new Error("Managed MCP OAuth requires a canonical HTTPS auth public base URL");
  }
  return new URL("/api/mcp/oauth/callback", base.origin).href;
}

export interface PersistentMcpOAuthClientProviderOptions {
  redirectUri: string;
  state: string;
  material: ManagedMcpOAuthMaterial;
  staticClient?: ManagedMcpOAuthStaticClient;
  save: (material: ManagedMcpOAuthMaterial) => void | Promise<void>;
}

export class PersistentMcpOAuthClientProvider implements OAuthClientProvider {
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  authorizationUrl: URL | null = null;
  private readonly oauthState: string;
  private readonly saveMaterial: PersistentMcpOAuthClientProviderOptions["save"];
  private readonly staticClientInformation?: StoredOAuthClientInformation;
  private material: ManagedMcpOAuthMaterial;

  constructor(options: PersistentMcpOAuthClientProviderOptions) {
    this.redirectUrl = options.redirectUri;
    this.oauthState = options.state;
    this.material = structuredClone(options.material);
    this.saveMaterial = options.save;
    this.staticClientInformation = options.staticClient
      ? {
          client_id: options.staticClient.clientId,
          client_secret: options.staticClient.clientSecret,
          issuer: options.staticClient.issuer,
          redirect_uris: [options.redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "client_secret_post",
        }
      : undefined;
    this.clientMetadata = {
      client_name: "Rudder",
      redirect_uris: [options.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: options.staticClient
        ? "client_secret_post"
        : "none",
    };
  }

  state(): string {
    return this.oauthState;
  }

  clientInformation(
    _context?: OAuthClientInformationContext,
  ): StoredOAuthClientInformation | undefined {
    return this.staticClientInformation ?? this.material.clientInformation;
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    _context?: OAuthClientInformationContext,
  ): Promise<void> {
    if (this.staticClientInformation) return;
    await this.update({ clientInformation });
  }

  tokens(_context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.material.tokens;
  }

  async saveTokens(
    tokens: StoredOAuthTokens,
    _context?: OAuthClientInformationContext,
  ): Promise<void> {
    await this.update({
      tokens: {
        ...tokens,
        ...(tokens.refresh_token
          ? {}
          : this.material.tokens?.refresh_token
            ? { refresh_token: this.material.tokens.refresh_token }
            : {}),
      },
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.authorizationUrl = new URL(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.update({ codeVerifier });
  }

  codeVerifier(): string {
    if (!this.material.codeVerifier) {
      throw new Error("Managed MCP OAuth PKCE verifier is unavailable");
    }
    return this.material.codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    await this.update({ discoveryState });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.material.discoveryState;
  }

  async saveResourceUrl(resourceUrl: string): Promise<void> {
    await this.update({ resourceUrl });
  }

  resourceUrl(): string | undefined {
    return this.material.resourceUrl;
  }

  async saveAuthorizationServerUrl(authorizationServerUrl: string): Promise<void> {
    await this.update({ authorizationServerUrl });
  }

  authorizationServerUrl(): string | undefined {
    return this.material.authorizationServerUrl;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    const next = { ...this.material };
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "verifier") delete next.codeVerifier;
    if (scope === "all" || scope === "discovery") {
      delete next.discoveryState;
      delete next.resourceUrl;
      delete next.authorizationServerUrl;
    }
    await this.saveMaterial(structuredClone(next));
    this.material = next;
  }

  snapshot(): ManagedMcpOAuthMaterial {
    return structuredClone(this.material);
  }

  private async update(patch: Partial<ManagedMcpOAuthMaterial>): Promise<void> {
    const next = { ...this.material, ...structuredClone(patch) };
    await this.saveMaterial(structuredClone(next));
    this.material = next;
  }
}
