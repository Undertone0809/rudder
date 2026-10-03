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
      "thread/turns/list", "thread/items/list",
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
let publicationPoll = null;

function completeTurn(thread, turn, text, status = "completed") {
  if (pendingCompletion) clearTimeout(pendingCompletion);
  pendingCompletion = null;
  if (publicationPoll) clearInterval(publicationPoll);
  publicationPoll = null;
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
    } else if (request.method === "thread/resume") {
      send({ id: request.id, result: { thread: load(params.threadId) } });
    } else if (request.method === "thread/read") {
      const thread = load(params.threadId);
      send({ id: request.id, result: { thread: params.includeTurns === false ? { ...thread, turns: [] } : thread } });
    } else if (request.method === "thread/turns/list") {
      const thread = load(params.threadId);
      const offset = Number(params.cursor ?? 0);
      const turn = thread.turns[offset];
      send({
        id: request.id,
        result: {
          data: turn ? [{ ...turn, items: [], itemsView: { type: "notLoaded" } }] : [],
          nextCursor: offset + 1 < thread.turns.length ? String(offset + 1) : null,
        },
      });
    } else if (request.method === "thread/items/list") {
      const thread = load(params.threadId);
      const turn = thread.turns.find((candidate) => candidate.id === params.turnId);
      const offset = Number(params.cursor ?? 0);
      const item = turn?.items[offset];
      send({
        id: request.id,
        result: {
          data: item ? [{ turnId: turn.id, item }] : [],
          nextCursor: turn && offset + 1 < turn.items.length ? String(offset + 1) : null,
        },
      });
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
      const defaultText = `Native reply ${thread.turns.length + 1}`;
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
      // Opt-in reply shape for continuation UI cases. Keep their existing
      // message oracle without replacing this fixture's persisted history.
      const replyBody = process.env.RUDDER_E2E_CODEX_REPLY_BODY;
      const sentinel = prompt.match(/(__RUDDER_RESULT_[a-f0-9-]+__)/i)?.[1];
      const text = replyBody && sentinel
        ? `${replyBody}\n${sentinel}${JSON.stringify({
          kind: "message", body: replyBody, structuredPayload: null,
        })}`
        : defaultText;
      const skillTelemetry = [...prompt.matchAll(/\bNative skill telemetry:\s*([a-z0-9][a-z0-9-]*)\b/gi)].at(-1)?.[1];
      if (skillTelemetry) {
        turn.items.push({
          type: "commandExecution",
          id: randomUUID(),
          command: `cat .agents/skills/${skillTelemetry}/SKILL.md`,
          cwd: process.cwd(),
          status: "completed",
          exitCode: 0,
          aggregatedOutput: `Read ${skillTelemetry} skill instructions`,
        });
      }
      const storagePayloadNonce = [...prompt.matchAll(/\bNative storage payload nonce:\s*([a-f0-9]{32})\b/gi)].at(-1)?.[1];
      if (storagePayloadNonce) {
        const marker = `NATIVE_TOOL_OUTPUT_${storagePayloadNonce}`;
        const outputBytes = 256 * 1024;
        turn.items.push({
          type: "commandExecution",
          id: randomUUID(),
          command: "rudder-native-storage-fixture",
          cwd: process.cwd(),
          status: "completed",
          exitCode: 0,
          aggregatedOutput: `${marker}${"x".repeat(outputBytes - marker.length)}`,
        });
      }
      const publicationNonce = [...prompt.matchAll(/\bNative transcript publication nonce:\s*([a-f0-9]{32})\b/gi)].at(-1)?.[1];
      const publicationDirectory = process.env.RUDDER_E2E_NATIVE_TRANSCRIPT_GATE;
      if (publicationNonce && publicationDirectory) {
        if (!path.isAbsolute(publicationDirectory)) throw new Error("Native publication gate requires an absolute test directory");
        activeTurn = { thread, turn };
        const gate = path.join(publicationDirectory, publicationNonce);
        // Native history already contains this input; the Run has not yet
        // acquired a terminal selector. Reader must report pending, not missing.
        fs.writeFileSync(`${gate}.ready.json`, JSON.stringify({ threadId: thread.id,
          turnId: turn.id, userItemId: turn.items[0].id, historyPath: file(thread.id) }));
        publicationPoll = setInterval(() => {
          if (!fs.existsSync(`${gate}.release`)) return;
          completeTurn(thread, turn, `NATIVE_LIVE_REPLY_${publicationNonce}`);
        }, 100);
        // Missing release must fail the test, never silently complete it.
        pendingCompletion = setTimeout(() => completeTurn(thread, turn, "", "interrupted"), 90_000);
      } else if (prompt.includes("Keep Steer message position stable")) {
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
