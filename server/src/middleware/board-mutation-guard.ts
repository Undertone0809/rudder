import type { Request, RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function trustedOriginsForRequest(req: Request) {
  const origins = new Set<string>();
  const host = req.header("host")?.trim();
  if (host) {
    origins.add(`http://${host}`.toLowerCase());
    origins.add(`https://${host}`.toLowerCase());
  }
  return origins;
}

function isTrustedBoardMutationRequest(req: Request) {
  const allowedOrigins = trustedOriginsForRequest(req);
  const rawOrigin = req.header("origin");
  if (rawOrigin !== undefined) {
    const origin = parseOrigin(rawOrigin);
    return origin !== null && allowedOrigins.has(origin);
  }

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
}

export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local-trusted mode and board bearer keys also support non-browser clients,
    // where Origin/Referer can legitimately be absent. When either header is
    // present, however, treat the request as browser-originated and enforce the
    // same-origin check so arbitrary websites cannot mutate a localhost board.
    if (req.actor.source === "local_implicit" || req.actor.source === "board_key") {
      const fetchSite = req.header("sec-fetch-site")?.trim().toLowerCase();
      if (
        !req.header("origin")
        && !req.header("referer")
        && (!fetchSite || fetchSite === "same-origin" || fetchSite === "none")
      ) {
        next();
        return;
      }
    }

    if (!isTrustedBoardMutationRequest(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
