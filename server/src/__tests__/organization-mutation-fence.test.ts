import type { Db } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { lockNodeMutationAuthority } from "../services/organization-mutation-fence.js";
import { organizationService } from "../services/orgs.js";
import { projectService } from "../services/projects.js";
import { resourceCatalogService } from "../services/resource-catalog.js";

const ORGANIZATION_ID = "00000000-0000-0000-0000-000000000001";
const PROJECT_ID = "00000000-0000-0000-0000-000000000002";
const RESOURCE_ID = "00000000-0000-0000-0000-000000000003";
const ATTACHMENT_ID = "00000000-0000-0000-0000-000000000004";

function createFailClosedDb(selectRows: unknown[] = []) {
  const tx = {
    execute: vi.fn().mockResolvedValue([]),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve(selectRows)),
      })),
    })),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as Db;
  return { db, tx };
}

describe("organization mutation authority fence", () => {
  it("locks and accepts a provisioned Node-owned row", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        owner: "node",
        mutation_version: "0",
        fence_epoch: "0",
        fence_token: "11111111-1111-4111-8111-111111111111",
      },
    ]);

    await expect(lockNodeMutationAuthority({ execute }, "00000000-0000-0000-0000-000000000001"))
      .resolves.toMatchObject({ owner: "node" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toBeTruthy();
  });

  it("rejects an unprovisioned row before a legacy writer can mutate", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(lockNodeMutationAuthority({ execute }, "00000000-0000-0000-0000-000000000001"))
      .rejects.toMatchObject<HttpError>({ status: 409 });
  });

  it("rejects a Rust-owned row so a stale Node transaction cannot write", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        owner: "rust",
        mutation_version: "12",
        fence_epoch: "4",
        fence_token: "11111111-1111-4111-8111-111111111111",
      },
    ]);

    await expect(lockNodeMutationAuthority({ execute }, "00000000-0000-0000-0000-000000000001"))
      .rejects.toMatchObject<HttpError>({ status: 409 });
  });

  it("rejects a malformed fencing token before a legacy writer can mutate", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        owner: "node",
        mutation_version: "12",
        fence_epoch: "4",
        fence_token: "stale-token",
      },
    ]);

    await expect(lockNodeMutationAuthority({ execute }, "00000000-0000-0000-0000-000000000001"))
      .rejects.toMatchObject<HttpError>({ status: 409 });
  });

  it("rejects malformed mutation fence counters before a legacy writer can mutate", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        owner: "node",
        mutation_version: "not-a-counter",
        fence_epoch: "4",
        fence_token: "11111111-1111-4111-8111-111111111111",
      },
    ]);

    await expect(lockNodeMutationAuthority({ execute }, "00000000-0000-0000-0000-000000000001"))
      .rejects.toMatchObject<HttpError>({ status: 409 });
  });

  it.each([
    ["organization archive", (db: Db) => organizationService(db).archive(ORGANIZATION_ID), "update", []],
    ["organization remove", (db: Db) => organizationService(db).remove(ORGANIZATION_ID), "delete", []],
    [
      "project remove",
      (db: Db) => projectService(db).remove(PROJECT_ID),
      "delete",
      [{ orgId: ORGANIZATION_ID }],
    ],
    [
      "organization resource create",
      (db: Db) => resourceCatalogService(db).createOrganizationResource(ORGANIZATION_ID, {
        name: "Resource",
        kind: "file",
        locator: "https://example.test/resource",
      }),
      "insert",
      [],
    ],
    [
      "organization resource update",
      (db: Db) => resourceCatalogService(db).updateOrganizationResource(ORGANIZATION_ID, RESOURCE_ID, {}),
      "update",
      [],
    ],
    [
      "organization resource remove",
      (db: Db) => resourceCatalogService(db).removeOrganizationResource(ORGANIZATION_ID, RESOURCE_ID),
      "delete",
      [],
    ],
    [
      "project resource replacement",
      (db: Db) => resourceCatalogService(db).replaceProjectResourceAttachments({
        orgId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        attachments: [],
      }),
      "delete",
      [],
    ],
    [
      "project resource create",
      (db: Db) => resourceCatalogService(db).createProjectResourceAttachment(PROJECT_ID, {
        resourceId: RESOURCE_ID,
      }),
      "insert",
      [{ orgId: ORGANIZATION_ID }],
    ],
    [
      "project resource update",
      (db: Db) => resourceCatalogService(db).updateProjectResourceAttachment(PROJECT_ID, ATTACHMENT_ID, {}),
      "update",
      [{ id: ATTACHMENT_ID, orgId: ORGANIZATION_ID, resourceId: RESOURCE_ID }],
    ],
    [
      "project resource remove",
      (db: Db) => resourceCatalogService(db).removeProjectResourceAttachment(PROJECT_ID, ATTACHMENT_ID),
      "delete",
      [{ id: ATTACHMENT_ID, orgId: ORGANIZATION_ID, resourceId: RESOURCE_ID }],
    ],
  ] as const)("fails closed before the first %s business write", async (_name, writer, writeMethod, selectRows) => {
    const { db, tx } = createFailClosedDb(selectRows);

    await expect(writer(db)).rejects.toMatchObject<HttpError>({ status: 409 });
    expect(tx[writeMethod]).not.toHaveBeenCalled();
  });
});
