import { Router } from "express";
import type { Db } from "@rudderhq/db";
import { and, count, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { heartbeatRuns, instanceUserRoles, invites } from "@rudderhq/db";
import type { DeploymentExposure, DeploymentMode } from "@rudderhq/shared";
import { readPersistedDevServerStatus, toDevServerHealthStatus } from "../dev-server-status.js";
import { resolveEffectiveLocalEnvName, resolveRuntimeOwnerKind } from "../local-runtime.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { serverVersion } from "../version.js";

export function healthRoutes(
  db?: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId?: string;
    localEnv?: string | null;
    runtimeOwnerKind?: string | null;
  } = {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    authReady: true,
    companyDeletionEnabled: true,
  },
) {
  const router = Router();
  const runtimeOwnerKind = resolveRuntimeOwnerKind(opts.runtimeOwnerKind);
  const instanceId = opts.instanceId ?? process.env.RUDDER_INSTANCE_ID?.trim() ?? "default";
  const localEnv = opts.localEnv ?? resolveEffectiveLocalEnvName(instanceId);

  router.get("/", async (_req, res) => {
    if (!db) {
      res.json({
        status: "ok",
        version: serverVersion,
        instanceId,
        localEnv,
        runtimeOwnerKind,
        uiLocale: "en",
      });
      return;
    }

    const instanceSettings = instanceSettingsService(db);
    const generalSettings = await instanceSettings.getGeneral();

    let bootstrapStatus: "ready" | "bootstrap_pending" = "ready";
    let bootstrapInviteActive = false;
    if (opts.deploymentMode === "authenticated") {
      const roleCount = await db
        .select({ count: count() })
        .from(instanceUserRoles)
        .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
        .then((rows) => Number(rows[0]?.count ?? 0));
      bootstrapStatus = roleCount > 0 ? "ready" : "bootstrap_pending";

      if (bootstrapStatus === "bootstrap_pending") {
        const now = new Date();
        const inviteCount = await db
          .select({ count: count() })
          .from(invites)
          .where(
            and(
              eq(invites.inviteType, "bootstrap_ceo"),
              isNull(invites.revokedAt),
              isNull(invites.acceptedAt),
              gt(invites.expiresAt, now),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0));
        bootstrapInviteActive = inviteCount > 0;
      }
    }

    const persistedDevServerStatus = readPersistedDevServerStatus();
    let devServer: ReturnType<typeof toDevServerHealthStatus> | undefined;
    if (persistedDevServerStatus) {
      const experimentalSettings = await instanceSettings.getExperimental();
      const activeRunCount = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]))
        .then((rows) => Number(rows[0]?.count ?? 0));

      devServer = toDevServerHealthStatus(persistedDevServerStatus, {
        autoRestartEnabled: experimentalSettings.autoRestartDevServerWhenIdle ?? false,
        activeRunCount,
      });
    }

    res.json({
      status: "ok",
      version: serverVersion,
      instanceId,
      localEnv,
      runtimeOwnerKind,
      deploymentMode: opts.deploymentMode,
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      bootstrapStatus,
      bootstrapInviteActive,
      uiLocale: generalSettings.locale,
      features: {
        companyDeletionEnabled: opts.companyDeletionEnabled,
      },
      ...(devServer ? { devServer } : {}),
    });
  });

  return router;
}
