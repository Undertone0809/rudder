import type { Db } from "@rudderhq/db";
import {
  createMcpConnectionSchema,
  mcpConnectionAccessModeSchema,
  mcpOAuthCallbackSchema,
  mcpOAuthStartSchema,
  updateMcpConnectionSchema,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { markHttpRequestBodySensitive } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  managedMcpConnectionService,
  managedMcpOAuthService,
} from "../services/index.js";
import type { ManagedMcpConnectionServiceOptions } from "../services/mcp/managed-connections.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const updateAccessModeSchema = z.object({
  accessMode: mcpConnectionAccessModeSchema,
}).strict();
const selectScopeBodySchema = z.object({
  externalScope: z.string().trim().min(1).max(512),
  accessMode: mcpConnectionAccessModeSchema,
}).strict();

export interface ManagedMcpConnectionRoutesOptions
  extends ManagedMcpConnectionServiceOptions {
  serverPort: number;
  authPublicBaseUrl?: string | null;
}

export function managedMcpConnectionRoutes(
  db: Db,
  options: ManagedMcpConnectionRoutesOptions,
) {
  const router = Router();
  let svc!: ReturnType<typeof managedMcpConnectionService>;
  const oauth = managedMcpOAuthService(db, {
    deploymentMode: options.deploymentMode,
    serverPort: options.serverPort,
    authPublicBaseUrl: options.authPublicBaseUrl,
    allowlists: options.allowlists,
    dnsLookup: options.dnsLookup,
    refreshConnectionTools: (orgId, connectionId, actor) =>
      svc.refreshTools(orgId, connectionId, actor),
  });
  svc = managedMcpConnectionService(db, {
    ...options,
    createOAuthCredential: (orgId, connectionId) =>
      oauth.createCredential(orgId, connectionId),
  });
  const access = accessService(db);

  function assertCanRead(req: Request, orgId: string) {
    assertBoard(req);
    assertCompanyAccess(req, orgId);
  }

  async function assertCanManage(req: Request, orgId: string) {
    assertCanRead(req, orgId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Organization owner access required");
    const membership = await access.getMembership(orgId, "user", userId);
    if (
      !membership
      || membership.status !== "active"
      || membership.membershipRole !== "owner"
    ) {
      throw forbidden("Organization owner access required");
    }
  }

  function mutationActor(req: Request) {
    return {
      userId: req.actor.userId ?? "board",
      agentId: null,
    };
  }

  function oauthActor(req: Request) {
    return {
      userId: req.actor.userId ?? null,
      isInstanceAdmin: req.actor.isInstanceAdmin === true,
      localImplicit: req.actor.source === "local_implicit",
    };
  }

  router.use("/orgs/:orgId/mcp/connections", (req, _res, next) => {
    markHttpRequestBodySensitive(req);
    next();
  });

  router.get("/orgs/:orgId/mcp/providers", (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    res.json(svc.catalog());
  });

  router.get("/orgs/:orgId/mcp/connections", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    res.json(await svc.list(orgId));
  });

  router.get("/orgs/:orgId/mcp/connections/:connectionId", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCanRead(req, orgId);
    res.json(await svc.get(orgId, req.params.connectionId as string));
  });

  router.get(
    "/mcp/oauth/callback",
    async (req, res) => {
      res.set({
        "Cache-Control": "no-store",
        Pragma: "no-cache",
        "Referrer-Policy": "no-referrer",
      });
      res.json(await oauth.callback(mcpOAuthCallbackSchema.parse({
        state: req.query.state,
        code: req.query.code,
        error: req.query.error,
        errorDescription: req.query.error_description,
        iss: req.query.iss,
      })));
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections",
    validate(createMcpConnectionSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const created = await svc.create(orgId, req.body, mutationActor(req));
      res.status(201).json(created);
    },
  );

  router.patch(
    "/orgs/:orgId/mcp/connections/:connectionId",
    validate(updateMcpConnectionSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const updated = await svc.update(orgId, connectionId, req.body, mutationActor(req));
      res.json(updated);
    },
  );

  router.patch(
    "/orgs/:orgId/mcp/connections/:connectionId/access-mode",
    validate(updateAccessModeSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const updated = await svc.update(
        orgId,
        connectionId,
        { accessMode: req.body.accessMode },
        mutationActor(req),
      );
      res.json(updated);
    },
  );

  router.get(
    "/orgs/:orgId/mcp/connections/:connectionId/tools",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCanRead(req, orgId);
      res.json(await svc.listTools(orgId, req.params.connectionId as string));
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections/:connectionId/oauth/start",
    validate(mcpOAuthStartSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      res.status(201).json(await oauth.start(
        orgId,
        connectionId,
        oauthActor(req),
      ));
    },
  );

  router.get(
    "/orgs/:orgId/mcp/connections/:connectionId/oauth/grant",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCanRead(req, orgId);
      res.json(await oauth.getGrantSummary(
        orgId,
        req.params.connectionId as string,
      ));
    },
  );

  router.get(
    "/orgs/:orgId/mcp/connections/:connectionId/oauth/scopes",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCanRead(req, orgId);
      res.json(await oauth.listScopeOptions(
        orgId,
        req.params.connectionId as string,
      ));
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections/:connectionId/oauth/scope",
    validate(selectScopeBodySchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      res.json(await oauth.selectScope(
        orgId,
        connectionId,
        {
          connectionId,
          externalScope: req.body.externalScope,
          accessMode: req.body.accessMode,
        },
        oauthActor(req),
      ));
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections/:connectionId/refresh-tools",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const tools = await svc.refreshTools(orgId, connectionId, mutationActor(req));
      res.json(tools);
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections/:connectionId/reconnect",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const connection = await svc.get(orgId, connectionId);
      if (connection.provider === "custom") {
        res.json(await svc.reconnect(orgId, connectionId, mutationActor(req)));
        return;
      }
      await oauth.revoke(
        orgId,
        connectionId,
        oauthActor(req),
        "connection_reconnect",
      );
      res.status(201).json(await oauth.start(orgId, connectionId, oauthActor(req)));
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections/:connectionId/disconnect",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const connection = await svc.get(orgId, connectionId);
      res.json(connection.provider === "custom"
        ? await svc.disconnect(orgId, connectionId, mutationActor(req))
        : await oauth.revoke(orgId, connectionId, oauthActor(req)));
    },
  );

  return router;
}
