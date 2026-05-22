import { createHash } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { agentApiKeys, agents, organizationMemberships, instanceUserRoles } from "@rudderhq/db";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import type { DeploymentMode } from "@rudderhq/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "./logger.js";
import { boardAuthService } from "../services/board-auth.js";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

interface ActorMiddlewareOptions {
  deploymentMode: DeploymentMode;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}

export function actorMiddleware(db: Db, opts: ActorMiddlewareOptions): RequestHandler {
  const boardAuth = boardAuthService(db);
  return async (req, res, next) => {
    req.actor =
      opts.deploymentMode === "local_trusted"
        ? { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }
        : { type: "none", source: "none" };

    const runIdHeader = req.header("x-rudder-run-id");
    const agentContextHeader = req.header("x-rudder-agent-id")?.trim() || undefined;

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      if (opts.deploymentMode === "authenticated" && opts.resolveSession) {
        let session: BetterAuthSessionResult | null = null;
        try {
          session = await opts.resolveSession(req);
        } catch (err) {
          logger.warn(
            { err, method: req.method, url: req.originalUrl },
            "Failed to resolve auth session from request headers",
          );
        }
        if (session?.user?.id) {
          const userId = session.user.id;
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
            runId: runIdHeader ?? undefined,
            source: "session",
          };
          if (rejectAgentContextMismatch(req, res, agentContextHeader)) return;
          next();
          return;
        }
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
      const access = await boardAuth.resolveBoardAccess(boardKey.userId);
      if (access.user) {
        await boardAuth.touchBoardApiKey(boardKey.id);
        req.actor = {
          type: "board",
          userId: boardKey.userId,
          orgIds: access.orgIds,
          isInstanceAdmin: access.isInstanceAdmin,
          keyId: boardKey.id,
          runId: runIdHeader || undefined,
          source: "board_key",
        };
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

      req.actor = {
        type: "agent",
        agentId: claims.sub,
        orgId: claims.org_id,
        keyId: undefined,
        runId: runIdHeader || claims.run_id || undefined,
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
