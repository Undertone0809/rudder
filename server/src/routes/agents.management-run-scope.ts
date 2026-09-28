import type { Request } from "express";
import type { RunIntelligenceAccessScope } from "../services/run-intelligence-access.js";
import { getAuthorizedOrgScope } from "./authz.js";

export function runIntelligenceScope(req: Request, notFoundMessage?: string): RunIntelligenceAccessScope {
  return {
    orgIds: getAuthorizedOrgScope(req),
    sideChatOwnerId: req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null,
    ...(notFoundMessage ? { notFoundMessage } : {}),
  };
}
