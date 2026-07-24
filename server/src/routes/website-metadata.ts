import { Router } from "express";
import { badRequest } from "../errors.js";
import {
  fetchWebsiteIcon,
  parsePublicHttpUrl,
  resolveWebsiteMetadata,
  type WebsiteMetadata,
  type WebsiteMetadataOptions,
  type WebsiteMetadataPurpose,
} from "../services/website-metadata.js";
import { assertBoard } from "./authz.js";

export interface WebsiteMetadataRouteOptions {
  resolveWebsiteMetadata?: (url: string, purpose: WebsiteMetadataPurpose) => Promise<WebsiteMetadata>;
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
    || error.message === "Credentialed URLs cannot be inspected"
    || error.message === "Private network URLs cannot be inspected"
    || error.message === "Website metadata redirect limit exceeded";
}

function parseWebsiteMetadataPurpose(value: unknown): WebsiteMetadataPurpose {
  if (value === undefined || value === "preview") return "preview";
  if (value === "authoring") return "authoring";
  throw badRequest("Invalid website metadata purpose");
}

function proxiedWebsiteIconUrl(iconUrl: string | null) {
  if (!iconUrl) return null;
  if (iconUrl.startsWith("data:image/")) return iconUrl;
  return `/api/website-metadata/icon?url=${encodeURIComponent(iconUrl)}`;
}

export function websiteMetadataRoutes(options: WebsiteMetadataRouteOptions = {}) {
  const router = Router();
  const resolveMetadata = options.resolveWebsiteMetadata
    ?? ((url: string, purpose: WebsiteMetadataPurpose) => resolveWebsiteMetadata(url, {
      ...options.urlOptions,
      purpose,
    }));
  const fetchIcon = options.fetchWebsiteIcon ?? ((url: string) => fetchWebsiteIcon(url, options.urlOptions));

  router.get("/website-metadata", async (req, res) => {
    assertBoard(req);
    const targetUrl = parseInspectableUrl(req.query.url);
    const purpose = parseWebsiteMetadataPurpose(req.query.purpose);
    let metadata: WebsiteMetadata;
    try {
      metadata = await resolveMetadata(targetUrl, purpose);
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

    res.setHeader("content-type", icon.contentType);
    res.setHeader("cache-control", "public, max-age=86400");
    res.send(icon.body);
  });

  return router;
}
