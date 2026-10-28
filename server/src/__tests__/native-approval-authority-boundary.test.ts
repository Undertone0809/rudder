import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/index.js", () => {
  const unavailable = () => { throw new Error("Retired Node Approval authority must not initialize"); };
  return Object.fromEntries([
    "accessService", "approvalService", "chatService", "goalService", "heartbeatService",
    "issueApprovalService", "issueService", "logActivity", "secretService",
  ].map((name) => [name, unavailable]));
});

import { approvalRoutes } from "../routes/approvals.js";
import type { Db } from "@rudderhq/db";

describe("native Approval authority boundary", () => {
  it("registers no Node reads, decisions, creations or comments behind the existing native identity guard", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", approvalRoutes({} as Db, undefined, { nativeApprovalReads: true }));
    app.use((_req, res) => res.status(404).json({ retired: true }));
    const paths = [
      ["get", "/orgs/organization/approvals"], ["get", "/approvals/approval"],
      ["get", "/approvals/approval/issues"], ["post", "/orgs/organization/approvals"],
      ["post", "/approvals/approval/approve"], ["post", "/approvals/approval/reject"],
      ["post", "/approvals/approval/request-revision"], ["post", "/approvals/approval/resubmit"],
      ["get", "/approvals/approval/comments"], ["post", "/approvals/approval/comments"],
    ] as const;
    for (const [method, path] of paths) {
      const response = await request(app)[method](`/api${path}`).send({});
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.body).toEqual({ retired: true });
    }
  });
});
