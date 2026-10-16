import type { Db } from "@rudderhq/db";
import { agentApiKeys, agents, instanceUserRoles, organizationMemberships } from "@rudderhq/db";
import {
  authRequirementForDeploymentMode,
  type AuthRequirement,
  type DeploymentMode,
} from "@rudderhq/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { Request, RequestHandler, Response } from "express";
import { createHash } from "node:crypto";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { getVerifiedNativeSessionAssertion } from "../auth/native-session-assertion.js";
import { boardAuthService } from "../services/board-auth.js";
import { logger, requestUrlForLogs } from "./logger.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function applyBoardKeyActor(
  req: Request,
  boardAuth: ReturnType<typeof boardAuthService>,
  identity: { userId: string; keyId: string; sessionId: string; runId?: string },
): Promise<boolean> {
  const access = await boardAuth.resolveBoardAccess(identity.userId);
  if (!access.user) return false;

  req.actor = {
    type: "board",
    userId: identity.userId,
    orgIds: access.orgIds,
    isInstanceAdmin: access.isInstanceAdmin,
    keyId: identity.keyId,
    sessionId: identity.sessionId,
    authEpoch: 1,
    runId: identity.runId,
    source: "board_key",
  };
  return true;
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  authRequirement?: AuthRequirement;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  const authRequirement = opts.authRequirement ?? authRequirementForDeploymentMode(opts.deploymentMode);
  return async (req, res, next) => {
    req.actor =
      authRequirement === "optional"
        ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit", sessionId: "local-implicit", authEpoch: 1 }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-rudder-run-id")?.trim() || undefined;
    const agentContextHeader = req.header("x-rudder-agent-id")?.trim() || undefined;

    const authHeader = req.header("authorization");
    const nativeAssertion = getVerifiedNativeSessionAssertion(req);
    if (nativeAssertion && nativeAssertion.kind !== "session") {
      if (nativeAssertion.kind === "none") {
        req.actor = { type: "none", source: "none", runId: runIdHeader };
      } else if (nativeAssertion.kind === "local_implicit") {
        req.actor = {
          type: "board",
          userId: "local-board",
          isInstanceAdmin: true,
          source: "local_implicit",
          sessionId: "local-implicit",
          authEpoch: 1,
        };
      } else if (nativeAssertion.kind === "board_key") {
        const applied = await applyBoardKeyActor(req, boardAuth, {
          userId: nativeAssertion.user_id,
          keyId: nativeAssertion.key_id,
          sessionId: nativeAssertion.session_id,
          runId: runIdHeader || undefined,
        });
        if (!applied) {
          req.actor = { type: "none", source: "none", runId: runIdHeader };
        }
      } else if (nativeAssertion.kind === "agent_key") {
        req.actor = {
          type: "agent",
          agentId: nativeAssertion.agent_id,
          orgId: nativeAssertion.org_id,
          keyId: nativeAssertion.key_id,
          sessionId: nativeAssertion.session_id,
          authEpoch: 1,
          runId: runIdHeader || undefined,
          source: "agent_key",
        };
      } else {
        req.actor = {
          type: "agent",
          agentId: nativeAssertion.agent_id,
          orgId: nativeAssertion.org_id,
          keyId: undefined,
          sessionId: nativeAssertion.session_id,
          credentialExpiresAt: nativeAssertion.expires_at,
          authEpoch: 1,
          runId: nativeAssertion.run_id,
          adapterType: nativeAssertion.adapter_type,
          source: "agent_jwt",
        };
      }
      if (runIdHeader && req.actor.type === "none") req.actor.runId = runIdHeader;
      if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
      next();
      return;
    }

    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      let sessionIdentity = nativeAssertion?.kind === "session"
        ? { userId: nativeAssertion.user_id, sessionId: nativeAssertion.session_id }
        : null;
      if (!nativeAssertion && authRequirement === "required" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: requestUrlForLogs(req) },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id && session.session?.id) {
          sessionIdentity = { userId: session.user.id, sessionId: session.session.id };
        }
      }
      // Both transports share the existing current-permission lookup. A native
      // result never invokes the legacy session resolver.
      if (sessionIdentity) {
        const { userId, sessionId } = sessionIdentity;
        const [roleRow, memberships] = await Promise.all([
          db
            .select({ id: instanceUserRoles.id })
            .from(instanceUserRoles)
            .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
            .then((rows) => rows[0] ?? null),
          db
            .select({ orgId: organizationMemberships.orgId })
            .from(organizationMemberships)
            .where(
              and(
                eq(organizationMemberships.principalType, "user"),
                eq(organizationMemberships.principalId, userId),
                eq(organizationMemberships.status, "active"),
              ),
            ),
        ]);
        req.actor = {
          type: "board",
          userId,
          orgIds: memberships.map((row) => row.orgId),
          isInstanceAdmin: Boolean(roleRow),
          sessionId,
          authEpoch: 1,
          runId: runIdHeader ?? undefined,
          source: "session",
        };
        if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
        next();
        return;
      }
      if (runIdHeader) req.actor.runId = runIdHeader;
      if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
      next();
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    if (!token) {
      if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
      next();
      return;
    }

    const boardKey = await boardAuth.findBoardApiKeyByToken(token);
    if (boardKey) {
      const applied = await applyBoardKeyActor(req, boardAuth, {
        userId: boardKey.userId,
        keyId: boardKey.id,
        sessionId: `board-key:${boardKey.id}`,
        runId: runIdHeader || undefined,
      });
      if (applied) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
        next();
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
        next();
        return;
      }

      const agentRecord = await db
        .select()
        .from(agents)
        .where(eq(agents.id, claims.sub))
        .then((rows) => rows[0] ?? null);

      if (!agentRecord || agentRecord.orgId !== claims.org_id) {
        if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
        next();
        return;
      }

      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
        if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
        next();
        return;
      }

      if (runIdHeader && runIdHeader !== claims.run_id) {
        res.status(403).json({
          error: "Agent run header does not match the signed runtime context",
          code: "agent_run_context_mismatch",
          details: {
            signedRunId: claims.run_id,
            requestedRunId: runIdHeader,
          },
        });
        return;
      }

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        orgId: claims.org_id,
        keyId: undefined,
        sessionId: `agent-jwt:${claims.sub}`,
        credentialExpiresAt: claims.exp,
        authEpoch: 1,
        runId: claims.run_id,
        adapterType: claims.adapter_type,
        source: "agent_jwt",
      };
      if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
      next();
      return;
    }

    await db
      .update(agentApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(agentApiKeys.id, key.id));

    const agentRecord = await db
      .select()
      .from(agents)
      .where(eq(agents.id, key.agentId))
      .then((rows) => rows[0] ?? null);

    if (!agentRecord || agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
      if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
      next();
      return;
    }

    req.actor = {
      type: "agent",
      agentId: key.agentId,
      orgId: key.orgId,
      keyId: key.id,
      sessionId: `agent-key:${key.id}`,
      authEpoch: 1,
      runId: runIdHeader || undefined,
      source: "agent_key",
    };

    if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
    next();
  };
}

function rejectAgentContextMismatch(req: Request, res: Response, expectedAgentId?: string) {
  if (!expectedAgentId || !isMutatingRequest(req)) return false;

  if (req.actor.type !== "agent") {
    res.status(401).json({
      error: "Agent authentication required for agent-scoped CLI request",
      code: "agent_auth_required",
      details: {
        expectedAgentId,
        actorType: req.actor.type,
        actorSource: req.actor.source,
      },
    });
    return true;
  }

  if (req.actor.agentId !== expectedAgentId) {
    res.status(403).json({
      error: "Agent authentication does not match the CLI agent context",
      code: "agent_context_mismatch",
      details: {
        expectedAgentId,
        authenticatedAgentId: req.actor.agentId ?? null,
      },
    });
    return true;
  }

  return false;
}

function isMutatingRequest(req: Request) {
  const method = req.method.toUpperCase();
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

export function requireBoard(req: Request) {
  return req.actor.type === "board";
}
