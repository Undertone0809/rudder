import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { messengerRoutes } from "../routes/messenger.js";

const mockMessengerService = vi.hoisted(() => ({
  listCustomGroups: vi.fn(),
  createCustomGroup: vi.fn(),
  createCustomGroupWithEntries: vi.fn(),
  updateCustomGroup: vi.fn(),
  listThreadTitles: vi.fn(),
  listCustomGroupThreadTitles: vi.fn(),
  separateCustomGroup: vi.fn(),
  deleteCustomGroup: vi.fn(),
  reorderCustomGroups: vi.fn(),
  assignThreadToCustomGroup: vi.fn(),
  reorderCustomGroupEntries: vi.fn(),
  removeThreadFromCustomGroups: vi.fn(),
  listThreadSummaries: vi.fn(),
}));

const mockProductIntelligence = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const mockSavedViewsService = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../services/messenger.js", () => ({
  messengerService: () => mockMessengerService,
}));

vi.mock("../services/product-intelligence.js", () => ({
  productIntelligenceService: () => mockProductIntelligence,
}));

vi.mock("../services/messenger-saved-views.js", () => ({
  messengerSavedViewsService: () => mockSavedViewsService,
}));

function createApp(actor: Record<string, unknown> = {
  type: "board",
  source: "local_implicit",
  userId: "user-1",
  orgIds: ["org-1"],
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", messengerRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("Messenger custom group title routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMessengerService.createCustomGroupWithEntries.mockResolvedValue({ groups: [] });
    mockMessengerService.updateCustomGroup.mockResolvedValue({
      id: "group-1",
      orgId: "org-1",
      userId: "user-1",
      name: "Generated group",
      icon: "folder::amber",
      sortOrder: 0,
      collapsed: false,
      pinnedAt: null,
      createdAt: new Date("2026-04-11T09:40:00.000Z"),
      updatedAt: new Date("2026-04-11T09:40:00.000Z"),
    });
    mockMessengerService.listThreadTitles.mockResolvedValue(["Planning chat", "Issues"]);
    mockMessengerService.listCustomGroupThreadTitles.mockResolvedValue(["Planning chat", "Issue triage"]);
  });

  it("generates a custom group title during drag merge when requested", async () => {
    mockProductIntelligence.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Planning and Issues",
    });

    const res = await request(createApp())
      .post("/api/orgs/org-1/messenger/groups/merge")
      .send({
        name: "Planning chat",
        icon: "folder::amber",
        threadKeys: ["chat:chat-1", "issues"],
        autoGenerateName: true,
      });

    expect(res.status).toBe(201);
    expect(mockMessengerService.listThreadTitles).toHaveBeenCalledWith("org-1", "user-1", ["chat:chat-1", "issues"]);
    expect(mockProductIntelligence.execute).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1",
      purpose: "lightweight",
      feature: "messenger_group_title",
      prompt: expect.stringContaining("Planning chat"),
    }));
    expect(mockMessengerService.createCustomGroupWithEntries).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "Planning and Issues",
      "folder::amber",
      ["chat:chat-1", "issues"],
    );
  });

  it("falls back to the provided merge name when group title generation fails", async () => {
    mockProductIntelligence.execute.mockRejectedValueOnce(new Error("Fast Intelligence unavailable"));

    const res = await request(createApp())
      .post("/api/orgs/org-1/messenger/groups/merge")
      .send({
        name: "Planning chat",
        icon: "folder::amber",
        threadKeys: ["chat:chat-1", "issues"],
        autoGenerateName: true,
      });

    expect(res.status).toBe(201);
    expect(mockMessengerService.createCustomGroupWithEntries).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "Planning chat",
      "folder::amber",
      ["chat:chat-1", "issues"],
    );
  });

  it("regenerates an existing custom group title from member titles", async () => {
    mockProductIntelligence.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { stdout: "Planning Triage" },
    });

    const res = await request(createApp())
      .post("/api/orgs/org-1/messenger/groups/group-1/title/regenerate")
      .send();

    expect(res.status).toBe(200);
    expect(mockMessengerService.listCustomGroupThreadTitles).toHaveBeenCalledWith("org-1", "user-1", "group-1");
    expect(mockMessengerService.updateCustomGroup).toHaveBeenCalledWith("org-1", "user-1", "group-1", {
      name: "Planning Triage",
    });
  });

  it("does not mutate the group when title regeneration returns unusable output", async () => {
    mockProductIntelligence.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "```",
    });

    const res = await request(createApp())
      .post("/api/orgs/org-1/messenger/groups/group-1/title/regenerate")
      .send();

    expect(res.status).toBe(422);
    expect(mockMessengerService.updateCustomGroup).not.toHaveBeenCalled();
  });
});

describe("Messenger Saved View and generic group routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSavedViewsService.list.mockResolvedValue([]);
    mockSavedViewsService.get.mockResolvedValue({ id: "view-1" });
    mockSavedViewsService.create.mockResolvedValue({ id: "view-1" });
    mockSavedViewsService.update.mockResolvedValue({ id: "view-1" });
    mockSavedViewsService.reorder.mockResolvedValue([]);
    mockSavedViewsService.remove.mockResolvedValue({ id: "view-1" });
    mockMessengerService.assignThreadToCustomGroup.mockResolvedValue({ itemKey: "saved-view:view-1" });
    mockMessengerService.reorderCustomGroupEntries.mockResolvedValue({ groups: [] });
  });

  it("scopes Saved View CRUD and list visibility to the current board user", async () => {
    const app = createApp();
    expect((await request(app).get("/api/orgs/org-1/messenger/saved-views?visibility=hidden")).status).toBe(200);
    expect(mockSavedViewsService.list).toHaveBeenCalledWith("org-1", "user-1", "hidden");

    const created = await request(app)
      .post("/api/orgs/org-1/messenger/saved-views")
      .send({
        target: { kind: "browser", tabId: "tab-1", url: "https://example.test" },
        title: "Example",
      });
    expect(created.status).toBe(201);
    expect(mockSavedViewsService.create).toHaveBeenCalledWith("org-1", "user-1", expect.objectContaining({
      target: { kind: "browser", tabId: "tab-1", url: "https://example.test" },
    }));

    expect((await request(app).get("/api/orgs/org-1/messenger/saved-views/view-1")).status).toBe(200);
    expect(mockSavedViewsService.get).toHaveBeenCalledWith("org-1", "user-1", "view-1");
    expect((await request(app).patch("/api/orgs/org-1/messenger/saved-views/view-1").send({ hidden: true })).status).toBe(200);
    expect(mockSavedViewsService.update).toHaveBeenCalledWith("org-1", "user-1", "view-1", { hidden: true });
    expect((await request(app).delete("/api/orgs/org-1/messenger/saved-views/view-1")).status).toBe(200);
    expect(mockSavedViewsService.remove).toHaveBeenCalledWith("org-1", "user-1", "view-1");
  });

  it("rejects invalid Saved View targets and inaccessible organizations", async () => {
    const invalid = await request(createApp())
      .post("/api/orgs/org-1/messenger/saved-views")
      .send({ target: { kind: "browser", tabId: "tab-1", url: "about:blank" }, title: "Blank" });
    expect(invalid.status).toBe(400);
    expect(mockSavedViewsService.create).not.toHaveBeenCalled();

    const forbidden = await request(createApp({
      type: "agent",
      source: "api_key",
      agentId: "agent-1",
      orgId: "org-1",
    })).get("/api/orgs/org-1/messenger/saved-views");
    expect(forbidden.status).toBe(403);
    expect(mockSavedViewsService.list).not.toHaveBeenCalled();
  });

  it("normalizes canonical and legacy custom-group item aliases", async () => {
    const app = createApp();
    expect((await request(app)
      .post("/api/orgs/org-1/messenger/groups/group-1/entries")
      .send({ itemKey: "saved-view:view-1" })).status).toBe(201);
    expect(mockMessengerService.assignThreadToCustomGroup).toHaveBeenLastCalledWith(
      "org-1", "user-1", "group-1", "saved-view:view-1",
    );

    expect((await request(app)
      .post("/api/orgs/org-1/messenger/groups/group-1/entries")
      .send({ threadKey: "chat:chat-1" })).status).toBe(201);
    expect(mockMessengerService.assignThreadToCustomGroup).toHaveBeenLastCalledWith(
      "org-1", "user-1", "group-1", "chat:chat-1",
    );

    const mismatch = await request(app)
      .post("/api/orgs/org-1/messenger/groups/group-1/entries")
      .send({ itemKey: "saved-view:view-1", threadKey: "chat:chat-1" });
    expect(mismatch.status).toBe(400);

    expect((await request(app)
      .patch("/api/orgs/org-1/messenger/groups/group-1/entries/reorder")
      .send({ itemKeys: ["saved-view:view-1", "chat:chat-1"] })).status).toBe(200);
    expect(mockMessengerService.reorderCustomGroupEntries).toHaveBeenCalledWith(
      "org-1", "user-1", "group-1", ["saved-view:view-1", "chat:chat-1"],
    );
  });

  it("validates and forwards Saved View reorder requests for the current board user", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    mockSavedViewsService.reorder.mockResolvedValueOnce([
      { id: secondId, sortOrder: 0 },
      { id: firstId, sortOrder: 1 },
    ]);

    const response = await request(createApp())
      .patch("/api/orgs/org-1/messenger/saved-views/reorder")
      .send({ ids: [secondId, firstId] });
    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { id: secondId, sortOrder: 0 },
      { id: firstId, sortOrder: 1 },
    ]);
    expect(mockSavedViewsService.reorder).toHaveBeenCalledWith("org-1", "user-1", [secondId, firstId]);

    const invalid = await request(createApp())
      .patch("/api/orgs/org-1/messenger/saved-views/reorder")
      .send({ ids: [firstId, firstId] });
    expect(invalid.status).toBe(400);
    expect(mockSavedViewsService.reorder).toHaveBeenCalledTimes(1);
  });
});
