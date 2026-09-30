import { Router, type Request } from "express";
import ipaddr from "ipaddr.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError, badRequest, forbidden, notFound, unauthorized } from "../errors.js";
import { createRustActorEnvelope } from "../services/rust-foundation-bridge.js";
import { assertCompanyAccess } from "./authz.js";

export const PUBLIC_INGRESS_AUTH_ROUTE = "/_internal/rudder-ingress/authorize-member-directory";
export const PUBLIC_INGRESS_AUTH_ENDPOINT = `/api${PUBLIC_INGRESS_AUTH_ROUTE}`;

const INTERNAL_AUTH_HEADER = "x-rudder-ingress-auth";
const MEMBER_DIRECTORY_ACTION = "organization.members.directory.read";
const EMPTY_BODY = Buffer.alloc(0);
const MIN_SECRET_BYTES = 32;
const MAX_SECRET_BYTES = 4_096;
const MAX_REQUEST_BODY_BYTES = 12 * 1_024;
const MAX_ORGANIZATION_ID_BYTES = 128;
const MAX_PUBLIC_PATH_BYTES = 8 * 1_024;
const MAX_REQUEST_TOKEN_BYTES = 128;
const REQUEST_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const ORGANIZATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

export type PublicIngressAuthRouteOptions = {
  internalIngressAuthKey: string;
  actorEnvelopeKey: string;
};

type AuthorizationRequest = {
  organizationId: string;
  publicPath: string;
  requestId: string;
  nonce: string;
};

function requireStrongSecret(name: string, value: string) {
  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < MIN_SECRET_BYTES || byteLength > MAX_SECRET_BYTES) {
    throw new Error(`${name} must be between ${MIN_SECRET_BYTES} and ${MAX_SECRET_BYTES} bytes`);
  }
  if (name === "internalIngressAuthKey" && (!/^[\x21-\x7e]+$/u.test(value) || /\s/u.test(value))) {
    throw new Error(`${name} must contain printable ASCII without whitespace`);
  }
  return value;
}

function hasValidInternalKey(presented: string | undefined, expected: string) {
  if (!presented || Buffer.byteLength(presented, "utf8") > MAX_SECRET_BYTES) return false;
  const presentedDigest = createHash("sha256").update(presented, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

function isLoopbackSocketPeer(remoteAddress: string | undefined) {
  if (!remoteAddress || !ipaddr.isValid(remoteAddress)) return false;
  return ipaddr.process(remoteAddress).range() === "loopback";
}

function assertRequestBodySize(req: Request) {
  const contentLength = req.get("content-length");
  if (contentLength !== undefined) {
    if (!/^\d+$/u.test(contentLength)) throw badRequest("Invalid request content length");
    if (Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large");
    }
  }

  const measuredBytes = req.rawBody?.byteLength
    ?? Buffer.byteLength(JSON.stringify(req.body) ?? "", "utf8");
  if (measuredBytes > MAX_REQUEST_BODY_BYTES) {
    throw new HttpError(413, "Request body is too large");
  }
}

function requireString(value: unknown, field: string, maxBytes: number, pattern?: RegExp) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw badRequest(`Invalid ${field}`);
  }
  if (pattern && !pattern.test(value)) throw badRequest(`Invalid ${field}`);
  return value;
}

function parseAuthorizationRequest(body: unknown): AuthorizationRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Expected a JSON authorization request");
  }
  const keys = Reflect.ownKeys(body);
  const expectedKeys = ["organizationId", "publicPath", "requestId", "nonce"];
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(String(key)))) {
    throw badRequest("Unexpected authorization request fields");
  }

  const request = body as Record<string, unknown>;
  const organizationId = requireString(
    request.organizationId,
    "organizationId",
    MAX_ORGANIZATION_ID_BYTES,
    ORGANIZATION_ID_PATTERN,
  );
  const publicPath = requireString(request.publicPath, "publicPath", MAX_PUBLIC_PATH_BYTES);
  const requestId = requireString(
    request.requestId,
    "requestId",
    MAX_REQUEST_TOKEN_BYTES,
    REQUEST_TOKEN_PATTERN,
  );
  const nonce = requireString(
    request.nonce,
    "nonce",
    MAX_REQUEST_TOKEN_BYTES,
    REQUEST_TOKEN_PATTERN,
  );

  if (!/^[\x21-\x7e]+$/u.test(publicPath) || publicPath.includes("#")) {
    throw badRequest("Invalid member directory path");
  }

  const expectedPath = `/api/orgs/${organizationId}/members/directory`;
  const queryStart = publicPath.indexOf("?");
  const rawPath = queryStart < 0 ? publicPath : publicPath.slice(0, queryStart);
  if (rawPath !== expectedPath) throw badRequest("Unsupported member directory path");

  return { organizationId, publicPath, requestId, nonce };
}

export function publicIngressAuthRoutes(options: PublicIngressAuthRouteOptions) {
  const internalIngressAuthKey = requireStrongSecret(
    "internalIngressAuthKey",
    options.internalIngressAuthKey,
  );
  const actorEnvelopeKey = requireStrongSecret("actorEnvelopeKey", options.actorEnvelopeKey);
  if (internalIngressAuthKey === actorEnvelopeKey) {
    throw new Error("Ingress auth and actor envelope keys must be different");
  }

  const router = Router();
  router.post(PUBLIC_INGRESS_AUTH_ROUTE, (req, res) => {
    if (req.originalUrl !== PUBLIC_INGRESS_AUTH_ENDPOINT) throw notFound();
    if (!isLoopbackSocketPeer(req.socket.remoteAddress)) {
      throw forbidden("Private ingress authorization requires a loopback peer");
    }
    if (!hasValidInternalKey(req.get(INTERNAL_AUTH_HEADER), internalIngressAuthKey)) {
      throw unauthorized();
    }
    if (!req.is("application/json")) {
      throw new HttpError(415, "Content-Type must be application/json");
    }
    assertRequestBodySize(req);

    const authorization = parseAuthorizationRequest(req.body);
    if (!req.actor || req.actor.type === "none") throw unauthorized();
    assertCompanyAccess(req, authorization.organizationId);

    const envelope = createRustActorEnvelope({
      actor: req.actor,
      organizationId: authorization.organizationId,
      method: "GET",
      path: authorization.publicPath,
      action: MEMBER_DIRECTORY_ACTION,
      body: EMPTY_BODY,
      secret: actorEnvelopeKey,
      requestId: authorization.requestId,
      nonce: authorization.nonce,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(envelope);
  });

  router.all(PUBLIC_INGRESS_AUTH_ROUTE, (req, res) => {
    if (req.originalUrl !== PUBLIC_INGRESS_AUTH_ENDPOINT) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
  });

  return router;
}
