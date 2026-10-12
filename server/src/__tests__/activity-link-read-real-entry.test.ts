import { activityLog, agents, approvalComments, approvals, authUsers, boardApiKeys, chatConversations, chatMessages, heartbeatRuns, issueComments, issues, operatorProfiles, organizationMemberships, projects } from "@rudderhq/db";
import { and, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityRoutes } from "../routes/activity.js";
import { activityService } from "../services/activity.js";
import { createRustActorEnvelope } from "../services/rust-foundation-bridge.js";
import { database, identities, port, publicServer, snapshot, VISIBILITY_ACTOR_KEY, wire, type Database } from "./visibility-read-fixture.js";

const construction = vi.hoisted(() => ({ native: false }));
vi.mock("../services/activity.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/activity.js")>();
  return { ...original, activityService: (...args: Parameters<typeof original.activityService>) => {
    const service = original.activityService(...args); const forbidden = () => { throw new Error("Node Activity link read projection executed"); };
    return construction.native ? { ...service, listUserActivityLedger: forbidden, runsForIssue: forbidden, issuesForRun: forbidden } : service;
  } };
});

describe.each(["off", "required"] as const)("Activity links and ledger public reads (%s ingress)", (ingress) => {
  let fixture: Database, ids: Awaited<ReturnType<typeof identities>>, server: Awaited<ReturnType<typeof publicServer>>;
  let issueId: string, projectId: string, chatId: string, approvalId: string, runId: string;
  const stamp = "2032-01-01T00:00:00.000Z";
  const tables = ["activity_log", "heartbeat_runs", "issues", "chat_conversations", "chat_messages", "issue_comments", "approval_comments", "operator_profiles", "instance_settings"];
  const get = (route: string, token = ids.agentToken) => request(server.target).get(`/api/${route}`).set("authorization", `Bearer ${token}`);
  const ledgerPath = (user: string = ids.userId) => `orgs/${ids.orgId}/users/${user}/activity-ledger`;
  const cursor = (id: string, kind = "activity_event", occurredAt = stamp) => Buffer.from(JSON.stringify({ occurredAt, kind, id })).toString("base64url");
  async function addIssue(extra: Partial<typeof issues.$inferInsert> = {}) { const id = randomUUID(); await fixture.db.insert(issues).values({ id, orgId: ids.orgId, title: "Issue", ...extra }); return id; }
  async function addRun(extra: Partial<typeof heartbeatRuns.$inferInsert> = {}) { const id = randomUUID(); await fixture.db.insert(heartbeatRuns).values({ id, orgId: ids.orgId, agentId: ids.agentId, contextSnapshot: { issueId }, ...extra }); return id; }
  async function pairLedger(filters: Parameters<ReturnType<typeof activityService>["listUserActivityLedger"]>[0], query: Record<string, unknown>) {
    const response = await get(ledgerPath(filters.userId)).query(query); expect(response.status, response.text).toBe(200);
    expect(response.body).toEqual(wire(await activityService(fixture.db).listUserActivityLedger(filters))); return response.body;
  }
  beforeAll(async () => {
    fixture = await database(); ids = await identities(fixture.db); projectId = randomUUID();
    await fixture.db.insert(projects).values({ id: projectId, orgId: ids.orgId, name: "Ledger project" });
    issueId = await addIssue({ identifier: "LINK-101", projectId, assigneeAgentId: ids.agentId, reviewerAgentId: ids.agentId });
    chatId = randomUUID(); approvalId = randomUUID();
    await fixture.db.insert(chatConversations).values({ id: chatId, orgId: ids.orgId, title: "Ledger chat", createdByUserId: ids.userId, primaryIssueId: issueId, preferredAgentId: ids.agentId, routedAgentId: ids.agentId });
    await fixture.db.insert(approvals).values({ id: approvalId, orgId: ids.orgId, type: "hire_agent", requestedByAgentId: ids.agentId, payload: { issueId, projectId } });
    await fixture.db.insert(operatorProfiles).values({ userId: ids.userId, nickname: "Synthetic reader" });
    runId = await addRun({ contextSnapshot: { issueId, resumeFromRunId: "source", passiveFollowup: { attempt: 2, maxAttempts: 4, secret: "omit" }, resumeSessionParams: { secret: "omit" }, delegationTask: "omit" }, usageJson: { provider: "usage-provider", model: "usage-model" }, resultJson: { summary: "fallback-summary", provider: "fallback-provider", secret: "omit" }, resultSummaryJson: { message: "explicit-result" } });
    await fixture.db.insert(chatMessages).values({ orgId: ids.orgId, conversationId: chatId, role: "user", body: "  chat\n message  ", runId, replyingAgentId: ids.agentId, createdAt: new Date(stamp) });
    await fixture.db.insert(issueComments).values({ orgId: ids.orgId, issueId, authorUserId: ids.userId, body: "  issue comment  ", createdAt: new Date(stamp) });
    await fixture.db.insert(approvalComments).values({ orgId: ids.orgId, approvalId, authorUserId: ids.userId, body: "  approval comment  ", createdAt: new Date(stamp) });
    await fixture.db.insert(activityLog).values({ orgId: ids.orgId, actorType: "user", actorId: ids.userId, agentId: ids.agentId, runId, action: "issue.updated", entityType: "issue", entityId: issueId, details: { title: "  Changed title  ", status: "todo", note: "note" }, createdAt: new Date(stamp) });
    server = await publicServer(fixture, ingress, (app, bridge) => { construction.native = true; try { app.use("/api", activityRoutes(fixture.db, bridge)); } finally { construction.native = false; } });
  }, 120000);
  afterAll(async () => { await server?.close(); await fixture?.close(); });

  it("pairs all four ledger sources, exact-time kind order and full metadata without writes", async () => {
    const before = await snapshot(fixture.db, tables);
    const body = await pairLedger({ orgId: ids.orgId, userId: ids.userId }, {});
    expect(body.items.map((row: { kind: string }) => row.kind)).toEqual(["activity_event", "approval_comment", "chat_message", "issue_comment"]);
    expect(await snapshot(fixture.db, tables)).toEqual(before);
  });
  it("pairs every include family, agent/project/issue filters and inclusive windows", async () => {
    for (const include of [[], ["chat"], ["comments"], ["issues"], ["approvals"], ["activity"], ["chat", "activity"]] as Array<Array<"chat" | "comments" | "issues" | "approvals" | "activity">>) {
      for (const filters of [{}, { agentId: ids.agentId }, { projectId }, { issueId }, { issueId: randomUUID() }]) {
        await pairLedger({ orgId: ids.orgId, userId: ids.userId, include, ...filters, since: new Date(stamp), until: new Date(stamp) }, { include: include.join(","), ...filters, since: stamp, until: stamp });
      }
    }
  });
  it("keeps me resolution and rejects invalid query inputs before dispatch", async () => {
    const board = await get(ledgerPath("me"), ids.boardToken); expect(board.body).toEqual(wire(await activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: ids.userId })));
    const agent = await get(ledgerPath("me")); expect(agent.body).toEqual(wire(await activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: "local-board" })));
    for (const query of ["limit=", "limit=0", "limit=1.5", "limit=101", "limit=1&limit=2", "include=unknown", "include=chat&include=comments", "since=invalid", "since=", "until=invalid", "until=1&until=2"]) expect((await get(`${ledgerPath()}?${query}`)).status, query).toBe(400);
    for (const query of ["limit=0x10", "limit=1e1", "include=,chat,,", "cursor=&cursor=x", "cursor=", "since=today", "since=1h", "since=1d", "since=1w"]) expect((await get(`${ledgerPath()}?${query}`)).status, query).toBe(200);
    expect((await get(`${ledgerPath()}?agentId=invalid`)).status).toBe(500);
  });
  it("preserves native limit and cursor errors before an overflowing relative Date", async () => {
    const overflow = "999999999999999999999999999999999999999999999999999999h";
    for (const field of ["since", "until"] as const) {
      for (const [control, error] of [[{ limit: 101 }, "'limit' must be between 1 and 100"], [{ cursor: "invalid" }, "User activity cursor is invalid or expired"]] as const) {
        await expect(activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: ids.userId, [field]: new Date(NaN), ...control })).rejects.toMatchObject({ status: 400, message: error });
        const response = await get(ledgerPath()).query({ [field]: overflow, ...control }); expect(response.status, response.text).toBe(400); expect(response.body.error).toBe(error);
      }
      await expect(activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: ids.userId, [field]: new Date(NaN) })).rejects.toThrow();
      expect((await get(ledgerPath()).query({ [field]: overflow })).status).toBe(500);
    }
  });
  it("preserves invalid-Date500 for empty sources under repeated and generic SQL plans", async () => {
    const user = randomUUID(), overflow = "999999999999999999999999999999999999999999999999999999h";
    for (let attempt = 0; attempt < 8; attempt++) expect((await get(ledgerPath(user)).query({ since: overflow, include: "activity" })).status).toBe(500);
    await fixture.db.execute(sql`ALTER DATABASE postgres SET plan_cache_mode = 'force_generic_plan'`);
    const restart = async () => { await server.bridge.close(); await server.bridge.start(); if (ingress === "required") { await server.bridge.waitForPublicIngressReady!(); server.target = server.bridge.publicIngressBaseUrl!; } };
    try {
      await restart();
      for (const field of ["since", "until"] as const) for (const control of [{}, { limit: 101 }, { cursor: "invalid" }]) {
        const expectedStatus = Object.keys(control).length ? 400 : 500;
        await expect(activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: user, include: ["activity"], [field]: new Date(NaN), ...control })).rejects.toThrow();
        const response = await get(ledgerPath(user)).query({ include: "activity", [field]: overflow, ...control }); expect(response.status, response.text).toBe(expectedStatus);
      }
    } finally { await fixture.db.execute(sql`ALTER DATABASE postgres SET plan_cache_mode = 'auto'`); await restart(); }
  });
  it("pairs full host-locale UUID order and raw uppercase cursor source caps", async () => {
    const user = randomUUID();
    const rowIds = ["aa000000", "ab000000", "b0000000", "c0000000", "d0000000"].map((prefix) => `${prefix}-0000-4000-8000-00000000000a`);
    await fixture.db.insert(activityLog).values(rowIds.map((id) => ({ id, orgId: ids.orgId, actorType: "user", actorId: user, action: "project.updated", entityType: "project", entityId: "locale", createdAt: new Date(stamp) })));
    const base = { orgId: ids.orgId, userId: user, include: ["activity"] as "activity"[], since: new Date(stamp), until: new Date(stamp) };
    const query = { include: "activity", since: stamp, until: stamp };
    const full = await pairLedger(base, query); expect(full.items.map((row: { id: string }) => row.id)).toEqual([...rowIds].sort((a, b) => a.localeCompare(b)));
    await pairLedger({ ...base, limit: 1 }, { ...query, limit: 1 });
    for (const id of [rowIds[3]!, rowIds[3]!.toUpperCase(), `${rowIds[3]!.slice(0, -1)}A`, rowIds[2]!, rowIds[4]!]) {
      const encoded = cursor(id); await pairLedger({ ...base, limit: 1, cursor: encoded }, { ...query, limit: 1, cursor: encoded });
    }
    console.log("LEDGER locale public pair", Intl.Collator().resolvedOptions(), full.items.map((row: { id: string }) => row.id));
  });
  it("retains the discriminating b/c/d uppercase limit1 empty-page behavior", async () => {
    const user = randomUUID(), rowIds = ["b", "c", "d"].map((prefix) => `${prefix}1000000-0000-4000-8000-00000000000a`);
    await fixture.db.insert(activityLog).values(rowIds.map((id) => ({ id, orgId: ids.orgId, actorType: "user", actorId: user, action: "project.updated", entityType: "project", entityId: "raw-cursor", createdAt: new Date(stamp) })));
    for (const id of [rowIds[1]!, rowIds[1]!.toUpperCase(), `${rowIds[1]!.slice(0, -1)}A`, rowIds[0]!, rowIds[2]!]) {
      const encoded = cursor(id); const body = await pairLedger({ orgId: ids.orgId, userId: user, include: ["activity"], limit: 1, cursor: encoded }, { include: "activity", limit: 1, cursor: encoded });
      if (Intl.Collator().resolvedOptions().locale.startsWith("en") && id === rowIds[1]!.toUpperCase()) expect(body).toEqual({ items: [], nextCursor: null });
    }
  });
  it("accepts legacy base64 variants and discloses the four-kind cursor restriction", async () => {
    const id = randomUUID(), normal = cursor(id);
    for (const encoded of [normal, `${normal}===`, `!${normal.slice(0, 4)}\n${normal.slice(4)}`, Buffer.from(JSON.stringify({ occurredAt: stamp, kind: "activity_event", id, extra: true })).toString("base64")]) await pairLedger({ orgId: ids.orgId, userId: ids.userId, cursor: encoded }, { cursor: encoded });
    for (const kind of ["ACTIVITY_EVENT", "äctivity_event", "ａｃｔｉｖｉｔｙ_event", "\u0000activity_event", "unknown", ""]) {
      const response = await get(ledgerPath()).query({ cursor: cursor(id, kind) }); expect(response.status, response.text).toBe(400); expect(response.body.error).toBe("User activity cursor is invalid or expired");
    }
    for (const encoded of ["bad", cursor("invalid"), cursor(id, "activity_event", "2032-13-01T00:00:00.000Z")]) expect((await get(ledgerPath()).query({ cursor: encoded })).status).toBe(400);
  });
  it("pairs overflowing ISO days, midnight24, year-zero database errors and microsecond page boundaries", async () => {
    const id = randomUUID();
    for (const occurredAt of ["2032-02-31T00:00:00.000Z", "2032-01-01T24:00:00.000Z", "0000-01-01T00:00:00.000Z"]) {
      const encoded = cursor(id, "activity_event", occurredAt); let expectedStatus = 200; let expected: unknown;
      try { expected = wire(await activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: ids.userId, cursor: encoded })); } catch { expectedStatus = 500; }
      const response = await get(ledgerPath()).query({ cursor: encoded }); expect(response.status, response.text).toBe(expectedStatus); if (expectedStatus === 200) expect(response.body).toEqual(expected);
    }
    const user = randomUUID(); await fixture.db.insert(activityLog).values(Array.from({ length: 7 }, (_, index) => ({ orgId: ids.orgId, actorType: "user", actorId: user, action: "project.updated", entityType: "project", entityId: "micros", createdAt: sql`${`2033-01-01T00:00:00.000${index + 1}00Z`}::timestamptz` })));
    const first = await pairLedger({ orgId: ids.orgId, userId: user, include: ["activity"], limit: 2 }, { include: "activity", limit: 2 });
    await pairLedger({ orgId: ids.orgId, userId: user, include: ["activity"], limit: 2, cursor: first.nextCursor }, { include: "activity", limit: 2, cursor: first.nextCursor });
  });
  it("keeps hydration exclusions after source limits and before invalid-Date serialization", async () => {
    const user = randomUUID(), hidden = await addIssue({ hiddenAt: new Date() });
    await fixture.db.insert(activityLog).values([{ orgId: ids.orgId, actorType: "user", actorId: user, action: "issue.updated", entityType: "issue", entityId: hidden, details: { status: "todo" }, createdAt: sql`'infinity'::timestamptz` }, { orgId: ids.orgId, actorType: "user", actorId: user, action: "issue.updated", entityType: "issue", entityId: randomUUID(), details: { status: "todo" }, createdAt: new Date("2040-01-01Z") }, { orgId: ids.orgId, actorType: "user", actorId: user, action: "project.updated", entityType: "project", entityId: "visible", createdAt: new Date("2030-01-01Z") }]);
    const body = await pairLedger({ orgId: ids.orgId, userId: user, include: ["activity"], limit: 1 }, { include: "activity", limit: 1 }); expect(body).toEqual({ items: [], nextCursor: null });
    const [visible] = await fixture.db.insert(activityLog).values({ orgId: ids.orgId, actorType: "user", actorId: user, action: "project.updated", entityType: "project", entityId: "invalid-date", createdAt: sql`'infinity'::timestamptz` }).returning();
    try { await expect(activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: user })).rejects.toThrow(); expect((await get(ledgerPath(user))).status).toBe(500); }
    finally { await fixture.db.delete(activityLog).where(eq(activityLog.id, visible!.id)); }
  });
  it("preserves all existing ledger organization fences on dirty related rows", async () => {
    const user = randomUUID(), foreignIssue = randomUUID(), foreignChat = randomUUID(), foreignApproval = randomUUID();
    await fixture.db.insert(issues).values({ id: foreignIssue, orgId: ids.foreign, title: "Foreign issue" });
    await fixture.db.insert(chatConversations).values({ id: foreignChat, orgId: ids.foreign, createdByUserId: user });
    await fixture.db.insert(approvals).values({ id: foreignApproval, orgId: ids.foreign, type: "hire_agent", payload: {} });
    await fixture.db.insert(chatMessages).values({ orgId: ids.orgId, conversationId: foreignChat, role: "user", body: "Foreign chat text" });
    await fixture.db.insert(issueComments).values({ orgId: ids.orgId, issueId: foreignIssue, authorUserId: user, body: "Foreign issue text" });
    await fixture.db.insert(approvalComments).values({ orgId: ids.orgId, approvalId: foreignApproval, authorUserId: user, body: "Foreign approval text" });
    await fixture.db.insert(activityLog).values([{ orgId: ids.orgId, actorType: "user", actorId: user, action: "issue.updated", entityType: "issue", entityId: foreignIssue, details: { status: "todo" } }, { orgId: ids.orgId, actorType: "user", actorId: user, action: "approval.updated", entityType: "approval", entityId: foreignApproval }]);
    expect((await pairLedger({ orgId: ids.orgId, userId: user }, {})).items).toEqual([]);
  });
  it("pairs low-signal exclusions, UTF16 excerpts, JSON string reparsing and deep details", async () => {
    const user = randomUUID(); const [event] = await fixture.db.insert(activityLog).values({ orgId: ids.orgId, actorType: "user", actorId: user, action: "project.updated", entityType: "project", entityId: "json" }).returning();
    for (const raw of ['{"nested":' + '['.repeat(600) + '9007199254740993' + ']'.repeat(600) + '}', JSON.stringify('{"title":"\\ud800","note":"' + 'x'.repeat(236) + '\\ud83d\\ude00tail"}'), JSON.stringify('{"\\ud800":true,"comment":"fallback"}'), JSON.stringify('"primitive"'), '{"title":"  title  ","note":"","comment":"ignored"}']) {
      await fixture.db.execute(sql`UPDATE activity_log SET details=${raw}::jsonb WHERE id=${event!.id}::uuid`); await pairLedger({ orgId: ids.orgId, userId: user }, {});
    }
    await fixture.db.insert(activityLog).values(["issue.read_marked", "issue.comment_added", "approval.comment_added"].map((action) => ({ orgId: ids.orgId, actorType: "user", actorId: user, action, entityType: "issue", entityId: issueId })));
    await fixture.db.insert(activityLog).values({ orgId: ids.orgId, actorType: "user", actorId: user, action: "issue.updated", entityType: "issue", entityId: issueId, details: { title: "low signal" } });
    expect((await pairLedger({ orgId: ids.orgId, userId: user }, {})).items).toHaveLength(1);
  });
  it("protects active, kept and expired SideChat message and title events before ledger caps", async () => {
    const user = randomUUID(), token = `rudder_board_${randomUUID()}`, ordinary = randomUUID();
    await fixture.db.insert(authUsers).values({ id: user, name: "Ledger owner", email: `${user}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await fixture.db.insert(boardApiKeys).values({ userId: user, name: "Ledger owner", keyHash: createHash("sha256").update(token).digest("hex") });
    await fixture.db.insert(organizationMemberships).values({ orgId: ids.orgId, principalType: "user", principalId: user, status: "active", membershipRole: "member" });
    const privateRows = ["active", "kept", "expired"].map((state, index) => ({ chat: randomUUID(), message: randomUUID(), event: randomUUID(), state, title: `PRIVATE_LEDGER_${state}_TITLE`, body: `PRIVATE_LEDGER_${state}_BODY`, createdAt: new Date(`2044-06-15T12:00:0${3 - index}.123Z`) }));
    const ordinaryMessage = randomUUID(), ordinaryEvent = randomUUID(), createdAt = new Date("2044-06-15T12:00:00.123Z");
    await fixture.db.insert(chatConversations).values([{ id: ordinary, orgId: ids.orgId, conversationKind: "chat", createdByUserId: user, title: "ORDINARY_LEDGER_TITLE" }, ...privateRows.map((row) => ({ id: row.chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: user, title: row.title, sideChatState: row.state, messengerVisible: row.state === "kept", sideChatExpiresAt: row.state === "active" ? new Date(Date.now() + 3600000) : null }))]);
    await fixture.db.insert(chatMessages).values([{ id: ordinaryMessage, orgId: ids.orgId, conversationId: ordinary, role: "user", body: "ORDINARY_LEDGER_BODY", createdAt }, ...privateRows.map((row) => ({ id: row.message, orgId: ids.orgId, conversationId: row.chat, role: "user", body: row.body, createdAt: row.createdAt }))]);
    await fixture.db.insert(activityLog).values([{ id: ordinaryEvent, orgId: ids.orgId, actorType: "user", actorId: user, action: "chat.updated", entityType: "chat", entityId: ordinary, details: { title: "ORDINARY_LEDGER_TITLE" }, createdAt }, ...privateRows.map((row) => ({ id: row.event, orgId: ids.orgId, actorType: "user", actorId: user, action: "chat.updated", entityType: "chat", entityId: row.chat, details: { title: row.title }, createdAt: row.createdAt }))]);
    const before = await snapshot(fixture.db, tables), privateIds = new Set<string>(privateRows.flatMap((row) => [row.message, row.event]));
    for (const include of ["chat", "activity", undefined] as const) {
      const query = { since: "2044-06-15T00:00:00.000Z", until: "2044-06-16T00:00:00.000Z", ...(include ? { include } : {}) };
      const original = wire(await activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: user, since: new Date(query.since), until: new Date(query.until), ...(include ? { include: [include] } : {}) }));
      expect(JSON.stringify(original)).toContain("PRIVATE_LEDGER_"); // Retained legacy leak; native intentionally enforces current ownership.
      for (const [viewer, isOwner] of [[token, true], [ids.boardToken, false], [ids.agentToken, false]] as const) {
        const expected = { ...original, items: original.items.filter((row: { id: string }) => isOwner || !privateIds.has(row.id)) };
        const response = await get(ledgerPath(user), viewer).query(query); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(expected);
        const rows: Array<{ id: string }> = []; let next: string | undefined;
        for (let page = 0; page <= expected.items.length; page++) {
          const response = await get(ledgerPath(user), viewer).query({ ...query, limit: 1, ...(next ? { cursor: next } : {}) });
          expect(response.status, response.text).toBe(200); expect(response.body.items).toHaveLength(1);
          if (!isOwner) expect(response.text).not.toContain("PRIVATE_LEDGER_");
          rows.push(...response.body.items); next = response.body.nextCursor; if (!next) break;
        }
        expect(next).toBeNull(); expect(rows.map((row) => row.id)).toEqual(expected.items.map((row: { id: string }) => row.id));
      }
    }
    expect(await snapshot(fixture.db, tables)).toEqual(before);
  });
  it("hides foreign, missing and malformed chat Activity targets while retaining ordinary and other entity events", async () => {
    const user = randomUUID(), ordinary = randomUUID(), foreign = randomUUID(), missing = randomUUID();
    await fixture.db.insert(chatConversations).values([{ id: ordinary, orgId: ids.orgId, conversationKind: "chat", createdByUserId: user }, { id: foreign, orgId: ids.foreign, conversationKind: "chat", createdByUserId: user }]);
    const rows = [foreign, missing, "malformed-chat-id", ordinary, "ordinary-project"].map((entityId, index) => ({ id: randomUUID(), orgId: ids.orgId, actorType: "user", actorId: user, action: index === 4 ? "project.updated" : "chat.updated", entityType: index === 4 ? "project" : "chat", entityId, details: { title: `target-${index}` }, createdAt: new Date(`2044-07-01T00:00:0${5 - index}.000Z`) }));
    await fixture.db.insert(activityLog).values(rows);
    const original = wire(await activityService(fixture.db).listUserActivityLedger({ orgId: ids.orgId, userId: user, include: ["activity"] })); expect(original.items).toHaveLength(5);
    for (const token of [ids.boardToken, ids.agentToken]) {
      const response = await get(ledgerPath(user), token).query({ include: "activity" }); expect(response.status, response.text).toBe(200); expect(response.body).toEqual({ ...original, items: original.items.filter((row: { id: string }) => rows.slice(3).some((visible) => visible.id === row.id)) });
      const first = await get(ledgerPath(user), token).query({ include: "activity", limit: 1 }); expect(first.body.items[0].id).toBe(rows[3]!.id);
      const second = await get(ledgerPath(user), token).query({ include: "activity", limit: 1, cursor: first.body.nextCursor }); expect(second.body.items[0].id).toBe(rows[4]!.id); expect(second.body.nextCursor).toBeNull();
    }
  });
  it("normalizes the verified local-board owner for both private ledger sources", async () => {
    const chat = randomUUID(), createdAt = new Date("2045-01-01T00:00:00.123Z");
    await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: "local-board", title: "LOCAL_LEDGER_PRIVATE_TITLE" });
    await fixture.db.insert(chatMessages).values({ orgId: ids.orgId, conversationId: chat, role: "user", body: "LOCAL_LEDGER_PRIVATE_BODY", createdAt });
    await fixture.db.insert(activityLog).values({ orgId: ids.orgId, actorType: "user", actorId: "local-board", action: "chat.updated", entityType: "chat", entityId: chat, details: { title: "LOCAL_LEDGER_PRIVATE_TITLE" }, createdAt });
    for (const [actor, visible] of [[{ type: "board", source: "local_implicit", isInstanceAdmin: true }, true], [{ type: "board", source: "session", userId: ids.userId }, false], [{ type: "agent", source: "agent_key", agentId: ids.agentId, orgId: ids.orgId }, false]] as const) {
      const response = await server.bridge.activityLinkRead!(actor, ids.orgId, { operation: "user-ledger", userId: "local-board", since: "2045-01-01T00:00:00.000Z", until: "2045-01-02T00:00:00.000Z", legacyDateTimezone: "UTC" });
      expect(response.status, response.body.toString()).toBe(200); expect(JSON.parse(response.body.toString()).items).toHaveLength(visible ? 2 : 0);
    }
  });
  it.each(["owner", "org", "delete"] as const)("rechecks chat Activity visibility after public authorization (%s)", async (change) => {
    const chat = randomUUID(), user = ids.userId;
    await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: user });
    await fixture.db.insert(activityLog).values({ orgId: ids.orgId, actorType: "user", actorId: user, action: "chat.updated", entityType: "chat", entityId: chat, details: { title: "CURRENT_LEDGER_PRIVATE_TITLE" }, createdAt: new Date("2046-01-01T00:00:00.000Z") });
    const query = { include: "activity", since: "2046-01-01T00:00:00.000Z", until: "2046-01-01T00:00:00.000Z" };
    const before = await get(ledgerPath(user), ids.boardToken).query(query); expect(before.status).toBe(200); expect(before.text).toContain("CURRENT_LEDGER_PRIVATE_TITLE");
    const read = server.bridge.activityLinkRead!; server.bridge.activityLinkRead = async (...args) => {
      if (change === "delete") await fixture.db.delete(chatConversations).where(eq(chatConversations.id, chat));
      else await fixture.db.update(chatConversations).set(change === "owner" ? { createdByUserId: "other-user" } : { orgId: ids.foreign }).where(eq(chatConversations.id, chat));
      return read(...args);
    };
    try { const response = await get(ledgerPath(user), ids.boardToken).query(query); expect(response.status, response.text).toBe(200); expect(response.text).not.toContain("CURRENT_LEDGER_PRIVATE_TITLE"); }
    finally { server.bridge.activityLinkRead = read; }
  });
  it("pairs Issue identifier lookup, result metadata precedence and context redaction", async () => {
    const expected = wire(await activityService(fixture.db).runsForIssue(ids.orgId, issueId));
    for (const reference of [issueId, "LINK-101", "link-101"]) { const response = await get(`issues/${reference}/runs`); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(expected); }
    expect(expected[0].contextSnapshot).toEqual({ issueId, resumeFromRunId: "source", passiveFollowup: { attempt: 2, maxAttempts: 4 } });
    expect(expected[0].resultJson).toEqual({ provider: "usage-provider", model: "usage-model", message: "explicit-result" });
    expect(JSON.stringify(expected)).not.toContain("omit");
  });
  it("pairs fallback SQL truncation, primitive spread, deep JSON and UTF16 usage truncation", async () => {
    const issue = await addIssue(), run = await addRun({ contextSnapshot: { issueId: issue }, resultJson: { summary: "😀".repeat(600), stdout: "x".repeat(33000), secret: "omit", total_cost_usd: 1.2 } });
    for (const raw of ['null', JSON.stringify('"\\ud800"'), JSON.stringify('{"\\ud800":true}'), '[1,true]', '{"nested":' + '['.repeat(600) + '1' + ']'.repeat(600) + '}']) {
      await fixture.db.execute(sql`UPDATE heartbeat_runs SET result_summary_json=${raw === "null" ? null : raw}::jsonb,usage_json=${JSON.stringify(JSON.stringify({ provider: "x".repeat(499) + "😀", billingType: "b".repeat(101) }))}::jsonb WHERE id=${run}::uuid`);
      const response = await get(`issues/${issue}/runs`); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(wire(await activityService(fixture.db).runsForIssue(ids.orgId, issue)));
    }
  });
  it.each(["heartbeat-runs", "agent-runs"])("pairs %s context-first deduplication, hidden suppression and short references", async (alias) => {
    const primary = await addIssue(), secondary = await addIssue(), hidden = await addIssue({ hiddenAt: new Date() });
    const run = await addRun({ contextSnapshot: { issueId: primary } });
    await fixture.db.insert(activityLog).values([secondary, hidden, secondary].map((entityId) => ({ orgId: ids.orgId, actorType: "user", actorId: ids.userId, action: "issue.updated", entityType: "issue", entityId, runId: run })));
    const expected = wire(await activityService(fixture.db).issuesForRun(run)); expect(expected.map((row: { issueId: string }) => row.issueId)).toEqual([primary, secondary]);
    for (const reference of [run, run.toUpperCase(), run.replaceAll("-", "").slice(0, 12), `run_${run.replaceAll("-", "").slice(0, 12)}`]) { const response = await get(`${alias}/${reference}/issues`); expect(response.status, response.text).toBe(200); expect(response.body).toEqual(expected); }
    await fixture.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: secondary } }).where(eq(heartbeatRuns.id, run));
    expect((await get(`${alias}/${run}/issues`)).body).toEqual(wire(await activityService(fixture.db).issuesForRun(run)));
    const missing = await get(`${alias}/${randomUUID()}/issues`); expect(missing.status).toBe(404); expect(missing.body.error).toBe(alias === "heartbeat-runs" ? "Heartbeat run not found" : "Agent run not found");
    await fixture.db.update(heartbeatRuns).set({ contextSnapshot: { issueId: "invalid" } }).where(eq(heartbeatRuns.id, run));
    expect((await get(`${alias}/${run}/issues`)).status).toBe(500);
  });
  it("preserves shared runs and hides private SideChat rows from other Board users and Agents", async () => {
    const issue = await addIssue(), ownChat = randomUUID(), otherChat = randomUUID(), ordinary = randomUUID();
    await fixture.db.insert(chatConversations).values([{ id: ownChat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: ids.userId }, { id: otherChat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: "other-user" }, { id: ordinary, orgId: ids.orgId, conversationKind: "chat", createdByUserId: "other-user" }]);
    const own = await addRun({ chatConversationId: ownChat, contextSnapshot: { issueId: issue, scene: "side_chat" } });
    const other = await addRun({ chatConversationId: otherChat, contextSnapshot: { issueId: issue, unifiedAgentRun: { scene: "side_chat" } } });
    const shared = await addRun({ contextSnapshot: { issueId: issue } }), chat = await addRun({ chatConversationId: ordinary, contextSnapshot: { issueId: issue, scene: "chat" } });
    const orphan = await addRun({ contextSnapshot: { issueId: issue, scene: "side_chat" } }), legacyOrphan = await addRun({ contextSnapshot: { issueId: issue, rudderScene: "chat" } });
    expect((await activityService(fixture.db).runsForIssue(ids.orgId, issue))).toHaveLength(6);
    for (const [token, visible] of [[ids.agentToken, [shared, chat]], [ids.boardToken, [own, shared, chat]]] as const) {
      const response = await get(`issues/${issue}/runs`, token); expect(response.status, response.text).toBe(200); expect(new Set(response.body.map((row: { runId: string }) => row.runId))).toEqual(new Set(visible));
      for (const alias of ["heartbeat-runs", "agent-runs"]) for (const run of [own, other, shared, chat, orphan, legacyOrphan]) expect((await get(`${alias}/${run}/issues`, token)).status, `${alias}/${run}`).toBe(visible.includes(run) ? 200 : 404);
    }
  });
  it("filters private prefix collisions before LIMIT2 ambiguity and retains visible ambiguity", async () => {
    const prefix = randomUUID().slice(0, 8), privateId = `${prefix}-0000-4000-8000-000000000001`, visibleId = `${prefix}-0000-4000-8000-000000000002`, second = `${prefix}-0000-4000-8000-000000000003`, chat = randomUUID();
    await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: "other-user" });
    await addRun({ id: privateId, chatConversationId: chat, contextSnapshot: { issueId, scene: "side_chat" } }); await addRun({ id: visibleId });
    for (const alias of ["heartbeat-runs", "agent-runs"]) expect((await get(`${alias}/${prefix}/issues`)).status).toBe(200);
    await addRun({ id: second }); for (const alias of ["heartbeat-runs", "agent-runs"]) expect((await get(`${alias}/${prefix}/issues`)).status).toBe(409);
  });
  it("uses local-board for a Board envelope lacking userId (non-public normalization control)", async () => {
    const chat = randomUUID(); await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: "local-board" });
    const run = await addRun({ chatConversationId: chat, contextSnapshot: { issueId, scene: "side_chat" } });
    const response = await server.bridge.activityLinkRead!({ type: "board", source: "local_implicit", isInstanceAdmin: true }, ids.orgId, { operation: "run-issues", runId: run, runAlias: "agent", legacyDateTimezone: "UTC" });
    expect(response.status).toBe(200); expect(JSON.parse(response.body.toString())).toEqual(wire(await activityService(fixture.db).issuesForRun(run)));
  });
  it.each(["issue-org", "run-org", "chat-owner", "chat-org"] as const)("rechecks current signed scope and visibility after Node identity resolution (%s)", async (change) => {
    const issue = await addIssue(), chat = randomUUID(); await fixture.db.insert(chatConversations).values({ id: chat, orgId: ids.orgId, conversationKind: "side_chat", createdByUserId: ids.userId });
    const run = await addRun({ chatConversationId: chat, contextSnapshot: { issueId: issue, scene: "side_chat" } });
    const read = server.bridge.activityLinkRead!; server.bridge.activityLinkRead = async (...args) => {
      if (change === "issue-org") await fixture.db.update(issues).set({ orgId: ids.foreign }).where(eq(issues.id, issue));
      if (change === "run-org") await fixture.db.update(heartbeatRuns).set({ orgId: ids.foreign }).where(eq(heartbeatRuns.id, run));
      if (change === "chat-owner") await fixture.db.update(chatConversations).set({ createdByUserId: "other-user" }).where(eq(chatConversations.id, chat));
      if (change === "chat-org") await fixture.db.update(chatConversations).set({ orgId: ids.foreign }).where(eq(chatConversations.id, chat));
      return read(...args);
    };
    try { const response = await get(change === "issue-org" ? `issues/${issue}/runs` : `agent-runs/${run}/issues`, ids.boardToken); expect(response.status, response.text).toBe(404); }
    finally { server.bridge.activityLinkRead = read; }
  });
  it("enforces current Board membership for all four public bindings", async () => {
    const routes = [ledgerPath(), `issues/${issueId}/runs`, `heartbeat-runs/${runId}/issues`, `agent-runs/${runId}/issues`];
    for (const route of routes) { expect((await request(server.target).get(`/api/${route}`)).status).toBe(401); expect((await get(route, ids.boardToken)).status).toBe(200); }
    expect((await get(`orgs/${ids.foreign}/users/${ids.userId}/activity-ledger`)).status).toBe(403);
    await fixture.db.update(organizationMemberships).set({ status: "inactive" }).where(and(eq(organizationMemberships.orgId, ids.orgId), eq(organizationMemberships.principalId, ids.userId)));
    try { for (const route of routes) expect((await get(route, ids.boardToken)).status).toBe(403); }
    finally { await fixture.db.update(organizationMemberships).set({ status: "active" }).where(and(eq(organizationMemberships.orgId, ids.orgId), eq(organizationMemberships.principalId, ids.userId))); }
  });
  it("rejects a signed foreign issue or run after public same-org resolution", async () => {
    const foreignAgent = randomUUID(); await fixture.db.insert(agents).values({ id: foreignAgent, orgId: ids.foreign, name: "Foreign", role: "general" });
    const foreignIssue = await addIssue({ orgId: ids.foreign }), foreignRun = await addRun({ orgId: ids.foreign, agentId: foreignAgent });
    const read = server.bridge.activityLinkRead!;
    server.bridge.activityLinkRead = (actor, org, input) => read(actor, org, input.operation === "issue-runs" ? { ...input, issueId: foreignIssue } : { ...input, runId: foreignRun });
    try { for (const route of [`issues/${issueId}/runs`, `heartbeat-runs/${runId}/issues`, `agent-runs/${runId}/issues`]) expect((await get(route)).status).toBe(404); }
    finally { server.bridge.activityLinkRead = read; }
  });
  it("overrides caller locale and rejects signed missing/invalid locale separately from tampering", async () => {
    const input = { operation: "user-ledger" as const, userId: ids.userId, canonicalLocale: "invalid_!", legacyDateTimezone: "UTC" };
    expect((await server.bridge.activityLinkRead!({ type: "agent", source: "agent_key", agentId: ids.agentId, orgId: ids.orgId }, ids.orgId, input)).status).toBe(200);
    const nativeFetch = globalThis.fetch;
    for (const mode of ["missing", "empty", "invalid", "long", "tamper"] as const) {
      const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
        if (!String(url).endsWith("/activity-link-reads")) return nativeFetch(url, options);
        const input = JSON.parse(Buffer.from(options!.body as Uint8Array).toString());
        if (mode === "missing") delete input.canonicalLocale; else input.canonicalLocale = mode === "empty" ? "" : mode === "long" ? "x".repeat(257) : "invalid_!";
        const body = Buffer.from(JSON.stringify(input)), headers = { ...options!.headers as Record<string, string> };
        if (mode !== "tamper") headers["x-rudder-actor-envelope"] = JSON.stringify(createRustActorEnvelope({ actor: { type: "agent", source: "agent_key", agentId: ids.agentId, orgId: ids.orgId }, organizationId: ids.orgId, method: "POST", path: new URL(String(url)).pathname, action: "activity_link.read", body, secret: VISIBILITY_ACTOR_KEY, requestId: headers["x-rudder-request-id"] }));
        return nativeFetch(url, { ...options, headers, body: body as unknown as BodyInit });
      });
      try { expect((await get(ledgerPath())).status, mode).toBe(mode === "tamper" ? 401 : 422); } finally { spy.mockRestore(); }
    }
  });
  it("fails closed without native transport and returns no Node projection", async () => {
    const read = server.bridge.activityLinkRead; server.bridge.activityLinkRead = undefined;
    try { for (const route of [ledgerPath(), `issues/${issueId}/runs`, `agent-runs/${runId}/issues`, `heartbeat-runs/${runId}/issues`]) expect((await get(route)).status).toBe(503); }
    finally { server.bridge.activityLinkRead = read; }
  });
  it("returns503 for an unreachable private TCP endpoint and recovers after a real process restart", async () => {
    const routes = [ledgerPath(), `issues/${issueId}/runs`, `agent-runs/${runId}/issues`, `heartbeat-runs/${runId}/issues`], before = await snapshot(fixture.db, tables);
    const closedPort = await port(), nativeFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
      if (!String(url).endsWith("/activity-link-reads")) return nativeFetch(url, options);
      const closed = new URL(String(url)); closed.port = String(closedPort); return nativeFetch(closed, options);
    });
    try { for (const route of routes) expect((await get(route)).status).toBe(503); } finally { spy.mockRestore(); }
    await server.bridge.close(); await server.bridge.start();
    if (ingress === "required") { await server.bridge.waitForPublicIngressReady!(); server.target = server.bridge.publicIngressBaseUrl!; }
    for (const route of routes) expect((await get(route)).status).toBe(200);
    expect(await snapshot(fixture.db, tables)).toEqual(before);
  });
});
