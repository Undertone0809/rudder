import { Router } from "express";
import {
  ACTIVE_CONTENT_SANDBOX_CSP,
  normalizeResponseContentType,
} from "../content-response-policy.js";
import { badRequest } from "../errors.js";
import {
  fetchWebsiteIcon,
  parsePublicHttpUrl,
  resolveWebsiteMetadata,
  type WebsiteMetadata,
  type WebsiteMetadataOptions,
} from "../services/website-metadata.js";
import { assertBoard } from "./authz.js";

const SAFE_WEBSITE_ICON_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
]);

export interface WebsiteMetadataRouteOptions {
  resolveWebsiteMetadata?: (url: string) => Promise<WebsiteMetadata>;
  fetchWebsiteIcon?: (url: string) => ReturnType<typeof fetchWebsiteIcon>;
  urlOptions?: WebsiteMetadataOptions;
}

function parseInspectableUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest("Missing url");
  }
  try {
    return parsePublicHttpUrl(value, {}).href;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid URL";
    throw badRequest(message);
  }
}

function isInspectableUrlError(error: unknown) {
  if (!(error instanceof Error)) return false;
  return error.message === "Only http and https URLs can be inspected"
    || error.message === "Private network URLs cannot be inspected"
    || error.message === "Website metadata redirect limit exceeded";
}

function proxiedWebsiteIconUrl(iconUrl: string | null) {
  if (!iconUrl) return null;
  if (iconUrl.startsWith("data:image/")) return iconUrl;
  return `/api/website-metadata/icon?url=${encodeURIComponent(iconUrl)}`;
}

export function websiteMetadataRoutes(options: WebsiteMetadataRouteOptions = {}) {
  const router = Router();
  const resolveMetadata = options.resolveWebsiteMetadata ?? ((url: string) => resolveWebsiteMetadata(url, options.urlOptions));
  const fetchIcon = options.fetchWebsiteIcon ?? ((url: string) => fetchWebsiteIcon(url, options.urlOptions));

  router.get("/website-metadata", async (req, res) => {
    assertBoard(req);
    const targetUrl = parseInspectableUrl(req.query.url);
    let metadata: WebsiteMetadata;
    try {
      metadata = await resolveMetadata(targetUrl);
    } catch (error) {
      if (isInspectableUrlError(error)) throw badRequest((error as Error).message);
      throw error;
    }
    res.json({ ...metadata, iconUrl: proxiedWebsiteIconUrl(metadata.iconUrl) });
  });

  router.get("/website-metadata/icon", async (req, res) => {
    assertBoard(req);
    const iconUrl = parseInspectableUrl(req.query.url);
    let icon: Awaited<ReturnType<typeof fetchWebsiteIcon>>;
    try {
      icon = await fetchIcon(iconUrl);
    } catch (error) {
      if (isInspectableUrlError(error)) throw badRequest((error as Error).message);
      throw error;
    }
    if (!icon) {
      res.status(404).json({ error: "Website icon not found" });
      return;
    }
    const contentType = normalizeResponseContentType(icon.contentType);
    if (!SAFE_WEBSITE_ICON_CONTENT_TYPES.has(contentType)) {
      res.status(415).json({ error: "Unsupported website icon type" });
      return;
    }

    res.setHeader("content-type", contentType);
    res.setHeader("cache-control", "public, max-age=86400");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", ACTIVE_CONTENT_SANDBOX_CSP);
    res.send(icon.body);
  });

  return router;
}
