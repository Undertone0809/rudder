import { compareRunDiagnoses } from "../diagnosis.js";
import { diagnoseRunForCli } from "./common.js";

const leftRunId = process.argv[2];
const rightRunId = process.argv[3];

if (!leftRunId || !rightRunId) {
  console.error("Usage: tsx compare.ts <runIdA> <runIdB>");
  process.exit(1);
}

async function main() {
  const [left, right] = await Promise.all([
    diagnoseRunForCli(leftRunId, "full"),
    diagnoseRunForCli(rightRunId, "full"),
  ]);
  const comparison = compareRunDiagnoses(left.diagnosis, right.diagnosis);

  console.log("## Comparison");
  console.log(comparison.summary);
  console.log("");
  console.log("## Deltas");
  for (const delta of comparison.deltas) {
    console.log(`- ${delta.metric}: ${delta.left} -> ${delta.right} | ${delta.detail}`);
  }
}

void main();
