import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const MAX_BODY_LENGTH = 800;

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
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .trim();
}

export function formatIssueNotification(event, repository) {
  const issue = event.issue;
  if (!issue) {
    return `Rudder dev GitHub Actions 手动测试成功。\nRepository: ${repository}`;
  }

  const labels = (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : label?.name))
    .filter(Boolean);
  const safeLabels = labels.map(normalizeText);
  const body = normalizeText(issue.body || "No description provided.");
  const excerpt =
    body.length > MAX_BODY_LENGTH
      ? `${body.slice(0, MAX_BODY_LENGTH - 1)}…`
      : body;

  return [
    "🐞 New GitHub Issue",
    `Repository: ${repository}`,
    `Issue: #${issue.number} ${normalizeText(issue.title)}`,
    `Opened by: @${issue.user?.login ?? "unknown"}`,
    safeLabels.length > 0 ? `Labels: ${safeLabels.join(", ")}` : null,
    "",
    excerpt,
    "",
    issue.html_url,
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export async function sendFeishuNotification({
  webhookUrl,
  secret,
  text,
  timestamp = Math.floor(Date.now() / 1000).toString(),
  fetchImpl = fetch,
}) {
  if (!webhookUrl || !secret) {
    throw new Error("Feishu notification secrets are not configured");
  }

  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timestamp,
      sign: createSignature(secret, timestamp),
      msg_type: "text",
      content: { text },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(`Feishu returned a non-JSON response (${response.status})`);
  }

  const code = result.code ?? result.StatusCode ?? null;
  if (!response.ok || (code !== null && code !== 0)) {
    const message = result.msg ?? result.StatusMessage ?? "unknown error";
    throw new Error(`Feishu notification failed (${response.status}): ${message}`);
  }

  return result;
}

async function main() {
  const event = JSON.parse(
    await fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8"),
  );
  const text = formatIssueNotification(event, process.env.GITHUB_REPOSITORY);

  await sendFeishuNotification({
    webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    secret: process.env.FEISHU_BOT_SECRET,
    text,
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
