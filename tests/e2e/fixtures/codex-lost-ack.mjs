#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("codex-cli 0.155.0\n");
  process.exit(0);
}

if (args.includes("generate-json-schema")) {
  const outputDir = args[args.indexOf("--out") + 1];
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "ClientRequest.json"), JSON.stringify({
    oneOf: ["thread/start", "thread/resume", "thread/read", "turn/start", "turn/interrupt"].map((method) => ({
      properties: { method: { const: method } },
    })),
  }));
  process.exit(0);
}

const statePath = process.env.RUDDER_E2E_CODEX_LOST_ACK_STATE;
if (!statePath || !path.isAbsolute(statePath)) {
  throw new Error("Lost-ack fixture requires an absolute state path");
}

const threadId = "thread-codex-lost-ack-e2e";
const thread = {
  id: threadId,
  sessionId: threadId,
  rootSessionId: threadId,
  model: "gpt-test",
  modelProvider: "openai",
  ephemeral: false,
  cwd: process.cwd(),
  updatedAt: Date.now(),
  turns: [],
};
const partialOutput = "PARTIAL_OUTPUT_BEFORE_LOST_ACK";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const readState = () => {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {
      providerSubmissionCount: 0,
      partialOutputSent: false,
      turnStartResponseSent: false,
      turnCompletedSent: false,
    };
  }
};
const writeState = (state) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state));
};

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") return;

  const params = request.params ?? {};
  if (request.method === "initialize") {
    send({ id: request.id, result: { userAgent: "rudder-codex-lost-ack-e2e" } });
  } else if (request.method === "thread/start") {
    send({ id: request.id, result: { thread } });
  } else if (request.method === "thread/resume" || request.method === "thread/read") {
    send({ id: request.id, result: { thread: { ...thread, id: params.threadId || threadId } } });
  } else if (request.method === "turn/start") {
    const state = readState();
    state.providerSubmissionCount += 1;
    state.requestReceived = true;
    writeState(state);

    const turnId = "turn-codex-lost-ack-e2e";
    const notifications = [
      {
        method: "turn/started",
        params: { threadId, turn: { id: turnId, status: "inProgress" } },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId, turnId, itemId: "assistant-partial-e2e", delta: partialOutput },
      },
    ].map((message) => `${JSON.stringify(message)}\n`).join("");

    process.stdout.write(notifications, () => {
      writeState({ ...state, partialOutputSent: true });
      setTimeout(() => process.exit(0), 400);
    });
  } else if (request.id !== undefined) {
    send({ id: request.id, error: { code: -32601, message: `Unsupported fixture method: ${request.method}` } });
  }
});
