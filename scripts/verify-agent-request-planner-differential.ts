import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGoalChangeProposalSchema } from "../packages/shared/src/validators/goal.js";
import {
  buildAgentV1ToolCallPlan,
  buildMcpServerEnv,
} from "../cli/src/agent-v1-mcp-server.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustManifest = path.join(repoRoot, "native/Cargo.toml");
const capability = "goal.change.propose";
const toolName = "rudder_goal_change_propose";
const schema = "rudder.agent-request-planner.differential/runtime-v1";
const runtime = {
  organizationId: null,
  agentId: "runtime-agent",
  runId: "runtime-run",
  browserEnabled: false,
};

type ExpectedResult = "equal" | "unsupported-by-rust";
type TimeZone = "Asia/Shanghai" | "America/New_York";

type CaseDefinition = {
  id: string;
  timezone: TimeZone;
  deadline: string;
  expected: ExpectedResult;
  note?: string;
};

const caseDefinitions: readonly CaseDefinition[] = [
  {
    id: "asia-shanghai-date-only",
    timezone: "Asia/Shanghai",
    deadline: "2026-08-20",
    expected: "equal",
  },
  {
    id: "asia-shanghai-local-no-seconds",
    timezone: "Asia/Shanghai",
    deadline: "2026-08-20T12:00",
    expected: "unsupported-by-rust",
    note: "Node z.coerce.date accepts local ISO without seconds; the candidate Rust parser requires seconds.",
  },
  {
    id: "asia-shanghai-local-with-seconds",
    timezone: "Asia/Shanghai",
    deadline: "2026-08-20T12:00:00",
    expected: "equal",
  },
  {
    id: "new-york-local-no-seconds",
    timezone: "America/New_York",
    deadline: "2026-01-15T12:00",
    expected: "unsupported-by-rust",
    note: "Node z.coerce.date accepts local ISO without seconds; the candidate Rust parser requires seconds.",
  },
  {
    id: "new-york-dst-gap",
    timezone: "America/New_York",
    deadline: "2026-03-08T02:30:00",
    expected: "equal",
  },
  {
    id: "new-york-dst-overlap",
    timezone: "America/New_York",
    deadline: "2026-11-01T01:30:00",
    expected: "equal",
  },
];

type DifferentialCase = {
  id: string;
  arguments: Record<string, unknown>;
  nodePayload: Record<string, unknown>;
  cliArgs: string[];
  expected: ExpectedResult;
  note?: string;
};

type DifferentialEnvelope = {
  schema: string;
  capability: string;
  timezone: TimeZone;
  runtime: typeof runtime;
  cases: DifferentialCase[];
};

type RustRun = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function nodeEnvironment() {
  return buildMcpServerEnv({
    RUDDER_API_URL: "http://127.0.0.1:3100",
    RUDDER_API_KEY: "differential-harness-key",
    RUDDER_ORG_ID: undefined,
    RUDDER_AGENT_ID: runtime.agentId,
    RUDDER_RUN_ID: runtime.runId,
    RUDDER_BROWSER_ENABLED: undefined,
  });
}

function buildNodeCases(timezone: TimeZone): DifferentialCase[] {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;

  try {
    return caseDefinitions
      .filter((definition) => definition.timezone === timezone)
      .map((definition) => {
        const input = {
          goal: "11111111-1111-4111-8111-111111111111",
          contractRevision: 7,
          afterContract: { actionDeadline: definition.deadline },
          rationale: "The runtime differential harness exercises date normalization.",
          idempotencyKey: `differential-${definition.id}`,
        };

        const cliPlan = buildAgentV1ToolCallPlan(toolName, input, nodeEnvironment());
        const afterContractFlag = cliPlan.args.indexOf("--after-contract");
        if (afterContractFlag < 0 || cliPlan.args[afterContractFlag + 1] === undefined) {
          throw new Error(`${definition.id}: CLI planning boundary omitted --after-contract`);
        }

        const parsed = createGoalChangeProposalSchema.parse({
          expectedContractRevision: input.contractRevision,
          afterContract: input.afterContract,
          rationale: input.rationale,
          evidenceRefs: input.evidenceRefs,
          idempotencyKey: input.idempotencyKey,
        });
        const nodePayload = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;

        return {
          id: definition.id,
          arguments: input,
          nodePayload,
          cliArgs: cliPlan.args,
          expected: definition.expected,
          ...(definition.note ? { note: definition.note } : {}),
        };
      });
  } finally {
    if (previousTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = previousTimezone;
    }
  }
}

function runRust(envelope: DifferentialEnvelope): Promise<RustRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--manifest-path",
        rustManifest,
        "--package",
        "rudder-agent-request-planner",
        "--bin",
        "agent-request-planner-differential",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, TZ: envelope.timezone },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(envelope)}\n`);
  });
}

async function main(): Promise<void> {
  let failed = false;

  for (const timezone of ["Asia/Shanghai", "America/New_York"] as const) {
    const cases = buildNodeCases(timezone);
    const envelope: DifferentialEnvelope = {
      schema,
      capability,
      timezone,
      runtime,
      cases,
    };

    console.log(`\nNode generated values (${timezone})`);
    for (const testCase of cases) {
      console.log(`  ${testCase.id}`);
      console.log(`    CLI plan: ${JSON.stringify(testCase.cliArgs)}`);
      console.log(`    payload:  ${JSON.stringify(testCase.nodePayload)}`);
    }

    const rustRun = await runRust(envelope);
    if (rustRun.stderr.trim()) {
      console.error(`Rust runner diagnostics (${timezone}):\n${rustRun.stderr.trim()}`);
    }
    if (!rustRun.stdout.trim()) {
      throw new Error(`Rust runner produced no JSON for ${timezone} (exit ${String(rustRun.exitCode)})`);
    }

    let report: { passed?: boolean };
    try {
      report = JSON.parse(rustRun.stdout) as { passed?: boolean };
    } catch (error) {
      throw new Error(`Rust runner produced invalid JSON for ${timezone}: ${String(error)}\n${rustRun.stdout}`);
    }

    console.log(`Rust planner output (${timezone})`);
    console.log(rustRun.stdout.trim());
    if (rustRun.exitCode !== 0 || report.passed !== true) {
      failed = true;
    }
  }

  if (failed) {
    throw new Error("Node -> Rust differential harness failed");
  }
  console.log("\nPASS Node -> Rust agent request planner differential");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
