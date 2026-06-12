import type { Db } from "@rudderhq/db";
import { operatorProfiles } from "@rudderhq/db";
import {
  keyboardShortcutSettingsSchema,
  type KeyboardShortcutSettings,
  operatorProfileSettingsSchema,
  type OperatorProfileSettings,
  type PatchKeyboardShortcutSettings,
  type PatchOperatorProfileSettings,
} from "@rudderhq/shared";
import { eq } from "drizzle-orm";

function normalizeField(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeProfile(raw: unknown): OperatorProfileSettings {
  const parsed = operatorProfileSettingsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return {
      nickname: "",
      moreAboutYou: "",
    };
  }

  return {
    nickname: normalizeField(parsed.data.nickname) ?? "",
    moreAboutYou: normalizeField(parsed.data.moreAboutYou) ?? "",
  };
}

function normalizePreferences(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return { ...(raw as Record<string, unknown>) };
}

function normalizeShortcutSettings(raw: unknown): KeyboardShortcutSettings {
  const parsed = keyboardShortcutSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return { shortcuts: [] };
}

export function operatorProfileService(db: Db) {
  return {
    get: async (userId: string): Promise<OperatorProfileSettings> => {
      const row = await db
        .select()
        .from(operatorProfiles)
        .where(eq(operatorProfiles.userId, userId))
        .then((rows) => rows[0] ?? null);

      return normalizeProfile({
        nickname: row?.nickname ?? "",
        moreAboutYou: row?.moreAboutYou ?? "",
      });
    },

    update: async (userId: string, patch: PatchOperatorProfileSettings): Promise<OperatorProfileSettings> => {
      const current = await db
        .select()
        .from(operatorProfiles)
        .where(eq(operatorProfiles.userId, userId))
        .then((rows) => rows[0] ?? null);

      const next = normalizeProfile({
        nickname: patch.nickname ?? current?.nickname ?? "",
        moreAboutYou: patch.moreAboutYou ?? current?.moreAboutYou ?? "",
      });
      const now = new Date();

      await db
        .insert(operatorProfiles)
        .values({
          userId,
          nickname: normalizeField(next.nickname),
          moreAboutYou: normalizeField(next.moreAboutYou),
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: operatorProfiles.userId,
          set: {
            nickname: normalizeField(next.nickname),
            moreAboutYou: normalizeField(next.moreAboutYou),
            updatedAt: now,
          },
        });

      return next;
    },

    getShortcuts: async (userId: string): Promise<KeyboardShortcutSettings> => {
      const row = await db
        .select()
        .from(operatorProfiles)
        .where(eq(operatorProfiles.userId, userId))
        .then((rows) => rows[0] ?? null);

      const preferences = normalizePreferences(row?.preferences);
      return normalizeShortcutSettings(preferences.keyboardShortcuts);
    },

    updateShortcuts: async (
      userId: string,
      patch: PatchKeyboardShortcutSettings,
    ): Promise<KeyboardShortcutSettings> => {
      const current = await db
        .select()
        .from(operatorProfiles)
        .where(eq(operatorProfiles.userId, userId))
        .then((rows) => rows[0] ?? null);

      const currentPreferences = normalizePreferences(current?.preferences);
      const nextShortcuts = normalizeShortcutSettings(patch);
      const nextPreferences = {
        ...currentPreferences,
        keyboardShortcuts: nextShortcuts,
      };
      const now = new Date();

      await db
        .insert(operatorProfiles)
        .values({
          userId,
          nickname: current?.nickname ?? null,
          moreAboutYou: current?.moreAboutYou ?? null,
          preferences: nextPreferences,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: operatorProfiles.userId,
          set: {
            preferences: nextPreferences,
            updatedAt: now,
          },
        });

      return nextShortcuts;
    },
  };
}
