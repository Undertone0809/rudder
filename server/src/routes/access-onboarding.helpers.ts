import type { Db } from "@rudderhq/db";
import {
  authUsers,
  invites
} from "@rudderhq/db";
import type { DeploymentExposure, DeploymentMode } from "@rudderhq/shared";
import {
  PERMISSION_KEYS
} from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import type { Request } from "express";
import { generateEd25519PrivateKeyPem, headerMapGetIgnoreCase, headerMapHasKeyIgnoreCase, isLoopbackHost, isPlainObject, JoinDiagnostic, nonEmptyTrimmedString, normalizeHeaderMap, normalizeHostname, parseBooleanLike, requestBaseUrl, tokenFromAuthorizationHeader } from "./access.helpers.js";

export function normalizeAgentDefaultsForJoin(input: {
  agentRuntimeType: string | null;
  defaultsPayload: unknown;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}) {
  const fatalErrors: string[] = [];
  const diagnostics: JoinDiagnostic[] = [];
  if (input.agentRuntimeType !== "openclaw_gateway") {
    const normalized = isPlainObject(input.defaultsPayload)
      ? (input.defaultsPayload as Record<string, unknown>)
      : null;
    return { normalized, diagnostics, fatalErrors };
  }

  if (!isPlainObject(input.defaultsPayload)) {
    diagnostics.push({
      code: "openclaw_gateway_defaults_missing",
      level: "warn",
      message:
        "No OpenClaw gateway config was provided in agentDefaultsPayload.",
      hint:
        "Include agentDefaultsPayload.url and headers.x-openclaw-token for OpenClaw gateway joins."
    });
    fatalErrors.push(
      "agentDefaultsPayload is required for agentRuntimeType=openclaw_gateway"
    );
    return {
      normalized: null as Record<string, unknown> | null,
      diagnostics,
      fatalErrors
    };
  }

  const defaults = input.defaultsPayload as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};

  let gatewayUrl: URL | null = null;
  const rawGatewayUrl = nonEmptyTrimmedString(defaults.url);
  if (!rawGatewayUrl) {
    diagnostics.push({
      code: "openclaw_gateway_url_missing",
      level: "warn",
      message: "OpenClaw gateway URL is missing.",
      hint: "Set agentDefaultsPayload.url to ws:// or wss:// gateway URL."
    });
    fatalErrors.push("agentDefaultsPayload.url is required");
  } else {
    try {
      gatewayUrl = new URL(rawGatewayUrl);
      if (gatewayUrl.protocol !== "ws:" && gatewayUrl.protocol !== "wss:") {
        diagnostics.push({
          code: "openclaw_gateway_url_protocol",
          level: "warn",
          message: `OpenClaw gateway URL must use ws:// or wss:// (got ${gatewayUrl.protocol}).`
        });
        fatalErrors.push(
          "agentDefaultsPayload.url must use ws:// or wss:// for openclaw_gateway"
        );
      } else {
        normalized.url = gatewayUrl.toString();
        diagnostics.push({
          code: "openclaw_gateway_url_configured",
          level: "info",
          message: `Gateway endpoint set to ${gatewayUrl.toString()}`
        });
      }
    } catch {
      diagnostics.push({
        code: "openclaw_gateway_url_invalid",
        level: "warn",
        message: `Invalid OpenClaw gateway URL: ${rawGatewayUrl}`
      });
      fatalErrors.push("agentDefaultsPayload.url is not a valid URL");
    }
  }

  const headers = normalizeHeaderMap(defaults.headers) ?? {};
  const gatewayToken =
    headerMapGetIgnoreCase(headers, "x-openclaw-token") ??
    headerMapGetIgnoreCase(headers, "x-openclaw-auth") ??
    tokenFromAuthorizationHeader(headerMapGetIgnoreCase(headers, "authorization"));
  if (gatewayToken && !headerMapHasKeyIgnoreCase(headers, "x-openclaw-token")) {
    headers["x-openclaw-token"] = gatewayToken;
  }
  if (Object.keys(headers).length > 0) {
    normalized.headers = headers;
  }

  if (!gatewayToken) {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_missing",
      level: "warn",
      message: "Gateway auth token is missing from agent defaults.",
      hint:
        "Set agentDefaultsPayload.headers.x-openclaw-token (or legacy x-openclaw-auth)."
    });
    fatalErrors.push(
      "agentDefaultsPayload.headers.x-openclaw-token (or x-openclaw-auth) is required"
    );
  } else if (gatewayToken.trim().length < 16) {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_too_short",
      level: "warn",
      message: `Gateway auth token appears too short (${gatewayToken.trim().length} chars).`,
      hint:
        "Use the full gateway auth token from ~/.openclaw/openclaw.json (typically long random string)."
    });
    fatalErrors.push(
      "agentDefaultsPayload.headers.x-openclaw-token is too short; expected a full gateway token"
    );
  } else {
    diagnostics.push({
      code: "openclaw_gateway_auth_header_configured",
      level: "info",
      message: "Gateway auth token configured."
    });
  }

  if (isPlainObject(defaults.payloadTemplate)) {
    normalized.payloadTemplate = defaults.payloadTemplate;
  }

  const parsedDisableDeviceAuth = parseBooleanLike(defaults.disableDeviceAuth);
  const disableDeviceAuth = parsedDisableDeviceAuth === true;
  if (parsedDisableDeviceAuth !== null) {
    normalized.disableDeviceAuth = parsedDisableDeviceAuth;
  }

  const configuredDevicePrivateKeyPem = nonEmptyTrimmedString(
    defaults.devicePrivateKeyPem
  );
  if (configuredDevicePrivateKeyPem) {
    normalized.devicePrivateKeyPem = configuredDevicePrivateKeyPem;
    diagnostics.push({
      code: "openclaw_gateway_device_key_configured",
      level: "info",
      message:
        "Gateway device key configured. Pairing approvals should persist for this agent."
    });
  } else if (!disableDeviceAuth) {
    try {
      normalized.devicePrivateKeyPem = generateEd25519PrivateKeyPem();
      diagnostics.push({
        code: "openclaw_gateway_device_key_generated",
        level: "info",
        message:
          "Generated persistent gateway device key for this join. Pairing approvals should persist for this agent."
      });
    } catch (err) {
      diagnostics.push({
        code: "openclaw_gateway_device_key_generate_failed",
        level: "warn",
        message: `Failed to generate gateway device key: ${
          err instanceof Error ? err.message : String(err)
        }`,
        hint:
          "Set agentDefaultsPayload.devicePrivateKeyPem explicitly or set disableDeviceAuth=true."
      });
      fatalErrors.push(
        "Failed to generate gateway device key. Set devicePrivateKeyPem or disableDeviceAuth=true."
      );
    }
  }

  const waitTimeoutMs =
    typeof defaults.waitTimeoutMs === "number" &&
    Number.isFinite(defaults.waitTimeoutMs)
      ? Math.floor(defaults.waitTimeoutMs)
      : typeof defaults.waitTimeoutMs === "string"
      ? Number.parseInt(defaults.waitTimeoutMs.trim(), 10)
      : NaN;
  if (Number.isFinite(waitTimeoutMs) && waitTimeoutMs > 0) {
    normalized.waitTimeoutMs = waitTimeoutMs;
  }

  const timeoutSec =
    typeof defaults.timeoutSec === "number" && Number.isFinite(defaults.timeoutSec)
      ? Math.floor(defaults.timeoutSec)
      : typeof defaults.timeoutSec === "string"
      ? Number.parseInt(defaults.timeoutSec.trim(), 10)
      : NaN;
  if (Number.isFinite(timeoutSec) && timeoutSec > 0) {
    normalized.timeoutSec = timeoutSec;
  }

  const sessionKeyStrategy = nonEmptyTrimmedString(defaults.sessionKeyStrategy);
  if (
    sessionKeyStrategy === "fixed" ||
    sessionKeyStrategy === "issue" ||
    sessionKeyStrategy === "run"
  ) {
    normalized.sessionKeyStrategy = sessionKeyStrategy;
  }

  const sessionKey = nonEmptyTrimmedString(defaults.sessionKey);
  if (sessionKey) {
    normalized.sessionKey = sessionKey;
  }

  const role = nonEmptyTrimmedString(defaults.role);
  if (role) {
    normalized.role = role;
  }

  if (Array.isArray(defaults.scopes)) {
    const scopes = defaults.scopes
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (scopes.length > 0) {
      normalized.scopes = scopes;
    }
  }

  const rawPaperclipApiUrl =
    typeof defaults.rudderApiUrl === "string"
      ? defaults.rudderApiUrl.trim()
      : "";
  if (rawPaperclipApiUrl) {
    try {
      const parsedPaperclipApiUrl = new URL(rawPaperclipApiUrl);
      if (
        parsedPaperclipApiUrl.protocol !== "http:" &&
        parsedPaperclipApiUrl.protocol !== "https:"
      ) {
        diagnostics.push({
          code: "openclaw_gateway_paperclip_api_url_protocol",
          level: "warn",
          message: `rudderApiUrl must use http:// or https:// (got ${parsedPaperclipApiUrl.protocol}).`
        });
      } else {
        normalized.rudderApiUrl = parsedPaperclipApiUrl.toString();
        diagnostics.push({
          code: "openclaw_gateway_paperclip_api_url_configured",
          level: "info",
          message: `rudderApiUrl set to ${parsedPaperclipApiUrl.toString()}`
        });
      }
    } catch {
      diagnostics.push({
        code: "openclaw_gateway_paperclip_api_url_invalid",
        level: "warn",
        message: `Invalid rudderApiUrl: ${rawPaperclipApiUrl}`
      });
    }
  }

  return { normalized, diagnostics, fatalErrors };
}

export function toInviteSummaryResponse(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect
) {
  const baseUrl = requestBaseUrl(req);
  const onboardingPath = `/api/invites/${token}/onboarding`;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const inviteMessage = extractInviteMessage(invite);
  return {
    id: invite.id,
    orgId: invite.orgId,
    inviteType: invite.inviteType,
    allowedJoinTypes: invite.allowedJoinTypes,
    expiresAt: invite.expiresAt,
    onboardingPath,
    onboardingUrl: baseUrl ? `${baseUrl}${onboardingPath}` : onboardingPath,
    onboardingTextPath,
    onboardingTextUrl: baseUrl
      ? `${baseUrl}${onboardingTextPath}`
      : onboardingTextPath,
    skillIndexPath: "/api/skills/index",
    skillIndexUrl: baseUrl
      ? `${baseUrl}/api/skills/index`
      : "/api/skills/index",
    inviteMessage
  };
}

export function buildOnboardingDiscoveryDiagnostics(input: {
  apiBaseUrl: string;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  bindHost: string;
  allowedHostnames: string[];
}): JoinDiagnostic[] {
  const diagnostics: JoinDiagnostic[] = [];
  let apiHost: string | null = null;
  if (input.apiBaseUrl) {
    try {
      apiHost = normalizeHostname(new URL(input.apiBaseUrl).hostname);
    } catch {
      apiHost = null;
    }
  }

  const bindHost = normalizeHostname(input.bindHost);
  const allowSet = new Set(
    input.allowedHostnames
      .map((entry) => normalizeHostname(entry))
      .filter((entry): entry is string => Boolean(entry))
  );

  if (apiHost && isLoopbackHost(apiHost)) {
    diagnostics.push({
      code: "openclaw_onboarding_api_loopback",
      level: "warn",
      message:
        "Onboarding URL resolves to loopback hostname. Remote OpenClaw agents cannot reach localhost on your Rudder host.",
      hint: "Use a reachable hostname/IP (for example Tailscale hostname, Docker host alias, or public domain)."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    (!bindHost || isLoopbackHost(bindHost))
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_loopback_bind",
      level: "warn",
      message: "Rudder is bound to loopback in authenticated/private mode.",
      hint: "Run with a reachable bind host or use pnpm dev --tailscale-auth for private-network onboarding."
    });
  }

  if (
    input.deploymentMode === "authenticated" &&
    input.deploymentExposure === "private" &&
    apiHost &&
    !isLoopbackHost(apiHost) &&
    allowSet.size > 0 &&
    !allowSet.has(apiHost)
  ) {
    diagnostics.push({
      code: "openclaw_onboarding_private_host_not_allowed",
      level: "warn",
      message: `Onboarding host "${apiHost}" is not in allowed hostnames for authenticated/private mode.`,
      hint: `Run pnpm rudder allowed-hostname ${apiHost}`
    });
  }

  return diagnostics;
}

export function buildOnboardingConnectionCandidates(input: {
  apiBaseUrl: string;
  bindHost: string;
  allowedHostnames: string[];
}): string[] {
  let base: URL | null = null;
  try {
    if (input.apiBaseUrl) {
      base = new URL(input.apiBaseUrl);
    }
  } catch {
    base = null;
  }

  const protocol = base?.protocol ?? "http:";
  const port = base?.port ? `:${base.port}` : "";
  const candidates = new Set<string>();

  if (base) {
    candidates.add(base.origin);
  }

  const bindHost = normalizeHostname(input.bindHost);
  if (bindHost && !isLoopbackHost(bindHost)) {
    candidates.add(`${protocol}//${bindHost}${port}`);
  }

  for (const rawHost of input.allowedHostnames) {
    const host = normalizeHostname(rawHost);
    if (!host) continue;
    candidates.add(`${protocol}//${host}${port}`);
  }

  if (base && isLoopbackHost(base.hostname)) {
    candidates.add(`${protocol}//host.docker.internal${port}`);
  }

  return Array.from(candidates);
}

export function buildInviteOnboardingManifest(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const baseUrl = requestBaseUrl(req);
  const skillPath = "/api/skills/rudder";
  const skillUrl = baseUrl ? `${baseUrl}${skillPath}` : skillPath;
  const registrationEndpointPath = `/api/invites/${token}/accept`;
  const registrationEndpointUrl = baseUrl
    ? `${baseUrl}${registrationEndpointPath}`
    : registrationEndpointPath;
  const onboardingTextPath = `/api/invites/${token}/onboarding.txt`;
  const onboardingTextUrl = baseUrl
    ? `${baseUrl}${onboardingTextPath}`
    : onboardingTextPath;
  const discoveryDiagnostics = buildOnboardingDiscoveryDiagnostics({
    apiBaseUrl: baseUrl,
    deploymentMode: opts.deploymentMode,
    deploymentExposure: opts.deploymentExposure,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });
  const connectionCandidates = buildOnboardingConnectionCandidates({
    apiBaseUrl: baseUrl,
    bindHost: opts.bindHost,
    allowedHostnames: opts.allowedHostnames
  });

  return {
    invite: toInviteSummaryResponse(req, token, invite),
    onboarding: {
      instructions:
        "Join as an OpenClaw Gateway agent, save your one-time claim secret, wait for board approval, then claim your API key. Save the claim response token to ~/.openclaw/workspace/rudder-claimed-api-key.json and load RUDDER_API_KEY from that file before starting heartbeat loops. You MUST submit agentRuntimeType='openclaw_gateway', set agentDefaultsPayload.url to your ws:// or wss:// OpenClaw gateway endpoint, and include agentDefaultsPayload.headers.x-openclaw-token (or legacy x-openclaw-auth).",
      inviteMessage: extractInviteMessage(invite),
      recommendedAdapterType: "openclaw_gateway",
      requiredFields: {
        requestType: "agent",
        agentName: "Display name for this agent",
        agentRuntimeType: "Use 'openclaw_gateway' for OpenClaw Gateway agents",
        capabilities: "Optional capability summary",
        agentDefaultsPayload:
          "Adapter config for OpenClaw gateway. MUST include url (ws:// or wss://) and headers.x-openclaw-token (or legacy x-openclaw-auth). Optional fields: rudderApiUrl, waitTimeoutMs, sessionKeyStrategy, sessionKey, role, scopes, disableDeviceAuth, devicePrivateKeyPem."
      },
      registrationEndpoint: {
        method: "POST",
        path: registrationEndpointPath,
        url: registrationEndpointUrl
      },
      claimEndpointTemplate: {
        method: "POST",
        path: "/api/join-requests/{requestId}/claim-api-key",
        body: {
          claimSecret:
            "one-time claim secret returned when the join request is created"
        }
      },
      connectivity: {
        deploymentMode: opts.deploymentMode,
        deploymentExposure: opts.deploymentExposure,
        bindHost: opts.bindHost,
        allowedHostnames: opts.allowedHostnames,
        connectionCandidates,
        diagnostics: discoveryDiagnostics,
        guidance:
          opts.deploymentMode === "authenticated" &&
          opts.deploymentExposure === "private"
            ? "If OpenClaw runs on another machine, ensure the Rudder hostname is reachable and allowed via `pnpm rudder allowed-hostname <host>`."
            : "Ensure OpenClaw can reach this Rudder API base URL for invite, claim, and skill bootstrap calls."
      },
      textInstructions: {
        path: onboardingTextPath,
        url: onboardingTextUrl,
        contentType: "text/plain"
      },
      skill: {
        name: "rudder",
        path: skillPath,
        url: skillUrl,
        installPath: "~/.openclaw/skills/rudder/SKILL.md"
      }
    }
  };
}

export function buildInviteOnboardingTextDocument(
  req: Request,
  token: string,
  invite: typeof invites.$inferSelect,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const manifest = buildInviteOnboardingManifest(req, token, invite, opts);
  const onboarding = manifest.onboarding as {
    inviteMessage?: string | null;
    registrationEndpoint: { method: string; path: string; url: string };
    claimEndpointTemplate: { method: string; path: string };
    textInstructions: { path: string; url: string };
    skill: { path: string; url: string; installPath: string };
    connectivity: {
      diagnostics?: JoinDiagnostic[];
      guidance?: string;
      connectionCandidates?: string[];
      testResolutionEndpoint?: { method?: string; path?: string; url?: string };
    };
  };
  const diagnostics = Array.isArray(onboarding.connectivity?.diagnostics)
    ? onboarding.connectivity.diagnostics
    : [];

  const lines: string[] = [];
  const appendBlock = (block: string) => {
    const trimmed = block.replace(/^\n/, "").replace(/\n\s*$/, "");
    const lineIndentation = trimmed
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.match(/^(\s*)/)?.[0].length ?? 0);
    const minIndent =
      lineIndentation.length > 0 ? Math.min(...lineIndentation) : 0;
    for (const line of trimmed.split("\n")) {
      lines.push(line.slice(minIndent));
    }
  };

  appendBlock(`
    # Rudder OpenClaw Gateway Onboarding

    This document is meant to be readable by both humans and agents.

    ## Invite
    - inviteType: ${invite.inviteType}
    - allowedJoinTypes: ${invite.allowedJoinTypes}
    - expiresAt: ${invite.expiresAt.toISOString()}
  `);

  if (onboarding.inviteMessage) {
    appendBlock(`
      ## Message from inviter
      ${onboarding.inviteMessage}
    `);
  }

  appendBlock(`
    ## Step 0

    Get the OpenClaw gateway auth token (THIS MUST BE SENT)
    Token lives in:

    ~/.openclaw/openclaw.json -> gateway.auth.token
    Extract:

    TOKEN="$(node -p 'require(process.env.HOME+\"/.openclaw/openclaw.json\").gateway.auth.token')"
    test -n "$TOKEN" || (echo "Missing TOKEN" && exit 1)
    test "\${#TOKEN}" -ge 16 || (echo "Gateway token unexpectedly short (\${#TOKEN})" && exit 1)

    3) IMPORTANT: Don't accidentally drop the token when generating JSON
    If you build JSON with Node, pass the token explicitly (argv), don't rely on an un-exported env var.

    Safe payload build looks sort of like this (substitute where necessary):

    BODY="$(node -e '
      const token = process.argv[1];
      if (!token) process.exit(2);
      const body = {
        requestType: "agent",
        agentName: "OpenClaw",
        agentRuntimeType: "openclaw_gateway",
        capabilities: "OpenClaw agent adapter",
        agentDefaultsPayload: {
          url: "ws://127.0.0.1:18789",
          rudderApiUrl: "http://host.docker.internal:3100",
          headers: { "x-openclaw-token": token },
          waitTimeoutMs: 120000,
          sessionKeyStrategy: "issue",
          role: "operator",
          scopes: ["operator.admin"]
        }
      };
      process.stdout.write(JSON.stringify(body));
    ' "$TOKEN")"

    ## Step 1: Submit agent join request
    ${onboarding.registrationEndpoint.method} ${
    onboarding.registrationEndpoint.url
  }

    IMPORTANT: You MUST include agentDefaultsPayload.headers.x-openclaw-token with your gateway token.
    Legacy x-openclaw-auth is also accepted, but x-openclaw-token is preferred.
    Use agentRuntimeType "openclaw_gateway" and a ws:// or wss:// gateway URL.
    Pairing mode requirement:
    - Keep device auth enabled (recommended). If devicePrivateKeyPem is omitted, Rudder generates and persists one during join so pairing approvals are stable.
    - You may set disableDeviceAuth=true only for special environments that cannot support pairing.
    - First run may return "pairing required" once; approve the pending pairing request in OpenClaw, then retry.
    Do NOT use /v1/responses or /hooks/* in this gateway join flow.

    Body (JSON):
    {
      "requestType": "agent",
      "agentName": "My OpenClaw Agent",
      "agentRuntimeType": "openclaw_gateway",
      "capabilities": "Optional summary",
      "agentDefaultsPayload": {
        "url": "wss://your-openclaw-gateway.example",
        "rudderApiUrl": "https://rudder-hostname-your-agent-can-reach:3100",
        "headers": { "x-openclaw-token": "replace-me" },
        "waitTimeoutMs": 120000,
        "sessionKeyStrategy": "issue",
        "role": "operator",
        "scopes": ["operator.admin"]
      }
    }

    Expected response includes:
    - request id
    - one-time claimSecret
    - claimApiKeyPath

    ## Step 2: Wait for board approval
    The board approves the join request in Rudder before key claim is allowed.

    ## Step 3: Claim API key (one-time)
    ${
      onboarding.claimEndpointTemplate.method
    } /api/join-requests/{requestId}/claim-api-key

    Body (JSON):
    {
      "claimSecret": "<one-time-claim-secret>"
    }

    On successful claim, save the full JSON response to:

    - ~/.openclaw/workspace/rudder-claimed-api-key.json
    chmod 600 ~/.openclaw/workspace/rudder-claimed-api-key.json

    And set the RUDDER_API_KEY and RUDDER_API_URL in your environment variables as specified here:
    https://docs.openclaw.ai/help/environment

    e.g. 

    {
      env: {
        RUDDER_API_KEY: "...",
        RUDDER_API_URL: "...",
      },
    }

    Then set RUDDER_API_KEY and RUDDER_API_URL from the saved token field for every heartbeat run.

    Important:
    - claim secrets expire
    - claim secrets are single-use
    - claim fails before board approval

    ## Step 4: Install Rudder skill in OpenClaw
    GET ${onboarding.skill.url}
    Install path: ${onboarding.skill.installPath}

    Be sure to prepend your RUDDER_API_URL to the top of your skill and note the path to your RUDDER_API_URL

    ## Text onboarding URL
    ${onboarding.textInstructions.url}

    ## Connectivity guidance
    ${
      onboarding.connectivity?.guidance ??
      "Ensure Rudder is reachable from your OpenClaw runtime."
    }
  `);

  const connectionCandidates = Array.isArray(
    onboarding.connectivity?.connectionCandidates
  )
    ? onboarding.connectivity.connectionCandidates.filter(
        (entry): entry is string => Boolean(entry)
      )
    : [];

  if (connectionCandidates.length > 0) {
    lines.push("## Suggested Rudder base URLs to try");
    for (const candidate of connectionCandidates) {
      lines.push(`- ${candidate}`);
    }
    appendBlock(`

      Test each candidate with:
      - GET <candidate>/api/health
      - set the first reachable candidate as agentDefaultsPayload.rudderApiUrl when submitting your join request

      If none are reachable: ask your human operator for a reachable hostname/address and help them update network configuration.
      For authenticated/private mode, they may need:
      - pnpm rudder allowed-hostname <host>
      - then restart Rudder and retry onboarding.
    `);
  }

  if (diagnostics.length > 0) {
    lines.push("## Connectivity diagnostics");
    for (const diag of diagnostics) {
      lines.push(`- [${diag.level}] ${diag.message}`);
      if (diag.hint) lines.push(`  hint: ${diag.hint}`);
    }
  }

  appendBlock(`

    ## Helpful endpoints
    ${onboarding.registrationEndpoint.path}
    ${onboarding.claimEndpointTemplate.path}
    ${onboarding.skill.path}
    ${manifest.invite.onboardingPath}
  `);

  return `${lines.join("\n")}\n`;
}

export function extractInviteMessage(
  invite: typeof invites.$inferSelect
): string | null {
  const rawDefaults = invite.defaultsPayload;
  if (
    !rawDefaults ||
    typeof rawDefaults !== "object" ||
    Array.isArray(rawDefaults)
  ) {
    return null;
  }
  const rawMessage = (rawDefaults as Record<string, unknown>).agentMessage;
  if (typeof rawMessage !== "string") {
    return null;
  }
  const trimmed = rawMessage.trim();
  return trimmed.length ? trimmed : null;
}

export function mergeInviteDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  agentMessage: string | null
): Record<string, unknown> | null {
  const merged =
    defaultsPayload && typeof defaultsPayload === "object"
      ? { ...defaultsPayload }
      : {};
  if (agentMessage) {
    merged.agentMessage = agentMessage;
  }
  return Object.keys(merged).length ? merged : null;
}

export function requestIp(req: Request) {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip || "unknown";
}

export function inviteExpired(invite: typeof invites.$inferSelect) {
  return invite.expiresAt.getTime() <= Date.now();
}

export function isLocalImplicit(req: Request) {
  return req.actor.type === "board" && req.actor.source === "local_implicit";
}

export async function resolveActorEmail(db: Db, req: Request): Promise<string | null> {
  if (isLocalImplicit(req)) return "local@rudder.local";
  const userId = req.actor.userId;
  if (!userId) return null;
  const user = await db
    .select({ email: authUsers.email })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .then((rows) => rows[0] ?? null);
  return user?.email ?? null;
}

export function grantsFromDefaults(
  defaultsPayload: Record<string, unknown> | null | undefined,
  key: "human" | "agent"
): Array<{
  permissionKey: (typeof PERMISSION_KEYS)[number];
  scope: Record<string, unknown> | null;
}> {
  if (!defaultsPayload || typeof defaultsPayload !== "object") return [];
  const scoped = defaultsPayload[key];
  if (!scoped || typeof scoped !== "object") return [];
  const grants = (scoped as Record<string, unknown>).grants;
  if (!Array.isArray(grants)) return [];
  const validPermissionKeys = new Set<string>(PERMISSION_KEYS);
  const result: Array<{
    permissionKey: (typeof PERMISSION_KEYS)[number];
    scope: Record<string, unknown> | null;
  }> = [];
  for (const item of grants) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.permissionKey !== "string") continue;
    if (!validPermissionKeys.has(record.permissionKey)) continue;
    result.push({
      permissionKey: record.permissionKey as (typeof PERMISSION_KEYS)[number],
      scope:
        record.scope &&
        typeof record.scope === "object" &&
        !Array.isArray(record.scope)
          ? (record.scope as Record<string, unknown>)
          : null
    });
  }
  return result;
}

export type JoinRequestManagerCandidate = {
  id: string;
  role: string;
  reportsTo: string | null;
};

export function resolveJoinRequestAgentManagerId(
  candidates: JoinRequestManagerCandidate[]
): string | null {
  const ceoCandidates = candidates.filter(
    (candidate) => candidate.role === "ceo"
  );
  if (ceoCandidates.length === 0) return null;
  const rootCeo = ceoCandidates.find(
    (candidate) => candidate.reportsTo === null
  );
  return (rootCeo ?? ceoCandidates[0] ?? null)?.id ?? null;
}

export function isInviteTokenHashCollisionError(error: unknown) {
  const candidates = [
    error,
    (error as { cause?: unknown } | null)?.cause ?? null
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const code =
      "code" in candidate && typeof candidate.code === "string"
        ? candidate.code
        : null;
    const message =
      "message" in candidate && typeof candidate.message === "string"
        ? candidate.message
        : "";
    const constraint =
      "constraint" in candidate && typeof candidate.constraint === "string"
        ? candidate.constraint
        : null;
    if (code !== "23505") continue;
    if (constraint === "invites_token_hash_unique_idx") return true;
    if (message.includes("invites_token_hash_unique_idx")) return true;
  }
  return false;
}

export function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

export type InviteResolutionProbe = {
  status: "reachable" | "timeout" | "unreachable";
  method: "HEAD";
  durationMs: number;
  httpStatus: number | null;
  message: string;
};

export async function probeInviteResolutionTarget(
  url: URL,
  timeoutMs: number
): Promise<InviteResolutionProbe> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal
    });
    const durationMs = Date.now() - startedAt;
    if (
      response.ok ||
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 405 ||
      response.status === 422 ||
      response.status === 500 ||
      response.status === 501
    ) {
      return {
        status: "reachable",
        method: "HEAD",
        durationMs,
        httpStatus: response.status,
        message: `Webhook endpoint responded to HEAD with HTTP ${response.status}.`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: response.status,
      message: `Webhook endpoint probe returned HTTP ${response.status}.`
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isAbortError(error)) {
      return {
        status: "timeout",
        method: "HEAD",
        durationMs,
        httpStatus: null,
        message: `Webhook endpoint probe timed out after ${timeoutMs}ms.`
      };
    }
    return {
      status: "unreachable",
      method: "HEAD",
      durationMs,
      httpStatus: null,
      message:
        error instanceof Error
          ? error.message
          : "Webhook endpoint probe failed."
    };
  } finally {
    clearTimeout(timeout);
  }
}


