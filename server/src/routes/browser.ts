import type { Db } from "@rudderhq/db";
import { heartbeatRuns } from "@rudderhq/db";
import type { DeploymentMode, InstanceBrowserSettings } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { forbidden, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import {
  BROWSER_ACTIONS,
  BrowserBrokerError,
  browserBrokerRegistry,
  type BrowserAction,
  type BrowserBrokerRegistry,
  type BrowserRuntimeIdentity,
} from "../services/browser-broker.js";
import { resolveBrowserCapability } from "../services/browser-capability.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { assertInstanceAdmin } from "./authz.js";

const brokerRegistrationSchema = z.object({
  endpoint: z.string().min(1).max(2_048),
  token: z.string().min(32).max(512),
}).strict();

const safeWebUrlSchema = z.string().min(1).max(8_192).refine((value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}, "Browser URL must use http or https.");

const tabIdSchema = z.string().trim().min(1).max(160);
const refSchema = z.string().trim().min(1).max(160);
const browserActionSchemas = {
  tabs: z.object({}).strict(),
  open: z.object({ url: safeWebUrlSchema }).strict(),
  navigate: z.object({ tabId: tabIdSchema, url: safeWebUrlSchema }).strict(),
  read: z.object({ tabId: tabIdSchema }).strict(),
  click: z.object({ tabId: tabIdSchema, ref: refSchema }).strict(),
  type: z.object({
    tabId: tabIdSchema,
    ref: refSchema,
    text: z.string().max(100_000),
    submit: z.boolean().optional(),
  }).strict(),
  screenshot: z.object({ tabId: tabIdSchema }).strict(),
  close: z.object({ tabId: tabIdSchema }).strict(),
} satisfies Record<BrowserAction, z.ZodType<Record<string, unknown>>>;

type BrowserRunRecord = {
  id: string;
  orgId: string;
  agentId: string;
  status: string;
};

type BrowserActivityEvent = {
  orgId: string;
  actorType: "agent";
  actorId: string;
  agentId: string;
  runId: string;
  action: string;
  entityType: "browser_tab";
  entityId: string;
  details: Record<string, unknown>;
};

export type BrowserRoutesOptions = {
  deploymentMode: DeploymentMode;
  registry?: Pick<BrowserBrokerRegistry, "register" | "unregister" | "isAvailable" | "forward">;
  getBrowserSettings?: () => Promise<InstanceBrowserSettings>;
  findRun?: (runId: string) => Promise<BrowserRunRecord | null>;
  recordActivity?: (event: BrowserActivityEvent) => Promise<unknown>;
};

function sendBrowserError(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: message, code });
}

function requireLocalBrowser(deploymentMode: DeploymentMode) {
  if (deploymentMode !== "local_trusted") {
    throw unprocessable("Rudder Browser is available only in local_trusted mode.");
  }
}

function requireAgentBrowserIdentity(req: Request, res: Response): BrowserRuntimeIdentity | null {
  if (req.actor.type !== "agent" || !req.actor.orgId || !req.actor.agentId) {
    throw forbidden("Agent access required");
  }
  if (req.actor.source !== "agent_jwt") {
    sendBrowserError(
      res,
      403,
      "browser_run_credential_required",
      "Rudder Browser tools require a run-scoped runtime credential.",
    );
    return null;
  }
  if (!req.actor.runId) {
    sendBrowserError(res, 400, "browser_run_required", "Rudder Browser tools require a runtime-owned run ID.");
    return null;
  }
  return {
    orgId: req.actor.orgId,
    agentId: req.actor.agentId,
    runId: req.actor.runId,
  };
}

function safeOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function browserBrokerStatus(code: string): number {
  if (code === "browser_unavailable") return 503;
  if (code === "browser_disabled") return 409;
  if (code === "browser_tab_limit") return 429;
  if (code === "browser_timeout") return 504;
  if (code === "browser_result_too_large") return 413;
  if (code === "browser_tab_forbidden") return 403;
  if (code === "browser_tab_not_found" || code === "browser_ref_not_found") return 404;
  if (code === "browser_invalid_argument" || code === "browser_unsafe_url") return 422;
  return 502;
}

export function browserRoutes(db: Db, options: BrowserRoutesOptions) {
  const router = Router();
  const registry = options.registry ?? browserBrokerRegistry;
  const settings = instanceSettingsService(db);
  const getBrowserSettings = options.getBrowserSettings ?? (() => settings.getBrowser());
  const findRun = options.findRun ?? (async (runId: string) => db
    .select({
      id: heartbeatRuns.id,
      orgId: heartbeatRuns.orgId,
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, runId))
    .then((rows) => rows[0] ?? null));
  const recordActivity = options.recordActivity ?? ((event: BrowserActivityEvent) => logActivity(db, event));

  router.put("/instance/browser/broker", async (req, res) => {
    assertInstanceAdmin(req);
    requireLocalBrowser(options.deploymentMode);
    const parsed = brokerRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      sendBrowserError(res, 400, "browser_broker_invalid_registration", "Browser Broker registration is invalid.");
      return;
    }
    try {
      registry.register(parsed.data);
    } catch (error) {
      if (error instanceof BrowserBrokerError) {
        sendBrowserError(res, 400, error.code, error.message);
        return;
      }
      throw error;
    }
    res.status(204).end();
  });

  router.delete("/instance/browser/broker", async (req, res) => {
    assertInstanceAdmin(req);
    requireLocalBrowser(options.deploymentMode);
    const parsed = z.object({ token: z.string().min(32).max(512) }).strict().safeParse(req.body);
    if (!parsed.success) {
      sendBrowserError(res, 400, "browser_broker_invalid_registration", "Browser Broker credential is invalid.");
      return;
    }
    registry.unregister(parsed.data.token);
    res.status(204).end();
  });

  router.post("/browser/:action", async (req, res) => {
    if (options.deploymentMode !== "local_trusted") {
      sendBrowserError(
        res,
        403,
        "browser_runtime_unsupported",
        "Rudder Browser tools are available only in local_trusted mode.",
      );
      return;
    }
    const identity = requireAgentBrowserIdentity(req, res);
    if (!identity) return;

    const action = req.params.action as BrowserAction;
    if (!BROWSER_ACTIONS.includes(action)) {
      sendBrowserError(res, 404, "browser_action_not_found", "Unknown Rudder Browser action.");
      return;
    }
    const parsed = browserActionSchemas[action].safeParse(req.body ?? {});
    if (!parsed.success) {
      sendBrowserError(res, 400, "browser_invalid_argument", "Rudder Browser arguments are invalid.");
      return;
    }
    const actionArgs = parsed.data as Record<string, unknown>;

    const browserSettings = await getBrowserSettings();
    const browserCapability = resolveBrowserCapability({
      deploymentMode: options.deploymentMode,
      browserEnabled: browserSettings.enabled,
      agentRuntimeType: req.actor.adapterType,
    });
    if (!browserCapability.instanceEligible) {
      sendBrowserError(res, 409, "browser_disabled", "Rudder Browser is disabled in Settings.");
      return;
    }
    if (!browserCapability.runEligible) {
      sendBrowserError(
        res,
        403,
        "browser_runtime_unsupported",
        "The current Agent runtime does not support Rudder Browser tools.",
      );
      return;
    }
    if (!registry.isAvailable()) {
      sendBrowserError(res, 503, "browser_unavailable", "Rudder Browser is unavailable because Desktop is not connected.");
      return;
    }

    const run = await findRun(identity.runId);
    if (!run || run.orgId !== identity.orgId || run.agentId !== identity.agentId) {
      sendBrowserError(res, 403, "browser_run_forbidden", "The current run does not own this Browser session.");
      return;
    }
    if (run.status !== "running") {
      sendBrowserError(res, 409, "browser_run_inactive", "The current run is no longer active.");
      return;
    }

    const requestedTabId = typeof actionArgs.tabId === "string" ? actionArgs.tabId : identity.runId;
    const requestedOrigin = safeOrigin(actionArgs.url);
    await recordActivity({
      orgId: identity.orgId,
      actorType: "agent",
      actorId: identity.agentId,
      agentId: identity.agentId,
      runId: identity.runId,
      action: `agent.browser.${action}.requested`,
      entityType: "browser_tab",
      entityId: requestedTabId,
      details: {
        action,
        status: "requested",
        ...(requestedOrigin ? { origin: requestedOrigin } : {}),
      },
    });

    let result: unknown;
    try {
      result = await registry.forward({ identity, action, args: actionArgs });
    } catch (error) {
      if (error instanceof BrowserBrokerError) {
        void recordActivity({
          orgId: identity.orgId,
          actorType: "agent",
          actorId: identity.agentId,
          agentId: identity.agentId,
          runId: identity.runId,
          action: `agent.browser.${action}.failed`,
          entityType: "browser_tab",
          entityId: requestedTabId,
          details: { action, status: "failed", code: error.code },
        }).catch((activityError) => {
          logger.warn({ err: activityError, action, runId: identity.runId }, "failed to record Browser action failure");
        });
        sendBrowserError(res, browserBrokerStatus(error.code), error.code, error.message);
        return;
      }
      throw error;
    }

    const resultRecord = typeof result === "object" && result !== null && !Array.isArray(result)
      ? result as Record<string, unknown>
      : {};
    const tabId = typeof actionArgs.tabId === "string"
      ? actionArgs.tabId
      : typeof resultRecord.tabId === "string"
        ? resultRecord.tabId
        : identity.runId;
    const origin = requestedOrigin ?? safeOrigin(resultRecord.url);
    void recordActivity({
        orgId: identity.orgId,
        actorType: "agent",
        actorId: identity.agentId,
        agentId: identity.agentId,
        runId: identity.runId,
        action: `agent.browser.${action}`,
        entityType: "browser_tab",
        entityId: tabId,
        details: {
          action,
          status: "completed",
          ...(origin ? { origin } : {}),
        },
      }).catch((error) => {
      // The durable intent prevents an unlogged side effect. Returning the
      // successful Broker result avoids an unsafe Agent retry.
      logger.warn({ err: error, action, runId: identity.runId }, "failed to record Browser action completion");
      });
    res.json(result ?? {});
  });

  return router;
}
