import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@rudderhq/db";
import { agentEnabledSkills } from "@rudderhq/db";

export function agentEnabledSkillsService(db: Db) {
  async function listKeys(agentId: string): Promise<string[]> {
    const rows = await db
      .select({
        skillKey: agentEnabledSkills.skillKey,
      })
      .from(agentEnabledSkills)
      .where(eq(agentEnabledSkills.agentId, agentId));
    return rows
      .map((row) => row.skillKey)
      .sort((left, right) => left.localeCompare(right));
  }

  async function listKeyMap(agentIds: string[]): Promise<Map<string, string[]>> {
    if (agentIds.length === 0) return new Map();

    const rows = await db
      .select({
        agentId: agentEnabledSkills.agentId,
        skillKey: agentEnabledSkills.skillKey,
      })
      .from(agentEnabledSkills)
      .where(inArray(agentEnabledSkills.agentId, agentIds));

    const out = new Map<string, string[]>();
    for (const row of rows) {
      const existing = out.get(row.agentId) ?? [];
      existing.push(row.skillKey);
      out.set(row.agentId, existing);
    }

    for (const [agentId, keys] of out.entries()) {
      out.set(agentId, keys.sort((left, right) => left.localeCompare(right)));
    }

    return out;
  }

  async function replaceKeys(orgId: string, agentId: string, skillKeys: string[]): Promise<string[]> {
    const normalized = Array.from(
      new Set(
        skillKeys
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ).sort((left, right) => left.localeCompare(right));

    await db
      .delete(agentEnabledSkills)
      .where(eq(agentEnabledSkills.agentId, agentId));

    if (normalized.length > 0) {
      await db
        .insert(agentEnabledSkills)
        .values(
          normalized.map((skillKey) => ({
            orgId,
            agentId,
            skillKey,
          })),
        );
    }

    return normalized;
  }

  async function addMissingKeys(orgId: string, agentId: string, skillKeys: string[]): Promise<string[]> {
    const existing = new Set(await listKeys(agentId));
    const next = skillKeys
      .map((value) => value.trim())
      .filter(Boolean)
      .filter((value) => !existing.has(value));

    if (next.length > 0) {
      await db
        .insert(agentEnabledSkills)
        .values(
          next.map((skillKey) => ({
            orgId,
            agentId,
            skillKey,
          })),
        );
    }

    return Array.from(new Set([...existing, ...next])).sort((left, right) => left.localeCompare(right));
  }

  async function removeSkillKeys(orgId: string, skillKeys: string[]) {
    const normalized = Array.from(
      new Set(
        skillKeys
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    );
    if (normalized.length === 0) return;

    await db
      .delete(agentEnabledSkills)
      .where(
        and(
          eq(agentEnabledSkills.orgId, orgId),
          inArray(agentEnabledSkills.skillKey, normalized),
        ),
      );
  }

  return {
    listKeys,
    listKeyMap,
    replaceKeys,
    addMissingKeys,
    removeSkillKeys,
  };
}
