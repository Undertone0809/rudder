import type { Db } from "@rudderhq/db";
import { Router } from "express";
import { createLlmReflectionAuthorizer, renderLlmReflectionDocument } from "../services/llm-reflection.js";

export function llmRoutes(db: Db) {
  const router = Router();
  const assertCanRead = createLlmReflectionAuthorizer(db);

  router.get("/llms/agent-configuration.txt", async (req, res) => {
    await assertCanRead(req);
    const document = renderLlmReflectionDocument({ kind: "index" });
    res.status(document.status).type("text/plain").send(document.body);
  });

  router.get("/llms/agent-icons.txt", async (req, res) => {
    await assertCanRead(req);
    const document = renderLlmReflectionDocument({ kind: "icons" });
    res.status(document.status).type("text/plain").send(document.body);
  });

  router.get("/llms/agent-configuration/:agentRuntimeType.txt", async (req, res) => {
    await assertCanRead(req);
    const document = renderLlmReflectionDocument({
      kind: "adapter",
      adapterType: req.params.agentRuntimeType as string,
    });
    res.status(document.status).type("text/plain").send(document.body);
  });

  return router;
}
