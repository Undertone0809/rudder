import { buildObservedRunTrace } from "../trace.js";
import { loadObservedRunDetailForCli } from "./common.js";

const runId = process.argv[2];

if (!runId) {
  console.error("Usage: tsx trace-outline.ts <runId>");
  process.exit(1);
}

async function main() {
  try {
    const detail = await loadObservedRunDetailForCli(runId);
    const trace = buildObservedRunTrace(detail);

    console.log("## Trace Overview");
    console.log(`Run ${detail.run.id.slice(0, 8)} | ${detail.agentName ?? detail.run.agentId} | ${detail.run.status}`);
    console.log(`Turns: ${trace.turnCount} | Steps: ${trace.steps.length} | Payload steps: ${trace.payloadStepCount}`);

    if (trace.looseSteps.length > 0) {
      console.log("");
      console.log("## Context");
      for (const step of trace.looseSteps) {
        console.log(`- [${step.index}] ${step.kind} | ${step.detailPreview || "(empty)"}`);
      }
    }

    console.log("");
    console.log("## Turns");
    if (trace.turns.length === 0) {
      console.log("- No model turns were parsed for this run.");
      return;
    }

    for (const turn of trace.turns) {
      console.log(`### Turn ${turn.turnIndex} | ${turn.stepCount} steps | ${turn.toolCallCount} tools${turn.hasError ? " | error" : ""}`);
      console.log(`Preview: ${turn.summary}`);
      for (const step of turn.steps) {
        console.log(`- [${step.index}] ${step.kind} | ${step.detailPreview || "(empty)"}`);
      }
      console.log("");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
