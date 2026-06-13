import { libraryEntries, type Db } from "@rudderhq/db";
import { and, eq, like, or } from "drizzle-orm";

type LibraryEntryRow = typeof libraryEntries.$inferSelect;

function titleFromPath(filePath: string) {
  const segments = filePath.split("/").filter(Boolean);
  return segments.at(-1) ?? filePath;
}

export function libraryEntryService(db: Db) {
  async function getByCurrentPath(orgId: string, filePath: string): Promise<LibraryEntryRow | null> {
    return await db
      .select()
      .from(libraryEntries)
      .where(and(
        eq(libraryEntries.orgId, orgId),
        eq(libraryEntries.currentPath, filePath),
        eq(libraryEntries.kind, "file"),
        eq(libraryEntries.sourceType, "workspace_file"),
      ))
      .then((rows) => rows[0] ?? null);
  }

  return {
    async getById(orgId: string, entryId: string): Promise<LibraryEntryRow | null> {
      return await db
        .select()
        .from(libraryEntries)
        .where(and(eq(libraryEntries.orgId, orgId), eq(libraryEntries.id, entryId)))
        .then((rows) => rows[0] ?? null);
    },

    async getByCurrentPath(orgId: string, filePath: string): Promise<LibraryEntryRow | null> {
      return getByCurrentPath(orgId, filePath);
    },

    async getOrCreateWorkspaceFileEntry(orgId: string, filePath: string, title?: string | null): Promise<LibraryEntryRow> {
      const existing = await getByCurrentPath(orgId, filePath);
      if (existing) return existing;

      const [entry] = await db
        .insert(libraryEntries)
        .values({
          orgId,
          kind: "file",
          sourceType: "workspace_file",
          currentPath: filePath,
          title: title?.trim() || titleFromPath(filePath),
          status: "active",
        })
        .onConflictDoNothing({
          target: [libraryEntries.orgId, libraryEntries.currentPath],
        })
        .returning();
      if (entry) return entry;

      const createdByConcurrentRequest = await getByCurrentPath(orgId, filePath);
      if (createdByConcurrentRequest) return createdByConcurrentRequest;
      throw new Error("Failed to create or load Library entry for workspace file");
    },

    async listByCurrentPaths(orgId: string, filePaths: string[]): Promise<Map<string, LibraryEntryRow>> {
      const entries = new Map<string, LibraryEntryRow>();
      if (filePaths.length === 0) return entries;

      await Promise.all(filePaths.map(async (filePath) => {
        const entry = await getByCurrentPath(orgId, filePath);
        if (entry?.currentPath) entries.set(entry.currentPath, entry);
      }));
      return entries;
    },

    async moveWorkspaceFileEntry(orgId: string, previousPath: string, nextPath: string): Promise<LibraryEntryRow | null> {
      const existing = await getByCurrentPath(orgId, previousPath);
      if (!existing) return null;
      const [updated] = await db
        .update(libraryEntries)
        .set({
          currentPath: nextPath,
          title: titleFromPath(nextPath),
          status: "active",
          updatedAt: new Date(),
        })
        .where(and(eq(libraryEntries.orgId, orgId), eq(libraryEntries.id, existing.id)))
        .returning();
      return updated ?? null;
    },

    async moveWorkspaceDirectoryEntries(orgId: string, previousPath: string, nextPath: string): Promise<void> {
      const rows = await db
        .select()
        .from(libraryEntries)
        .where(and(
          eq(libraryEntries.orgId, orgId),
          eq(libraryEntries.kind, "file"),
          eq(libraryEntries.sourceType, "workspace_file"),
          or(
            eq(libraryEntries.currentPath, previousPath),
            like(libraryEntries.currentPath, `${previousPath}/%`),
          ),
        ));

      await Promise.all(rows.map(async (entry) => {
        if (!entry.currentPath) return;
        const movedPath = entry.currentPath === previousPath
          ? nextPath
          : `${nextPath}${entry.currentPath.slice(previousPath.length)}`;
        await db
          .update(libraryEntries)
          .set({
            currentPath: movedPath,
            title: titleFromPath(movedPath),
            status: "active",
            updatedAt: new Date(),
          })
          .where(and(eq(libraryEntries.orgId, orgId), eq(libraryEntries.id, entry.id)));
      }));
    },

    async markWorkspaceFileEntryDeleted(orgId: string, filePath: string): Promise<LibraryEntryRow | null> {
      const existing = await getByCurrentPath(orgId, filePath);
      if (!existing) return null;
      const [updated] = await db
        .update(libraryEntries)
        .set({
          currentPath: null,
          status: "deleted",
          updatedAt: new Date(),
        })
        .where(and(eq(libraryEntries.orgId, orgId), eq(libraryEntries.id, existing.id)))
        .returning();
      return updated ?? null;
    },

    async markWorkspaceDirectoryEntriesDeleted(orgId: string, directoryPath: string): Promise<void> {
      await db
        .update(libraryEntries)
        .set({
          currentPath: null,
          status: "deleted",
          updatedAt: new Date(),
        })
        .where(and(
          eq(libraryEntries.orgId, orgId),
          eq(libraryEntries.kind, "file"),
          eq(libraryEntries.sourceType, "workspace_file"),
          or(
            eq(libraryEntries.currentPath, directoryPath),
            like(libraryEntries.currentPath, `${directoryPath}/%`),
          ),
        ));
    },
  };
}
