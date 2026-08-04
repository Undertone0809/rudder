import type { Db } from "@rudderhq/db";
import {
  instancePathPickerRequestSchema,
  patchInstanceBrowserSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  patchInstanceNotificationSettingsSchema,
  patchKeyboardShortcutSettingsSchema,
  patchOperatorProfileSettingsSchema,
  type DeploymentMode,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import { forbidden, unprocessable } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { browserBrokerRegistry } from "../services/browser-broker.js";
import {
  boardAuthService,
  instanceSettingsService,
  logActivity,
  operatorProfileService,
} from "../services/index.js";
import { createNativePathPicker, NativePathPickerUnsupportedError } from "../services/native-path-picker.js";
import {
  getProductAnalyticsInstallationState,
  reconcileProductAnalyticsInstallationMode,
  recordProductAnalyticsConsent,
  registerProductAnalyticsInstallation,
} from "../services/product-analytics.js";
import { assertBoard, getActorInfo } from "./authz.js";

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function assertLocalBrowserSettings(deploymentMode: DeploymentMode) {
  if (deploymentMode !== "local_trusted") {
    throw unprocessable("Browser settings are only available in local_trusted mode.");
  }
}

export function instanceSettingsRoutes(
  db: Db,
  opts: { deploymentMode: DeploymentMode; instanceId?: string },
) {
  const router = Router();
  const svc = instanceSettingsService(db);
  const operatorProfiles = operatorProfileService(db);
  const boardAuth = boardAuthService(db);
  const pathPicker = createNativePathPicker();
  const telemetryInstallationId = opts.instanceId ?? process.env.RUDDER_INSTANCE_ID ?? "default";

  router.get("/instance/settings/product-analytics", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const state = await getProductAnalyticsInstallationState(db, telemetryInstallationId);
    const general = await svc.getGeneral();
    const installationState = state?.installation.state as Record<string, unknown> | undefined;
    const installationId = state?.installation.installationId ?? telemetryInstallationId;
    const maskedInstallationId = installationId.length > 6
      ? `****${installationId.slice(-6)}`
      : installationId.length > 0 ? `****${installationId}` : null;
    res.json({
      mode: general.productAnalyticsMode,
      consentVersion: "v1",
      consentEpoch: general.productAnalyticsConsentEpoch,
      maskedInstallationId,
      pendingCount: state?.pendingCount ?? 0,
      lastAttemptedAt: typeof installationState?.lastAttemptedAt === "string" ? installationState.lastAttemptedAt : null,
      lastSucceededAt: typeof installationState?.lastSucceededAt === "string" ? installationState.lastSucceededAt : null,
      lastErrorCode: typeof installationState?.lastErrorCode === "string" ? installationState.lastErrorCode : null,
      coverageGap: installationState?.coverageGap === true,
      lastPayloadAt: typeof installationState?.lastPayloadAt === "string" ? installationState.lastPayloadAt : null,
      lastPayload: Array.isArray(installationState?.lastPayload) ? installationState.lastPayload : null,
      disclosure: {
        collected: ["event names", "coarse version/platform dimensions", "pseudonymous ids"],
        excluded: ["prompts", "transcripts", "file paths", "issue titles", "output content", "credentials"],
      },
    });
  });

  router.patch("/instance/settings/product-analytics", async (req, res) => {
    assertCanManageInstanceSettings(req);
    const mode = req.body?.mode;
    if (mode !== "off" && mode !== "anonymous" && mode !== "account_linked") {
      throw unprocessable("Product analytics mode is invalid");
    }
    const installation = await registerProductAnalyticsInstallation(db, { installationId: telemetryInstallationId });
    if (!installation.installation && !installation.installationSecret) {
      // Existing registrations are intentionally not returned with their secret.
      // The local uploader keeps its credential separately.
    }
    const actor = getActorInfo(req);
    const localUserId = mode === "account_linked" && actor.actorType === "user" ? actor.actorId : null;
    if (mode === "account_linked" && (!localUserId || req.actor.source === "local_implicit")) throw forbidden("Account-linked telemetry requires a signed-in user");
    const scope = mode === "account_linked" ? "account_linked_user" : "anonymous_installation";
    await recordProductAnalyticsConsent(db, {
      installationId: telemetryInstallationId,
      scope,
      localUserId,
      decision: mode === "off" ? "revoked" : "granted",
      policyVersion: "v1",
      decidedByLocalUserId: actor.actorType === "user" ? actor.actorId : null,
    });
    await reconcileProductAnalyticsInstallationMode(db, telemetryInstallationId, mode);
    const updated = await svc.updateGeneral({ productAnalyticsMode: mode });
    res.json({ mode: updated.general.productAnalyticsMode, consentEpoch: updated.general.productAnalyticsConsentEpoch });
  });

  router.get("/instance/settings/general", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await svc.getGeneral());
  });

  router.get("/instance/settings/browser", async (req, res) => {
    assertCanManageInstanceSettings(req);
    assertLocalBrowserSettings(opts.deploymentMode);
    res.json(await svc.getBrowser());
  });

  router.get("/instance/settings/notifications", async (req, res) => {
    assertCanManageInstanceSettings(req);
    res.json(await svc.getNotifications());
  });

  router.patch(
    "/instance/settings/browser",
    validate(patchInstanceBrowserSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      assertLocalBrowserSettings(opts.deploymentMode);
      const updated = await svc.updateBrowser(req.body);
      if (!updated.browser.enabled) browserBrokerRegistry.revoke();
      const actor = getActorInfo(req);
      const orgIds = await svc.listCompanyIds();
      await Promise.all(
        orgIds.map((orgId) =>
          logActivity(db, {
            orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.browser_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              settings: updated.browser,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.browser);
    },
  );

  router.patch(
    "/instance/settings/general",
    validate(patchInstanceGeneralSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateGeneral(req.body);
      const actor = getActorInfo(req);
      const orgIds = await svc.listCompanyIds();
      await Promise.all(
        orgIds.map((orgId) =>
          logActivity(db, {
            orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.general_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              general: updated.general,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.general);
    },
  );

  router.patch(
    "/instance/settings/notifications",
    validate(patchInstanceNotificationSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      const updated = await svc.updateNotifications(req.body);
      const actor = getActorInfo(req);
      const orgIds = await svc.listCompanyIds();
      await Promise.all(
        orgIds.map((orgId) =>
          logActivity(db, {
            orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.notifications_updated",
            entityType: "instance_settings",
            entityId: updated.id,
            details: {
              notifications: updated.notifications,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );
      res.json(updated.notifications);
    },
  );

  router.get("/instance/settings/profile", async (req, res) => {
    assertBoard(req);
    if (!req.actor.userId) {
      throw forbidden("Board user identity required");
    }
    res.json(await operatorProfiles.get(req.actor.userId));
  });

  router.patch(
    "/instance/settings/profile",
    validate(patchOperatorProfileSettingsSchema),
    async (req, res) => {
      assertBoard(req);
      if (!req.actor.userId) {
        throw forbidden("Board user identity required");
      }

      const updated = await operatorProfiles.update(req.actor.userId, req.body);
      const actor = getActorInfo(req);
      const orgIds = await boardAuth.resolveBoardActivityCompanyIds({
        userId: req.actor.userId,
      });

      await Promise.all(
        orgIds.map((orgId) =>
          logActivity(db, {
            orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.profile_updated",
            entityType: "operator_profile",
            entityId: req.actor.userId ?? "unknown-user",
            details: {
              profile: updated,
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );

      res.json(updated);
    },
  );

  router.get("/instance/settings/shortcuts", async (req, res) => {
    assertBoard(req);
    if (!req.actor.userId) {
      throw forbidden("Board user identity required");
    }
    res.json(await operatorProfiles.getShortcuts(req.actor.userId));
  });

  router.patch(
    "/instance/settings/shortcuts",
    validate(patchKeyboardShortcutSettingsSchema),
    async (req, res) => {
      assertBoard(req);
      if (!req.actor.userId) {
        throw forbidden("Board user identity required");
      }

      const updated = await operatorProfiles.updateShortcuts(req.actor.userId, req.body);
      const actor = getActorInfo(req);
      const orgIds = await boardAuth.resolveBoardActivityCompanyIds({
        userId: req.actor.userId,
      });

      await Promise.all(
        orgIds.map((orgId) =>
          logActivity(db, {
            orgId,
            actorType: actor.actorType,
            actorId: actor.actorId,
            agentId: actor.agentId,
            runId: actor.runId,
            action: "instance.settings.shortcuts_updated",
            entityType: "operator_profile",
            entityId: req.actor.userId ?? "unknown-user",
            details: {
              shortcutActionIds: updated.shortcuts.map((shortcut) => shortcut.actionId).sort(),
              disabledActionIds: updated.shortcuts
                .filter((shortcut) => shortcut.disabled === true)
                .map((shortcut) => shortcut.actionId)
                .sort(),
            },
          }),
        ),
      );

      res.json(updated);
    },
  );

  router.post(
    "/instance/path-picker",
    validate(instancePathPickerRequestSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      if (opts.deploymentMode !== "local_trusted") {
        throw unprocessable("Native path picker is only available in local_trusted mode.");
      }

      try {
        const path = await pathPicker.pick(req.body.selectionType);
        res.json({ path, cancelled: path === null });
      } catch (error) {
        if (error instanceof NativePathPickerUnsupportedError) {
          throw unprocessable(error.message);
        }
        throw error;
      }
    },
  );

  return router;
}
