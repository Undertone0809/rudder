import type { Db } from "@rudderhq/db";
import { agents } from "@rudderhq/db";
import { upsertMcpAgentBindingSchema } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { accessService } from "../services/access.js";
import { managedMcpBindingService } from "../services/mcp/managed-bindings.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

type BindingService = Pick<
  ReturnType<typeof managedMcpBindingService>,
  "listForAgent" | "upsert" | "revoke"
>;

export interface ManagedMcpAgentBindingRoutesOptions {
  bindingService?: BindingService;
  findAgent?: (agentId: string) => Promise<{ id: string; orgId: string } | null>;
  getMembership?: ReturnType<typeof accessService>["getMembership"];
}

export function managedMcpAgentBindingRoutes(
  db: Db,
  options: ManagedMcpAgentBindingRoutesOptions = {},
) {
  const router = Router();
  const bindings = options.bindingService ?? managedMcpBindingService(db);
  const getMembership = options.getMembership ?? accessService(db).getMembership;
  const findAgent = options.findAgent ?? (async (agentId: string) =>
    db.select({ id: agents.id, orgId: agents.orgId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null));

  async function targetAgent(req: Request) {
    assertBoard(req);
    const agent = await findAgent(req.params.id as string);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.orgId);
    return agent;
  }

  function actor(req: Request) {
    return {
      userId: req.actor.userId ?? "board",
      agentId: null,
    };
  }

  async function assertCanManage(req: Request, orgId: string): Promise<void> {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Organization owner access required");
    const membership = await getMembership(orgId, "user", userId);
    if (
      !membership
      || membership.status !== "active"
      || membership.membershipRole !== "owner"
    ) {
      throw forbidden("Organization owner access required");
    }
  }

  router.get("/agents/:id/mcp-connections", async (req, res) => {
    const agent = await targetAgent(req);
    res.json(await bindings.listForAgent(agent.orgId, agent.id));
  });

  const upsert = async (req: Request, res: Response) => {
    const agent = await targetAgent(req);
    await assertCanManage(req, agent.orgId);
    res.json(await bindings.upsert(
      agent.orgId,
      agent.id,
      req.params.connectionId as string,
      req.body,
      actor(req),
    ));
  };
  router.put(
    "/agents/:id/mcp-connections/:connectionId",
    validate(upsertMcpAgentBindingSchema),
    upsert,
  );
  router.patch(
    "/agents/:id/mcp-connections/:connectionId",
    validate(upsertMcpAgentBindingSchema),
    upsert,
  );

  router.delete("/agents/:id/mcp-connections/:connectionId", async (req, res) => {
    const agent = await targetAgent(req);
    await assertCanManage(req, agent.orgId);
    const revoked = await bindings.revoke(
      agent.orgId,
      agent.id,
      req.params.connectionId as string,
      actor(req),
    );
    if (!revoked) throw notFound("Managed MCP binding not found");
    res.json(revoked);
  });

  return router;
}
