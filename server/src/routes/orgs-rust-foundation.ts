import type { Db } from "@rudderhq/db";
import { Router, type Request, type Response } from "express";
import { badRequest, forbidden } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { handoffOrganizationBrandingAuthority } from "../services/organization-branding-fence.js";
import {
  normalizeOrganizationMemberDirectoryQuery,
  type OrganizationMemberDirectoryQuery,
} from "../services/organization-members.js";
import {
  RustFoundationBridgeError,
  type RustFoundationBridge,
  type RustFoundationMode,
  type RustFoundationResponse,
} from "../services/rust-foundation-bridge.js";
import { assertCompanyAccess } from "./authz.js";

export type RustFoundationProbeReceipt = {
  orgId: string;
  requestId: string | null;
  probeMode: RustFoundationMode;
  rustInvoked: boolean;
  responseAuthority: "rust" | "node" | "none";
  fallbackReason: string | null;
  oldAuthority: "node" | null;
  oldAuthorityInvoked: boolean;
  status: number | null;
};

export type OrganizationRouteOptions = {
  onRustFoundationProbe?: (receipt: RustFoundationProbeReceipt) => void;
};

type OrganizationRustServices = {
  svc: {
    getById(orgId: string): Promise<unknown>;
  };
  agents: {
    getById(agentId: string): Promise<{ orgId: string; role: string } | null>;
  };
  members: {
    list(input: OrganizationMemberDirectoryQuery & { orgId: string }): Promise<unknown>;
  };
};

export type OrganizationRustFoundationContext = OrganizationRustServices & {
  db: Db;
  rustFoundationBridge?: RustFoundationBridge;
  options: OrganizationRouteOptions;
};

export function createOrganizationRustFoundationHandlers(
  context: OrganizationRustFoundationContext,
) {
  const { db, svc, agents, members, rustFoundationBridge, options } = context;

  function sendRustResponse(res: Response, response: RustFoundationResponse) {
    res
      .status(response.status)
      .set("Content-Type", response.contentType)
      .end(response.body);
  }

  function canonicalizeJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalizeJson);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
  }

  function jsonBody(response: RustFoundationResponse) {
    try {
      return canonicalizeJson(JSON.parse(response.body.toString("utf8")));
    } catch {
      return null;
    }
  }

  function emitRustFoundationProbeReceipt(
    input: Omit<RustFoundationProbeReceipt, "requestId">,
    req: Request,
    resource: "member directory" | "organization branding" = "member directory",
  ) {
    const receipt: RustFoundationProbeReceipt = {
      ...input,
      requestId: req.header("x-rudder-request-id")?.trim() || null,
    };
    options.onRustFoundationProbe?.(receipt);
    logger.info(
      {
        orgId: receipt.orgId,
        requestId: receipt.requestId,
        probe_mode: receipt.probeMode,
        rust_invoked: receipt.rustInvoked,
        response_authority: receipt.responseAuthority,
        fallback_reason: receipt.fallbackReason,
        old_authority: receipt.oldAuthority,
        old_authority_invoked: receipt.oldAuthorityInvoked,
        status: receipt.status,
      },
      `Rust ${resource} bridge receipt`,
    );
  }

  function nodeErrorFromRustResponse(response: RustFoundationResponse, resource = "member directory") {
    const body = jsonBody(response);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const message = typeof record.error === "string"
        ? record.error
        : typeof record.reason === "string"
          ? record.reason
          : null;
      if (message) return { error: message };
    }
    return { error: `Rust ${resource} request failed` };
  }

  function nodeMemberDirectoryErrorFromRustResponse(response: RustFoundationResponse) {
    const body = jsonBody(response);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      const reason = typeof record.reason === "string" ? record.reason : null;
      if (reason === "member_directory_invalid_limit") {
        return { error: "'limit' must be between 1 and 100" };
      }
      if (reason === "member_directory_invalid_cursor") {
        return { error: "Invalid organization member cursor." };
      }
      if (reason === "member_directory_invalid_type") {
        return { error: "Member directory type must be all, human, or agent." };
      }
    }
    return nodeErrorFromRustResponse(response);
  }

  function memberDirectoryRequestPath(req: Request, query: OrganizationMemberDirectoryQuery) {
    const path = req.originalUrl.split("?", 1)[0] ?? req.originalUrl;
    const params = new URLSearchParams();
    params.set("type", query.type);
    if (query.query !== null) params.set("query", query.query);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.fullIds) params.set("fullIds", "true");
    return `${path}?${params.toString()}`;
  }

  async function applyRustBranding(req: Request, orgId: string, requestPath = req.originalUrl) {
    if (!rustFoundationBridge) {
      return { kind: "unavailable" as const, code: "bridge_missing" };
    }
    try {
      // Start and prove the private Rust child before changing the durable
      // owner. A failed start therefore cannot strand Node behind a fence.
      await rustFoundationBridge.start();
      await handoffOrganizationBrandingAuthority(db, orgId);
      const response = await rustFoundationBridge.organizationBranding(
        req,
        orgId,
        Buffer.from(JSON.stringify(req.body), "utf8"),
        requestPath,
      );
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "required",
        rustInvoked: true,
        responseAuthority: "rust",
        fallbackReason: null,
        oldAuthority: null,
        oldAuthorityInvoked: false,
        status: response.status,
      }, req, "organization branding");
      if (response.status < 200 || response.status >= 300) {
        return { kind: "response" as const, response };
      }
      const organization = await svc.getById(orgId);
      return organization
        ? { kind: "organization" as const, organization }
        : { kind: "response" as const, response: { ...response, status: 404 } };
    } catch (error) {
      const code = error instanceof RustFoundationBridgeError ? error.code : "request_failed";
      logger.error({ err: error, code, orgId }, "required Rust organization branding bridge failed");
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "required",
        rustInvoked: true,
        responseAuthority: "none",
        fallbackReason: `required_bridge_${code}`,
        oldAuthority: null,
        oldAuthorityInvoked: false,
        status: null,
      }, req, "organization branding");
      return { kind: "unavailable" as const, code };
    }
  }

  function scalarBrandColorPatchOnly(body: Record<string, unknown>) {
    const keys = Object.keys(body);
    return keys.length === 1 && keys[0] === "brandColor";
  }

  function rustBrandingRequiredForRequest(req: Request) {
    return rustFoundationBridge?.organizationBrandingMode === "required"
      || req.header("x-rudder-required-authority")?.trim().toLowerCase() === "rust";
  }

  function requireBrandingIdempotencyKey(req: Request) {
    if (!req.header("x-rudder-idempotency-key")?.trim()) {
      throw badRequest("x-rudder-idempotency-key is required for Rust organization branding");
    }
  }

  async function assertCanUpdateBranding(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") return;
    if (!req.actor.agentId) throw forbidden("Agent authentication required");

    const actorAgent = await agents.getById(req.actor.agentId);
    if (!actorAgent || actorAgent.orgId !== orgId) {
      throw forbidden("Agent key cannot access another organization");
    }
    if (actorAgent.role !== "ceo") {
      throw forbidden("Only CEO agents can update organization branding");
    }
  }

  async function serveMemberDirectory(
    req: Request,
    res: Response,
    orgId: string,
    query: OrganizationMemberDirectoryQuery,
  ) {
    const requestPath = memberDirectoryRequestPath(req, query);
    const mode = rustFoundationBridge?.mode;
    if (!rustFoundationBridge) {
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "required",
        rustInvoked: false,
        responseAuthority: "none",
        fallbackReason: "required_bridge_missing",
        oldAuthority: null,
        oldAuthorityInvoked: false,
        status: null,
      }, req, "member directory");
      res.status(503).json({
        error: "Rust member directory is unavailable",
        code: "rust_foundation_member_directory_unavailable",
      });
      return;
    }

    if (mode === "required") {
      try {
        const rustResponse = await rustFoundationBridge.memberDirectory(req, orgId, requestPath);
        emitRustFoundationProbeReceipt({
          orgId,
          probeMode: "required",
          rustInvoked: true,
          responseAuthority: "rust",
          fallbackReason: null,
          oldAuthority: null,
          oldAuthorityInvoked: false,
          status: rustResponse.status,
        }, req, "member directory");
        if (rustResponse.status >= 200 && rustResponse.status < 300) {
          sendRustResponse(res, rustResponse);
        } else {
          res.status(rustResponse.status).json(nodeMemberDirectoryErrorFromRustResponse(rustResponse));
        }
      } catch (error) {
        const code = error instanceof RustFoundationBridgeError ? error.code : "request_failed";
        logger.error({ err: error, code, orgId }, "required Rust member directory bridge failed");
        emitRustFoundationProbeReceipt({
          orgId,
          probeMode: "required",
          rustInvoked: true,
          responseAuthority: "none",
          fallbackReason: `required_bridge_${code}`,
          oldAuthority: null,
          oldAuthorityInvoked: false,
          status: null,
        }, req, "member directory");
        res.status(503).json({
          error: "Rust member directory is unavailable",
          code: "rust_foundation_member_directory_unavailable",
        });
      }
      return;
    }

    let shadowResponse: RustFoundationResponse | null = null;
    if (mode === "shadow") {
      try {
        shadowResponse = await rustFoundationBridge.memberDirectory(req, orgId, requestPath);
      } catch (error) {
        const code = error instanceof RustFoundationBridgeError ? error.code : "request_failed";
        logger.warn({ err: error, code, orgId }, "Rust member directory shadow request failed; serving Node result");
      }
    }

    const page = await members.list({ orgId, ...query });
    if (mode === "off") {
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "off",
        rustInvoked: false,
        responseAuthority: "node",
        fallbackReason: "mode_off",
        oldAuthority: "node",
        oldAuthorityInvoked: true,
        status: 200,
      }, req, "member directory");
    } else if (shadowResponse) {
      const matches = shadowResponse.status === 200
        && JSON.stringify(jsonBody(shadowResponse)) === JSON.stringify(canonicalizeJson(page));
      const shadowFallbackReason = shadowResponse.status < 200 || shadowResponse.status >= 300
        ? "shadow_non_success_response"
        : matches
          ? "shadow_probe_only"
          : "shadow_response_mismatch";
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "shadow",
        rustInvoked: true,
        responseAuthority: "node",
        fallbackReason: shadowFallbackReason,
        oldAuthority: "node",
        oldAuthorityInvoked: true,
        status: shadowResponse.status,
      }, req, "member directory");
      if (!matches) {
        logger.warn(
          { orgId, status: shadowResponse.status, bodyBytes: shadowResponse.body.byteLength },
          "Rust member directory shadow response differed from Node result",
        );
      }
    } else if (mode === "shadow") {
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "shadow",
        rustInvoked: true,
        responseAuthority: "node",
        fallbackReason: "shadow_bridge_error",
        oldAuthority: "node",
        oldAuthorityInvoked: true,
        status: 200,
      }, req, "member directory");
    }
    res.json(page);
  }

  function registerMemberDirectoryRoute(router: Router) {
    router.get("/:orgId/members/directory", async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      const query = normalizeOrganizationMemberDirectoryQuery(req.query as Record<string, unknown>);
      await serveMemberDirectory(req, res, orgId, query);
    });
  }

  return {
    applyRustBranding,
    assertCanUpdateBranding,
    nodeErrorFromRustResponse,
    registerMemberDirectoryRoute,
    requireBrandingIdempotencyKey,
    rustBrandingRequiredForRequest,
    scalarBrandColorPatchOnly,
  };
}
