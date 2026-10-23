import type { Db } from "@rudderhq/db";
import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { organizationRoutes } from "../routes/orgs.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const ORG = "10000000-0000-4000-8000-000000000001";
const RESOURCE = "20000000-0000-4000-8000-000000000001";
const BOARD = { type: "board", source: "local_implicit", userId: "synthetic-user" } as const;

function app(actor: Request["actor"] = BOARD) {
  const result = express();
  const organizationCatalogRead = vi.fn();
  const organizationResourceMutation = vi.fn();
  const dbExecute = vi.fn();
  const db = { execute: dbExecute } as unknown as Db;
  const bridge = { organizationCatalogRead, organizationResourceMutation } as unknown as RustFoundationBridge;
  result.use((req, _res, next) => { req.actor = actor; next(); });
  result.use("/api/orgs", organizationRoutes(db, undefined, undefined, bridge));
  result.use(errorHandler);
  return { app: result, organizationCatalogRead, organizationResourceMutation, dbExecute };
}

describe("Organization catalog Node route retirement", () => {
  it("does not register the catalog resource CRUD or read paths on the Node router", async () => {
    const instance = app();
    const requests = [
      () => request(instance.app).get(`/api/orgs/${ORG}/resources`),
      () => request(instance.app).post(`/api/orgs/${ORG}/resources`).send({ name: "No Node create" }),
      () => request(instance.app).patch(`/api/orgs/${ORG}/resources/${RESOURCE}`).send({ name: "No Node update" }),
      () => request(instance.app).delete(`/api/orgs/${ORG}/resources/${RESOURCE}`),
      () => request(instance.app).get(`/api/orgs/${ORG}/intelligence-profiles`),
    ];

    for (const makeRequest of requests) {
      expect((await makeRequest()).status).toBe(404);
    }
    expect(instance.organizationCatalogRead).not.toHaveBeenCalled();
    expect(instance.organizationResourceMutation).not.toHaveBeenCalled();
    expect(instance.dbExecute).not.toHaveBeenCalled();
  });
});
