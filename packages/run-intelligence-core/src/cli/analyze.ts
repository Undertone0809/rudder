import type { RunDiagnosis, RunDiagnosisMode } from "../types.js";
import { diagnoseRunForCli } from "./common.js";

const runId = process.argv[2];
const mode = (process.argv[3] ?? "auto") as RunDiagnosisMode;

if (!runId) {
  console.error("Usage: tsx analyze.ts <runId> [auto|quick|error|perf|full]");
  process.exit(1);
}

function printDiagnosis(runIdValue: string, agentName: string | null, diagnosis: RunDiagnosis) {
  console.log("## Summary");
  console.log(`Run ${runIdValue} | ${agentName ?? "unknown-agent"} | ${diagnosis.status}`);
  console.log(`Mode: ${diagnosis.mode} | Taxonomy: ${diagnosis.failureTaxonomy}`);
  console.log(`Duration: ${diagnosis.metrics.durationMs}ms | Cost: $${diagnosis.metrics.costUsd.toFixed(2)} | Tokens: ${diagnosis.metrics.inputTokens}/${diagnosis.metrics.outputTokens}`);
  console.log("");
  console.log("## Key Findings");
  for (const finding of diagnosis.findings.slice(0, 8)) {
    console.log(`- [${finding.severity}] ${finding.title}: ${finding.detail}`);
  }
  console.log("");
  console.log("## Next Steps");
  for (const step of diagnosis.nextSteps) {
    console.log(`- ${step}`);
  }
}

async function main() {
  try {
    const { detail, diagnosis } = await diagnoseRunForCli(runId, mode);
    printDiagnosis(detail.run.id.slice(0, 8), detail.agentName, diagnosis);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
