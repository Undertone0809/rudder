import type { Db } from "@rudderhq/db";
import { createAssetImageMetadataSchema } from "@rudderhq/shared";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { buildContentResponsePolicy } from "../content-response-policy.js";
import { assetService, logActivity } from "../services/index.js";
import type { StorageService } from "../storage/types.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

const SAFE_RASTER_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
]);

export function assetRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = assetService(db);
  const assetUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });
  const companyLogoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });

  async function runSingleFileUpload(
    upload: ReturnType<typeof multer>,
    req: Request,
    res: Response,
  ) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  router.post("/orgs/:orgId/assets/images", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    try {
      await runSingleFileUpload(assetUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `File exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const parsedMeta = createAssetImageMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid image metadata", details: parsedMeta.error.issues });
      return;
    }

    const namespaceSuffix = parsedMeta.data.namespace ?? "general";
    const contentType = (file.mimetype || "").toLowerCase();
    if (!SAFE_RASTER_IMAGE_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported file type: ${contentType || "unknown"}` });
      return;
    }
    const fileBody = file.buffer;
    if (fileBody.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      orgId,
      namespace: `assets/${namespaceSuffix}`,
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
    });

    const asset = await svc.create(orgId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
      },
    });

    res.status(201).json({
      assetId: asset.id,
      orgId: asset.orgId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  router.post("/orgs/:orgId/logo", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    try {
      await runSingleFileUpload(companyLogoUpload, req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Image exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }

    const contentType = (file.mimetype || "").toLowerCase();
    if (!SAFE_RASTER_IMAGE_CONTENT_TYPES.has(contentType)) {
      res.status(422).json({ error: `Unsupported image type: ${contentType || "unknown"}` });
      return;
    }

    const fileBody = file.buffer;

    if (fileBody.length <= 0) {
      res.status(422).json({ error: "Image is empty" });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      orgId,
      namespace: "assets/orgs",
      originalFilename: file.originalname || null,
      contentType,
      body: fileBody,
    });

    const asset = await svc.create(orgId, {
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "asset.created",
      entityType: "asset",
      entityId: asset.id,
      details: {
        originalFilename: asset.originalFilename,
        contentType: asset.contentType,
        byteSize: asset.byteSize,
        namespace: "assets/orgs",
      },
    });

    res.status(201).json({
      assetId: asset.id,
      orgId: asset.orgId,
      provider: asset.provider,
      objectKey: asset.objectKey,
      contentType: asset.contentType,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      originalFilename: asset.originalFilename,
      createdByAgentId: asset.createdByAgentId,
      createdByUserId: asset.createdByUserId,
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      contentPath: `/api/assets/${asset.id}/content`,
    });
  });

  router.get("/assets/:assetId/content", async (req, res, next) => {
    const assetId = req.params.assetId as string;
    const asset = await svc.getById(assetId);
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    assertCompanyAccess(req, asset.orgId);

    const object = await storage.getObject(asset.orgId, asset.objectKey);
    const responseContentType = asset.contentType || object.contentType || "application/octet-stream";
    const responsePolicy = buildContentResponsePolicy(
      responseContentType,
      asset.originalFilename ?? "asset",
      "asset",
    );
    res.setHeader("Content-Type", responseContentType);
    res.setHeader("Content-Length", String(asset.byteSize || object.contentLength || 0));
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (responsePolicy.contentSecurityPolicy) {
      res.setHeader("Content-Security-Policy", responsePolicy.contentSecurityPolicy);
    }
    res.setHeader("Content-Disposition", responsePolicy.contentDisposition);

    object.stream.on("error", (err) => {
      next(err);
    });
    object.stream.pipe(res);
  });

  return router;
}
