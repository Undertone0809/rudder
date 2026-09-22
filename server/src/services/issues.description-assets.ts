import { assets } from "@rudderhq/db";
import { isUuidLike } from "@rudderhq/shared";
import { and, eq, inArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { StorageService } from "../storage/types.js";
import { lockNodeMutationAuthority } from "./organization-mutation-fence.js";

const ISSUE_DESCRIPTION_ASSET_PATH_RE = /\/api\/assets\/([^/?#\s)]+)\/content/g;

export function extractIssueDescriptionAssetIds(description: string | null | undefined): string[] {
  if (!description) return [];
  const ids = new Set<string>();
  for (const match of description.matchAll(ISSUE_DESCRIPTION_ASSET_PATH_RE)) {
    const assetId = match[1]?.trim();
    if (assetId && isUuidLike(assetId)) ids.add(assetId.toLowerCase());
  }
  return [...ids];
}

export function rewriteIssueDescriptionAssetPaths(
  description: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return description.replace(ISSUE_DESCRIPTION_ASSET_PATH_RE, (full, assetId: string) => {
    return replacements.get(assetId.toLowerCase()) ?? full;
  });
}

async function readStorageObject(stream: AsyncIterable<Buffer | string | Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

type StagedIssueDescriptionAttachment = {
  attachmentId: string;
  assetId: string;
};

export async function stageIssueDescriptionAssets(input: {
  tx: any;
  storage: StorageService;
  orgId: string;
  issueId: string;
  description: string | null | undefined;
  copiedObjectKeys: Array<{ orgId: string; objectKey: string }>;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
}) {
  await lockNodeMutationAuthority(input.tx, input.orgId);
  const sourceAssetIds = extractIssueDescriptionAssetIds(input.description);
  if (sourceAssetIds.length === 0) {
    return {
      description: input.description,
      attachments: [] as StagedIssueDescriptionAttachment[],
    };
  }

  const sourceAssets: Array<typeof assets.$inferSelect> = await input.tx
    .select()
    .from(assets)
    .where(and(eq(assets.orgId, input.orgId), inArray(assets.id, sourceAssetIds)));
  const sourceAssetsById = new Map(sourceAssets.map((asset) => [asset.id, asset]));
  const replacements = new Map<string, string>();
  const attachments: StagedIssueDescriptionAttachment[] = [];

  for (const sourceAssetId of sourceAssetIds) {
    const sourceAsset = sourceAssetsById.get(sourceAssetId);
    if (!sourceAsset) {
      throw unprocessable("Issue description image asset is missing or outside the organization");
    }

    let stored: Awaited<ReturnType<StorageService["putFile"]>>;
    try {
      const object = await input.storage.getObject(input.orgId, sourceAsset.objectKey);
      const body = await readStorageObject(object.stream);
      if (body.length === 0) throw new Error("Issue description image asset is empty");
      stored = await input.storage.putFile({
        orgId: input.orgId,
        namespace: `issues/${input.issueId}/description`,
        originalFilename: sourceAsset.originalFilename,
        contentType: sourceAsset.contentType || object.contentType || "application/octet-stream",
        body,
      });
    } catch (error) {
      logger.warn(
        { err: error, orgId: input.orgId, assetId: sourceAsset.id, issueId: input.issueId },
        "failed to preserve an Issue description asset",
      );
      throw unprocessable("Issue description image could not be saved; please retry the Issue creation");
    }

    input.copiedObjectKeys.push({ orgId: input.orgId, objectKey: stored.objectKey });
    const [copiedAsset] = await input.tx
      .insert(assets)
      .values({
        orgId: input.orgId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: input.createdByAgentId ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning({ id: assets.id });
    if (!copiedAsset) throw new Error("Failed to create preserved Issue description asset");

    const attachmentId = randomUUID();
    attachments.push({ attachmentId, assetId: copiedAsset.id });
    replacements.set(sourceAsset.id, `/api/attachments/${attachmentId}/content`);
  }

  return {
    description: typeof input.description === "string"
      ? rewriteIssueDescriptionAssetPaths(input.description, replacements)
      : input.description,
    attachments,
  };
}
