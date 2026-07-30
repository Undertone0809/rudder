import type { Db } from "@rudderhq/db";
import {
  appBuilderApps,
  chatConversations,
  heartbeatRuns,
  projects,
} from "@rudderhq/db";
import type {
  AppBuilderApp,
  AppBuilderRunKind,
  AttachAppBuilderConversation,
  BindAppBuilderLocalRuntime,
  CreateAppBuilderApp,
  UpdateAppBuilderBuild,
} from "@rudderhq/shared";
import { and, desc, eq } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../errors.js";

type AppBuilderAppRow = typeof appBuilderApps.$inferSelect;

function toAppBuilderApp(row: AppBuilderAppRow): AppBuilderApp {
  return {
    id: row.id,
    orgId: row.orgId,
    projectId: row.projectId ?? null,
    conversationId: row.conversationId ?? null,
    name: row.name,
    sourceRoot: row.sourceRoot,
    scaffoldVersion: row.scaffoldVersion,
    buildStatus: row.buildStatus as AppBuilderApp["buildStatus"],
    latestBuildRunId: row.latestBuildRunId ?? null,
    latestVerificationRunId: row.latestVerificationRunId ?? null,
    desktopInstallationId: row.desktopInstallationId ?? null,
    appPublicId: row.appPublicId ?? null,
    localBindingId: row.localBindingId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function postgresErrorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return null;
}

function isUniqueViolation(error: unknown) {
  return postgresErrorCode(error) === "23505";
}

function readContextProjectId(contextSnapshot: Record<string, unknown> | null) {
  const projectId = contextSnapshot?.projectId;
  return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
}

export function appBuilderService(db: Db) {
  async function assertProjectInOrganization(orgId: string, projectId: string) {
    const [project] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, orgId)))
      .limit(1);
    if (!project) throw notFound("Project not found");
  }

  async function assertConversationInOrganization(orgId: string, conversationId: string) {
    const [conversation] = await db
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(
        and(
          eq(chatConversations.id, conversationId),
          eq(chatConversations.orgId, orgId),
        ),
      )
      .limit(1);
    if (!conversation) {
      throw unprocessable("App Builder conversation must belong to the Project organization");
    }
  }

  async function getRowById(orgId: string, appId: string) {
    const [row] = await db
      .select()
      .from(appBuilderApps)
      .where(
        and(
          eq(appBuilderApps.orgId, orgId),
          eq(appBuilderApps.id, appId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function requireRowById(orgId: string, appId: string) {
    const row = await getRowById(orgId, appId);
    if (!row) throw notFound("App Builder app not found");
    return row;
  }

  async function getRowForProject(orgId: string, projectId: string) {
    const [row] = await db
      .select()
      .from(appBuilderApps)
      .where(
        and(
          eq(appBuilderApps.orgId, orgId),
          eq(appBuilderApps.projectId, projectId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async function assertRunScope(
    app: AppBuilderAppRow,
    runId: string,
    runKind: AppBuilderRunKind,
  ) {
    const [run] = await db
      .select({
        id: heartbeatRuns.id,
        chatConversationId: heartbeatRuns.chatConversationId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          eq(heartbeatRuns.orgId, app.orgId),
        ),
      )
      .limit(1);
    if (!run) {
      throw unprocessable(`The ${runKind} run must belong to the App Builder organization`);
    }
    if (
      app.projectId
      && readContextProjectId(run.contextSnapshot) !== app.projectId
    ) {
      throw unprocessable(`The ${runKind} run must belong to the App Builder Project`);
    }
    if (app.conversationId && run.chatConversationId !== app.conversationId) {
      throw unprocessable(`The ${runKind} run must belong to the App Builder conversation`);
    }
  }

  return {
    async listForOrganization(orgId: string) {
      const rows = await db
        .select()
        .from(appBuilderApps)
        .where(eq(appBuilderApps.orgId, orgId))
        .orderBy(desc(appBuilderApps.updatedAt));
      return rows.map(toAppBuilderApp);
    },

    async getForProject(orgId: string, projectId: string) {
      const row = await getRowForProject(orgId, projectId);
      return row ? toAppBuilderApp(row) : null;
    },

    async getById(orgId: string, appId: string) {
      const row = await getRowById(orgId, appId);
      return row ? toAppBuilderApp(row) : null;
    },

    async create(orgId: string, input: CreateAppBuilderApp) {
      if (input.projectId) {
        await assertProjectInOrganization(orgId, input.projectId);
      }
      if (input.conversationId) {
        await assertConversationInOrganization(orgId, input.conversationId);
      }

      if (input.projectId) {
        const existing = await getRowForProject(orgId, input.projectId);
        if (existing) {
          throw conflict("This Project already has an App Builder app");
        }
      }

      const [sourceRootOwner] = await db
        .select({ id: appBuilderApps.id })
        .from(appBuilderApps)
        .where(
          and(
            eq(appBuilderApps.orgId, orgId),
            eq(appBuilderApps.sourceRoot, input.sourceRoot),
          ),
        )
        .limit(1);
      if (sourceRootOwner) {
        throw conflict("This App Builder source root is already in use");
      }

      try {
        const [created] = await db
          .insert(appBuilderApps)
          .values({
            orgId,
            projectId: input.projectId ?? null,
            conversationId: input.conversationId ?? null,
            name: input.name,
            sourceRoot: input.sourceRoot,
            scaffoldVersion: input.scaffoldVersion,
            buildStatus: "preparing",
          })
          .returning();
        return toAppBuilderApp(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("The Project or source root already has an App Builder app");
        }
        throw error;
      }
    },

    async updateBuild(orgId: string, appId: string, input: UpdateAppBuilderBuild) {
      const existing = await requireRowById(orgId, appId);
      if (input.runId) {
        await assertRunScope(existing, input.runId, input.runKind);
      }

      const runUpdate =
        "runId" in input
          ? input.runKind === "verification"
            ? { latestVerificationRunId: input.runId ?? null }
            : { latestBuildRunId: input.runId ?? null }
          : {};
      const updateScope = input.expectedStatus
        ? and(
            eq(appBuilderApps.orgId, orgId),
            eq(appBuilderApps.id, appId),
            eq(appBuilderApps.buildStatus, input.expectedStatus),
          )
        : and(
            eq(appBuilderApps.orgId, orgId),
            eq(appBuilderApps.id, appId),
          );
      const [updated] = await db
        .update(appBuilderApps)
        .set({
          buildStatus: input.status,
          ...runUpdate,
          updatedAt: new Date(),
        })
        .where(updateScope)
        .returning();
      if (!updated) {
        throw conflict("The App build state changed in another window");
      }
      return toAppBuilderApp(updated);
    },

    async attachConversation(
      orgId: string,
      appId: string,
      input: AttachAppBuilderConversation,
    ) {
      await requireRowById(orgId, appId);
      await assertConversationInOrganization(orgId, input.conversationId);
      const [updated] = await db
        .update(appBuilderApps)
        .set({
          conversationId: input.conversationId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(appBuilderApps.orgId, orgId),
            eq(appBuilderApps.id, appId),
          ),
        )
        .returning();
      return toAppBuilderApp(updated);
    },

    async bindLocalRuntime(
      orgId: string,
      appId: string,
      binding: BindAppBuilderLocalRuntime,
    ) {
      await requireRowById(orgId, appId);
      try {
        const [updated] = await db
          .update(appBuilderApps)
          .set({
            desktopInstallationId: binding.desktopInstallationId,
            appPublicId: binding.appPublicId,
            localBindingId: binding.localBindingId,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(appBuilderApps.orgId, orgId),
              eq(appBuilderApps.id, appId),
            ),
          )
          .returning();
        return toAppBuilderApp(updated);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict("This local App Builder binding is already in use");
        }
        throw error;
      }
    },

    async clearLocalBinding(orgId: string, appId: string) {
      await requireRowById(orgId, appId);
      const [updated] = await db
        .update(appBuilderApps)
        .set({
          desktopInstallationId: null,
          appPublicId: null,
          localBindingId: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(appBuilderApps.orgId, orgId),
            eq(appBuilderApps.id, appId),
          ),
        )
        .returning();
      return toAppBuilderApp(updated);
    },
  };
}
