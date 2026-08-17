import { workspaceBackups, type Db } from "@rudderhq/db";
import { and, eq } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultBackupDir, resolveOrganizationWorkspaceRoot } from "../home-paths.js";
import { walkWorkspaceBackupV2 } from "./workspace-backup-v2.js";
import type { WorkspaceRestoreReceipt } from "./workspace-backups.js";

async function pathExists(targetPath: string) {
  return fs.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function syncDirectory(directoryPath: string) {
  const handle = await fs.open(directoryPath, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function workspaceTreeSha256(rootPath: string) {
  return (await walkWorkspaceBackupV2(rootPath)).treeSha256;
}

async function readRestoreReceipt(filePath: string): Promise<WorkspaceRestoreReceipt | null> {
  try {
    const value = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<WorkspaceRestoreReceipt>;
    if (value.version !== 1 || typeof value.operationId !== "string" || typeof value.orgId !== "string"
      || typeof value.backupId !== "string"
      || !["prepared", "live_moved", "committed", "rolled_back", "recovery_required"].includes(value.phase ?? "")
      || typeof value.workspaceRoot !== "string" || typeof value.stagingRoot !== "string"
      || typeof value.rollbackRoot !== "string"
      || (value.liveTreeSha256 !== null && typeof value.liveTreeSha256 !== "string")
      || typeof value.stagingTreeSha256 !== "string"
      || (value.expectedTreeSha256 !== null && typeof value.expectedTreeSha256 !== "string")
      || typeof value.preRestoreBackupId !== "string") return null;
    return value as WorkspaceRestoreReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function isOwnedRestoreRoot(root: string, workspaceRoot: string, operationId: string, kind: "staging" | "rollback") {
  return path.resolve(root) !== path.resolve(workspaceRoot)
    && path.resolve(root) === path.resolve(path.dirname(workspaceRoot), `.rudder-workspace-restore-${kind}-${operationId}`);
}

/** Reconcile only validated receipts and their exact operation-owned roots. */
export async function reconcileWorkspaceRestoreReceipts(db?: Db): Promise<{
  recovered: string[];
  blocked: Array<{ receiptPath: string; operationId: string; error: string }>;
}> {
  const receiptRoot = path.resolve(resolveDefaultBackupDir(), "workspace-restore-receipts");
  const recovered: string[] = [];
  const blocked: Array<{ receiptPath: string; operationId: string; error: string }> = [];
  let names: string[];
  try { names = await fs.readdir(receiptRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { recovered, blocked };
    throw error;
  }
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const receiptPath = path.join(receiptRoot, name);
    let receipt: WorkspaceRestoreReceipt | null = null;
    try { receipt = await readRestoreReceipt(receiptPath); } catch (error) {
      blocked.push({ receiptPath, operationId: "unknown", error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    let canonicalWorkspaceRoot: string | null = null;
    try { if (receipt?.orgId) canonicalWorkspaceRoot = path.resolve(resolveOrganizationWorkspaceRoot(receipt.orgId)); } catch { canonicalWorkspaceRoot = null; }
    if (!receipt || !canonicalWorkspaceRoot
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(receipt.operationId)
      || path.resolve(receipt.workspaceRoot) !== canonicalWorkspaceRoot
      || !isOwnedRestoreRoot(receipt.stagingRoot, receipt.workspaceRoot, receipt.operationId, "staging")
      || !isOwnedRestoreRoot(receipt.rollbackRoot, receipt.workspaceRoot, receipt.operationId, "rollback")) {
      blocked.push({ receiptPath, operationId: receipt?.operationId ?? "unknown", error: "invalid_or_unowned_receipt" });
      continue;
    }
    try {
      const workspace = await pathExists(receipt.workspaceRoot);
      const rollback = await pathExists(receipt.rollbackRoot);
      const expectedPublishedTree = receipt.expectedTreeSha256 ?? receipt.stagingTreeSha256;
      let publishedRestore = false;
      if (receipt.phase === "prepared") {
        if (workspace && rollback) throw new Error("prepared receipt has conflicting live and rollback roots");
        if (!workspace && rollback) {
          if (!receipt.liveTreeSha256 || await workspaceTreeSha256(receipt.rollbackRoot) !== receipt.liveTreeSha256) throw new Error("prepared rollback tree does not match recorded live tree");
          await fs.rename(receipt.rollbackRoot, receipt.workspaceRoot);
          await syncDirectory(path.dirname(receipt.workspaceRoot));
        }
      } else if (receipt.phase === "committed") {
        if (!workspace) throw new Error("committed receipt workspace is missing");
        if (await workspaceTreeSha256(receipt.workspaceRoot) !== expectedPublishedTree) {
          throw new Error("committed workspace tree does not match receipt");
        }
        publishedRestore = true;
      } else if (receipt.phase === "rolled_back") {
        if (!workspace) throw new Error("rolled_back receipt workspace is missing");
        if (receipt.liveTreeSha256 && await workspaceTreeSha256(receipt.workspaceRoot) !== receipt.liveTreeSha256) throw new Error("rolled_back workspace tree does not match recorded live tree");
      } else if (receipt.phase === "live_moved" || receipt.phase === "recovery_required") {
        if (!workspace && rollback) {
          if (!receipt.liveTreeSha256 || await workspaceTreeSha256(receipt.rollbackRoot) !== receipt.liveTreeSha256) throw new Error("rollback tree does not match recorded live tree");
          await fs.rename(receipt.rollbackRoot, receipt.workspaceRoot);
          await syncDirectory(path.dirname(receipt.workspaceRoot));
        } else if (workspace && !rollback) {
          if (await workspaceTreeSha256(receipt.workspaceRoot) !== expectedPublishedTree) throw new Error("published workspace tree does not match receipt");
          publishedRestore = true;
        } else if (workspace && rollback) {
          if (await workspaceTreeSha256(receipt.workspaceRoot) === expectedPublishedTree) publishedRestore = true;
          else if (receipt.liveTreeSha256 && await workspaceTreeSha256(receipt.rollbackRoot) === receipt.liveTreeSha256) {
            await fs.rm(receipt.workspaceRoot, { recursive: true, force: true });
            await fs.rename(receipt.rollbackRoot, receipt.workspaceRoot);
            await syncDirectory(path.dirname(receipt.workspaceRoot));
          } else throw new Error("workspace and rollback roots match neither recorded tree");
        } else throw new Error("workspace and rollback roots are both missing");
      }
      if (publishedRestore && db) {
        const [updated] = await db.update(workspaceBackups).set({ status: "restored", updatedAt: new Date() })
          .where(and(eq(workspaceBackups.id, receipt.backupId), eq(workspaceBackups.orgId, receipt.orgId))).returning({ id: workspaceBackups.id });
        if (!updated) throw new Error("restore receipt backup row is missing");
      }
      await fs.rm(receipt.stagingRoot, { recursive: true, force: true });
      await fs.rm(receipt.rollbackRoot, { recursive: true, force: true });
      await fs.rm(receiptPath, { force: true });
      await syncDirectory(receiptRoot);
      recovered.push(receipt.operationId);
    } catch (error) {
      blocked.push({ receiptPath, operationId: receipt.operationId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { recovered, blocked };
}
