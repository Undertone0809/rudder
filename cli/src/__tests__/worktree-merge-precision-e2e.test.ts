import { applyPendingMigrations, createDb, ensurePostgresDatabase } from "@rudderhq/db";
import EmbeddedPostgres from "embedded-postgres";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statfsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMergePlan, collectMergePlan } from "../commands/worktree-merge.js";

const timestampFields = {
  projects: ["paused_at", "archived_at", "created_at", "updated_at"],
  project_workspaces: ["created_at", "updated_at"],
  issues: ["started_at", "completed_at", "cancelled_at", "hidden_at", "created_at", "updated_at"],
  issue_comments: ["created_at", "updated_at"],
  documents: ["created_at", "updated_at"],
  issue_documents: ["created_at", "updated_at"],
  document_revisions: ["created_at"],
  assets: ["created_at", "updated_at"],
  issue_attachments: ["created_at", "updated_at"],
} as const;

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("No test port")));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

// Uses two disposable databases in one temporary cluster; no configured user DB.
describe("worktree merge exact PostgreSQL timestamps", () => {
  let root = "";
  let pg: EmbeddedPostgres | undefined;
  let started = false;
  const databases: ReturnType<typeof createDb>[] = [];
  const orgId = randomUUID();
  const ids = Object.fromEntries(Object.keys(timestampFields).map((name) => [name, randomUUID()]));
  const company = { id: orgId, name: "Merge precision", issuePrefix: "PREC" };
  const storage = { getObject: async () => Buffer.from("fixture"), putObject: async () => ({}) } as never;

  beforeAll(async () => {
    const disk = statfsSync(os.tmpdir());
    if (disk.bavail * disk.bsize < 1100 * 1024 * 1024) throw new Error("Need 1.1 GiB free before disposable precision test");
    root = mkdtempSync(path.join(os.tmpdir(), "rudder-merge-precision-"));
    const port = await freePort();
    const startupLog: string[] = [];
    pg = new EmbeddedPostgres({ databaseDir: path.join(root, "pg"), user: "rudder", password: "rudder", port,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: (message) => startupLog.push(String(message)), onError: (message) => startupLog.push(String(message)) });
    try {
      await pg.initialise();
      await pg.start();
    } catch (error) {
      throw new Error(`Disposable PostgreSQL startup failed: ${String(error)}\n${startupLog.join("\n").slice(-4000)}`);
    }
    started = true;
    for (const name of ["merge_source", "merge_target"]) {
      await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, name);
      const url = `postgres://rudder:rudder@127.0.0.1:${port}/${name}`;
      await applyPendingMigrations(url);
      const db = createDb(url);
      databases.push(db);
      await db.$client.unsafe("INSERT INTO organizations (id,url_key,name,issue_prefix) VALUES ($1,$2,'Merge precision','PREC')", [orgId, orgId]);
    }
    const source = databases[0].$client;
    await source.unsafe("INSERT INTO projects (id,org_id,name) VALUES ($1,$2,'Precise project')", [ids.projects, orgId]);
    await source.unsafe("INSERT INTO project_workspaces (id,org_id,project_id,name) VALUES ($1,$2,$3,'Precise workspace')", [ids.project_workspaces, orgId, ids.projects]);
    await source.unsafe("INSERT INTO issues (id,org_id,project_id,project_workspace_id,title,status,issue_number,identifier) VALUES ($1,$2,$3,$4,'Precise issue','todo',1,'PREC-1')", [ids.issues, orgId, ids.projects, ids.project_workspaces]);
    await source.unsafe("INSERT INTO issue_comments (id,org_id,issue_id,body) VALUES ($1,$2,$3,'Comment')", [ids.issue_comments, orgId, ids.issues]);
    await source.unsafe("INSERT INTO documents (id,org_id,title,latest_body,latest_revision_id) VALUES ($1,$2,'Doc','Body',$3)", [ids.documents, orgId, ids.document_revisions]);
    await source.unsafe("INSERT INTO issue_documents (id,org_id,issue_id,document_id,key) VALUES ($1,$2,$3,$4,'plan')", [ids.issue_documents, orgId, ids.issues, ids.documents]);
    await source.unsafe("INSERT INTO document_revisions (id,org_id,document_id,revision_number,body) VALUES ($1,$2,$3,1,'Body')", [ids.document_revisions, orgId, ids.documents]);
    await source.unsafe("INSERT INTO assets (id,org_id,provider,object_key,content_type,byte_size,sha256) VALUES ($1,$2,'local_disk','fixture','text/plain',7,'fixture')", [ids.assets, orgId]);
    await source.unsafe("INSERT INTO issue_attachments (id,org_id,issue_id,asset_id) VALUES ($1,$2,$3,$4)", [ids.issue_attachments, orgId, ids.issues, ids.assets]);
    for (const [table, fields] of Object.entries(timestampFields)) {
      for (const [index, field] of fields.entries()) {
        // Different offsets and microseconds must survive driver decoding.
        const literal = index % 2 ? "2026-10-03 08:18:34.999999-05" : "2026-10-03 21:18:34.228710+08";
        await source.unsafe(`UPDATE ${table} SET ${field} = $1::timestamptz WHERE id = $2`, [literal, ids[table]]);
      }
    }
    await source.unsafe("UPDATE projects SET paused_at=NULL WHERE id=$1", [ids.projects]);
    await source.unsafe("UPDATE issues SET cancelled_at=NULL WHERE id=$1", [ids.issues]);
  }, 120_000);

  afterAll(async () => {
    try {
      await Promise.all(databases.map((db) => db.$client.end({ timeout: 5 })));
    } finally {
      // If stop fails, retain the owned directory for diagnosis rather than
      // remove files beneath a possibly running PostgreSQL process.
      if (started) await pg?.stop();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  async function collectAndApply() {
    const { plan } = await collectMergePlan({ sourceDb: databases[0] as never, targetDb: databases[1] as never,
      company, scopes: ["issues", "comments"], importProjectIds: [ids.projects] });
    const result = await applyMergePlan({ plan, company, sourceStorages: [storage], targetStorage: storage, targetDb: databases[1] as never });
    return { plan, result };
  }

  async function exactSnapshot(db: ReturnType<typeof createDb>) {
    const values: Record<string, unknown> = {};
    for (const [table, fields] of Object.entries(timestampFields)) {
      const selection = fields.map((field) => `to_char(${field} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${field}`).join(",");
      values[table] = (await db.$client.unsafe(`SELECT ${selection} FROM ${table} WHERE id=$1`, [ids[table]]))[0];
    }
    return values;
  }

  it("copies all 23 timestamp fields through collection, planning and apply, then remains idempotent", async () => {
    const first = await collectAndApply();
    expect(first.result).toMatchObject({ insertedProjects: 1, insertedProjectWorkspaces: 1, insertedIssues: 1,
      insertedComments: 1, insertedDocuments: 1, insertedDocumentRevisions: 1, insertedAttachments: 1 });
    const expected = await exactSnapshot(databases[0]);
    expect(await exactSnapshot(databases[1])).toEqual(expected);
    const again = await collectAndApply();
    expect(again.result).toMatchObject({ insertedProjects: 0, insertedProjectWorkspaces: 0, insertedIssues: 0,
      insertedComments: 0, insertedDocuments: 0, insertedDocumentRevisions: 0, insertedAttachments: 0 });
    expect(await exactSnapshot(databases[1])).toEqual(expected);

    // Same millisecond, different database instant: do not skip this update.
    await databases[0].$client.unsafe("UPDATE documents SET updated_at=updated_at - interval '1 microsecond' WHERE id=$1", [ids.documents]);
    await databases[0].$client.unsafe("UPDATE issue_documents SET updated_at=updated_at - interval '1 microsecond' WHERE id=$1", [ids.issue_documents]);
    const changed = await collectAndApply();
    expect(changed.result.mergedDocuments).toBe(1);
    expect(await exactSnapshot(databases[1])).toEqual(await exactSnapshot(databases[0]));
    const disk = statfsSync(os.tmpdir());
    expect(disk.bavail * disk.bsize).toBeGreaterThan(700 * 1024 * 1024);
  });
});
