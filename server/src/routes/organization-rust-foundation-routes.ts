import type { Db } from "@rudderhq/db";
import { updateOrganizationBrandingSchema, updateOrganizationSchema } from "@rudderhq/shared";
import { Router, type Request, type Response } from "express";
import { badRequest, conflict, forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  agentService,
  handoffOrganizationBrandingAuthority,
  logActivity,
  organizationMemberService,
  organizationService,
} from "../services/index.js";
import {
  RustFoundationBridgeError,
  type RustFoundationBridge,
  type RustFoundationMode,
  type RustFoundationResponse,
} from "../services/rust-foundation-bridge.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

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

export function assertOrganizationBrandingCreateAllowed(
  bridge: RustFoundationBridge | undefined,
  brandColor: unknown,
) {
  if (bridge?.organizationBrandingMode === "required" && brandColor != null) {
    throw conflict("Organization creation with brandColor is unavailable while Rust branding authority is required; create the organization first, then use the Rust branding endpoint");
  }
}

export async function handoffRequiredOrganizationBranding(
  db: Db,
  bridge: RustFoundationBridge | undefined,
  orgId: string,
) {
  if (bridge?.organizationBrandingMode === "required") {
    await handoffOrganizationBrandingAuthority(db, orgId);
  }
}

function sendRustResponse(res: Response, response: RustFoundationResponse) {
  res.status(response.status).set("Content-Type", response.contentType).end(response.body);
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
  options: OrganizationRouteOptions,
  resource: "member directory" | "organization branding" = "member directory",
) {
  const receipt: RustFoundationProbeReceipt = {
    ...input,
    requestId: req.header("x-rudder-request-id")?.trim() || null,
  };
  options.onRustFoundationProbe?.(receipt);
  logger.info({
    orgId: receipt.orgId,
    requestId: receipt.requestId,
    probe_mode: receipt.probeMode,
    rust_invoked: receipt.rustInvoked,
    response_authority: receipt.responseAuthority,
    fallback_reason: receipt.fallbackReason,
    old_authority: receipt.oldAuthority,
    old_authority_invoked: receipt.oldAuthorityInvoked,
    status: receipt.status,
  }, `Rust ${resource} bridge receipt`);
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

async function applyRustBranding(
  db: Db,
  orgService: ReturnType<typeof organizationService>,
  bridge: RustFoundationBridge | undefined,
  req: Request,
  orgId: string,
  options: OrganizationRouteOptions,
  requestPath = req.originalUrl,
) {
  if (!bridge) return { kind: "unavailable" as const, code: "bridge_missing" };
  try {
    // Start and prove the private Rust child before changing the durable owner.
    await bridge.start();
    await handoffOrganizationBrandingAuthority(db, orgId);
    const response = await bridge.organizationBranding(
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
    }, req, options, "organization branding");
    if (response.status < 200 || response.status >= 300) {
      return { kind: "response" as const, response };
    }
    const organization = await orgService.getById(orgId);
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
    }, req, options, "organization branding");
    return { kind: "unavailable" as const, code };
  }
}

function scalarBrandColorPatchOnly(body: Record<string, unknown>) {
  const keys = Object.keys(body);
  return keys.length === 1 && keys[0] === "brandColor";
}

function rustBrandingRequiredForRequest(req: Request, bridge: RustFoundationBridge | undefined) {
  return bridge?.organizationBrandingMode === "required"
    || req.header("x-rudder-required-authority")?.trim().toLowerCase() === "rust";
}

function requireBrandingIdempotencyKey(req: Request) {
  if (!req.header("x-rudder-idempotency-key")?.trim()) {
    throw badRequest("x-rudder-idempotency-key is required for Rust organization branding");
  }
}

async function assertCanUpdateBranding(
  req: Request,
  orgId: string,
  agents: ReturnType<typeof agentService>,
) {
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

export function registerOrganizationRustFoundationRoutes(
  router: Router,
  db: Db,
  bridge: RustFoundationBridge | undefined,
  options: OrganizationRouteOptions,
) {
  const organizations = organizationService(db);
  const agents = agentService(db);
  const members = organizationMemberService(db);

  router.get("/:orgId/members/directory", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const rawType = typeof req.query.type === "string" ? req.query.type.trim().toLowerCase() : "all";
    if (rawType !== "all" && rawType !== "human" && rawType !== "agent") {
      throw unprocessable("Member directory type must be all, human, or agent.");
    }
    const rawLimit = typeof req.query.limit === "string" && req.query.limit.trim()
      ? Number(req.query.limit)
      : undefined;

    let shadowResponse: RustFoundationResponse | null = null;
    if (bridge?.mode === "required") {
      try {
        const rustResponse = await bridge.memberDirectory(req, orgId);
        emitRustFoundationProbeReceipt({
          orgId,
          probeMode: "required",
          rustInvoked: true,
          responseAuthority: "rust",
          fallbackReason: null,
          oldAuthority: null,
          oldAuthorityInvoked: false,
          status: rustResponse.status,
        }, req, options);
        if (rustResponse.status >= 200 && rustResponse.status < 300) {
          sendRustResponse(res, rustResponse);
        } else {
          res.status(rustResponse.status).json(nodeErrorFromRustResponse(rustResponse));
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
        }, req, options);
        res.status(503).json({
          error: "Rust member directory is unavailable",
          code: "rust_foundation_member_directory_unavailable",
        });
      }
      return;
    }
    if (bridge?.mode === "shadow") {
      try {
        shadowResponse = await bridge.memberDirectory(req, orgId);
      } catch (error) {
        const code = error instanceof RustFoundationBridgeError ? error.code : "request_failed";
        logger.warn({ err: error, code, orgId }, "Rust member directory shadow request failed; serving Node result");
      }
    }

    const page = await members.list({
      orgId,
      query: typeof req.query.query === "string" ? req.query.query : null,
      type: rawType,
      limit: rawLimit,
      cursor: typeof req.query.cursor === "string" ? req.query.cursor : null,
      fullIds: req.query.fullIds === "true" || req.query.fullIds === "1",
    });
    if (bridge?.mode === "off") {
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "off",
        rustInvoked: false,
        responseAuthority: "node",
        fallbackReason: "mode_off",
        oldAuthority: "node",
        oldAuthorityInvoked: true,
        status: 200,
      }, req, options);
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
      }, req, options);
      if (!matches) {
        logger.warn(
          { orgId, status: shadowResponse.status, bodyBytes: shadowResponse.body.byteLength },
          "Rust member directory shadow response differed from Node result",
        );
      }
    } else if (bridge?.mode === "shadow") {
      emitRustFoundationProbeReceipt({
        orgId,
        probeMode: "shadow",
        rustInvoked: true,
        responseAuthority: "node",
        fallbackReason: "shadow_bridge_error",
        oldAuthority: "node",
        oldAuthorityInvoked: true,
        status: 200,
      }, req, options);
    }
    res.json(page);
  });

  router.patch("/:orgId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const actor = getActorInfo(req);
    let body: Record<string, unknown>;

    if (req.actor.type === "agent") {
      // Only CEO agents may update organization branding fields
      const agentSvc = agentService(db);
      const actorAgent = req.actor.agentId ? await agentSvc.getById(req.actor.agentId) : null;
      if (!actorAgent || actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents or board users may update organization settings");
      }
      if (actorAgent.orgId !== orgId) {
        throw forbidden("Agent key cannot access another organization");
      }
      body = updateOrganizationBrandingSchema.parse(req.body);
    } else {
      assertBoard(req);
      body = updateOrganizationSchema.parse(req.body);
    }

    if (rustBrandingRequiredForRequest(req, bridge) && Object.prototype.hasOwnProperty.call(body, "brandColor")) {
      if (!scalarBrandColorPatchOnly(body)) {
        throw conflict("Organization branding and non-branding updates must use separate requests while Rust branding authority is enabled");
      }
      if (bridge?.organizationBrandingMode !== "required") {
        res.status(503).json({
          error: "Rust organization branding is not enabled",
          code: "rust_foundation_organization_branding_disabled",
        });
        return;
      }
      requireBrandingIdempotencyKey(req);
      const result = await applyRustBranding(
        db,
        organizations,
        bridge,
        req,
        orgId,
        options,
        `/api/orgs/${encodeURIComponent(orgId)}/branding`,
      );
      if (result.kind === "organization") {
        res.json(result.organization);
      } else if (result.kind === "response") {
        res.status(result.response.status).json(nodeErrorFromRustResponse(result.response, "organization branding"));
      } else {
        res.status(503).json({
          error: "Rust organization branding is unavailable",
          code: `rust_foundation_organization_branding_${result.code}`,
        });
      }
      return;
    }

    const organization = await organizations.update(orgId, body);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "organization.updated",
      entityType: "organization",
      entityId: orgId,
      details: body,
    });
    res.json(organization);
  });

  router.patch("/:orgId/branding", validate(updateOrganizationBrandingSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCanUpdateBranding(req, orgId, agents);
    if (rustBrandingRequiredForRequest(req, bridge) && Object.prototype.hasOwnProperty.call(req.body, "brandColor")) {
      if (!scalarBrandColorPatchOnly(req.body)) {
        throw conflict("Only scalar brandColor updates are currently Rust-authoritative; migrate other branding fields separately");
      }
      if (bridge?.organizationBrandingMode !== "required") {
        res.status(503).json({
          error: "Rust organization branding is not enabled",
          code: "rust_foundation_organization_branding_disabled",
        });
        return;
      }
      requireBrandingIdempotencyKey(req);
      const result = await applyRustBranding(db, organizations, bridge, req, orgId, options);
      if (result.kind === "organization") {
        res.json(result.organization);
      } else if (result.kind === "response") {
        res.status(result.response.status).json(nodeErrorFromRustResponse(result.response, "organization branding"));
      } else {
        res.status(503).json({
          error: "Rust organization branding is unavailable",
          code: `rust_foundation_organization_branding_${result.code}`,
        });
      }
      return;
    }
    const organization = await organizations.update(orgId, req.body);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "organization.branding_updated",
      entityType: "organization",
      entityId: orgId,
      details: req.body,
    });
    res.json(organization);
  });
}
