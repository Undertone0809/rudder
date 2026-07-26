import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  createSignature,
  formatIssueNotification,
  sendFeishuNotification,
} from "../.github/scripts/notify-feishu-issue.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempPaths = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((tempPath) =>
      fs.rm(tempPath, { force: true, recursive: true }),
    ),
  );
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function runNotificationScript(env) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(repoRoot, ".github/scripts/notify-feishu-issue.mjs")],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

describe("GitHub issue to Feishu notification", () => {
  it("formats useful issue details and bounds long bodies", () => {
    const text = formatIssueNotification(
      {
        issue: {
          number: 42,
          title: "  Broken   installer  ",
          body: `First line\n\n\n${"x".repeat(1_000)}`,
          html_url: "https://github.com/acme/rudder/issues/42",
          user: { login: "octocat" },
          labels: [{ name: "bug" }, { name: "desktop" }],
        },
      },
      "acme/rudder",
    );

    expect(text).toContain("#42 Broken installer");
    expect(text).toContain("Opened by: @octocat");
    expect(text).toContain("Labels: bug, desktop");
    expect(text).toContain("https://github.com/acme/rudder/issues/42");
    expect(text.length).toBeLessThan(1_100);
  });

  it("uses the Feishu timestamp-plus-secret signing contract", () => {
    const timestamp = "1785080000";
    const secret = "test-secret";
    const expected = crypto
      .createHmac("sha256", `${timestamp}\n${secret}`)
      .update("")
      .digest("base64");

    expect(createSignature(secret, timestamp)).toBe(expected);
  });

  it("neutralizes Feishu mention markup from untrusted issue text", () => {
    const text = formatIssueNotification(
      {
        issue: {
          number: 43,
          title: '<at user_id="all">Everyone</at>',
          body: '<at user_id="ou_known">Target</at>',
          html_url: "https://github.com/acme/rudder/issues/43",
          user: { login: "reporter" },
          labels: [{ name: '<at user_id="all">urgent</at>' }],
        },
      },
      "acme/rudder",
    );

    expect(text).not.toContain("<at");
    expect(text).toContain('＜at user_id="all"＞Everyone＜/at＞');
    expect(text).toContain('＜at user_id="ou_known"＞Target＜/at＞');
  });

  it("runs the workflow script end to end and sends a signed payload", async () => {
    let receivedBody;
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        receivedBody = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: 0, msg: "success" }));
      });
    });
    const address = await listen(server);

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "rudder-feishu-issue-"),
    );
    tempPaths.push(tempDir);
    const eventPath = path.join(tempDir, "event.json");
    await fs.writeFile(
      eventPath,
      JSON.stringify({
        issue: {
          number: 7,
          title: "Notification regression",
          body: "The webhook should receive this issue.",
          html_url: "https://github.com/acme/rudder/issues/7",
          user: { login: "reporter" },
          labels: [{ name: "bug" }],
        },
      }),
    );

    try {
      const result = await runNotificationScript({
        FEISHU_WEBHOOK_URL: `http://127.0.0.1:${address.port}/hook`,
        FEISHU_BOT_SECRET: "integration-secret",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "acme/rudder",
      });

      expect(result).toEqual({
        code: 0,
        stderr: "",
        stdout: "Feishu issue notification sent successfully\n",
      });
      expect(receivedBody.msg_type).toBe("text");
      expect(receivedBody.content.text).toContain("#7 Notification regression");
      expect(receivedBody.sign).toBe(
        createSignature("integration-secret", receivedBody.timestamp),
      );
    } finally {
      await close(server);
    }
  });

  it("fails closed when Feishu rejects a notification", async () => {
    await expect(
      sendFeishuNotification({
        webhookUrl: "https://example.invalid/hook",
        secret: "secret",
        text: "test",
        timestamp: "1785080000",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ code: 19021, msg: "sign match fail" }),
        }),
      }),
    ).rejects.toThrow("sign match fail");
  });
});
