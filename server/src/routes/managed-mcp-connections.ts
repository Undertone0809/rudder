import type { Db } from "@rudderhq/db";
import {
  createMcpConnectionSchema,
  mcpConnectionAccessModeSchema,
  updateMcpConnectionSchema,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  logActivity,
  managedMcpConnectionService,
} from "../services/index.js";
import type { ManagedMcpConnectionServiceOptions } from "../services/mcp/managed-connections.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const updateAccessModeSchema = z.object({
  accessMode: mcpConnectionAccessModeSchema,
}).strict();

export function managedMcpConnectionRoutes(
  db: Db,
  options: ManagedMcpConnectionServiceOptions,
) {
  const router = Router();
  const svc = managedMcpConnectionService(db, options);
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

  async function logMutation(
    req: Request,
    input: {
      orgId: string;
      connectionId: string;
      action: string;
      details?: Record<string, unknown>;
    },
  ) {
    await logActivity(db, {
      orgId: input.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: input.action,
      entityType: "mcp_connection",
      entityId: input.connectionId,
      details: input.details ?? null,
    });
  }

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

  router.post(
    "/orgs/:orgId/mcp/connections",
    validate(createMcpConnectionSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      await assertCanManage(req, orgId);
      const created = await svc.create(orgId, req.body, mutationActor(req));
      await logMutation(req, {
        orgId,
        connectionId: created.id,
        action: "mcp_connection.created",
        details: {
          provider: created.provider,
          transport: created.transport,
          status: created.status,
        },
      });
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
      await logMutation(req, {
        orgId,
        connectionId,
        action: "mcp_connection.updated",
        details: {
          provider: updated.provider,
          status: updated.status,
          accessMode: updated.accessMode,
        },
      });
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
      await logMutation(req, {
        orgId,
        connectionId,
        action: "mcp_connection.access_mode_updated",
        details: { accessMode: updated.accessMode },
      });
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
    "/orgs/:orgId/mcp/connections/:connectionId/refresh-tools",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const tools = await svc.refreshTools(orgId, connectionId);
      await logMutation(req, {
        orgId,
        connectionId,
        action: "mcp_connection.tools_refreshed",
        details: { toolCount: tools.length },
      });
      res.json(tools);
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections/:connectionId/reconnect",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const connection = await svc.reconnect(orgId, connectionId);
      await logMutation(req, {
        orgId,
        connectionId,
        action: "mcp_connection.reconnect_requested",
        details: { provider: connection.provider, status: connection.status },
      });
      res.json(connection);
    },
  );

  router.post(
    "/orgs/:orgId/mcp/connections/:connectionId/disconnect",
    async (req, res) => {
      const orgId = req.params.orgId as string;
      const connectionId = req.params.connectionId as string;
      await assertCanManage(req, orgId);
      const connection = await svc.disconnect(orgId, connectionId);
      await logMutation(req, {
        orgId,
        connectionId,
        action: "mcp_connection.disconnected",
        details: { provider: connection.provider, status: connection.status },
      });
      res.json(connection);
    },
  );

  return router;
}
