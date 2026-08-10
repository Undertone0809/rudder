import type { Db } from "@rudderhq/db";
import { heartbeatRuns } from "@rudderhq/db";
import {
  COMPUTER_USE_ACTIONS,
  computerUseActionSchemas,
  type ComputerUseAction,
  type ComputerUseRuntimeIdentity,
  type DeploymentMode,
} from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { logger, markHttpRequestBodySensitive } from "../middleware/logger.js";
import {
  ComputerBrokerError,
  computerBrokerRegistry,
  type ComputerBrokerRegistry,
} from "../services/computer-broker.js";
import { resolveComputerUseCapability } from "../services/computer-capability.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { assertInstanceAdmin } from "./authz.js";

const brokerRegistrationSchema = z.object({
  endpoint: z.string().min(1).max(2_048),
  token: z.string().min(32).max(512),
  ownerId: z.string().uuid().optional(),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  refresh: z.boolean().optional(),
}).strict().refine(
  (value) => (value.ownerId === undefined) === (value.generation === undefined),
  "Computer Broker ownerId and generation must be provided together.",
).refine(
  (value) => !value.refresh || value.ownerId !== undefined,
  "Computer Broker refresh requires an ownerId and generation.",
);

type ComputerRunRecord = {
  id: string;
  orgId: string;
  agentId: string;
  status: string;
};

type ComputerActivityEvent = {
  orgId: string;
  actorType: "agent";
  actorId: string;
  agentId: string;
  runId: string;
  action: string;
  entityType: "agent_run";
  entityId: string;
  details: Record<string, unknown>;
};

export type ComputerRoutesOptions = {
  deploymentMode: DeploymentMode;
  registry?: Pick<ComputerBrokerRegistry, "register" | "unregister" | "isAvailable" | "forward">;
  getEnabled?: () => Promise<boolean>;
  findRun?: (runId: string) => Promise<ComputerRunRecord | null>;
  recordActivity?: (event: ComputerActivityEvent) => Promise<unknown>;
};

function sendComputerError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: message, code });
}

function requireAgentIdentity(req: Request, res: Response): ComputerUseRuntimeIdentity | null {
  if (req.actor.type !== "agent" || !req.actor.orgId || !req.actor.agentId) {
    throw forbidden("Agent access required");
  }
  if (req.actor.source !== "agent_jwt") {
    sendComputerError(res, 403, "computer_run_credential_required", "Computer Use requires a run-scoped runtime credential.");
    return null;
  }
  if (!req.actor.runId) {
    sendComputerError(res, 400, "computer_run_required", "Computer Use requires a runtime-owned run ID.");
    return null;
  }
  return { orgId: req.actor.orgId, agentId: req.actor.agentId, runId: req.actor.runId };
}

function brokerStatus(code: string): number {
  if (code === "computer_unavailable") return 503;
  if (code === "computer_disabled" || code === "computer_run_inactive") return 409;
  if (code === "computer_timeout") return 504;
  if (code === "computer_result_too_large") return 413;
  if (code === "computer_stale_observation" || code === "computer_target_not_found") return 404;
  if (code === "computer_invalid_argument") return 400;
  if (code === "computer_permission_required") return 409;
  return 502;
}

function boundedTargetMetadata(args: Record<string, unknown>, result?: unknown): Record<string, unknown> {
  const output = typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : {};
  const details: Record<string, unknown> = {};
  const pid = typeof args.pid === "number" ? args.pid : typeof output.pid === "number" ? output.pid : null;
  const windowId = typeof args.windowId === "number"
    ? args.windowId
    : typeof output.windowId === "number" ? output.windowId : null;
  const observationId = typeof args.observationId === "string"
    ? args.observationId
    : typeof output.observationId === "string" ? output.observationId : null;
  const effect = typeof output.effect === "string" ? output.effect.slice(0, 80) : null;
  if (pid !== null) details.pid = pid;
  if (windowId !== null) details.windowId = windowId;
  if (observationId) details.observationId = observationId;
  if (effect) details.effect = effect;
  return details;
}

export function computerRoutes(db: Db, options: ComputerRoutesOptions) {
  const router = Router();
  router.use((req, _res, next) => {
    markHttpRequestBodySensitive(req);
    next();
  });
  const registry = options.registry ?? computerBrokerRegistry;
  const settings = instanceSettingsService(db);
  const getEnabled = options.getEnabled ?? (async () => (await settings.getGeneral()).experimentalComputerUseEnabled);
  const findRun = options.findRun ?? (async (runId: string) => db
    .select({ id: heartbeatRuns.id, orgId: heartbeatRuns.orgId, agentId: heartbeatRuns.agentId, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null));
  const recordActivity = options.recordActivity ?? ((event: ComputerActivityEvent) => logActivity(db, event));

  router.put("/instance/computer/broker", async (req, res) => {
    assertInstanceAdmin(req);
    if (options.deploymentMode !== "local_trusted") {
      sendComputerError(res, 403, "computer_runtime_unsupported", "Computer Use is available only in local_trusted mode.");
      return;
    }
    const parsed = brokerRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      sendComputerError(res, 400, "computer_broker_invalid_registration", "Computer Broker registration is invalid.");
      return;
    }
    try {
      registry.register(parsed.data);
    } catch (error) {
      if (error instanceof ComputerBrokerError) {
        sendComputerError(res, error.code.includes("stale") || error.code.includes("revoked") ? 409 : 400, error.code, error.message);
        return;
      }
      throw error;
    }
    res.status(204).end();
  });

  router.delete("/instance/computer/broker", async (req, res) => {
    assertInstanceAdmin(req);
    if (options.deploymentMode !== "local_trusted") {
      sendComputerError(res, 403, "computer_runtime_unsupported", "Computer Use is available only in local_trusted mode.");
      return;
    }
    const parsed = z.object({ token: z.string().min(32).max(512) }).strict().safeParse(req.body);
    if (!parsed.success) {
      sendComputerError(res, 400, "computer_broker_invalid_registration", "Computer Broker credential is invalid.");
      return;
    }
    registry.unregister(parsed.data.token);
    res.status(204).end();
  });

  router.get("/instance/computer/readiness", async (req, res) => {
    assertInstanceAdmin(req);
    const enabled = await getEnabled();
    res.json({
      enabled,
      desktopConnected: registry.isAvailable(),
      supported: options.deploymentMode === "local_trusted",
    });
  });

  router.post("/computer/:action", async (req, res) => {
    if (options.deploymentMode !== "local_trusted") {
      sendComputerError(res, 403, "computer_runtime_unsupported", "Computer Use is available only in local_trusted mode.");
      return;
    }
    const identity = requireAgentIdentity(req, res);
    if (!identity) return;
    const action = req.params.action as ComputerUseAction;
    if (!COMPUTER_USE_ACTIONS.includes(action)) {
      sendComputerError(res, 404, "computer_action_not_found", "Unknown Computer Use action.");
      return;
    }
    const parsed = computerUseActionSchemas[action].safeParse(req.body ?? {});
    if (!parsed.success) {
      sendComputerError(res, 400, "computer_invalid_argument", "Computer Use arguments are invalid.");
      return;
    }
    const enabled = await getEnabled();
    const capability = resolveComputerUseCapability({
      deploymentMode: options.deploymentMode,
      enabled,
      desktopReady: registry.isAvailable(),
      agentRuntimeType: req.actor.adapterType,
    });
    if (!enabled) {
      sendComputerError(res, 409, "computer_disabled", "Computer Use is disabled in Experimental Settings.");
      return;
    }
    if (!capability.runtimeSupported) {
      sendComputerError(res, 403, "computer_runtime_unsupported", "The current Agent runtime does not support Computer Use.");
      return;
    }
    if (!capability.instanceEligible) {
      sendComputerError(res, 503, "computer_unavailable", "Computer Use is unavailable because Rudder Desktop is not ready.");
      return;
    }
    const run = await findRun(identity.runId);
    if (!run || run.orgId !== identity.orgId || run.agentId !== identity.agentId) {
      sendComputerError(res, 403, "computer_run_forbidden", "The current run does not own this Computer Use session.");
      return;
    }
    if (run.status !== "running") {
      sendComputerError(res, 409, "computer_run_inactive", "The current run is no longer active.");
      return;
    }
    const args = parsed.data as Record<string, unknown>;
    await recordActivity({
      orgId: identity.orgId,
      actorType: "agent",
      actorId: identity.agentId,
      agentId: identity.agentId,
      runId: identity.runId,
      action: `agent.computer.${action}.requested`,
      entityType: "agent_run",
      entityId: identity.runId,
      details: { action, status: "requested", ...boundedTargetMetadata(args) },
    });
    try {
      const result = await registry.forward({ identity, action, args });
      void recordActivity({
        orgId: identity.orgId,
        actorType: "agent",
        actorId: identity.agentId,
        agentId: identity.agentId,
        runId: identity.runId,
        action: `agent.computer.${action}`,
        entityType: "agent_run",
        entityId: identity.runId,
        details: { action, status: "completed", ...boundedTargetMetadata(args, result) },
      }).catch((error) => logger.warn({ err: error, action, runId: identity.runId }, "failed to record Computer Use completion"));
      res.json(result ?? {});
    } catch (error) {
      if (error instanceof ComputerBrokerError) {
        void recordActivity({
          orgId: identity.orgId,
          actorType: "agent",
          actorId: identity.agentId,
          agentId: identity.agentId,
          runId: identity.runId,
          action: `agent.computer.${action}.failed`,
          entityType: "agent_run",
          entityId: identity.runId,
          details: { action, status: "failed", code: error.code, ...boundedTargetMetadata(args) },
        }).catch((activityError) => logger.warn({ err: activityError, action, runId: identity.runId }, "failed to record Computer Use failure"));
        sendComputerError(res, brokerStatus(error.code), error.code, error.message);
        return;
      }
      throw error;
    }
  });

  return router;
}
