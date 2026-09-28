import type { Db } from "@rudderhq/db";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentInvocationInstructionsRoute } from "../routes/agents.management-invocation-instructions.js";
import { readRecoveredRunDeveloperInstructions, readRunInstructionSnapshotForEvent } from "../services/run-instruction-snapshots.js";
import type { StorageService } from "../storage/types.js";

vi.mock("../services/run-instruction-snapshots.js", () => ({
  readRecoveredRunDeveloperInstructions: vi.fn(), readRunInstructionSnapshotForEvent: vi.fn(),
}));
const orgId = "22222222-2222-4222-8222-222222222222";
const runId = "11111111-1111-4111-8111-111111111111";
function appFor(allowedOrg = orgId) {
  const app = express();
  app.use((req, _res, next) => { req.actor = { type: "board", source: "session", orgIds: [allowedOrg] }; next(); });
  const router = express.Router();
  registerAgentInvocationInstructionsRoute({ router, db: {} as Db, storage: {} as StorageService,
    heartbeat: { getRun: async () => ({ id: runId, orgId }) },
    resolveScope: () => ({ orgIds: [allowedOrg] }),
    getCurrentUserRedactionOptions: async () => ({ userNames: ["sample-user"], homeDirs: ["/Users/sample-user"] }),
  });
  app.use("/api", router);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: "unavailable" }));
  return app;
}
const url = `/api/agent-runs/${runId}/events/6/invocation-instructions`;
describe("Metadata recovery public route contract", () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(readRunInstructionSnapshotForEvent).mockResolvedValue(null); });
  it("keeps stored snapshots authoritative", async () => {
    vi.mocked(readRunInstructionSnapshotForEvent).mockResolvedValue({ agentInstructionStack: "original stack", sha256: "a".repeat(64), byteSize: 14 });
    const response = await request(appFor()).get(url);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: "stored_snapshot", completeness: "complete", agentInstructionStack: "original stack" });
    expect(readRecoveredRunDeveloperInstructions).not.toHaveBeenCalled();
  });
  it("returns redacted partial evidence without claiming the missing stack", async () => {
    vi.mocked(readRecoveredRunDeveloperInstructions).mockResolvedValue({
      source: "codex_native_rollout", completeness: "partial", snapshotStatus: "missing",
      developerInstructions: "/Users/sample-user/file api_key=fixture-secret", sha256: "a".repeat(64), byteSize: 49,
      spanId: "span", sessionId: "session", turnId: "turn",
    });
    const response = await request(appFor()).get(url);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toMatchObject({ completeness: "partial", snapshotStatus: "missing" });
    expect(response.body).not.toHaveProperty("agentInstructionStack");
    expect(response.body.developerInstructions).not.toContain("fixture-secret");
    expect(response.body.developerInstructions).not.toContain("sample-user");
  });
  it("keeps unverified recovery missing and uncached", async () => {
    vi.mocked(readRecoveredRunDeveloperInstructions).mockResolvedValue(null);
    const response = await request(appFor()).get(url);
    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toContain("no-store");
  });
  it.each([
    ["JSON api_key", '{"api_key":"synthetic-review-secret"}'],
    ["quoted JSON escapes", '{"api_key":"synthetic-review-secret\\\"suffix"}'],
    ["environment assignment", "OPENAI_API_KEY=synthetic-review-secret"],
    ["export and quoted spaces", "export OPENAI_API_KEY='synthetic-review-secret with spaces'"],
    ["AWS secret", "AWS_SECRET_ACCESS_KEY=synthetic-review-secret"],
    ["service role environment", "SUPABASE_SERVICE_ROLE_KEY=synthetic-review-secret"],
    ["service role JSON", '{"SUPABASE_SERVICE_ROLE_KEY":"synthetic-review-secret"}'],
    ["service role quoted export", "export SUPABASE_SERVICE_ROLE_KEY='synthetic-review-secret with spaces'"],
    ["refresh token", '{"refresh_token": "synthetic-review-secret"}'],
    ["client secret", '{"clientSecret": "synthetic-review-secret"}'],
    ["HTTP Basic", "Authorization: Basic synthetic-review-secret"],
    ["HTTP Bearer", "Authorization: Bearer synthetic-review-secret"],
    ["cookies", "Cookie: first=synthetic-review-secret; second=synthetic-review-secret"],
    ["database URL", "postgres://operator:synthetic-review-secret@localhost/database"],
    ["private key", "-----BEGIN PRIVATE KEY-----\nsynthetic-review-secret\n-----END PRIVATE KEY-----"],
  ])("redacts recovered %s while preserving original digest metadata", async (_name, text) => {
    vi.mocked(readRecoveredRunDeveloperInstructions).mockResolvedValue({
      source: "codex_native_rollout", completeness: "partial", snapshotStatus: "missing",
      developerInstructions: `Keep ordinary instruction text.\n${text}`,
      sha256: "b".repeat(64), byteSize: 123,
      spanId: "span", sessionId: "session", turnId: "turn",
    });
    const response = await request(appFor()).get(url);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain("synthetic-review-secret");
    expect(response.body.developerInstructions).toContain("Keep ordinary instruction text.");
    expect(response.body.developerInstructions).toContain("REDACTED");
    expect(response.body).toMatchObject({ sha256: "b".repeat(64), byteSize: 123, completeness: "partial" });
    expect(response.body).not.toHaveProperty("agentInstructionStack");
  });
  it("rejects cross-organization access before any instruction read", async () => {
    const response = await request(appFor("other-org")).get(url);
    expect(response.status).toBe(403);
    expect(readRunInstructionSnapshotForEvent).not.toHaveBeenCalled();
    expect(readRecoveredRunDeveloperInstructions).not.toHaveBeenCalled();
  });
});
