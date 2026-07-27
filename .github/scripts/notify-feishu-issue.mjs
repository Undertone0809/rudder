import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_BODY_LENGTH = 800;
const MAX_LABEL_LENGTH = 40;
const MAX_LABELS = 8;
const MAX_PAYLOAD_BYTES = 20 * 1024;
const MAX_TITLE_LENGTH = 256;

export function createSignature(secret, timestamp) {
  return crypto
    .createHmac("sha256", `${timestamp}\n${secret}`)
    .update("")
    .digest("base64");
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function truncateText(value, maxLength) {
  const characters = Array.from(value);
  return characters.length > maxLength
    ? `${characters.slice(0, maxLength - 1).join("")}…`
    : value;
}

function neutralizeCardMarkdown(value) {
  return value.replace(
    /[!-/:-@[-`{-~]/gu,
    (character) => `&#${character.codePointAt(0)};`,
  );
}

function validateIssueUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GitHub issue URL is invalid");
  }

  const isIssuePath = /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(url.pathname);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !isIssuePath
  ) {
    throw new Error("GitHub issue URL must be an HTTPS github.com issue URL");
  }

  return url.href;
}

function buildCard({ bodyElements, repository, title }) {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
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
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements: bodyElements,
    },
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
      subtitle: {
        tag: "plain_text",
        content: normalizeText(repository),
      },
      template: "blue",
      padding: "12px 12px 12px 12px",
    },
  };
}

export function buildIssueCard(event, repository) {
  const issue = event.issue;
  if (!issue) {
    return buildCard({
      repository,
      title: "✅ GitHub Actions 手动测试",
      bodyElements: [
        {
          tag: "markdown",
          content: "Rudder dev 通知通道正常。",
          text_align: "left",
          text_size: "normal_v2",
        },
      ],
    });
  }

  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
  const safeLabels = labels
    .slice(0, MAX_LABELS)
    .map((label) =>
      neutralizeCardMarkdown(
        truncateText(normalizeText(label), MAX_LABEL_LENGTH),
      ),
    );
  if (labels.length > MAX_LABELS) {
    safeLabels.push(`另有 ${labels.length - MAX_LABELS} 个`);
  }
  const excerpt = neutralizeCardMarkdown(
    truncateText(
      normalizeText(issue.body || "未提供描述。"),
      MAX_BODY_LENGTH,
    ),
  );
  const safeTitle = neutralizeCardMarkdown(
    truncateText(normalizeText(issue.title), MAX_TITLE_LENGTH),
  );
  const issueUrl = validateIssueUrl(issue.html_url);

  return buildCard({
    repository,
    title: "🐞 新 GitHub Issue",
    bodyElements: [
      {
        tag: "markdown",
        content: `#${issue.number} ${safeTitle}`,
        text_align: "left",
        text_size: "normal_v2",
      },
      {
        tag: "markdown",
        content: [
          `提交人：@${issue.user?.login ?? "unknown"}`,
          `标签：${safeLabels.length > 0 ? safeLabels.join(" · ") : "无"}`,
        ].join("\n"),
        text_align: "left",
        text_size: "normal_v2",
      },
      {
        tag: "markdown",
        content: excerpt,
        text_align: "left",
        text_size: "normal_v2",
      },
      {
        tag: "button",
        text: {
          tag: "plain_text",
          content: "在 GitHub 查看 Issue",
        },
        type: "primary",
        width: "default",
        size: "medium",
        behaviors: [
          {
            type: "open_url",
            default_url: issueUrl,
            pc_url: "",
            ios_url: "",
            android_url: "",
          },
        ],
      },
    ],
  });
}

export async function sendFeishuNotification({
  webhookUrl,
  secret,
  card,
  timestamp = Math.floor(Date.now() / 1000).toString(),
  fetchImpl = fetch,
}) {
  if (!webhookUrl || !secret) {
    throw new Error("Feishu notification secrets are not configured");
  }

  const payload = {
    timestamp,
    sign: createSignature(secret, timestamp),
    msg_type: "interactive",
    card,
  };
  const payloadSize = new TextEncoder().encode(JSON.stringify(payload)).length;
  if (payloadSize > MAX_PAYLOAD_BYTES) {
    throw new Error("Feishu notification payload exceeds 20 KB");
  }

  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Feishu returned a non-JSON response (${response.status})`);
  }

  const code = Object.hasOwn(result, "code")
    ? result.code
    : result.StatusCode;
  if (!response.ok || code !== 0) {
    const message = result.msg ?? result.StatusMessage ?? "unknown error";
    throw new Error(`Feishu notification failed (${response.status}): ${message}`);
  }

  return result;
}

async function main() {
  const event = JSON.parse(
    await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const card = buildIssueCard(event, process.env.GITHUB_REPOSITORY);

  await sendFeishuNotification({
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    secret: process.env.FEISHU_BOT_SECRET,
    card,
  });

  console.log("Feishu issue notification sent successfully");
}

const isDirectExecution =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
