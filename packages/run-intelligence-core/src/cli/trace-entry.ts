import { buildObservedRunTrace } from "../trace.js";
import { loadObservedRunDetailForCli } from "./common.js";

const runId = process.argv[2];
const target = process.argv[3];

if (!runId || !target) {
  console.error("Usage: tsx trace-entry.ts <runId> <stepIndex|turn:N>");
  process.exit(1);
}

function printStep(step: ReturnType<typeof buildObservedRunTrace>["steps"][number]) {
  console.log(`## Step ${step.index}`);
  console.log(`Kind: ${step.kind}`);
  console.log(`Time: ${step.ts}`);
  console.log(`Turn: ${step.turnIndex ?? "none"}`);
  console.log(`Preview: ${step.preview || "(empty)"}`);
  console.log("");
  console.log(step.detailText || "(no detail)");
}

async function main() {
  try {
    const detail = await loadObservedRunDetailForCli(runId);
    const trace = buildObservedRunTrace(detail);

    if (target.startsWith("turn:")) {
      const turnIndex = Number(target.slice("turn:".length));
      const turn = trace.turns.find((candidate) => candidate.turnIndex === turnIndex);
      if (!turn) {
        throw new Error(`Turn "${target}" not found.`);
      }

      console.log(`## Turn ${turn.turnIndex}`);
      console.log(`Summary: ${turn.summary}`);
      console.log(`Steps: ${turn.stepCount} | Tool calls: ${turn.toolCallCount}${turn.hasError ? " | error" : ""}`);
      for (const step of turn.steps) {
        console.log("");
        printStep(step);
      }
      return;
    }

    const stepIndex = Number(target);
    if (!Number.isFinite(stepIndex)) {
      throw new Error(`Invalid target "${target}". Use a numeric step index or turn:N.`);
    }
    const step = trace.steps.find((candidate) => candidate.index === stepIndex);
    if (!step) {
      throw new Error(`Step "${stepIndex}" not found.`);
    }
    printStep(step);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
