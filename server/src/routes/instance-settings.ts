import type { Db } from "@rudderhq/db";
import {
  instancePathPickerRequestSchema,
  patchInstanceBrowserSettingsSchema,
  patchInstanceGeneralSettingsSchema,
  patchInstanceLangfuseSettingsSchema,
  patchInstanceNotificationSettingsSchema,
  patchKeyboardShortcutSettingsSchema,
  patchOperatorProfileSettingsSchema,
  type DeploymentMode,
  type LangfuseConfig,
  type PatchInstanceLangfuseSettings,
} from "@rudderhq/shared";
import { Router, type Request } from "express";
import { updateConfigFile } from "../config-file.js";
import { loadConfig } from "../config.js";
import { conflict, forbidden, unprocessable } from "../errors.js";
import { resolveEffectiveLocalEnvName, resolveLangfuseEnvironmentName } from "../local-runtime.js";
import { validate } from "../middleware/validate.js";
import {
  boardAuthService,
  instanceSettingsService,
  logActivity,
  operatorProfileService,
} from "../services/index.js";
import { createNativePathPicker, NativePathPickerUnsupportedError } from "../services/native-path-picker.js";
import { assertBoard, getActorInfo } from "./authz.js";

const LANGFUSE_BASE_URL_DEFAULT = "http://localhost:3000";
const LANGFUSE_ENV_KEYS = [
  "LANGFUSE_ENABLED",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_ENVIRONMENT",
] as const;
type LangfuseSettingsSource = {
  installed?: boolean;
  enabled?: boolean;
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  environment?: string;
};

function assertCanManageInstanceSettings(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

function assertLocalLangfuseSettings(deploymentMode: DeploymentMode) {
  if (deploymentMode !== "local_trusted") {
    throw unprocessable("Langfuse settings are only available in local_trusted mode.");
  }
}

function assertLocalBrowserSettings(deploymentMode: DeploymentMode) {
  if (deploymentMode !== "local_trusted") {
    throw unprocessable("Browser settings are only available in local_trusted mode.");
  }
}

function isLangfuseManagedByEnv() {
  return LANGFUSE_ENV_KEYS.some((key) => trimOptionalString(process.env[key]) !== undefined);
}

function trimOptionalString(value: string | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function getLangfuseSettings(langfuse: LangfuseSettingsSource | undefined = loadConfig().langfuse) {
  const localEnv = resolveEffectiveLocalEnvName();
  return {
    installed: langfuse?.installed ?? false,
    enabled: langfuse?.enabled ?? false,
    baseUrl: langfuse?.baseUrl ?? LANGFUSE_BASE_URL_DEFAULT,
    publicKey: langfuse?.publicKey ?? "",
    environment: resolveLangfuseEnvironmentName(langfuse?.environment, localEnv) ?? "",
    secretKeyConfigured: Boolean(langfuse?.secretKey),
    managedByEnv: isLangfuseManagedByEnv(),
  };
}

function applyLangfusePatch(current: Record<string, unknown> | undefined, patch: PatchInstanceLangfuseSettings) {
  const installed = ((current?.installed as boolean | undefined) ?? false) || Object.keys(patch).length > 0;
  const nextEnabled = patch.enabled ?? (current?.enabled as boolean | undefined) ?? false;
  const nextBaseUrl =
    (Object.prototype.hasOwnProperty.call(patch, "baseUrl")
      ? patch.baseUrl?.trim()
      : (typeof current?.baseUrl === "string" ? current.baseUrl : undefined))
    || LANGFUSE_BASE_URL_DEFAULT;
  const nextPublicKey = Object.prototype.hasOwnProperty.call(patch, "publicKey")
    ? trimOptionalString(patch.publicKey)
    : trimOptionalString(typeof current?.publicKey === "string" ? current.publicKey : undefined);
  const nextEnvironment = resolveLangfuseEnvironmentName(
    Object.prototype.hasOwnProperty.call(patch, "environment")
      ? trimOptionalString(patch.environment)
      : trimOptionalString(typeof current?.environment === "string" ? current.environment : undefined),
  );

  let nextSecretKey = trimOptionalString(typeof current?.secretKey === "string" ? current.secretKey : undefined);
  if (patch.clearSecretKey === true) {
    nextSecretKey = undefined;
  } else if (typeof patch.secretKey === "string" && patch.secretKey.trim().length > 0) {
    nextSecretKey = patch.secretKey.trim();
  }

  return {
    installed,
    enabled: nextEnabled,
    baseUrl: nextBaseUrl,
    ...(nextPublicKey ? { publicKey: nextPublicKey } : {}),
    ...(nextSecretKey ? { secretKey: nextSecretKey } : {}),
    ...(nextEnvironment ? { environment: nextEnvironment } : {}),
  };
}

function installLangfuseIntegration(current: LangfuseConfig | undefined): LangfuseConfig {
  if (!current) {
    return {
      installed: true,
      enabled: false,
      baseUrl: LANGFUSE_BASE_URL_DEFAULT,
    };
  }

  return {
    ...current,
    installed: true,
  };
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

  router.get("/instance/settings/langfuse", async (req, res) => {
    assertCanManageInstanceSettings(req);
    assertLocalLangfuseSettings(opts.deploymentMode);
    res.json(getLangfuseSettings());
  });

  router.post("/instance/settings/langfuse/install", async (req, res) => {
    assertCanManageInstanceSettings(req);
    assertLocalLangfuseSettings(opts.deploymentMode);
    if (isLangfuseManagedByEnv()) {
      throw conflict("Langfuse settings are managed by environment variables.");
    }

    const updatedConfig = updateConfigFile((current) => ({
      ...current,
      langfuse: installLangfuseIntegration(current.langfuse),
    }));

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
          action: "instance.settings.langfuse_installed",
          entityType: "instance_settings",
          entityId: "langfuse",
          details: {
            langfuse: {
              installed: updatedConfig.langfuse?.installed ?? true,
              enabled: updatedConfig.langfuse?.enabled ?? false,
              baseUrl: updatedConfig.langfuse?.baseUrl ?? LANGFUSE_BASE_URL_DEFAULT,
              publicKeyConfigured: Boolean(updatedConfig.langfuse?.publicKey),
              secretKeyConfigured: Boolean(updatedConfig.langfuse?.secretKey),
              environment: updatedConfig.langfuse?.environment ?? null,
            },
            changedKeys: ["installed"],
          },
        }),
      ),
    );

    res.json(getLangfuseSettings(updatedConfig.langfuse));
  });

  router.patch(
    "/instance/settings/langfuse",
    validate(patchInstanceLangfuseSettingsSchema),
    async (req, res) => {
      assertCanManageInstanceSettings(req);
      assertLocalLangfuseSettings(opts.deploymentMode);
      if (isLangfuseManagedByEnv()) {
        throw conflict("Langfuse settings are managed by environment variables.");
      }

      const updatedConfig = updateConfigFile((current) => ({
        ...current,
        langfuse: applyLangfusePatch(current.langfuse as Record<string, unknown> | undefined, req.body),
      }));

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
            action: "instance.settings.langfuse_updated",
            entityType: "instance_settings",
            entityId: "langfuse",
            details: {
              langfuse: {
                installed: updatedConfig.langfuse?.installed ?? false,
                enabled: updatedConfig.langfuse?.enabled ?? false,
                baseUrl: updatedConfig.langfuse?.baseUrl ?? LANGFUSE_BASE_URL_DEFAULT,
                publicKeyConfigured: Boolean(updatedConfig.langfuse?.publicKey),
                secretKeyConfigured: Boolean(updatedConfig.langfuse?.secretKey),
                environment: updatedConfig.langfuse?.environment ?? null,
              },
              changedKeys: Object.keys(req.body).sort(),
            },
          }),
        ),
      );

      res.json(getLangfuseSettings(updatedConfig.langfuse));
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
