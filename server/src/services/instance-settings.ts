import type { Db } from "@rudder/db";
import { organizations, instanceSettings } from "@rudder/db";
import {
  instanceGeneralSettingsSchema,
  type InstanceGeneralSettings,
  type InstanceLocale,
  instanceNotificationSettingsSchema,
  type InstanceNotificationSettings,
  instanceExperimentalSettingsSchema,
  type InstanceExperimentalSettings,
  type PatchInstanceGeneralSettings,
  type PatchInstanceNotificationSettings,
  type InstanceSettings,
  type PatchInstanceExperimentalSettings,
} from "@rudder/shared";
import { eq } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

function normalizeGeneralSettings(raw: unknown): InstanceGeneralSettings {
  const parsed = instanceGeneralSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      censorUsernameInLogs: parsed.data.censorUsernameInLogs ?? false,
      locale: parsed.data.locale ?? "en",
    };
  }
  return {
    censorUsernameInLogs: false,
    locale: "en",
  };
}

export function normalizeInstanceLocale(raw: unknown): InstanceLocale {
  return normalizeGeneralSettings({ locale: raw }).locale;
}

function normalizeNotificationSettings(raw: unknown): InstanceNotificationSettings {
  const parsed = instanceNotificationSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) {
    return {
      desktopInboxNotifications: parsed.data.desktopInboxNotifications ?? true,
      desktopDockBadge: parsed.data.desktopDockBadge ?? true,
    };
  }
  return {
    desktopInboxNotifications: true,
    desktopDockBadge: true,
  };
}

function normalizeExperimentalSettings(raw: unknown): InstanceExperimentalSettings {
  const normalizedRaw =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.entries(raw as Record<string, unknown>).filter(([key]) => key !== "enableIsolatedWorkspaces"),
        )
      : {};
  const parsed = instanceExperimentalSettingsSchema.safeParse(normalizedRaw);
  if (parsed.success) {
    return {
      autoRestartDevServerWhenIdle: parsed.data.autoRestartDevServerWhenIdle ?? false,
    };
  }
  return {
    autoRestartDevServerWhenIdle: false,
  };
}

function toInstanceSettings(row: typeof instanceSettings.$inferSelect): InstanceSettings {
  return {
    id: row.id,
    general: normalizeGeneralSettings(row.general),
    notifications: normalizeNotificationSettings(row.notifications),
    experimental: normalizeExperimentalSettings(row.experimental),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function instanceSettingsService(db: Db) {
  async function getOrCreateRow() {
    const existing = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;

    const now = new Date();
    const [created] = await db
      .insert(instanceSettings)
      .values({
        singletonKey: DEFAULT_SINGLETON_KEY,
        general: {},
        notifications: {},
        experimental: {},
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [instanceSettings.singletonKey],
        set: {
          updatedAt: now,
        },
      })
      .returning();

    return created;
  }

  return {
    get: async (): Promise<InstanceSettings> => toInstanceSettings(await getOrCreateRow()),

    getGeneral: async (): Promise<InstanceGeneralSettings> => {
      const row = await getOrCreateRow();
      return normalizeGeneralSettings(row.general);
    },

    getNotifications: async (): Promise<InstanceNotificationSettings> => {
      const row = await getOrCreateRow();
      return normalizeNotificationSettings(row.notifications);
    },

    getExperimental: async (): Promise<InstanceExperimentalSettings> => {
      const row = await getOrCreateRow();
      return normalizeExperimentalSettings(row.experimental);
    },

    updateGeneral: async (patch: PatchInstanceGeneralSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextGeneral = normalizeGeneralSettings({
        ...normalizeGeneralSettings(current.general),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          general: { ...nextGeneral },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateNotifications: async (patch: PatchInstanceNotificationSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextNotifications = normalizeNotificationSettings({
        ...normalizeNotificationSettings(current.notifications),
        ...patch,
      });
      if (patch.desktopInboxNotifications === true && patch.desktopDockBadge == null) {
        nextNotifications.desktopDockBadge = true;
      }
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          notifications: { ...nextNotifications },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    updateExperimental: async (patch: PatchInstanceExperimentalSettings): Promise<InstanceSettings> => {
      const current = await getOrCreateRow();
      const nextExperimental = normalizeExperimentalSettings({
        ...normalizeExperimentalSettings(current.experimental),
        ...patch,
      });
      const now = new Date();
      const [updated] = await db
        .update(instanceSettings)
        .set({
          experimental: { ...nextExperimental },
          updatedAt: now,
        })
        .where(eq(instanceSettings.id, current.id))
        .returning();
      return toInstanceSettings(updated ?? current);
    },

    listCompanyIds: async (): Promise<string[]> =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .then((rows) => rows.map((row) => row.id)),
  };
}
