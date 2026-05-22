import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Request } from "express";
import { and, eq, isNull, desc } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import {
  agentApiKeys,
  authUsers,
  invites,
  joinRequests
} from "@rudderhq/db";
import {
  acceptInviteSchema,
  createCliAuthChallengeSchema,
  claimJoinRequestApiKeySchema,
  createCompanyInviteSchema,
  createOpenClawInvitePromptSchema,
  listJoinRequestsQuerySchema,
  resolveCliAuthChallengeSchema,
  updateMemberPermissionsSchema,
  updateUserCompanyAccessSchema,
  PERMISSION_KEYS
} from "@rudderhq/shared";
import type { DeploymentExposure, DeploymentMode } from "@rudderhq/shared";
import {
  forbidden,
  conflict,
  notFound,
  unauthorized,
  badRequest
} from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  agentService,
  boardAuthService,
  deduplicateAgentName,
  logActivity,
  notifyHireApproved
} from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import {
  claimBoardOwnership,
  inspectBoardClaimChallenge
} from "../board-claim.js";
import { hashToken, INVITE_TOKEN_PREFIX, INVITE_TOKEN_ALPHABET, INVITE_TOKEN_SUFFIX_LENGTH, INVITE_TOKEN_MAX_RETRIES, COMPANY_INVITE_TTL_MS, createInviteToken, createClaimSecret, companyInviteExpiresAt, tokenHashesMatch, requestBaseUrl, buildCliAuthApprovalPath, readSkillMarkdown, resolveRudderSkillsDir, parseSkillFrontmatter, AvailableSkill, listAvailableSkills, toJoinRequestResponse, JoinDiagnostic, isPlainObject, isLoopbackHost, normalizeHostname, normalizeHeaderValue, extractHeaderEntries, normalizeHeaderMap, nonEmptyTrimmedString, headerMapHasKeyIgnoreCase, headerMapGetIgnoreCase, tokenFromAuthorizationHeader, parseBooleanLike, generateEd25519PrivateKeyPem, buildJoinDefaultsPayloadForAccept, mergeJoinDefaultsPayloadForReplay, canReplayOpenClawGatewayInviteAccept, summarizeSecretForLog, summarizeOpenClawGatewayDefaultsForLog } from "./access.helpers.js";
import { normalizeAgentDefaultsForJoin, toInviteSummaryResponse, buildOnboardingDiscoveryDiagnostics, buildOnboardingConnectionCandidates, buildInviteOnboardingManifest, buildInviteOnboardingTextDocument, extractInviteMessage, mergeInviteDefaults, requestIp, inviteExpired, isLocalImplicit, resolveActorEmail, grantsFromDefaults, JoinRequestManagerCandidate, resolveJoinRequestAgentManagerId, isInviteTokenHashCollisionError, isAbortError, InviteResolutionProbe, probeInviteResolutionTarget } from "./access-onboarding.helpers.js";
export { companyInviteExpiresAt, buildJoinDefaultsPayloadForAccept, mergeJoinDefaultsPayloadForReplay, canReplayOpenClawGatewayInviteAccept } from "./access.helpers.js";
export { normalizeAgentDefaultsForJoin, buildInviteOnboardingTextDocument, resolveJoinRequestAgentManagerId } from "./access-onboarding.helpers.js";

export function accessRoutes(
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    bindHost: string;
    allowedHostnames: string[];
  }
) {
  const router = Router();
  const access = accessService(db);
  const boardAuth = boardAuthService(db);
  const agents = agentService(db);

  async function assertInstanceAdmin(req: Request) {
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.isInstanceAdmin(req.actor.userId);
    if (!allowed) throw forbidden("Instance admin required");
  }

  router.get("/board-claim/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.query.code === "string" ? req.query.code.trim() : undefined;
    if (!token) throw notFound("Board claim challenge not found");
    const challenge = inspectBoardClaimChallenge(token, code);
    if (challenge.status === "invalid")
      throw notFound("Board claim challenge not found");
    res.json(challenge);
  });

  router.post("/board-claim/:token/claim", async (req, res) => {
    const token = (req.params.token as string).trim();
    const code =
      typeof req.body?.code === "string" ? req.body.code.trim() : undefined;
    if (!token) throw notFound("Board claim challenge not found");
    if (!code) throw badRequest("Claim code is required");
    if (
      req.actor.type !== "board" ||
      req.actor.source !== "session" ||
      !req.actor.userId
    ) {
      throw unauthorized("Sign in before claiming board ownership");
    }

    const claimed = await claimBoardOwnership(db, {
      token,
      code,
      userId: req.actor.userId
    });

    if (claimed.status === "invalid")
      throw notFound("Board claim challenge not found");
    if (claimed.status === "expired")
      throw conflict(
        "Board claim challenge expired. Restart server to generate a new one."
      );
    if (claimed.status === "claimed") {
      res.json({
        claimed: true,
        userId: claimed.claimedByUserId ?? req.actor.userId
      });
      return;
    }

    throw conflict("Board claim challenge is no longer available");
  });

  router.post(
    "/cli-auth/challenges",
    validate(createCliAuthChallengeSchema),
    async (req, res) => {
      const created = await boardAuth.createCliAuthChallenge(req.body);
      const approvalPath = buildCliAuthApprovalPath(
        created.challenge.id,
        created.challengeSecret,
      );
      const baseUrl = requestBaseUrl(req);
      res.status(201).json({
        id: created.challenge.id,
        token: created.challengeSecret,
        boardApiToken: created.pendingBoardToken,
        approvalPath,
        approvalUrl: baseUrl ? `${baseUrl}${approvalPath}` : null,
        pollPath: `/cli-auth/challenges/${created.challenge.id}`,
        expiresAt: created.challenge.expiresAt.toISOString(),
        suggestedPollIntervalMs: 1000,
      });
    },
  );

  router.get("/cli-auth/challenges/:id", async (req, res) => {
    const id = (req.params.id as string).trim();
    const token =
      typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!id || !token) throw notFound("CLI auth challenge not found");
    const challenge = await boardAuth.describeCliAuthChallenge(id, token);
    if (!challenge) throw notFound("CLI auth challenge not found");

    const isSignedInBoardUser =
      req.actor.type === "board" &&
      (req.actor.source === "session" || isLocalImplicit(req)) &&
      Boolean(req.actor.userId);
    const canApprove =
      isSignedInBoardUser &&
      (challenge.requestedAccess !== "instance_admin_required" ||
        isLocalImplicit(req) ||
        Boolean(req.actor.isInstanceAdmin));

    res.json({
      ...challenge,
      requiresSignIn: !isSignedInBoardUser,
      canApprove,
      currentUserId: req.actor.type === "board" ? req.actor.userId ?? null : null,
    });
  });

  router.post(
    "/cli-auth/challenges/:id/approve",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      if (
        req.actor.type !== "board" ||
        (!req.actor.userId && !isLocalImplicit(req))
      ) {
        throw unauthorized("Sign in before approving CLI access");
      }

      const userId = req.actor.userId ?? "local-board";
      const approved = await boardAuth.approveCliAuthChallenge(
        id,
        req.body.token,
        userId,
      );

      if (approved.status === "approved") {
        const orgIds = await boardAuth.resolveBoardActivityCompanyIds({
          userId,
          requestedCompanyId: approved.challenge.requestedCompanyId,
          boardApiKeyId: approved.challenge.boardApiKeyId,
        });
        for (const orgId of orgIds) {
          await logActivity(db, {
            orgId,
            actorType: "user",
            actorId: userId,
            action: "board_api_key.created",
            entityType: "user",
            entityId: userId,
            details: {
              boardApiKeyId: approved.challenge.boardApiKeyId,
              requestedAccess: approved.challenge.requestedAccess,
              requestedCompanyId: approved.challenge.requestedCompanyId,
              challengeId: approved.challenge.id,
            },
          });
        }
      }

      res.json({
        approved: approved.status === "approved",
        status: approved.status,
        userId,
        keyId: approved.challenge.boardApiKeyId ?? null,
        expiresAt: approved.challenge.expiresAt.toISOString(),
      });
    },
  );

  router.post(
    "/cli-auth/challenges/:id/cancel",
    validate(resolveCliAuthChallengeSchema),
    async (req, res) => {
      const id = (req.params.id as string).trim();
      const cancelled = await boardAuth.cancelCliAuthChallenge(id, req.body.token);
      res.json({
        status: cancelled.status,
        cancelled: cancelled.status === "cancelled",
      });
    },
  );

  router.get("/cli-auth/me", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("Board authentication required");
    }
    const accessSnapshot = await boardAuth.resolveBoardAccess(req.actor.userId);
    res.json({
      user: accessSnapshot.user,
      userId: req.actor.userId,
      isInstanceAdmin: accessSnapshot.isInstanceAdmin || isLocalImplicit(req),
      orgIds: accessSnapshot.orgIds,
      source: req.actor.source ?? "none",
      keyId: req.actor.source === "board_key" ? req.actor.keyId ?? null : null,
    });
  });

  router.post("/cli-auth/revoke-current", async (req, res) => {
    if (req.actor.type !== "board" || req.actor.source !== "board_key") {
      throw badRequest("Current board API key context is required");
    }
    const key = await boardAuth.assertCurrentBoardKey(
      req.actor.keyId,
      req.actor.userId,
    );
    await boardAuth.revokeBoardApiKey(key.id);
    const orgIds = await boardAuth.resolveBoardActivityCompanyIds({
      userId: key.userId,
      boardApiKeyId: key.id,
    });
    for (const orgId of orgIds) {
      await logActivity(db, {
        orgId,
        actorType: "user",
        actorId: key.userId,
        action: "board_api_key.revoked",
        entityType: "user",
        entityId: key.userId,
        details: {
          boardApiKeyId: key.id,
          revokedVia: "cli_auth_logout",
        },
      });
    }
    res.json({ revoked: true, keyId: key.id });
  });

  async function assertCompanyPermission(
    req: Request,
    orgId: string,
    permissionKey: any
  ) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden();
      const allowed = await access.hasPermission(
        orgId,
        "agent",
        req.actor.agentId,
        permissionKey
      );
      if (!allowed) throw forbidden("Permission denied");
      return;
    }
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.canUser(
      orgId,
      req.actor.userId,
      permissionKey
    );
    if (!allowed) throw forbidden("Permission denied");
  }

  async function assertCanGenerateOpenClawInvitePrompt(
    req: Request,
    orgId: string
  ) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const actorAgent = await agents.getById(req.actor.agentId);
      if (!actorAgent || actorAgent.orgId !== orgId) {
        throw forbidden("Agent key cannot access another organization");
      }
      if (actorAgent.role !== "ceo") {
        throw forbidden("Only CEO agents can generate OpenClaw invite prompts");
      }
      return;
    }
    if (req.actor.type !== "board") throw unauthorized();
    if (isLocalImplicit(req)) return;
    const allowed = await access.canUser(orgId, req.actor.userId, "users:invite");
    if (!allowed) throw forbidden("Permission denied");
  }

  async function createCompanyInviteForCompany(input: {
    req: Request;
    orgId: string;
    allowedJoinTypes: "human" | "agent" | "both";
    defaultsPayload?: Record<string, unknown> | null;
    agentMessage?: string | null;
  }) {
    const normalizedAgentMessage =
      typeof input.agentMessage === "string"
        ? input.agentMessage.trim() || null
        : null;
    const insertValues = {
      orgId: input.orgId,
      inviteType: "company_join" as const,
      allowedJoinTypes: input.allowedJoinTypes,
      defaultsPayload: mergeInviteDefaults(
        input.defaultsPayload ?? null,
        normalizedAgentMessage
      ),
      expiresAt: companyInviteExpiresAt(),
      invitedByUserId: input.req.actor.userId ?? null
    };

    let token: string | null = null;
    let created: typeof invites.$inferSelect | null = null;
    for (let attempt = 0; attempt < INVITE_TOKEN_MAX_RETRIES; attempt += 1) {
      const candidateToken = createInviteToken();
      try {
        const row = await db
          .insert(invites)
          .values({
            ...insertValues,
            tokenHash: hashToken(candidateToken)
          })
          .returning()
          .then((rows) => rows[0]);
        token = candidateToken;
        created = row;
        break;
      } catch (error) {
        if (!isInviteTokenHashCollisionError(error)) {
          throw error;
        }
      }
    }
    if (!token || !created) {
      throw conflict("Failed to generate a unique invite token. Please retry.");
    }

    return { token, created, normalizedAgentMessage };
  }

  router.get("/skills/available", (_req, res) => {
    res.json({ skills: listAvailableSkills() });
  });

  router.get("/skills/index", (_req, res) => {
    res.json({
      skills: [
        { name: "rudder", path: "/api/skills/rudder" },
        {
          name: "para-memory-files",
          path: "/api/skills/para-memory-files"
        },
        {
          name: "rudder-create-agent",
          path: "/api/skills/rudder-create-agent"
        }
      ]
    });
  });

  router.get("/skills/:skillName", (req, res) => {
    const skillName = (req.params.skillName as string).trim().toLowerCase();
    const markdown = readSkillMarkdown(skillName);
    if (!markdown) throw notFound("Skill not found");
    res.type("text/markdown").send(markdown);
  });

  router.post(
    "/orgs/:orgId/invites",
    validate(createCompanyInviteSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCompanyPermission(req, orgId, "users:invite");
      const { token, created, normalizedAgentMessage } =
        await createCompanyInviteForCompany({
          req,
          orgId,
          allowedJoinTypes: req.body.allowedJoinTypes,
          defaultsPayload: req.body.defaultsPayload ?? null,
          agentMessage: req.body.agentMessage ?? null
        });

      await logActivity(db, {
        orgId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const inviteSummary = toInviteSummaryResponse(req, token, created);
      res.status(201).json({
        ...created,
        token,
        inviteUrl: `/invite/${token}`,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.post(
    "/orgs/:orgId/openclaw/invite-prompt",
    validate(createOpenClawInvitePromptSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanGenerateOpenClawInvitePrompt(req, orgId);
      const { token, created, normalizedAgentMessage } =
        await createCompanyInviteForCompany({
          req,
          orgId,
          allowedJoinTypes: "agent",
          defaultsPayload: null,
          agentMessage: req.body.agentMessage ?? null
        });

      await logActivity(db, {
        orgId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.openclaw_prompt_created",
        entityType: "invite",
        entityId: created.id,
        details: {
          inviteType: created.inviteType,
          allowedJoinTypes: created.allowedJoinTypes,
          expiresAt: created.expiresAt.toISOString(),
          hasAgentMessage: Boolean(normalizedAgentMessage)
        }
      });

      const inviteSummary = toInviteSummaryResponse(req, token, created);
      res.status(201).json({
        ...created,
        token,
        inviteUrl: `/invite/${token}`,
        onboardingTextPath: inviteSummary.onboardingTextPath,
        onboardingTextUrl: inviteSummary.onboardingTextUrl,
        inviteMessage: inviteSummary.inviteMessage
      });
    }
  );

  router.get("/invites/:token", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (
      !invite ||
      invite.revokedAt ||
      invite.acceptedAt ||
      inviteExpired(invite)
    ) {
      throw notFound("Invite not found");
    }

    res.json(toInviteSummaryResponse(req, token, invite));
  });

  router.get("/invites/:token/onboarding", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    res.json(buildInviteOnboardingManifest(req, token, invite, opts));
  });

  router.get("/invites/:token/onboarding.txt", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    res
      .type("text/plain; charset=utf-8")
      .send(buildInviteOnboardingTextDocument(req, token, invite, opts));
  });

  router.get("/invites/:token/test-resolution", async (req, res) => {
    const token = (req.params.token as string).trim();
    if (!token) throw notFound("Invite not found");
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.tokenHash, hashToken(token)))
      .then((rows) => rows[0] ?? null);
    if (!invite || invite.revokedAt || inviteExpired(invite)) {
      throw notFound("Invite not found");
    }

    const rawUrl =
      typeof req.query.url === "string" ? req.query.url.trim() : "";
    if (!rawUrl) throw badRequest("url query parameter is required");
    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      throw badRequest("url must be an absolute http(s) URL");
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw badRequest("url must use http or https");
    }

    const parsedTimeoutMs =
      typeof req.query.timeoutMs === "string"
        ? Number(req.query.timeoutMs)
        : NaN;
    const timeoutMs = Number.isFinite(parsedTimeoutMs)
      ? Math.max(1000, Math.min(15000, Math.floor(parsedTimeoutMs)))
      : 5000;
    const probe = await probeInviteResolutionTarget(target, timeoutMs);
    res.json({
      inviteId: invite.id,
      testResolutionPath: `/api/invites/${token}/test-resolution`,
      requestedUrl: target.toString(),
      timeoutMs,
      ...probe
    });
  });

  router.post(
    "/invites/:token/accept",
    validate(acceptInviteSchema),
    async (req, res) => {
      const token = (req.params.token as string).trim();
      if (!token) throw notFound("Invite not found");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.tokenHash, hashToken(token)))
        .then((rows) => rows[0] ?? null);
      if (!invite || invite.revokedAt || inviteExpired(invite)) {
        throw notFound("Invite not found");
      }
      const inviteAlreadyAccepted = Boolean(invite.acceptedAt);
      const existingJoinRequestForInvite = inviteAlreadyAccepted
        ? await db
            .select()
            .from(joinRequests)
            .where(eq(joinRequests.inviteId, invite.id))
            .then((rows) => rows[0] ?? null)
        : null;

      if (invite.inviteType === "bootstrap_ceo") {
        if (inviteAlreadyAccepted) throw notFound("Invite not found");
        if (req.body.requestType !== "human") {
          throw badRequest("Bootstrap invite requires human request type");
        }
        if (
          req.actor.type !== "board" ||
          (!req.actor.userId && !isLocalImplicit(req))
        ) {
          throw unauthorized(
            "Authenticated user required for bootstrap acceptance"
          );
        }
        const userId = req.actor.userId ?? "local-board";
        const existingAdmin = await access.isInstanceAdmin(userId);
        if (!existingAdmin) {
          await access.promoteInstanceAdmin(userId);
        }
        const updatedInvite = await db
          .update(invites)
          .set({ acceptedAt: new Date(), updatedAt: new Date() })
          .where(eq(invites.id, invite.id))
          .returning()
          .then((rows) => rows[0] ?? invite);
        res.status(202).json({
          inviteId: updatedInvite.id,
          inviteType: updatedInvite.inviteType,
          bootstrapAccepted: true,
          userId
        });
        return;
      }

      const requestType = req.body.requestType as "human" | "agent";
      const orgId = invite.orgId;
      if (!orgId) throw conflict("Invite is missing organization scope");
      if (
        invite.allowedJoinTypes !== "both" &&
        invite.allowedJoinTypes !== requestType
      ) {
        throw badRequest(`Invite does not allow ${requestType} joins`);
      }

      if (requestType === "human" && req.actor.type !== "board") {
        throw unauthorized(
          "Human invite acceptance requires authenticated user"
        );
      }
      if (
        requestType === "human" &&
        !req.actor.userId &&
        !isLocalImplicit(req)
      ) {
        throw unauthorized("Authenticated user is required");
      }
      if (requestType === "agent" && !req.body.agentName) {
        if (
          !inviteAlreadyAccepted ||
          !existingJoinRequestForInvite?.agentName
        ) {
          throw badRequest("agentName is required for agent join requests");
        }
      }

      const agentRuntimeType = req.body.agentRuntimeType ?? null;
      if (
        inviteAlreadyAccepted &&
        !canReplayOpenClawGatewayInviteAccept({
          requestType,
          agentRuntimeType,
          existingJoinRequest: existingJoinRequestForInvite
        })
      ) {
        throw notFound("Invite not found");
      }
      const replayJoinRequestId = inviteAlreadyAccepted
        ? existingJoinRequestForInvite?.id ?? null
        : null;
      if (inviteAlreadyAccepted && !replayJoinRequestId) {
        throw conflict("Join request not found");
      }

      const replayMergedDefaults = inviteAlreadyAccepted
        ? mergeJoinDefaultsPayloadForReplay(
            existingJoinRequestForInvite?.agentDefaultsPayload ?? null,
            req.body.agentDefaultsPayload ?? null
          )
        : req.body.agentDefaultsPayload ?? null;

      const gatewayDefaultsPayload =
        requestType === "agent"
          ? buildJoinDefaultsPayloadForAccept({
              agentRuntimeType,
              defaultsPayload: replayMergedDefaults,
              rudderApiUrl: req.body.rudderApiUrl ?? null,
              inboundOpenClawAuthHeader: req.header("x-openclaw-auth") ?? null,
              inboundOpenClawTokenHeader: req.header("x-openclaw-token") ?? null
            })
          : null;

      const joinDefaults =
        requestType === "agent"
          ? normalizeAgentDefaultsForJoin({
              agentRuntimeType,
              defaultsPayload: gatewayDefaultsPayload,
              deploymentMode: opts.deploymentMode,
              deploymentExposure: opts.deploymentExposure,
              bindHost: opts.bindHost,
              allowedHostnames: opts.allowedHostnames
            })
          : {
              normalized: null as Record<string, unknown> | null,
              diagnostics: [] as JoinDiagnostic[],
              fatalErrors: [] as string[]
            };

      if (requestType === "agent" && joinDefaults.fatalErrors.length > 0) {
        throw badRequest(joinDefaults.fatalErrors.join("; "));
      }

      if (requestType === "agent" && agentRuntimeType === "openclaw_gateway") {
        logger.info(
          {
            inviteId: invite.id,
            joinRequestDiagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level
            })),
            normalizedAgentDefaults: summarizeOpenClawGatewayDefaultsForLog(
              joinDefaults.normalized
            )
          },
          "invite accept normalized OpenClaw gateway defaults"
        );
      }

      const claimSecret =
        requestType === "agent" && !inviteAlreadyAccepted
          ? createClaimSecret()
          : null;
      const claimSecretHash = claimSecret ? hashToken(claimSecret) : null;
      const claimSecretExpiresAt = claimSecret
        ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        : null;

      const actorEmail =
        requestType === "human" ? await resolveActorEmail(db, req) : null;
      const created = !inviteAlreadyAccepted
        ? await db.transaction(async (tx) => {
            await tx
              .update(invites)
              .set({ acceptedAt: new Date(), updatedAt: new Date() })
              .where(
                and(
                  eq(invites.id, invite.id),
                  isNull(invites.acceptedAt),
                  isNull(invites.revokedAt)
                )
              );

            const row = await tx
              .insert(joinRequests)
              .values({
                inviteId: invite.id,
                orgId,
                requestType,
                status: "pending_approval",
                requestIp: requestIp(req),
                requestingUserId:
                  requestType === "human"
                    ? req.actor.userId ?? "local-board"
                    : null,
                requestEmailSnapshot:
                  requestType === "human" ? actorEmail : null,
                agentName: requestType === "agent" ? req.body.agentName : null,
                agentRuntimeType: requestType === "agent" ? agentRuntimeType : null,
                capabilities:
                  requestType === "agent"
                    ? req.body.capabilities ?? null
                    : null,
                agentDefaultsPayload:
                  requestType === "agent" ? joinDefaults.normalized : null,
                claimSecretHash,
                claimSecretExpiresAt
              })
              .returning()
              .then((rows) => rows[0]);
            return row;
          })
        : await db
            .update(joinRequests)
            .set({
              requestIp: requestIp(req),
              agentName:
                requestType === "agent"
                  ? req.body.agentName ??
                    existingJoinRequestForInvite?.agentName ??
                    null
                  : null,
              capabilities:
                requestType === "agent"
                  ? req.body.capabilities ??
                    existingJoinRequestForInvite?.capabilities ??
                    null
                  : null,
              agentRuntimeType: requestType === "agent" ? agentRuntimeType : null,
              agentDefaultsPayload:
                requestType === "agent" ? joinDefaults.normalized : null,
              updatedAt: new Date()
            })
            .where(eq(joinRequests.id, replayJoinRequestId as string))
            .returning()
            .then((rows) => rows[0]);

      if (!created) {
        throw conflict("Join request not found");
      }

      if (
        inviteAlreadyAccepted &&
        requestType === "agent" &&
        agentRuntimeType === "openclaw_gateway" &&
        created.status === "approved" &&
        created.createdAgentId
      ) {
        const existingAgent = await agents.getById(created.createdAgentId);
        if (!existingAgent) {
          throw conflict("Approved join request agent not found");
        }
        const existingAdapterConfig = isPlainObject(existingAgent.agentRuntimeConfig)
          ? (existingAgent.agentRuntimeConfig as Record<string, unknown>)
          : {};
        const nextAdapterConfig = {
          ...existingAdapterConfig,
          ...(joinDefaults.normalized ?? {})
        };
        const updatedAgent = await agents.update(created.createdAgentId, {
          agentRuntimeType,
          agentRuntimeConfig: nextAdapterConfig
        });
        if (!updatedAgent) {
          throw conflict("Approved join request agent not found");
        }
        await logActivity(db, {
          orgId,
          actorType: req.actor.type === "agent" ? "agent" : "user",
          actorId:
            req.actor.type === "agent"
              ? req.actor.agentId ?? "invite-agent"
              : req.actor.userId ?? "board",
          action: "agent.updated_from_join_replay",
          entityType: "agent",
          entityId: updatedAgent.id,
          details: { inviteId: invite.id, joinRequestId: created.id }
        });
      }

      if (requestType === "agent" && agentRuntimeType === "openclaw_gateway") {
        const expectedDefaults = summarizeOpenClawGatewayDefaultsForLog(
          joinDefaults.normalized
        );
        const persistedDefaults = summarizeOpenClawGatewayDefaultsForLog(
          created.agentDefaultsPayload
        );
        const missingPersistedFields: string[] = [];

        if (expectedDefaults.url && !persistedDefaults.url)
          missingPersistedFields.push("url");
        if (
          expectedDefaults.rudderApiUrl &&
          !persistedDefaults.rudderApiUrl
        ) {
          missingPersistedFields.push("rudderApiUrl");
        }
        if (expectedDefaults.gatewayToken && !persistedDefaults.gatewayToken) {
          missingPersistedFields.push("headers.x-openclaw-token");
        }
        if (
          expectedDefaults.devicePrivateKeyPem &&
          !persistedDefaults.devicePrivateKeyPem
        ) {
          missingPersistedFields.push("devicePrivateKeyPem");
        }
        if (
          expectedDefaults.headerKeys.length > 0 &&
          persistedDefaults.headerKeys.length === 0
        ) {
          missingPersistedFields.push("headers");
        }

        logger.info(
          {
            inviteId: invite.id,
            joinRequestId: created.id,
            joinRequestStatus: created.status,
            expectedDefaults,
            persistedDefaults,
            diagnostics: joinDefaults.diagnostics.map((diag) => ({
              code: diag.code,
              level: diag.level,
              message: diag.message,
              hint: diag.hint ?? null
            }))
          },
          "invite accept persisted OpenClaw gateway join request"
        );

        if (missingPersistedFields.length > 0) {
          logger.warn(
            {
              inviteId: invite.id,
              joinRequestId: created.id,
              missingPersistedFields
            },
            "invite accept detected missing persisted OpenClaw gateway defaults"
          );
        }
      }

      await logActivity(db, {
        orgId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "invite-agent"
            : req.actor.userId ??
              (requestType === "agent" ? "invite-anon" : "board"),
        action: inviteAlreadyAccepted
          ? "join.request_replayed"
          : "join.requested",
        entityType: "join_request",
        entityId: created.id,
        details: {
          requestType,
          requestIp: created.requestIp,
          inviteReplay: inviteAlreadyAccepted
        }
      });

      const response = toJoinRequestResponse(created);
      if (claimSecret) {
        const onboardingManifest = buildInviteOnboardingManifest(
          req,
          token,
          invite,
          opts
        );
        res.status(202).json({
          ...response,
          claimSecret,
          claimApiKeyPath: `/api/join-requests/${created.id}/claim-api-key`,
          onboarding: onboardingManifest.onboarding,
          diagnostics: joinDefaults.diagnostics
        });
        return;
      }
      res.status(202).json({
        ...response,
        ...(joinDefaults.diagnostics.length > 0
          ? { diagnostics: joinDefaults.diagnostics }
          : {})
      });
    }
  );

  router.post("/invites/:inviteId/revoke", async (req, res) => {
    const id = req.params.inviteId as string;
    const invite = await db
      .select()
      .from(invites)
      .where(eq(invites.id, id))
      .then((rows) => rows[0] ?? null);
    if (!invite) throw notFound("Invite not found");
    if (invite.inviteType === "bootstrap_ceo") {
      await assertInstanceAdmin(req);
    } else {
      if (!invite.orgId) throw conflict("Invite is missing organization scope");
      await assertCompanyPermission(req, invite.orgId, "users:invite");
    }
    if (invite.acceptedAt) throw conflict("Invite already consumed");
    if (invite.revokedAt) return res.json(invite);

    const revoked = await db
      .update(invites)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(invites.id, id))
      .returning()
      .then((rows) => rows[0]);

    if (invite.orgId) {
      await logActivity(db, {
        orgId: invite.orgId,
        actorType: req.actor.type === "agent" ? "agent" : "user",
        actorId:
          req.actor.type === "agent"
            ? req.actor.agentId ?? "unknown-agent"
            : req.actor.userId ?? "board",
        action: "invite.revoked",
        entityType: "invite",
        entityId: id
      });
    }

    res.json(revoked);
  });

  router.get("/orgs/:orgId/join-requests", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCompanyPermission(req, orgId, "joins:approve");
    const query = listJoinRequestsQuerySchema.parse(req.query);
    const all = await db
      .select()
      .from(joinRequests)
      .where(eq(joinRequests.orgId, orgId))
      .orderBy(desc(joinRequests.createdAt));
    const filtered = all.filter((row) => {
      if (query.status && row.status !== query.status) return false;
      if (query.requestType && row.requestType !== query.requestType)
        return false;
      return true;
    });
    res.json(filtered.map(toJoinRequestResponse));
  });

  router.post(
    "/orgs/:orgId/join-requests/:requestId/approve",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, orgId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.orgId, orgId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const invite = await db
        .select()
        .from(invites)
        .where(eq(invites.id, existing.inviteId))
        .then((rows) => rows[0] ?? null);
      if (!invite) throw notFound("Invite not found");

      let createdAgentId: string | null = existing.createdAgentId ?? null;
      if (existing.requestType === "human") {
        if (!existing.requestingUserId)
          throw conflict("Join request missing user identity");
        await access.ensureMembership(
          orgId,
          "user",
          existing.requestingUserId,
          "member",
          "active"
        );
        const grants = grantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null,
          "human"
        );
        await access.setPrincipalGrants(
          orgId,
          "user",
          existing.requestingUserId,
          grants,
          req.actor.userId ?? null
        );
      } else {
        const existingAgents = await agents.list(orgId);
        const managerId = resolveJoinRequestAgentManagerId(existingAgents);
        if (!managerId) {
          throw conflict(
            "Join request cannot be approved because this organization has no active CEO"
          );
        }

        const agentName = deduplicateAgentName(
          existing.agentName ?? "New Agent",
          existingAgents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status
          }))
        );

        const created = await agents.create(orgId, {
          name: agentName,
          role: "general",
          title: null,
          status: "idle",
          reportsTo: managerId,
          capabilities: existing.capabilities ?? null,
          agentRuntimeType: existing.agentRuntimeType ?? "process",
          agentRuntimeConfig:
            existing.agentDefaultsPayload &&
            typeof existing.agentDefaultsPayload === "object"
              ? (existing.agentDefaultsPayload as Record<string, unknown>)
              : {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          permissions: {},
          lastHeartbeatAt: null,
          metadata: null
        });
        createdAgentId = created.id;
        await access.ensureMembership(
          orgId,
          "agent",
          created.id,
          "member",
          "active"
        );
        await access.setPrincipalPermission(
          orgId,
          "agent",
          created.id,
          "tasks:assign",
          true,
          req.actor.userId ?? null
        );
        const grants = grantsFromDefaults(
          invite.defaultsPayload as Record<string, unknown> | null,
          "agent"
        );
        await access.setPrincipalGrants(
          orgId,
          "agent",
          created.id,
          grants,
          req.actor.userId ?? null
        );
      }

      const approved = await db
        .update(joinRequests)
        .set({
          status: "approved",
          approvedByUserId:
            req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
          approvedAt: new Date(),
          createdAgentId,
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "join.approved",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType, createdAgentId }
      });

      if (createdAgentId) {
        void notifyHireApproved(db, {
          orgId,
          agentId: createdAgentId,
          source: "join_request",
          sourceId: requestId,
          approvedAt: new Date()
        }).catch(() => {});
      }

      res.json(toJoinRequestResponse(approved));
    }
  );

  router.post(
    "/orgs/:orgId/join-requests/:requestId/reject",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const requestId = req.params.requestId as string;
      await assertCompanyPermission(req, orgId, "joins:approve");

      const existing = await db
        .select()
        .from(joinRequests)
        .where(
          and(
            eq(joinRequests.orgId, orgId),
            eq(joinRequests.id, requestId)
          )
        )
        .then((rows) => rows[0] ?? null);
      if (!existing) throw notFound("Join request not found");
      if (existing.status !== "pending_approval")
        throw conflict("Join request is not pending");

      const rejected = await db
        .update(joinRequests)
        .set({
          status: "rejected",
          rejectedByUserId:
            req.actor.userId ?? (isLocalImplicit(req) ? "local-board" : null),
          rejectedAt: new Date(),
          updatedAt: new Date()
        })
        .where(eq(joinRequests.id, requestId))
        .returning()
        .then((rows) => rows[0]);

      await logActivity(db, {
        orgId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "join.rejected",
        entityType: "join_request",
        entityId: requestId,
        details: { requestType: existing.requestType }
      });

      res.json(toJoinRequestResponse(rejected));
    }
  );

  router.post(
    "/join-requests/:requestId/claim-api-key",
    validate(claimJoinRequestApiKeySchema),
    async (req, res) => {
      const requestId = req.params.requestId as string;
      const presentedClaimSecretHash = hashToken(req.body.claimSecret);
      const joinRequest = await db
        .select()
        .from(joinRequests)
        .where(eq(joinRequests.id, requestId))
        .then((rows) => rows[0] ?? null);
      if (!joinRequest) throw notFound("Join request not found");
      if (joinRequest.requestType !== "agent")
        throw badRequest("Only agent join requests can claim API keys");
      if (joinRequest.status !== "approved")
        throw conflict("Join request must be approved before key claim");
      if (!joinRequest.createdAgentId)
        throw conflict("Join request has no created agent");
      if (!joinRequest.claimSecretHash)
        throw conflict("Join request is missing claim secret metadata");
      if (
        !tokenHashesMatch(joinRequest.claimSecretHash, presentedClaimSecretHash)
      ) {
        throw forbidden("Invalid claim secret");
      }
      if (
        joinRequest.claimSecretExpiresAt &&
        joinRequest.claimSecretExpiresAt.getTime() <= Date.now()
      ) {
        throw conflict("Claim secret expired");
      }
      if (joinRequest.claimSecretConsumedAt)
        throw conflict("Claim secret already used");

      const existingKey = await db
        .select({ id: agentApiKeys.id })
        .from(agentApiKeys)
        .where(eq(agentApiKeys.agentId, joinRequest.createdAgentId))
        .then((rows) => rows[0] ?? null);
      if (existingKey) throw conflict("API key already claimed");

      const consumed = await db
        .update(joinRequests)
        .set({ claimSecretConsumedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(joinRequests.id, requestId),
            isNull(joinRequests.claimSecretConsumedAt)
          )
        )
        .returning({ id: joinRequests.id })
        .then((rows) => rows[0] ?? null);
      if (!consumed) throw conflict("Claim secret already used");

      const created = await agents.createApiKey(
        joinRequest.createdAgentId,
        "initial-join-key"
      );

      await logActivity(db, {
        orgId: joinRequest.orgId,
        actorType: "system",
        actorId: "join-claim",
        action: "agent_api_key.claimed",
        entityType: "agent_api_key",
        entityId: created.id,
        details: {
          agentId: joinRequest.createdAgentId,
          joinRequestId: requestId
        }
      });

      res.status(201).json({
        keyId: created.id,
        token: created.token,
        agentId: joinRequest.createdAgentId,
        createdAt: created.createdAt
      });
    }
  );

  router.get("/orgs/:orgId/members", async (req, res) => {
    const orgId = req.params.orgId as string;
    await assertCompanyPermission(req, orgId, "users:manage_permissions");
    const members = await access.listMembers(orgId);
    res.json(members);
  });

  router.patch(
    "/orgs/:orgId/members/:memberId/permissions",
    validate(updateMemberPermissionsSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const memberId = req.params.memberId as string;
      await assertCompanyPermission(req, orgId, "users:manage_permissions");
      const updated = await access.setMemberPermissions(
        orgId,
        memberId,
        req.body.grants ?? [],
        req.actor.userId ?? null
      );
      if (!updated) throw notFound("Member not found");
      res.json(updated);
    }
  );

  router.post(
    "/admin/users/:userId/promote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const result = await access.promoteInstanceAdmin(userId);
      res.status(201).json(result);
    }
  );

  router.post(
    "/admin/users/:userId/demote-instance-admin",
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const removed = await access.demoteInstanceAdmin(userId);
      if (!removed) throw notFound("Instance admin role not found");
      res.json(removed);
    }
  );

  router.get("/admin/users/:userId/organization-access", async (req, res) => {
    await assertInstanceAdmin(req);
    const userId = req.params.userId as string;
    const memberships = await access.listUserCompanyAccess(userId);
    res.json(memberships);
  });

  router.put(
    "/admin/users/:userId/organization-access",
    validate(updateUserCompanyAccessSchema),
    async (req, res) => {
      await assertInstanceAdmin(req);
      const userId = req.params.userId as string;
      const memberships = await access.setUserCompanyAccess(
        userId,
        req.body.orgIds ?? []
      );
      res.json(memberships);
    }
  );

  return router;
}
