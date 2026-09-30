import {
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  organizationMutationState,
  organizationResourceMutationState,
  organizationResources,
  organizations,
  projectGoalMutationState,
  projectResourceAttachments,
  projects,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { lockNodeOrganizationResourceMutationAuthority } from "../services/organization-resource-mutation-fence.js";
import { resourceCatalogService } from "../services/resource-catalog.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-resource-catalog-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("resource catalog mutation authority", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  async function createOrganization(name: string, issuePrefix: string) {
    const orgId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(name),
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(organizationMutationState).values({ orgId }).onConflictDoNothing();
    return orgId;
  }

  async function createProject(orgId: string, name: string, id = randomUUID()) {
    return db.insert(projects).values({ id, orgId, name, status: "planned" })
      .returning().then((rows) => rows[0]!);
  }

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(projectResourceAttachments);
    await db.delete(organizationResources);
    await db.delete(projects);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("allows every project attachment mutation while the project is Node-owned", async () => {
    const orgId = await createOrganization("Node Resource Fence Org", "NRF");
    const project = await createProject(orgId, "Node Resource Fence Project");
    const resources = await db.insert(organizationResources).values([
      {
        orgId,
        name: "Primary resource",
        kind: "file",
        sourceType: "external",
        locator: "https://example.test/primary",
      },
      {
        orgId,
        name: "Secondary resource",
        kind: "file",
        sourceType: "external",
        locator: "https://example.test/secondary",
      },
    ]).returning();
    const catalog = resourceCatalogService(db);

    const replaced = await catalog.replaceProjectResourceAttachments({
      orgId,
      projectId: project.id,
      attachments: [{ resourceId: resources[0]!.id, role: "reference" }],
    });
    expect(replaced.map((attachment) => attachment.resourceId)).toEqual([resources[0]!.id]);

    const created = await catalog.createProjectResourceAttachment(project.id, {
      resourceId: resources[1]!.id,
      role: "working_set",
      note: "Before update",
    });
    expect(created).toMatchObject({ resourceId: resources[1]!.id, note: "Before update" });

    const updated = await catalog.updateProjectResourceAttachment(project.id, created!.id, {
      note: "After update",
      isPrimary: true,
    });
    expect(updated).toMatchObject({ resourceId: resources[1]!.id, note: "After update", isPrimary: true });

    await expect(catalog.removeProjectResourceAttachment(project.id, created!.id))
      .resolves.toMatchObject({ id: created!.id });
    const remaining = await catalog.listProjectResourceAttachments(project.id);
    expect(remaining.map((attachment) => attachment.resourceId)).toEqual([resources[0]!.id]);
  });

  it("rejects every project attachment mutation for a Rust-owned project without changing persisted data", async () => {
    const orgId = await createOrganization("Rust Resource Fence Org", "RRF");
    const project = await createProject(orgId, "Rust Resource Fence Project");
    const resources = await db.insert(organizationResources).values([
      {
        orgId,
        name: "Existing resource",
        kind: "file",
        sourceType: "external",
        locator: "https://example.test/existing",
      },
      {
        orgId,
        name: "New resource",
        kind: "file",
        sourceType: "external",
        locator: "https://example.test/new",
      },
    ]).returning();
    const existingAttachment = await db.insert(projectResourceAttachments).values({
      orgId,
      projectId: project.id,
      resourceId: resources[0]!.id,
      role: "reference",
      note: "Keep unchanged",
    }).returning().then((rows) => rows[0]!);
    await db.update(projectGoalMutationState)
      .set({ owner: "rust", fenceEpoch: 1n, fenceToken: randomUUID() })
      .where(eq(projectGoalMutationState.projectId, project.id));

    const catalog = resourceCatalogService(db);
    const rustOwned = {
      status: 409,
      message: "Project goal mutation authority is owned by Rust",
    };
    await expect(catalog.replaceProjectResourceAttachments({
      orgId,
      projectId: project.id,
      attachments: [{ resourceId: resources[1]!.id }],
      newResources: [{
        name: "Inline resource",
        kind: "file",
        sourceType: "external",
        locator: "https://example.test/inline",
        role: "reference",
      }],
    })).rejects.toMatchObject(rustOwned);
    await expect(catalog.createProjectResourceAttachment(project.id, {
      resourceId: resources[1]!.id,
    })).rejects.toMatchObject(rustOwned);
    await expect(catalog.updateProjectResourceAttachment(project.id, existingAttachment.id, {
      note: "Must not change",
    })).rejects.toMatchObject(rustOwned);
    await expect(catalog.removeProjectResourceAttachment(project.id, existingAttachment.id))
      .rejects.toMatchObject(rustOwned);

    const attachments = await db.select()
      .from(projectResourceAttachments)
      .where(eq(projectResourceAttachments.projectId, project.id));
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      id: existingAttachment.id,
      resourceId: resources[0]!.id,
      note: "Keep unchanged",
    });
    const inlineResource = await db.select({ id: organizationResources.id })
      .from(organizationResources)
      .where(eq(organizationResources.locator, "https://example.test/inline"));
    expect(inlineResource).toEqual([]);
  });

  it("rejects organization resource update and deletion if any attached project is Rust-owned", async () => {
    const orgId = await createOrganization("Shared Rust Resource Org", "SRR");
    const nodeProject = await createProject(orgId, "Earlier Node Project", "11111111-1111-4111-8111-111111111111");
    const rustProject = await createProject(orgId, "Later Rust Project", "22222222-2222-4222-8222-222222222222");
    const resource = await db.insert(organizationResources).values({
      orgId,
      name: "Shared resource",
      kind: "file",
      sourceType: "external",
      locator: "https://example.test/shared",
    }).returning().then((rows) => rows[0]!);
    await db.insert(organizationResourceMutationState).values({
      resourceId: resource.id,
      orgId,
      owner: "node",
    });
    await db.insert(projectResourceAttachments).values([
      { orgId, projectId: nodeProject.id, resourceId: resource.id },
      { orgId, projectId: rustProject.id, resourceId: resource.id },
    ]);
    await db.update(projectGoalMutationState)
      .set({ owner: "rust", fenceEpoch: 1n, fenceToken: randomUUID() })
      .where(eq(projectGoalMutationState.projectId, rustProject.id));

    const catalog = resourceCatalogService(db);
    const rustOwned = {
      status: 409,
      message: "Project goal mutation authority is owned by Rust",
    };
    await expect(catalog.updateOrganizationResource(orgId, resource.id, {
      name: "Must remain unchanged",
    })).rejects.toMatchObject(rustOwned);
    let persistedResource = await db.select()
      .from(organizationResources)
      .where(eq(organizationResources.id, resource.id))
      .then((rows) => rows[0]);
    let persistedAttachments = await db.select()
      .from(projectResourceAttachments)
      .where(eq(projectResourceAttachments.resourceId, resource.id));
    expect(persistedResource?.name).toBe("Shared resource");
    expect(persistedAttachments).toHaveLength(2);

    await expect(catalog.removeOrganizationResource(orgId, resource.id))
      .rejects.toMatchObject(rustOwned);
    persistedResource = await db.select()
      .from(organizationResources)
      .where(eq(organizationResources.id, resource.id))
      .then((rows) => rows[0]);
    persistedAttachments = await db.select()
      .from(projectResourceAttachments)
      .where(eq(projectResourceAttachments.resourceId, resource.id));
    expect(persistedResource?.name).toBe("Shared resource");
    expect(persistedAttachments).toHaveLength(2);
    expect(await db.select({ owner: organizationResourceMutationState.owner })
      .from(organizationResourceMutationState)
      .where(eq(organizationResourceMutationState.resourceId, resource.id)))
      .toEqual([{ owner: "node" }]);
  });

  it("allows organization resource update and deletion when attached projects are Node-owned", async () => {
    const orgId = await createOrganization("Shared Node Resource Org", "SNR");
    const project = await createProject(orgId, "Node-owned Resource Project");
    const resource = await db.insert(organizationResources).values({
      orgId,
      name: "Original resource",
      kind: "file",
      sourceType: "external",
      locator: "https://example.test/node-resource",
    }).returning().then((rows) => rows[0]!);
    await db.insert(projectResourceAttachments).values({
      orgId,
      projectId: project.id,
      resourceId: resource.id,
    });

    const catalog = resourceCatalogService(db);
    await expect(catalog.updateOrganizationResource(orgId, resource.id, {
      name: "Updated resource",
    })).resolves.toMatchObject({ name: "Updated resource" });
    expect(await db.select({ id: projectResourceAttachments.id })
      .from(projectResourceAttachments)
      .where(eq(projectResourceAttachments.resourceId, resource.id))).toHaveLength(1);

    await expect(catalog.removeOrganizationResource(orgId, resource.id))
      .resolves.toMatchObject({ id: resource.id, name: "Updated resource" });
    expect(await db.select({ id: projectResourceAttachments.id })
      .from(projectResourceAttachments)
      .where(eq(projectResourceAttachments.resourceId, resource.id))).toEqual([]);
    expect(await db.select({ orgId: organizationResourceMutationState.orgId })
      .from(organizationResourceMutationState)
      .where(eq(organizationResourceMutationState.resourceId, resource.id)))
      .toEqual([{ orgId }]);
  });

  it("rejects stale Node resource writers after Rust ownership survives canonical deletion", async () => {
    const orgId = await createOrganization("Rust Resource Tombstone Org", "RTO");
    const catalog = resourceCatalogService(db);
    const resource = await catalog.createOrganizationResource(orgId, {
      name: "Tombstoned resource",
      kind: "file",
      sourceType: "external",
      locator: "https://example.test/tombstoned-resource",
    });
    await db.update(organizationResourceMutationState)
      .set({ owner: "rust", fenceEpoch: 2n, mutationVersion: 7n, fenceToken: randomUUID() })
      .where(eq(organizationResourceMutationState.resourceId, resource.id));

    await db.delete(organizationResources).where(eq(organizationResources.id, resource.id));

    const rustOwned = {
      status: 409,
      message: "Organization resource mutation authority is owned by Rust",
    };
    await expect(catalog.updateOrganizationResource(orgId, resource.id, {
      name: "Stale Node update",
    })).rejects.toMatchObject(rustOwned);
    await expect(catalog.removeOrganizationResource(orgId, resource.id))
      .rejects.toMatchObject(rustOwned);
    expect(await db.select({
      owner: organizationResourceMutationState.owner,
      orgId: organizationResourceMutationState.orgId,
      mutationVersion: organizationResourceMutationState.mutationVersion,
      fenceEpoch: organizationResourceMutationState.fenceEpoch,
    }).from(organizationResourceMutationState)
      .where(eq(organizationResourceMutationState.resourceId, resource.id)))
      .toEqual([{
        owner: "rust",
        orgId,
        mutationVersion: 7n,
        fenceEpoch: 2n,
      }]);
  });

  it("provisions Node ownership transactionally for new inline resources", async () => {
    const orgId = await createOrganization("Inline Node Resource Org", "INR");
    const project = await createProject(orgId, "Inline Node Resource Project");
    const attachments = await resourceCatalogService(db).replaceProjectResourceAttachments({
      orgId,
      projectId: project.id,
      attachments: [],
      newResources: [{
        name: "New inline resource",
        kind: "file",
        sourceType: "external",
        locator: "https://example.test/inline-node-resource",
        role: "reference",
      }],
    });
    const resourceId = attachments[0]!.resourceId;

    expect(await db.select({ owner: organizationResourceMutationState.owner,
      orgId: organizationResourceMutationState.orgId,
      mutationVersion: organizationResourceMutationState.mutationVersion,
      fenceEpoch: organizationResourceMutationState.fenceEpoch })
      .from(organizationResourceMutationState)
      .where(eq(organizationResourceMutationState.resourceId, resourceId)))
      .toEqual([{ owner: "node", orgId, mutationVersion: 0n, fenceEpoch: 0n }]);
  });

  it("keeps foreign resource IDs indistinguishable from missing resources", async () => {
    const requestedOrg = await createOrganization("Requested Resource Org", "RRO");
    const ownerOrg = await createOrganization("Foreign Resource Org", "FRO");
    const resource = await db.insert(organizationResources).values({
      orgId: ownerOrg,
      name: "Foreign resource",
      kind: "file",
      sourceType: "external",
      locator: "https://example.test/foreign-resource",
    }).returning().then((rows) => rows[0]!);
    await db.insert(organizationResourceMutationState).values({
      resourceId: resource.id,
      orgId: ownerOrg,
      owner: "rust",
      fenceEpoch: 1n,
    });

    const catalog = resourceCatalogService(db);
    await expect(catalog.updateOrganizationResource(requestedOrg, resource.id, {
      name: "Must remain private",
    })).resolves.toBeNull();
    await expect(catalog.removeOrganizationResource(requestedOrg, resource.id)).resolves.toBeNull();
    expect(await db.select({ name: organizationResources.name, orgId: organizationResources.orgId })
      .from(organizationResources)
      .where(eq(organizationResources.id, resource.id)))
      .toEqual([{ name: "Foreign resource", orgId: ownerOrg }]);
    expect(await db.select({ owner: organizationResourceMutationState.owner, orgId: organizationResourceMutationState.orgId })
      .from(organizationResourceMutationState)
      .where(eq(organizationResourceMutationState.resourceId, resource.id)))
      .toEqual([{ owner: "rust", orgId: ownerOrg }]);
  });

  it("fails closed when a scoped canonical resource has corrupt component scope", async () => {
    const requestedOrg = "33333333-3333-4333-8333-333333333333";
    const corruptOrg = "44444444-4444-4444-8444-444444444444";
    const resourceId = "55555555-5555-4555-8555-555555555555";
    const execute = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        resource_id: resourceId,
        org_id: corruptOrg,
        owner: "node",
        mutation_version: "0",
        fence_epoch: "0",
        fence_token: "66666666-6666-4666-8666-666666666666",
      }]);

    await expect(lockNodeOrganizationResourceMutationAuthority(
      { execute },
      requestedOrg,
      resourceId,
      { initializeFromCanonical: true },
    )).rejects.toMatchObject({
      status: 409,
      message: "Organization resource mutation authority has an invalid scope",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("reuses a Rust-owned Library resource without changing its resource fence", async () => {
    const orgId = await createOrganization("Rust Library Reuse Org", "RLR");
    const project = await createProject(orgId, "Library Reuse Project");
    const resource = await db.insert(organizationResources).values({
      orgId,
      name: "Rust-owned Library row",
      kind: "file",
      sourceType: "library",
      locator: "projects/shared/README.md",
    }).returning().then((rows) => rows[0]!);
    await db.insert(organizationResourceMutationState).values({
      resourceId: resource.id,
      orgId,
      owner: "rust",
      mutationVersion: 11n,
      fenceEpoch: 3n,
    });

    const attachments = await resourceCatalogService(db).replaceProjectResourceAttachments({
      orgId,
      projectId: project.id,
      attachments: [],
      newResources: [{
        name: "Requested Library row",
        kind: "file",
        sourceType: "library",
        locator: "projects/shared/README.md",
        role: "reference",
      }],
    });

    expect(attachments.map((attachment) => attachment.resourceId)).toEqual([resource.id]);
    expect(await db.select({ owner: organizationResourceMutationState.owner,
      mutationVersion: organizationResourceMutationState.mutationVersion,
      fenceEpoch: organizationResourceMutationState.fenceEpoch })
      .from(organizationResourceMutationState)
      .where(eq(organizationResourceMutationState.resourceId, resource.id)))
      .toEqual([{ owner: "rust", mutationVersion: 11n, fenceEpoch: 3n }]);
    expect(await db.select({ name: organizationResources.name })
      .from(organizationResources)
      .where(eq(organizationResources.id, resource.id)))
      .toEqual([{ name: "Rust-owned Library row" }]);
  });
});
