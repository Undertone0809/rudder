import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { llmRoutes } from "../routes/llms.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      orgIds: ["organization-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use(llmRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("llm routes", () => {
  it("documents agent icons as legacy compatibility instead of hire guidance", async () => {
    const res = await request(createApp()).get("/llms/agent-icons.txt");

    expect(res.status).toBe(200);
    expect(res.text).toContain("Do not set `icon` on normal hire/create payloads");
    expect(res.text).toContain("DiceBear Notionists");
    expect(res.text).toContain("legacy compatibility");
    expect(res.text).toContain('{ "name": "SearchOps", "role": "researcher" }');
    expect(res.text).not.toContain('"icon": "search"');
  });
});
