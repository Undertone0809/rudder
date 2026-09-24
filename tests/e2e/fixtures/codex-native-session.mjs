#!/usr/bin/env node
// Stateful protocol fixture: each process observes the same native history.
// This tests Rudder wiring, not the installed Codex provider's capabilities.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.155.0");
  process.exit(0);
}
if (args.includes("generate-json-schema")) {
  const directory = args[args.indexOf("--out") + 1];
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "ClientRequest.json"), JSON.stringify({
    oneOf: [
      "thread/start", "thread/resume", "thread/read", "thread/fork",
      "turn/start", "turn/steer", "turn/interrupt",
    ].map((method) => ({
      properties: { method: { const: method } },
    })),
  }));
  process.exit(0);
}
if (!process.env.CODEX_HOME || !path.isAbsolute(process.env.CODEX_HOME)) {
  throw new Error("Native fixture requires an isolated managed CODEX_HOME");
}
const root = path.join(process.env.CODEX_HOME, "e2e-native-history");
fs.mkdirSync(root, { recursive: true });
const file = (id) => {
  if (!/^[a-f0-9-]+$/.test(id)) throw new Error("Invalid fixture thread ID");
  return path.join(root, `${id}.json`);
};
const load = (id) => JSON.parse(fs.readFileSync(file(id), "utf8"));
const save = (thread) => fs.writeFileSync(file(thread.id), JSON.stringify(thread));
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const create = () => ({
  id: randomUUID(), sessionId: randomUUID(), turns: [], model: "gpt-test",
  modelProvider: "openai", ephemeral: false, cwd: process.cwd(), updatedAt: Date.now(),
});
let activeTurn = null;
let pendingCompletion = null;

function completeTurn(thread, turn, text, status = "completed") {
  if (pendingCompletion) clearTimeout(pendingCompletion);
  pendingCompletion = null;
  if (status === "completed") {
    const item = { type: "agentMessage", id: randomUUID(), text };
    turn.items.push(item);
    send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
  }
  turn.status = status;
  thread.updatedAt = Date.now();
  save(thread);
  send({ method: "turn/completed", params: { threadId: thread.id, turn } });
  activeTurn = null;
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") return;
  const params = request.params ?? {};
  try {
    if (request.method === "initialize") {
      send({ id: request.id, result: { userAgent: "rudder-native-e2e" } });
    } else if (request.method === "thread/start") {
      const thread = create();
      save(thread);
      send({ id: request.id, result: { thread } });
    } else if (request.method === "thread/resume" || request.method === "thread/read") {
      send({ id: request.id, result: { thread: load(params.threadId) } });
    } else if (request.method === "thread/fork") {
      const parent = load(params.threadId);
      const index = parent.turns.findIndex((turn) => turn.id === params.lastTurnId);
      if (index < 0) throw new Error("Unknown fork boundary");
      const thread = { ...create(), forkedFromId: parent.id, turns: parent.turns.slice(0, index + 1) };
      save(thread);
      send({ id: request.id, result: { thread } });
    } else if (request.method === "turn/start") {
      const thread = load(params.threadId);
      const turn = { id: randomUUID(), status: "inProgress", itemsView: { type: "full" }, items: [] };
      const text = `Native reply ${thread.turns.length + 1}`;
      turn.items.push({ type: "userMessage", id: randomUUID(), content: params.input });
      thread.turns.push(turn);
      thread.updatedAt = Date.now();
      save(thread);
      send({ id: request.id, result: { turn: { id: turn.id } } });
      send({ method: "turn/started", params: { threadId: thread.id, turn: { id: turn.id } } });
      for (const item of turn.items) send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item } });
      const prompt = (params.input ?? [])
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item.text)
        .join("\n");
      if (prompt.includes("Keep Steer message position stable")) {
        activeTurn = { thread, turn };
        setTimeout(() => send({
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            item: { type: "reasoning", id: randomUUID(), summary: ["Reasoning before Steer"], content: [] },
          },
        }), 600);
        pendingCompletion = setTimeout(() => completeTurn(thread, turn, "Initial native reply"), 60_000);
      } else {
        completeTurn(thread, turn, text);
      }
    } else if (request.method === "turn/steer") {
      if (!activeTurn || params.expectedTurnId !== activeTurn.turn.id) {
        throw new Error("expectedTurnId does not match the active turn");
      }
      const feedback = params.input?.find((item) => item?.type === "text")?.text ?? "feedback";
      const receivedLocalImage = params.input?.some((item) => item?.type === "localImage") ?? false;
      send({ id: request.id, result: { turnId: activeTurn.turn.id } });
      const { thread, turn } = activeTurn;
      const steeredItem = { type: "userMessage", id: randomUUID(), content: params.input };
      turn.items.push(steeredItem);
      save(thread);
      send({ method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: steeredItem } });
      setTimeout(() => send({
        method: "item/completed",
        params: {
          threadId: thread.id,
          turnId: turn.id,
          item: { type: "reasoning", id: randomUUID(), summary: ["Reasoning after Steer"], content: [] },
        },
      }), 250);
      setTimeout(() => completeTurn(thread, turn, [
        "Native steer applied: " + feedback,
        "Native steer image received: " + receivedLocalImage,
      ].join("\n\n")), 1_000);
    } else if (request.method === "turn/interrupt") {
      if (!activeTurn || params.expectedTurnId !== activeTurn.turn.id) {
        throw new Error("expectedTurnId does not match the active turn");
      }
      send({ id: request.id, result: {} });
      completeTurn(activeTurn.thread, activeTurn.turn, "", "interrupted");
    } else {
      send({ id: request.id, error: { code: -32601, message: `Unsupported fixture method: ${request.method}` } });
    }
  } catch (error) {
    send({ id: request.id, error: { code: -32000, message: error.message } });
  }
});
