import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { websiteMetadataRoutes } from "../routes/website-metadata.js";

function createApp(options: Parameters<typeof websiteMetadataRoutes>[0] = {}) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
    };
    next();
  });
  app.use("/api", websiteMetadataRoutes(options));
  app.use(errorHandler);
  return app;
}

describe("website metadata routes", () => {
  it("returns proxied site icons discovered from page metadata", async () => {
    const resolveWebsiteMetadata = vi.fn().mockResolvedValue({
      url: "https://example.com/post",
      siteName: "Metadata Fixture",
      iconUrl: "https://static.example.com/favicon.ico",
    });
    const app = createApp({ resolveWebsiteMetadata });

    const metadataRes = await request(app)
      .get("/api/website-metadata")
      .query({ url: "https://example.com/post#section" });

    expect(metadataRes.status).toBe(200);
    expect(resolveWebsiteMetadata).toHaveBeenCalledWith("https://example.com/post");
    expect(metadataRes.body).toMatchObject({
      url: "https://example.com/post",
      siteName: "Metadata Fixture",
      iconUrl: `/api/website-metadata/icon?url=${encodeURIComponent("https://static.example.com/favicon.ico")}`,
    });
  });

  it("returns local data-url icons without wrapping them in the icon proxy", async () => {
    const resolveWebsiteMetadata = vi.fn().mockResolvedValue({
      url: "https://x.com/example/status/1",
      siteName: "X",
      iconUrl: "data:image/svg+xml,%3Csvg%2F%3E",
    });
    const app = createApp({ resolveWebsiteMetadata });

    const metadataRes = await request(app)
      .get("/api/website-metadata")
      .query({ url: "https://x.com/example/status/1" });

    expect(metadataRes.status).toBe(200);
    expect(metadataRes.body).toMatchObject({
      url: "https://x.com/example/status/1",
      siteName: "X",
      iconUrl: "data:image/svg+xml,%3Csvg%2F%3E",
    });
  });

  it("proxies fetched website icon bytes", async () => {
    const fetchWebsiteIcon = vi.fn().mockResolvedValue({
      contentType: "image/x-icon",
      body: Buffer.from("ico"),
    });
    const app = createApp({ fetchWebsiteIcon });

    const iconUrl = "https://static.example.com/favicon.ico";
    const iconRes = await request(app)
      .get("/api/website-metadata/icon")
      .query({ url: iconUrl });

    expect(iconRes.status).toBe(200);
    expect(fetchWebsiteIcon).toHaveBeenCalledWith(iconUrl);
    expect(iconRes.headers["content-type"]).toContain("image/x-icon");
    expect(iconRes.headers["cache-control"]).toBe("public, max-age=86400");
    expect(iconRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(iconRes.headers["content-security-policy"]).toBe(
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(iconRes.body).toEqual(Buffer.from("ico"));
  });

  it("rejects proxied SVG icons even when the icon fetcher returns one", async () => {
    const fetchWebsiteIcon = vi.fn().mockResolvedValue({
      contentType: "image/svg+xml",
      body: Buffer.from("<svg onload='alert(1)'/>"),
    });
    const app = createApp({ fetchWebsiteIcon });

    const iconRes = await request(app)
      .get("/api/website-metadata/icon")
      .query({ url: "https://static.example.com/favicon.svg" });

    expect(iconRes.status).toBe(415);
    expect(iconRes.body.error).toBe("Unsupported website icon type");
  });

  it("rejects private-network metadata targets before fetching", async () => {
    const resolveWebsiteMetadata = vi.fn();
    const app = createApp({ resolveWebsiteMetadata });

    const res = await request(app)
      .get("/api/website-metadata")
      .query({ url: "http://127.0.0.1:12345/post" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Private network URLs cannot be inspected");
    expect(resolveWebsiteMetadata).not.toHaveBeenCalled();
  });

  it("maps private redirect validation failures to bad request", async () => {
    const resolveWebsiteMetadata = vi.fn().mockRejectedValue(new Error("Private network URLs cannot be inspected"));
    const app = createApp({ resolveWebsiteMetadata });

    const res = await request(app)
      .get("/api/website-metadata")
      .query({ url: "https://example.com/post" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Private network URLs cannot be inspected");
  });
});
