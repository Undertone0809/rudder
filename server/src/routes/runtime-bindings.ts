import { Router, type Request, type Response } from "express";
import { unauthorized } from "../errors.js";
import { callRuntimeBinding, type RuntimeBindingInput } from "../services/runtime-binding-bridge.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

/** Read transport only. Rust validates organization/target ownership and
 * projects the immutable binding. No database handle or legacy read fallback. */
export function runtimeBindingRoutes(bridge?: RustFoundationBridge) {
  const router = Router();
  async function forward(req: Request, res: Response, input: RuntimeBindingInput) {
    if (req.actor.type === "none") throw unauthorized();
    const response = await callRuntimeBinding(bridge, req.actor, req.params.orgId as string, input);
    res.status(response.status).set("content-type", response.contentType).send(response.body);
  }
  router.get("/orgs/:orgId/chats/:chatId/runtime-binding", (req, res) => forward(req, res, {
    operation: "public_current",
    target: { targetType: "chat_conversation", targetId: req.params.chatId as string },
  }));
  router.get("/orgs/:orgId/runtime-bindings/:bindingId", (req, res) => forward(req, res, {
    operation: "public_read", bindingId: req.params.bindingId as string,
  }));
  return router;
}
