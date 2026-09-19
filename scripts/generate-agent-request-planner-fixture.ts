import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGoalChangeProposalSchema } from "../packages/shared/src/validators/goal.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(
  repoRoot,
  "native/crates/agent-request-planner/tests/fixtures/node-goal-change-proposal.json",
);

if (process.env.TZ !== "Asia/Shanghai") {
  throw new Error("Run this generator with TZ=Asia/Shanghai to preserve the local-time fixture oracle");
}

const cases = [
  {
    id: "date-only-and-local-wall-clock",
    arguments: {
      goal: "goal-1",
      contractRevision: 7,
      afterContract: {
        actionDeadline: "2026-08-20",
        evaluationDeadline: "2026-08-20T12:00:00",
      },
      rationale: "The evidence requires a contract update.",
      idempotencyKey: "change-local-time",
    },
  },
  {
    id: "offset-and-fractional-seconds",
    arguments: {
      goal: "goal-1",
      contractRevision: 8,
      afterContract: {
        actionDeadline: "2026-08-20T12:00:00.123+08:00",
        evaluationDeadline: "2026-08-21T04:00:00.987Z",
      },
      evidenceRefs: ["artifact://goal/schedule"],
      rationale: "The evidence requires a contract update.",
      idempotencyKey: "change-offset-time",
    },
  },
];

const fixture = {
  schema: "rudder.agent-request-planner.differential/v1",
  source: "packages/shared/src/validators/goal.ts#createGoalChangeProposalSchema",
  timezone: process.env.TZ,
  cases: cases.map((testCase) => {
    const input = testCase.arguments;
    const parsed = createGoalChangeProposalSchema.parse({
      expectedContractRevision: input.contractRevision,
      afterContract: input.afterContract,
      rationale: input.rationale,
      evidenceRefs: input.evidenceRefs,
      idempotencyKey: input.idempotencyKey,
    });
    return {
      ...testCase,
      nodePayload: JSON.parse(JSON.stringify(parsed)),
    };
  }),
};

await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
console.log(`wrote ${path.relative(repoRoot, outputPath)}`);
