import type { Db } from "@rudderhq/db";
import { aiSearchRequestSchema } from "@rudderhq/shared";
import { Router } from "express";
import { validate } from "../middleware/validate.js";
import { aiSearchService } from "../services/ai-search.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function aiSearchRoutes(db: Db) {
  const router = Router();
  const search = aiSearchService(db);

  router.post(
    "/:orgId/ai-search",
    validate(aiSearchRequestSchema),
    async (req, res) => {
      const orgId = req.params.orgId as string;
      assertCompanyAccess(req, orgId);
      assertBoard(req);
      res.json(await search.search(orgId, req.body.query, req.body.scope));
    },
  );

  return router;
}
