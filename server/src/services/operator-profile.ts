import type { Db } from "@rudder/db";
import { operatorProfiles } from "@rudder/db";
import {
  operatorProfileSettingsSchema,
  type OperatorProfileSettings,
  type PatchOperatorProfileSettings,
} from "@rudder/shared";
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
  };
}
