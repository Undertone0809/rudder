#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("2.1.216 (Claude Code)\n");
  process.exit(0);
}

const configDir = process.env.CLAUDE_CONFIG_DIR;
if (!configDir || !path.isAbsolute(configDir)) {
  throw new Error("Claude native session fixture requires an isolated CLAUDE_CONFIG_DIR");
}

const cwd = process.cwd();
const sessionCwd = process.platform === "darwin" && cwd.startsWith("/private/tmp/")
  ? cwd.replace(/^\/private\/tmp(?=\/)/, "/tmp")
  : cwd;
const projectsDir = path.join(configDir, "projects", path.resolve(sessionCwd).replace(/[^a-zA-Z0-9]/g, "-"));
const sessionPath = (sessionId) => path.join(projectsDir, `${sessionId}.jsonl`);
const invocationPath = path.join(configDir, "rudder-e2e-invocations.jsonl");
const resumeIndex = args.indexOf("--resume");
const resumedSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
const isFork = args.includes("--fork-session");

function readSession(sessionId) {
  const target = sessionPath(sessionId);
  if (!fs.existsSync(target)) return [];
  return fs.readFileSync(target, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function contentText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => typeof block?.text === "string" ? block.text : "").join("\n");
}

function currentMessageBody(inputText) {
  const inputStart = inputText.lastIndexOf("Conversation input:");
  if (inputStart < 0) return null;
  const bodyStart = inputStart + "Conversation input:".length;
  const inputEnd = inputText.indexOf("\n\nFinal Rudder result reminder:", bodyStart);
  if (inputEnd < 0) return null;
  try {
    return JSON.parse(inputText.slice(bodyStart, inputEnd).trim()).currentMessage?.body ?? null;
  } catch {
    return null;
  }
}

function writeEvent(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

let handled = false;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (handled) return;
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  handled = true;

  const inputText = contentText(input.message);
  const userUuid = typeof input.uuid === "string" && input.uuid ? input.uuid : randomUUID();
  const sourceRecords = resumedSessionId ? readSession(resumedSessionId) : [];
  const sessionId = isFork || !resumedSessionId ? randomUUID() : resumedSessionId;
  const records = isFork
    ? sourceRecords.map((record) => ({ ...record, sessionId }))
    : sourceRecords;
  const previousAssistant = [...records].reverse().find((record) => record.type === "assistant" && record.uuid);
  const assistantUuid = randomUUID();
  // An SDK-created child is resumed without --fork-session. Its first new
  // assistant follows only inherited assistant records marked forkedFrom.
  const firstSdkChildTurn = sourceRecords.some((record) => record.forkedFrom)
    && !sourceRecords.some((record) => record.type === "assistant" && !record.forkedFrom);
  const reply = isFork || firstSdkChildTurn
    ? "Claude native fork reply"
    : `Claude native reply ${records.filter((record) => record.type === "assistant").length + 1}`;
  const now = new Date().toISOString();

  fs.mkdirSync(projectsDir, { recursive: true });
  const userRecord = {
    type: "user",
    uuid: userUuid,
    parentUuid: previousAssistant?.uuid ?? null,
    // Native JSONL uses sessionId; stream-json below uses session_id.
    sessionId,
    cwd: sessionCwd,
    timestamp: now,
    message: { role: "user", content: [{ type: "text", text: inputText }] },
  };
  const assistantRecord = {
    type: "assistant",
    uuid: assistantUuid,
    parentUuid: userUuid,
    sessionId,
    cwd: sessionCwd,
    timestamp: now,
    message: { role: "assistant", content: [{ type: "text", text: reply }], stop_reason: "end_turn" },
  };
  fs.appendFileSync(invocationPath, `${JSON.stringify({
    args,
    cwd,
    inputText,
    resumedSessionId,
    sessionId,
    fork: isFork,
  })}\n`);

  if (String(currentMessageBody(inputText) ?? "").startsWith("RUDDER_E2E_PROCESS_LOSS:")) {
    process.stderr.write("Claude fixture exited before returning a terminal result.\n");
    process.exit(86);
  }

  const sessionRecords = [...records, userRecord, assistantRecord];
  fs.writeFileSync(sessionPath(sessionId), `${sessionRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);

  writeEvent({ type: "system", subtype: "init", session_id: sessionId, model: "claude-e2e" });
  writeEvent({
    type: "user",
    uuid: userUuid,
    session_id: sessionId,
    message: input.message,
    isReplay: true,
  });
  writeEvent({
    type: "assistant",
    uuid: assistantUuid,
    parentUuid: userUuid,
    session_id: sessionId,
    message: assistantRecord.message,
  });
  writeEvent({
    type: "result",
    session_id: sessionId,
    subtype: "success",
    is_error: false,
    result: reply,
    usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    total_cost_usd: 0,
  });
  process.stdout.end();
});
