import type { Db } from "@rudderhq/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@rudderhq/shared";
import { Router, type NextFunction, type Request, type Response } from "express";
import { markHttpRequestBodySensitive } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { secretService } from "../services/index.js";
import {
  RustFoundationBridgeError,
  type RustFoundationBridge,
  type RustFoundationResponse,
} from "../services/rust-foundation-bridge.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

function sendNativeResponse(res: Response, result: RustFoundationResponse) {
  res.status(result.status).setHeader("content-type", result.contentType).send(result.body);
}

function unavailable(res: Response) {
  res.status(503).json({
    error: "Rust Secrets is unavailable",
    code: "rust_foundation_secrets_unavailable",
  });
}

export function secretRoutes(db: Db, native?: RustFoundationBridge) {
  const router = Router();
  const markSensitiveMutationBody = (req: Request, _res: Response, next: NextFunction) => {
    markHttpRequestBodySensitive(req);
    next();
  };
  // The Node service remains available to runtime secret resolution and the
  // managed-MCP implementation. Public CRUD is owned by the Rust foundation.
  const svc = secretService(db);
  const configuredDefaultProvider = process.env.RUDDER_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  async function execute(req: Request, res: Response, orgId: string, input: Record<string, unknown>) {
    if (!native?.secret) {
      unavailable(res);
      return;
    }
    try {
      sendNativeResponse(res, await native.secret(req.actor, orgId, input));
    } catch (error) {
      if (!(error instanceof RustFoundationBridgeError)) throw error;
      unavailable(res);
    }
  }

  router.get("/orgs/:orgId/secret-providers", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    await execute(req, res, orgId, { operation: "providers" });
  });

  router.get("/orgs/:orgId/secrets", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    await execute(req, res, orgId, { operation: "list" });
  });

  router.post("/orgs/:orgId/secrets", markSensitiveMutationBody, validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    await execute(req, res, orgId, {
      operation: "create",
      input: { ...req.body, provider: req.body.provider ?? defaultProvider },
    });
  });

  router.post("/secrets/:id/rotate", markSensitiveMutationBody, validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    await execute(req, res, existing.orgId, { operation: "rotate", id, input: req.body });
  });

  router.patch("/secrets/:id", markSensitiveMutationBody, validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    await execute(req, res, existing.orgId, { operation: "update", id, input: req.body });
  });

  router.delete("/secrets/:id", markSensitiveMutationBody, async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);
    await execute(req, res, existing.orgId, { operation: "delete", id });
  });

  return router;
}
