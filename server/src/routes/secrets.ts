import { Router } from "express";
import type { Db } from "@rudderhq/db";
import {
  SECRET_PROVIDERS,
  type SecretProvider,
  createSecretSchema,
  rotateSecretSchema,
  updateSecretSchema,
} from "@rudderhq/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";

export function secretRoutes(db: Db) {
  const router = Router();
  const svc = secretService(db);
  const configuredDefaultProvider = process.env.RUDDER_SECRETS_PROVIDER;
  const defaultProvider = (
    configuredDefaultProvider && SECRET_PROVIDERS.includes(configuredDefaultProvider as SecretProvider)
      ? configuredDefaultProvider
      : "local_encrypted"
  ) as SecretProvider;

  router.get("/orgs/:orgId/secret-providers", (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    res.json(svc.listProviders());
  });

  router.get("/orgs/:orgId/secrets", async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const secrets = await svc.list(orgId);
    res.json(secrets);
  });

  router.post("/orgs/:orgId/secrets", validate(createSecretSchema), async (req, res) => {
    assertBoard(req);
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);

    const created = await svc.create(
      orgId,
      {
        name: req.body.name,
        provider: req.body.provider ?? defaultProvider,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
  });

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);

    const rotated = await svc.rotate(
      id,
      {
        value: req.body.value,
        externalRef: req.body.externalRef,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      orgId: rotated.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: { version: rotated.latestVersion },
    });

    res.json(rotated);
  });

  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);

    const updated = await svc.update(id, {
      name: req.body.name,
      description: req.body.description,
      externalRef: req.body.externalRef,
    });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      orgId: updated.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    assertCompanyAccess(req, existing.orgId);

    const removed = await svc.remove(id);
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      orgId: removed.orgId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  return router;
}
