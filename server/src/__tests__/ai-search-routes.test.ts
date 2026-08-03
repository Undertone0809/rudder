import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";

const mockSearch = vi.hoisted(() => vi.fn());

vi.mock("../services/ai-search.js", () => ({
  aiSearchService: () => ({ search: mockSearch }),
}));

async function createApp() {
  const { aiSearchRoutes } = await import("../routes/ai-search.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
      orgIds: ["org-1"],
    };
    next();
  });
  app.use("/api/orgs", aiSearchRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("AI Search routes", () => {
  beforeEach(() => {
    mockSearch.mockReset();
    mockSearch.mockResolvedValue({
      query: "architecture",
      answer: "Found one project.",
      results: [],
    });
  });

  it("uses the organization Smart Model search service for board requests", async () => {
    const app = await createApp();

    const response = await request(app)
      .post("/api/orgs/org-1/ai-search")
      .send({ query: "  architecture  " });

    expect(response.status).toBe(200);
    expect(mockSearch).toHaveBeenCalledWith("org-1", "architecture", undefined);
    expect(response.body).toEqual({
      query: "architecture",
      answer: "Found one project.",
      results: [],
    });
  });

  it("passes an explicit search scope to the organization Smart Model search service", async () => {
    const app = await createApp();

    const response = await request(app)
      .post("/api/orgs/org-1/ai-search")
      .send({ query: "architecture", scope: "issue" });

    expect(response.status).toBe(200);
    expect(mockSearch).toHaveBeenCalledWith("org-1", "architecture", "issue");
  });

  it("rejects short queries before invoking the model", async () => {
    const app = await createApp();

    const response = await request(app)
      .post("/api/orgs/org-1/ai-search")
      .send({ query: "a" });

    expect(response.status).toBe(400);
    expect(mockSearch).not.toHaveBeenCalled();
  });
});
