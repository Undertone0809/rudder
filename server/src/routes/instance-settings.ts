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
import {
  boardAuthService,
  instanceSettingsService,
  logActivity,
  operatorProfileService,
} from "../services/index.js";
import { createNativePathPicker, NativePathPickerUnsupportedError } from "../services/native-path-picker.js";
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
  opts: { deploymentMode: DeploymentMode },
) {
  const router = Router();
  const svc = instanceSettingsService(db);
  const operatorProfiles = operatorProfileService(db);
  const boardAuth = boardAuthService(db);
  const pathPicker = createNativePathPicker();

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
