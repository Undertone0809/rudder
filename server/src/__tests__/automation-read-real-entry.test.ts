import { agents, authUsers, automationRuns, automations, automationTriggers, boardApiKeys, chatConversations, heartbeatRuns, issueLabels, issues, labels, organizationMemberships, projects } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { automationRoutes } from "../routes/automations.js";
import { automationService } from "../services/automations.js";
import { createRustActorEnvelope } from "../services/rust-foundation-bridge.js";
import { database, identities, port, publicServer, snapshot, VISIBILITY_ACTOR_KEY, wire, type Database } from "./visibility-read-fixture.js";

const construction = vi.hoisted(() => ({ native: false }));
vi.mock("../services/automations.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/automations.js")>();
  return { ...original, automationService: (...args: Parameters<typeof original.automationService>) => {
    const service = original.automationService(...args);
    const forbidden = () => { throw new Error("Node Automation read projection executed"); };
    return construction.native ? { ...service, list: forbidden, getDetail: forbidden, listRuns: forbidden } : service;
  } };
});

describe.each(["off", "required"] as const)("Automation public reads (%s ingress)", (ingress) => {
  let fixture: Database, ids: Awaited<ReturnType<typeof identities>>, server: Awaited<ReturnType<typeof publicServer>>;
  let automationId: string, projectId: string, parentId: string, foreignAgent: string, foreignAutomation: string;
  const tables = ["automations", "automation_triggers", "automation_runs", "issues", "heartbeat_runs", "activity_log", "instance_settings"];
  const get = (route: string, token = ids.agentToken) => request(server.target).get(`/api/${route}`).set("authorization", `Bearer ${token}`);
  async function addAutomation(extra: Partial<typeof automations.$inferInsert> = {}) {
    const id = randomUUID(); await fixture.db.insert(automations).values({ id, orgId: ids.orgId, title: "Automation", assigneeAgentId: ids.agentId, ...extra }); return id;
  }
  beforeAll(async () => {
    fixture = await database(); ids = await identities(fixture.db);
    projectId = randomUUID(); parentId = randomUUID(); foreignAgent = randomUUID();
    await fixture.db.insert(projects).values({ id: projectId, orgId: ids.orgId, name: "Project" });
    await fixture.db.insert(agents).values({ id: foreignAgent, orgId: ids.foreign, name: "Foreign assignee", role: "general" });
    await fixture.db.insert(issues).values({ id: parentId, orgId: ids.orgId, title: "Hidden parent remains readable", hiddenAt: new Date(), projectId });
    const label = randomUUID(); await fixture.db.insert(labels).values({ id: label, orgId: ids.orgId, name: "Parent label", color: "#123456" });
    await fixture.db.insert(issueLabels).values({ orgId: ids.orgId, issueId: parentId, labelId: label });
    automationId = await addAutomation({ title: "Main automation", projectId, parentIssueId: parentId, assigneeAgentRuntimeOverrides: { nested: [1, true] } });
    foreignAutomation = await addAutomation({ orgId: ids.foreign, assigneeAgentId: foreignAgent, title: "Foreign automation" });
    await fixture.db.insert(automationTriggers).values([1, 2].map((index) => ({ orgId: ids.orgId, automationId, kind: index === 1 ? "schedule" : "webhook", label: `Trigger ${index}`, createdAt: new Date(1700000000000 + index) })));
    await fixture.db.insert(automationRuns).values(Array.from({ length: 4 }, (_, index) => ({ orgId: ids.orgId, automationId, source: "manual", createdAt: sql`${`2032-01-01T00:00:00.000${index + 1}00Z`}::timestamptz`, triggerPayload: { index } })));
    server = await publicServer(fixture, ingress, (app, bridge) => { construction.native = true; try { app.use("/api", automationRoutes(fixture.db, bridge)); } finally { construction.native = false; } });
  }, 120000);
  afterAll(async () => { await server?.close(); await fixture?.close(); });

  it("pairs full list, hidden parent detail, labels and raw microsecond run ordering", async () => {
    const before = await snapshot(fixture.db, tables);
    for (const [route, expected] of [
      [`orgs/${ids.orgId}/automations`, await automationService(fixture.db).list(ids.orgId)],
      [`automations/${automationId}`, await automationService(fixture.db).getDetail(automationId)],
      [`automations/${automationId}/runs`, await automationService(fixture.db).listRuns(automationId)],
    ] as const) { const response = await get(route); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(wire(expected)); }
    expect(await snapshot(fixture.db, tables)).toEqual(before);
  });
  it("preserves archived detail404, list exclusion and archived runs200", async () => {
    const id = await addAutomation({ status: "archived" });
    await fixture.db.insert(automationRuns).values({ orgId: ids.orgId, automationId: id, source: "manual" });
    expect((await get(`automations/${id}`)).status).toBe(404);
    expect((await get(`orgs/${ids.orgId}/automations`)).body.some((row: { id: string }) => row.id === id)).toBe(false);
    expect((await get(`automations/${id}/runs`)).body).toEqual(wire(await automationService(fixture.db).listRuns(id)));
  });
  it("preserves Number coercion, clamping, repeated values and fractional SQL failure", async () => {
    for (const [query, limit] of [["", 50], ["?limit=", 0], ["?limit=-2", -2], ["?limit=0x2", 2], ["?limit=1e1", 10], ["?limit=Infinity", 50], ["?limit=2&limit=3", 50]] as const) {
      const response = await get(`automations/${automationId}/runs${query}`); expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual(wire(await automationService(fixture.db).listRuns(automationId, limit)));
    }
    await expect(automationService(fixture.db).listRuns(automationId, 1.5)).rejects.toThrow();
    expect((await get(`automations/${automationId}/runs?limit=1.5`)).status).toBe(500);
  });
  it("excludes foreign detail references and child rows before their limits", async () => {
    const project = randomUUID(), parent = randomUUID();
    await fixture.db.insert(projects).values({ id: project, orgId: ids.foreign, name: "Foreign project" });
    await fixture.db.insert(issues).values({ id: parent, orgId: ids.foreign, title: "Foreign parent" });
    const id = await addAutomation({ projectId: project, parentIssueId: parent, assigneeAgentId: foreignAgent });
    await fixture.db.insert(automationTriggers).values({ orgId: ids.foreign, automationId: id, kind: "webhook", label: "Foreign trigger" });
    await fixture.db.insert(automationRuns).values(Array.from({ length: 30 }, () => ({ orgId: ids.foreign, automationId: id, source: "manual", createdAt: new Date("2040-01-01Z") })));
    const [local] = await fixture.db.insert(automationRuns).values({ orgId: ids.orgId, automationId: id, source: "manual", createdAt: new Date("2030-01-01Z") }).returning();
    const legacy = await automationService(fixture.db).getDetail(id); expect(legacy?.project?.id).toBe(project); expect(legacy?.recentRuns).toHaveLength(25);
    const response = await get(`automations/${id}`); expect(response.status, response.text).toBe(200);
    expect(response.body.project).toBeNull(); expect(response.body.assignee).toBeNull(); expect(response.body.parentIssue).toBeNull(); expect(response.body.triggers).toEqual([]);
    expect(response.body.recentRuns.map((row: { id: string }) => row.id)).toEqual([local!.id]);
    expect((await get(`automations/${id}/runs?limit=1`)).body.map((row: { id: string }) => row.id)).toEqual([local!.id]);
    const listed = (await get(`orgs/${ids.orgId}/automations`)).body.find((row: { id: string }) => row.id === id);
    expect(listed.triggers).toEqual([]); expect(listed.lastRun.id).toBe(local!.id);
  });
  it("retains local run IDs while foreign trigger, issue and chat hydration becomes fallback", async () => {
    const id = await addAutomation(), trigger = randomUUID(), issue = randomUUID(), chat = randomUUID();
    await fixture.db.insert(automationTriggers).values({ id: trigger, orgId: ids.foreign, automationId: foreignAutomation, kind: "webhook", label: "Foreign trigger" });
    await fixture.db.insert(issues).values({ id: issue, orgId: ids.foreign, title: "Foreign issue" });
    await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.foreign, title: "Foreign chat" });
    await fixture.db.insert(automationRuns).values({ orgId: ids.orgId, automationId: id, source: "manual", triggerId: trigger, linkedIssueId: issue, linkedChatConversationId: chat });
    const legacy = wire((await automationService(fixture.db).listRuns(id))[0]); expect(legacy.trigger.label).toBe("Foreign trigger");
    const expected = { ...legacy, trigger: { id: trigger, kind: null, label: null }, linkedIssue: { id: issue, identifier: null, title: "Automation execution", status: "todo", priority: "medium", updatedAt: legacy.updatedAt }, linkedChatConversation: { id: chat, title: "Chat", status: "active", preferredAgentId: null, lastMessageAt: null } };
    const response = await get(`automations/${id}/runs`); expect(response.status, response.text).toBe(200); expect(response.body).toEqual([expected]);
  });
  it("redacts private linked Chat hydration while preserving Automation rows, raw IDs, order and limits", async () => {
    const id = await addAutomation(), otherUser = randomUUID(), otherToken = `rudder_board_${randomUUID()}`;
    await fixture.db.insert(authUsers).values({ id: otherUser, name: "Other automation reader", email: `${otherUser}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await fixture.db.insert(boardApiKeys).values({ userId: otherUser, name: "Other automation reader", keyHash: createHash("sha256").update(otherToken).digest("hex") });
    await fixture.db.insert(organizationMemberships).values({ orgId: ids.orgId, principalType: "user", principalId: otherUser, status: "active", membershipRole: "member" });
    const privateChats = ["active", "kept", "expired"].map((state) => ({ id: randomUUID(), state })), ordinary = randomUUID(), foreign = randomUUID(), deleted = randomUUID();
    await fixture.db.insert(chatConversations).values([
      ...privateChats.map((chat) => ({ id: chat.id, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: ids.userId, title: `PRIVATE_AUTOMATION_${chat.state}`, status: "archived", preferredAgentId: ids.agentId, lastMessageAt: new Date("2047-01-01T00:00:00.123Z"), sideChatState: chat.state, messengerVisible: chat.state === "kept", sideChatExpiresAt: chat.state === "active" ? new Date(Date.now() + 3600000) : null })),
      { id: ordinary, orgId: ids.orgId, conversationKind: "chat", createdByUserId: ids.userId, title: "ORDINARY_AUTOMATION_CHAT", preferredAgentId: ids.agentId },
      { id: foreign, orgId: ids.foreign, title: "FOREIGN_AUTOMATION_CHAT" },
      { id: deleted, orgId: ids.orgId, title: "DELETED_AUTOMATION_CHAT" },
    ]);
    const linkedIds = [...privateChats.map((chat) => chat.id), ordinary, foreign, deleted];
    await fixture.db.insert(automationRuns).values(linkedIds.map((linkedChatConversationId, index) => ({ orgId: ids.orgId, automationId: id, source: "manual", linkedChatConversationId, createdAt: sql`${`2047-01-01T00:00:00.000${9 - index}00Z`}::timestamptz` })));
    // The real FK clears the raw reference on deletion; no constraints are removed.
    await fixture.db.delete(chatConversations).where(eq(chatConversations.id, deleted));
    const originalRuns = wire(await automationService(fixture.db).listRuns(id)), originalDetail = wire(await automationService(fixture.db).getDetail(id)), originalList = wire(await automationService(fixture.db).list(ids.orgId)).find((row: { id: string }) => row.id === id);
    expect(originalRuns[0].linkedChatConversation.title).toBe("PRIVATE_AUTOMATION_active"); expect(originalRuns.at(-1).linkedChatConversationId).toBeNull();
    const before = await snapshot(fixture.db, [...tables, "chat_conversations"]);
    for (const [token, owner] of [[ids.boardToken, true], [otherToken, false], [ids.agentToken, false]] as const) {
      const expected = originalRuns.map((row: { linkedChatConversationId: string | null }) => row.linkedChatConversationId === foreign || (!owner && privateChats.some((chat) => chat.id === row.linkedChatConversationId)) ? { ...row, linkedChatConversation: { id: row.linkedChatConversationId, title: "Chat", status: "active", preferredAgentId: null, lastMessageAt: null } } : row);
      for (const limit of [1, 3, 50]) { const response = await get(`automations/${id}/runs?limit=${limit}`, token); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(expected.slice(0, limit)); }
      const detail = await get(`automations/${id}`, token); expect(detail.status, detail.text).toBe(200); expect(detail.body).toEqual({ ...originalDetail, recentRuns: expected });
      const list = await get(`orgs/${ids.orgId}/automations`, token); expect(list.status, list.text).toBe(200); expect(list.body.find((row: { id: string }) => row.id === id)).toEqual({ ...originalList, lastRun: expected[0] });
    }
    expect(await snapshot(fixture.db, [...tables, "chat_conversations"])).toEqual(before);
  });
  it("uses the verified local-board fallback for linked Automation Chat hydration", async () => {
    const id = await addAutomation(), chat = randomUUID();
    await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: "local-board", title: "LOCAL_PRIVATE_AUTOMATION_CHAT" });
    await fixture.db.insert(automationRuns).values({ orgId: ids.orgId, automationId: id, source: "manual", linkedChatConversationId: chat });
    for (const [actor, owner] of [[{ type: "board", source: "local_implicit", isInstanceAdmin: true }, true], [{ type: "agent", source: "agent_key", agentId: ids.agentId, orgId: ids.orgId }, false]] as const) for (const operation of ["list", "detail", "runs"] as const) {
      const response = await server.bridge.automationRead!(actor, ids.orgId, { operation, automationId: id, legacyDateTimezone: "UTC" }); expect(response.status, response.body.toString()).toBe(200);
      const body = JSON.parse(response.body.toString()), run = operation === "list" ? body.find((row: { id: string }) => row.id === id).lastRun : operation === "detail" ? body.recentRuns[0] : body[0];
      expect(run.linkedChatConversationId).toBe(chat); expect(run.linkedChatConversation.title).toBe(owner ? "LOCAL_PRIVATE_AUTOMATION_CHAT" : "Chat");
    }
  });
  it.each(["owner", "org"] as const)("rechecks linked Automation Chat visibility after public authorization (%s)", async (change) => {
    const id = await addAutomation(), chat = randomUUID();
    await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: ids.userId, title: "CURRENT_PRIVATE_AUTOMATION_CHAT" });
    await fixture.db.insert(automationRuns).values({ orgId: ids.orgId, automationId: id, source: "manual", linkedChatConversationId: chat });
    for (const route of [`orgs/${ids.orgId}/automations`, `automations/${id}`, `automations/${id}/runs`]) {
      await fixture.db.update(chatConversations).set({ orgId: ids.orgId, createdByUserId: ids.userId }).where(eq(chatConversations.id, chat));
      const read = server.bridge.automationRead!; server.bridge.automationRead = async (...args) => { await fixture.db.update(chatConversations).set(change === "owner" ? { createdByUserId: "other-user" } : { orgId: ids.foreign }).where(eq(chatConversations.id, chat)); return read(...args); };
      try { const response = await get(route, ids.boardToken); expect(response.status, response.text).toBe(200); const run = route.startsWith("orgs/") ? response.body.find((row: { id: string }) => row.id === id).lastRun : route.endsWith("/runs") ? response.body[0] : response.body.recentRuns[0]; expect(run.linkedChatConversationId).toBe(chat); expect(run.linkedChatConversation).toEqual({ id: chat, title: "Chat", status: "active", preferredAgentId: null, lastMessageAt: null }); }
      finally { server.bridge.automationRead = read; }
    }
  });
  it("fences both parent label references while retaining all same-org labels", async () => {
    const foreignLabel = randomUUID(), localLabel = randomUUID();
    await fixture.db.insert(labels).values([{ id: foreignLabel, orgId: ids.foreign, name: "Foreign label", color: "#654321" }, { id: localLabel, orgId: ids.orgId, name: "Foreign link", color: "#654321" }]);
    await fixture.db.insert(issueLabels).values([{ orgId: ids.orgId, issueId: parentId, labelId: foreignLabel }, { orgId: ids.foreign, issueId: parentId, labelId: localLabel }]);
    try { const response = await get(`automations/${automationId}`); expect(response.status, response.text).toBe(200); expect(response.body.parentIssue.labels.map((row: { name: string }) => row.name)).toEqual(["Parent label"]); expect(response.body.parentIssue.labelIds).toEqual(response.body.parentIssue.labels.map((row: { id: string }) => row.id)); }
    finally { await fixture.db.delete(issueLabels).where(eq(issueLabels.labelId, foreignLabel)); await fixture.db.delete(issueLabels).where(eq(issueLabels.labelId, localLabel)); }
  });
  it("removes foreign live execution candidates and preserves same-org legacy fallback", async () => {
    const id = await addAutomation(), foreignRun = randomUUID(), localRun = randomUUID(), invalidIssue = randomUUID(), fallback = randomUUID();
    await fixture.db.insert(heartbeatRuns).values([{ id: foreignRun, orgId: ids.foreign, agentId: foreignAgent, status: "running" }, { id: localRun, orgId: ids.orgId, agentId: ids.agentId, status: "running", contextSnapshot: { issueId: fallback } }]);
    await fixture.db.insert(issues).values([{ id: invalidIssue, orgId: ids.orgId, title: "Foreign execution candidate", originKind: "automation_execution", originId: id, originRunId: randomUUID(), executionRunId: foreignRun, status: "in_progress", updatedAt: new Date("2040-01-01Z") }, { id: fallback, orgId: ids.orgId, title: "Local fallback", originKind: "automation_execution", originId: id, originRunId: randomUUID(), status: "in_progress", updatedAt: new Date("2030-01-01Z") }]);
    expect((await automationService(fixture.db).getDetail(id))?.activeIssue?.id).toBe(invalidIssue);
    expect((await get(`automations/${id}`)).body.activeIssue.id).toBe(fallback);
    expect((await get(`orgs/${ids.orgId}/automations`)).body.find((row: { id: string }) => row.id === id).activeIssue.id).toBe(fallback);
    await fixture.db.update(issues).set({ executionRunId: localRun }).where(eq(issues.id, invalidIssue));
    const response = await get(`automations/${id}`); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(wire(await automationService(fixture.db).getDetail(id)));
  });
  it("pairs deep and reparsed JSON, surrogate values and historical Date projection", async () => {
    const id = await addAutomation();
    for (const raw of ['{"nested":' + '['.repeat(600) + '9007199254740993' + ']'.repeat(600) + '}', JSON.stringify('"\\ud800"'), JSON.stringify('{"\\ud800":true}'), '123', 'null']) {
      await fixture.db.execute(sql`UPDATE automations SET assignee_agent_runtime_overrides=${raw}::jsonb,created_at='0032-01-01T00:00:00.000900Z'::timestamptz,last_triggered_at='275760-09-13T00:00:00.000999Z'::timestamptz,last_enqueued_at='infinity'::timestamptz WHERE id=${id}::uuid`);
      const response = await get(`automations/${id}`); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(wire(await automationService(fixture.db).getDetail(id)));
    }
  });
  it("returns every large list row without a generic receipt cap", async () => {
    const rows = await fixture.db.insert(automations).values(Array.from({ length: 130 }, (_, index) => ({ orgId: ids.empty, title: `Volume ${index}`, description: "x".repeat(9000), assigneeAgentId: ids.agentId, updatedAt: new Date(1700000000000 + index) }))).returning({ id: automations.id });
    try { const response = await get(`orgs/${ids.empty}/automations`, ids.boardToken); expect(response.status, response.text).toBe(200); expect(response.body).toHaveLength(130); expect(response.text.length).toBeGreaterThan(1048576); expect(response.body).toEqual(wire(await automationService(fixture.db).list(ids.empty))); }
    finally { for (const row of rows) await fixture.db.delete(automations).where(eq(automations.id, row.id)); }
  });
  it.each(["delete", "move", "archive"] as const)("rechecks native current target after public identity resolution (%s)", async (change) => {
    const id = await addAutomation(), [original] = await fixture.db.select().from(automations).where(eq(automations.id, id));
    const read = server.bridge.automationRead!; server.bridge.automationRead = async (...args) => {
      if (change === "delete") await fixture.db.delete(automations).where(eq(automations.id, id));
      else await fixture.db.update(automations).set(change === "move" ? { orgId: ids.foreign } : { status: "archived" }).where(eq(automations.id, id));
      return read(...args);
    };
    try { const response = await get(`automations/${id}`); expect(response.status, response.text).toBe(404); expect(response.body.error).toBe("Automation not found"); }
    finally { server.bridge.automationRead = read; if (change === "delete") await fixture.db.insert(automations).values(original!); }
  });
  it.each(["delete", "move"] as const)("rechecks the Automation runs target after identity resolution (%s)", async (change) => {
    const id = await addAutomation(), read = server.bridge.automationRead!;
    server.bridge.automationRead = async (...args) => {
      if (change === "delete") await fixture.db.delete(automations).where(eq(automations.id, id));
      else await fixture.db.update(automations).set({ orgId: ids.foreign }).where(eq(automations.id, id));
      return read(...args);
    };
    try { const response = await get(`automations/${id}/runs`); expect(response.status, response.text).toBe(404); expect(response.body.error).toBe("Automation not found"); }
    finally { server.bridge.automationRead = read; }
  });
  it("enforces anonymous, foreign and live-revoked Board authority on all three reads", async () => {
    const routes = [`orgs/${ids.orgId}/automations`, `automations/${automationId}`, `automations/${automationId}/runs`];
    for (const route of routes) { expect((await request(server.target).get(`/api/${route}`)).status).toBe(401); expect((await get(route, ids.boardToken)).status).toBe(200); }
    expect((await get(`orgs/${ids.foreign}/automations`)).status).toBe(403); expect((await get(`automations/${foreignAutomation}`)).status).toBe(403); expect((await get(`automations/${foreignAutomation}/runs`)).status).toBe(403);
    await fixture.db.update(organizationMemberships).set({ status: "inactive" }).where(and(eq(organizationMemberships.orgId, ids.orgId), eq(organizationMemberships.principalId, ids.userId)));
    try { for (const route of routes) expect((await get(route, ids.boardToken)).status).toBe(403); }
    finally { await fixture.db.update(organizationMemberships).set({ status: "active" }).where(and(eq(organizationMemberships.orgId, ids.orgId), eq(organizationMemberships.principalId, ids.userId))); }
    for (const suffix of ["", "/runs"]) { expect((await get(`automations/${randomUUID()}${suffix}`)).status).toBe(404); expect((await get(`automations/invalid${suffix}`)).status).toBe(500); }
  });
  it("rejects tampered bodies and signed foreign targets, and fails closed without transport", async () => {
    const nativeFetch = globalThis.fetch;
    for (const mode of ["tamper", "foreign"] as const) {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
        if (!String(url).endsWith("/automation-reads")) return nativeFetch(url, options);
        const body = Buffer.from(JSON.stringify({ operation: "detail", automationId: foreignAutomation, legacyDateTimezone: "UTC" })); const headers = { ...options!.headers as Record<string, string> };
        if (mode === "foreign") headers["x-rudder-actor-envelope"] = JSON.stringify(createRustActorEnvelope({ actor: { type: "agent", source: "agent_key", agentId: ids.agentId, orgId: ids.orgId }, organizationId: ids.orgId, method: "POST", path: new URL(String(url)).pathname, action: "automation.read", body, secret: VISIBILITY_ACTOR_KEY, requestId: headers["x-rudder-request-id"] }));
        return nativeFetch(url, { ...options, headers, body: body as unknown as BodyInit });
      });
      try { expect((await get(`automations/${automationId}`)).status).toBe(mode === "tamper" ? 401 : 404); } finally { spy.mockRestore(); }
    }
    const read = server.bridge.automationRead; server.bridge.automationRead = undefined;
    try { for (const route of [`orgs/${ids.orgId}/automations`, `automations/${automationId}`, `automations/${automationId}/runs`]) expect((await get(route)).status).toBe(503); } finally { server.bridge.automationRead = read; }
  });
  it("returns503 for an unreachable private TCP endpoint and recovers after a real process restart", async () => {
    const routes = [`orgs/${ids.orgId}/automations`, `automations/${automationId}`, `automations/${automationId}/runs`], before = await snapshot(fixture.db, tables);
    const closedPort = await port(), nativeFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (!String(url).endsWith("/automation-reads")) return nativeFetch(url, options);
      const closed = new URL(String(url)); closed.port = String(closedPort); return nativeFetch(closed, options);
    });
    try { for (const route of routes) expect((await get(route)).status).toBe(503); } finally { spy.mockRestore(); }
    await server.bridge.close(); await server.bridge.start();
    if (ingress === "required") { await server.bridge.waitForPublicIngressReady!(); server.target = server.bridge.publicIngressBaseUrl!; }
    for (const route of routes) expect((await get(route)).status).toBe(200);
    expect(await snapshot(fixture.db, tables)).toEqual(before);
  });
});
