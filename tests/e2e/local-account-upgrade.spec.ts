import { expect, test } from "@playwright/test";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "../../packages/db/node_modules/drizzle-orm/index.js";
import {
  chatConversationUserStates,
  chatConversations,
  chatMessages,
  createDb,
  installationAccountBindings,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerSavedViews,
  organizationMemberships,
  organizations,
} from "../../packages/db/src/index.ts";
import { startServer } from "../../server/src/index.ts";

async function availablePort() {
  return new Promise<number>((resolve, reject) => {
    const listener = net.createServer();
    listener.unref();
    listener.on("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local E2E port"));
        return;
      }
      listener.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

test("repairs an already-claimed Canary workspace before Messenger renders", async ({ page }) => {
  test.setTimeout(120_000);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-account-upgrade-e2e-"));
  const instanceId = "account-upgrade";
  const instanceRoot = path.join(homeDir, "instances", instanceId);
  const configPath = path.join(instanceRoot, "config.json");
  const [appPort, dbPort, identityPort] = await Promise.all([
    availablePort(),
    availablePort(),
    availablePort(),
  ]);
  fs.mkdirSync(instanceRoot, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    $meta: {
      version: 1,
      updatedAt: "2026-07-30T00:00:00.000Z",
      source: "test",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: path.join(instanceRoot, "db"),
      embeddedPostgresPort: dbPort,
      backup: {
        enabled: false,
        intervalMinutes: 60,
        retentionDays: 1,
        dir: path.join(instanceRoot, "data/backups"),
      },
    },
    logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
    server: { deploymentMode: "local_trusted", host: "127.0.0.1", port: appPort },
    auth: { baseUrlMode: "auto" },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: path.join(instanceRoot, "data/storage") },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets/master.key") },
    },
  }, null, 2));

  const issuer = `http://127.0.0.1:${identityPort}`;
  const identityServer = createServer((_req, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      issuer,
      subject: "account-upgrade-user",
      audience: `rudder-installation:${instanceId}`,
      installationId: instanceId,
      jti: "upgrade-exchange-jti",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      email: "upgrade@example.com",
      name: "Upgrade Operator",
    }));
  });
  await new Promise<void>((resolve) => identityServer.listen(identityPort, "127.0.0.1", resolve));

  const envKeys = [
    "RUDDER_HOME",
    "RUDDER_CONFIG",
    "RUDDER_INSTANCE_ID",
    "RUDDER_LOCAL_ENV",
    "RUDDER_UI_DEV_MIDDLEWARE",
  ] as const;
  const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.RUDDER_HOME = homeDir;
  process.env.RUDDER_CONFIG = configPath;
  process.env.RUDDER_INSTANCE_ID = instanceId;
  process.env.RUDDER_LOCAL_ENV = "e2e-account-upgrade";
  process.env.RUDDER_UI_DEV_MIDDLEWARE = "true";

  const started = await startServer({
    runtimeOwnerKind: "cli",
    localAccountAuth: {
      identityOrigin: issuer,
      audience: `rudder-installation:${instanceId}`,
      sessionSecret: "account-upgrade-e2e-session-secret",
      secureCookie: false,
    },
    runtimeOverrides: {
      host: "127.0.0.1",
      port: appPort,
      deploymentMode: "local_trusted",
      serveUi: true,
      uiDevMiddleware: true,
      heartbeatSchedulerEnabled: false,
      databaseBackupEnabled: false,
    },
  });
  const db = createDb(started.databaseUrl);

  try {
    const [org] = await db.insert(organizations).values({
      name: "Recovered workspace",
      urlKey: "recovered-workspace",
      issuePrefix: "RCV",
    }).returning();
    const [readConversation, unreadConversation] = await db.insert(chatConversations).values([
      {
        orgId: org!.id,
        title: "Previously read history",
        lastMessageAt: new Date("2026-07-29T12:00:00.000Z"),
      },
      {
        orgId: org!.id,
        title: "One genuinely unread chat",
        lastMessageAt: new Date("2026-07-30T12:00:00.000Z"),
      },
    ]).returning();
    await db.insert(chatMessages).values([
      ...Array.from({ length: 105 }, (_, index) => ({
        orgId: org!.id,
        conversationId: readConversation!.id,
        role: "assistant",
        body: `Historical message ${index + 1}`,
        createdAt: new Date(Date.parse("2026-07-29T10:00:00.000Z") + index * 30_000),
      })),
      {
        orgId: org!.id,
        conversationId: unreadConversation!.id,
        role: "assistant",
        body: "Actually unread",
        createdAt: new Date("2026-07-30T12:00:00.000Z"),
      },
    ]);
    await db.insert(organizationMemberships).values({
      orgId: org!.id,
      principalType: "user",
      principalId: "local-board",
      status: "active",
      membershipRole: "owner",
    });
    await db.insert(chatConversationUserStates).values([
      {
        orgId: org!.id,
        conversationId: readConversation!.id,
        userId: "local-board",
        lastReadAt: new Date("2026-07-29T13:00:00.000Z"),
      },
      {
        orgId: org!.id,
        conversationId: unreadConversation!.id,
        userId: "local-board",
        lastReadAt: new Date("2026-07-30T11:00:00.000Z"),
      },
    ]);
    const [group] = await db.insert(messengerCustomGroups).values({
      orgId: org!.id,
      userId: "local-board",
      name: "Recovered priority",
      sortOrder: 0,
      pinnedAt: new Date("2026-07-29T13:00:00.000Z"),
    }).returning();
    const [savedView] = await db.insert(messengerSavedViews).values({
      orgId: org!.id,
      userId: "local-board",
      targetKind: "browser",
      targetPayload: {
        kind: "browser",
        tabId: "upgrade-tab",
        url: "https://example.com/recovered",
        viewInstanceId: "upgrade-view",
      },
      resourceKey: "browser:https://example.com/recovered",
      instanceId: "upgrade-view",
      canonicalResourceKey: "browser:https://example.com/recovered",
      title: "Recovered saved view",
      sortOrder: 1,
    }).returning();
    await db.insert(messengerCustomGroupEntries).values([
      {
        orgId: org!.id,
        userId: "local-board",
        groupId: group!.id,
        threadKey: `chat:${readConversation!.id}`,
        sortOrder: 0,
      },
      {
        orgId: org!.id,
        userId: "local-board",
        groupId: group!.id,
        threadKey: `saved-view:${savedView!.id}`,
        sortOrder: 1,
      },
    ]);

    const exchange = await page.request.post(`${started.apiUrl}/api/auth/local-exchange`, {
      data: { exchangeCode: "canary-upgrade-exchange" },
    });
    expect(exchange.ok()).toBe(true);
    const exchangeBody = await exchange.json() as { userId: string };
    const cookieHeader = exchange.headers()["set-cookie"];
    expect(cookieHeader).toBeTruthy();
    await db.insert(installationAccountBindings).values({
      installationId: instanceId,
      issuer,
      subject: "account-upgrade-user",
      localUserId: exchangeBody.userId,
    });
    await db.update(organizationMemberships).set({
      status: "revoked",
      updatedAt: new Date(),
    }).where(eq(organizationMemberships.principalId, "local-board"));
    await db.insert(organizationMemberships).values({
      orgId: org!.id,
      principalType: "user",
      principalId: exchangeBody.userId,
      status: "active",
      membershipRole: "owner",
    });

    const claim = await page.request.post(`${started.apiUrl}/api/auth/local-claim`, {
      headers: {
        cookie: cookieHeader!.split(";")[0]!,
        origin: started.apiUrl,
      },
    });
    expect(claim.ok()).toBe(true);
    const [cookiePair] = cookieHeader!.split(";");
    const cookieSeparator = cookiePair!.indexOf("=");
    await page.context().addCookies([{
      name: cookiePair!.slice(0, cookieSeparator),
      value: decodeURIComponent(cookiePair!.slice(cookieSeparator + 1)),
      url: started.apiUrl,
      httpOnly: true,
      sameSite: "Lax",
    }]);

    await page.goto(`${started.apiUrl}/${org!.issuePrefix}/messenger`);
    await expect(page.getByRole("link", { name: "1 Messenger" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Recovered priority", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Recovered saved view/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Previously read history/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("link", { name: "1 Messenger" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Recovered priority", exact: true }),
    ).toBeVisible();
  } finally {
    await db.$client.end({ timeout: 5 }).catch(() => undefined);
    await started.stop();
    await new Promise<void>((resolve) => identityServer.close(() => resolve()));
    for (const key of envKeys) {
      const value = priorEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});
