import type { AuthRequirement } from "@rudderhq/shared";
import type { RequestHandler } from "express";

export function accountSessionRequired(
  authRequirement: AuthRequirement,
): RequestHandler {
  return (req, res, next) => {
    if (
      authRequirement !== "required"
      || req.actor.type === "board"
      || req.actor.type === "agent"
      || req.path === "/api/auth/local-exchange"
      || req.path === "/api/auth/local-offline"
      || req.path === "/api/health"
      || req.path.startsWith("/api/health/")
    ) {
      next();
      return;
    }
    res.status(401).json({
      error: "Rudder Account session required",
      code: "account_session_required",
    });
  };
}
