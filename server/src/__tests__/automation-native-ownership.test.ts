import type { Db } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import { automationService } from "../services/automations.js";

const { forbiddenNode, service } = vi.hoisted(() => {
  const forbiddenNode = vi.fn(() => { throw new Error("Node Automation authority executed"); });
  return { forbiddenNode, service: () => new Proxy({}, { get: () => forbiddenNode }) };
});
vi.mock("../services/issues.js", () => ({ issueService: service }));
vi.mock("../services/chats.js", () => ({ chatService: service }));
vi.mock("../services/secrets.js", () => ({ secretService: service }));
vi.mock("../services/heartbeat.js", () => ({ heartbeatService: service }));
vi.mock("../services/chat-assistant.js", () => ({ chatAssistantService: service, ChatAssistantStreamError: class extends Error {}, userVisiblePartialBodyFromError: forbiddenNode }));
vi.mock("../storage/index.js", () => ({ getStorageService: service }));
vi.mock("../services/activity-log.js", () => ({ logActivity: forbiddenNode }));

describe("native Automation execution ownership", () => {
  it("declines the legacy scheduler and both producer entries before any Node query or effect", async () => {
    const db = new Proxy({} as Db, { get: forbiddenNode });
    const runtime = automationService(db, { nativeExecution: true });
    expect(await runtime.tickScheduledTriggers(new Date("2026-10-28T00:00:00Z"))).toEqual({ triggered: 0 });
    await expect(runtime.runAutomation("synthetic", { source: "manual" })).rejects.toMatchObject({ status: 409, message: "Automation execution is owned by Rust" });
    await expect(runtime.firePublicTrigger("synthetic", { payload: {} })).rejects.toMatchObject({ status: 409, message: "Automation execution is owned by Rust" });
    expect(forbiddenNode).not.toHaveBeenCalled();
  });
});
