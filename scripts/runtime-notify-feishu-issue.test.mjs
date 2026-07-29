import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildIssueCard,
  createSignature,
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

function decodeNumericEntities(value) {
  return value.replace(/&#(\d+);/gu, (_match, codePoint) =>
    String.fromCodePoint(Number(codePoint)),
  );
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
  it("builds a bounded issue card with a GitHub button", () => {
    const card = buildIssueCard(
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
    const [title, metadata, body, button] = card.body.elements;

    expect(card).toMatchObject({
      schema: "2.0",
      config: {
        style: {
          text_size: {
            normal_v2: {
              default: "normal",
              pc: "normal",
              mobile: "heading",
            },
          },
        },
      },
      header: {
        title: { tag: "plain_text", content: "🐞 新 GitHub Issue" },
        subtitle: { tag: "plain_text", content: "acme/rudder" },
        template: "blue",
      },
    });
    expect(title).toMatchObject({
      tag: "markdown",
      content: "#42 Broken installer",
    });
    expect(metadata.content).toContain("提交人：@octocat");
    expect(metadata.content).toContain("标签：bug · desktop");
    expect(body.content.length).toBeLessThan(900);
    expect(button).toMatchObject({
      tag: "button",
      text: { tag: "plain_text", content: "在 GitHub 查看 Issue" },
      type: "primary",
      behaviors: [
        {
          type: "open_url",
          default_url: "https://github.com/acme/rudder/issues/42",
        },
      ],
    });
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
    const card = buildIssueCard(
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
    const markdown = card.body.elements
      .filter((element) => element.tag === "markdown")
      .map((element) => element.content)
      .join("\n");

    expect(markdown).not.toMatch(/<\s*\/?\s*at\b/iu);
    expect(decodeNumericEntities(markdown)).toContain(
      '<at user_id="all">Everyone</at>',
    );
    expect(decodeNumericEntities(markdown)).toContain(
      '<at user_id="ou_known">Target</at>',
    );
    expect(
      card.body.elements
        .filter((element) => element.tag !== "button")
        .every((element) => element.tag === "markdown"),
    ).toBe(true);
  });

  it("neutralizes Markdown structure while preserving visible source glyphs", () => {
    const card = buildIssueCard(
      {
        issue: {
          number: 45,
          title:
            "Normal *italic* _under_ `code` **bold** [Open securely](https://evil.example)",
          body:
            "# Heading\nSetext\n===\n> quote\n![trusted image](https://evil.example/image.png)",
          html_url: "https://github.com/acme/rudder/issues/45",
          user: { login: "reporter" },
          labels: [{ name: "[security](https://evil.example)" }],
        },
      },
      "acme/rudder",
    );
    const [title, metadata, body] = card.body.elements;

    const encodedTitle = title.content.slice("#45 ".length);
    const encodedLabels = metadata.content.split("标签：")[1];
    const untrustedMarkdown = [encodedTitle, encodedLabels, body.content].join(
      "\n",
    );

    expect([title.tag, metadata.tag, body.tag]).toEqual([
      "markdown",
      "markdown",
      "markdown",
    ]);
    expect(untrustedMarkdown).not.toMatch(/[*_`<>\[\]()=!|~\\]/u);
    expect(untrustedMarkdown).not.toMatch(/(^|\n)[#>+-][ \t]/u);
    expect(decodeNumericEntities(title.content)).toBe(
      "#45 Normal *italic* _under_ `code` **bold** [Open securely](https://evil.example)",
    );
    expect(decodeNumericEntities(metadata.content)).toContain(
      "标签：[security](https://evil.example)",
    );
    expect(decodeNumericEntities(body.content)).toBe(
      "# Heading\nSetext\n===\n> quote\n![trusted image](https://evil.example/image.png)",
    );
  });

  it("builds a manual test card without a navigation button", () => {
    const card = buildIssueCard({}, "acme/rudder");

    expect(card.header.title.content).toBe("✅ GitHub Actions 手动测试");
    expect(card.header.subtitle.content).toBe("acme/rudder");
    expect(card.body.elements).toEqual([
      expect.objectContaining({
        tag: "markdown",
        content: "Rudder dev 通知通道正常。",
      }),
    ]);
    expect(card.body.elements.some((element) => element.tag === "button")).toBe(
      false,
    );
  });

  it("rejects non-GitHub and non-HTTPS issue links", () => {
    const event = {
      issue: {
        number: 44,
        title: "Unsafe link",
        body: "Do not render this button.",
        html_url: "https://example.com/acme/rudder/issues/44",
        user: { login: "reporter" },
      },
    };

    expect(() => buildIssueCard(event, "acme/rudder")).toThrow(
      "GitHub issue URL must be an HTTPS github.com issue URL",
    );
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
      expect(receivedBody.msg_type).toBe("interactive");
      expect(receivedBody.card.schema).toBe("2.0");
      expect(receivedBody.card.body.elements[0].content).toContain(
        "#7 Notification regression",
      );
      expect(receivedBody.card.body.elements[3]).toMatchObject({
        tag: "button",
        behaviors: [
          {
            type: "open_url",
            default_url: "https://github.com/acme/rudder/issues/7",
          },
        ],
      });
      expect(receivedBody.sign).toBe(
        createSignature("integration-secret", receivedBody.timestamp),
      );
    } finally {
      await close(server);
    }
  });

  it("bounds a production-shaped high-volume issue below the webhook limit", async () => {
    let payloadBody;
    const card = buildIssueCard(
      {
        issue: {
          number: 46,
          title: "😀".repeat(256),
          body: "😀".repeat(800),
          html_url: "https://github.com/acme/rudder/issues/46",
          user: { login: "reporter" },
          labels: Array.from({ length: 100 }, (_, index) => ({
            name: `${index}-${"😀".repeat(50)}`,
          })),
        },
      },
      "acme/rudder",
    );

    await sendFeishuNotification({
      webhookUrl: "https://example.invalid/hook",
      secret: "secret",
      card,
      timestamp: "1785080000",
      fetchImpl: async (_url, options) => {
        payloadBody = options.body;
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, msg: "success" }),
        };
      },
    });

    expect(new TextEncoder().encode(payloadBody).length).toBeLessThanOrEqual(
      20 * 1024,
    );
    const labelsLine = JSON.parse(payloadBody).card.body.elements[1].content;
    expect(labelsLine).toContain("另有 92 个");
  });

  it("uses a Chinese fallback for an empty issue body", () => {
    const card = buildIssueCard(
      {
        issue: {
          number: 47,
          title: "No body",
          body: "",
          html_url: "https://github.com/acme/rudder/issues/47",
          user: { login: "reporter" },
        },
      },
      "acme/rudder",
    );

    expect(card.body.elements[2].content).toContain("未提供描述。");
  });

  it("fails closed when Feishu rejects a notification", async () => {
    await expect(
      sendFeishuNotification({
        webhookUrl: "https://example.invalid/hook",
        secret: "secret",
        card: buildIssueCard({}, "acme/rudder"),
        timestamp: "1785080000",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ code: 19021, msg: "sign match fail" }),
        }),
      }),
    ).rejects.toThrow("sign match fail");
  });

  it("fails closed when Feishu omits an explicit success code", async () => {
    await expect(
      sendFeishuNotification({
        webhookUrl: "https://example.invalid/hook",
        secret: "secret",
        card: buildIssueCard({}, "acme/rudder"),
        timestamp: "1785080000",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({}),
        }),
      }),
    ).rejects.toThrow("unknown error");
  });
});
