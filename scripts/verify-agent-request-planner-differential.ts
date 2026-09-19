import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildAgentV1ToolCallPlan,
  buildMcpServerEnv,
  runAgentV1McpJsonRpcMessage,
} from "../cli/src/agent-v1-mcp-server.js";
import { createGoalChangeProposalSchema } from "../packages/shared/src/validators/goal.js";

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

type TimeZone = "Asia/Shanghai" | "America/New_York";

type CaseDefinition = {
  id: string;
  timezone: TimeZone;
  deadline: string;
  note?: string;
};

const caseDefinitions: readonly CaseDefinition[] = [
  {
    id: "asia-shanghai-date-only",
    timezone: "Asia/Shanghai",
    deadline: "2026-08-20",
  },
  {
    id: "asia-shanghai-local-no-seconds",
    timezone: "Asia/Shanghai",
    deadline: "2026-08-20T12:00",
    note: "Node z.coerce.date accepts local ISO without seconds and canonicalizes it to UTC.",
  },
  {
    id: "asia-shanghai-local-with-seconds",
    timezone: "Asia/Shanghai",
    deadline: "2026-08-20T12:00:00",
  },
  {
    id: "new-york-local-no-seconds",
    timezone: "America/New_York",
    deadline: "2026-01-15T12:00",
    note: "Node z.coerce.date accepts local ISO without seconds and canonicalizes it to UTC.",
  },
  {
    id: "new-york-dst-gap",
    timezone: "America/New_York",
    deadline: "2026-03-08T02:30:00",
    note: "Node Date advances the nonexistent spring-forward wall time using the post-gap clock value.",
  },
  {
    id: "new-york-dst-overlap",
    timezone: "America/New_York",
    deadline: "2026-11-01T01:30:00",
    note: "Node Date selects the earlier occurrence during the fall-back overlap.",
  },
];

type DifferentialCase = {
  id: string;
  arguments: Record<string, unknown>;
  nodePayload: Record<string, unknown>;
  cliArgs: string[];
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

function nodeEnvironment(apiUrl: string) {
  return buildMcpServerEnv({
    RUDDER_API_URL: apiUrl,
    RUDDER_API_KEY: "differential-harness-key",
    RUDDER_ORG_ID: undefined,
    RUDDER_AGENT_ID: runtime.agentId,
    RUDDER_RUN_ID: runtime.runId,
    RUDDER_BROWSER_ENABLED: undefined,
  });
}

type CapturedRequest = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
};

async function captureNodeMcpPayload(
  timezone: TimeZone,
  input: Record<string, unknown>,
): Promise<CapturedRequest> {
  let resolveRequest!: (request: CapturedRequest) => void;
  let rejectRequest!: (error: Error) => void;
  const request = new Promise<CapturedRequest>((resolve, reject) => {
    resolveRequest = resolve;
    rejectRequest = reject;
  });
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("error", (error) => rejectRequest(error));
    incoming.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        resolveRequest({
          method: incoming.method ?? "",
          path: incoming.url ?? "",
          headers: incoming.headers,
          body,
        });
      } catch (error) {
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ id: "proposal-1", status: "pending" }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("differential harness could not determine loopback port");
  }

  try {
    const response = await runAgentV1McpJsonRpcMessage({
      jsonrpc: "2.0",
      id: `differential-${timezone}`,
      method: "tools/call",
      params: { name: toolName, arguments: input },
    }, nodeEnvironment(`http://127.0.0.1:${address.port}`));
    const result = response?.result as { isError?: boolean; structuredContent?: unknown } | undefined;
    if (result?.isError) {
      throw new Error(`${timezone}: MCP call failed: ${JSON.stringify(result.structuredContent)}`);
    }
    const captured = await request;
    if (captured.method !== "POST" || !captured.path.endsWith("/change-proposals")) {
      throw new Error(`${timezone}: unexpected captured request ${captured.method} ${captured.path}`);
    }
    if (
      captured.headers.authorization !== "Bearer differential-harness-key"
      || captured.headers["x-rudder-agent-id"] !== runtime.agentId
      || captured.headers["x-rudder-run-id"] !== runtime.runId
    ) {
      throw new Error(`${timezone}: captured request lost managed runtime identity headers`);
    }
    return captured;
  } finally {
    server.close();
    await once(server, "close").catch(() => undefined);
  }
}

async function buildNodeCases(timezone: TimeZone): Promise<DifferentialCase[]> {
  const previousTimezone = process.env.TZ;
  process.env.TZ = timezone;

  try {
    const cases: DifferentialCase[] = [];
    for (const definition of caseDefinitions.filter((candidate) => candidate.timezone === timezone)) {
      const input = {
        goal: "11111111-1111-4111-8111-111111111111",
        contractRevision: 7,
        afterContract: { actionDeadline: definition.deadline },
        rationale: "The runtime differential harness exercises date normalization.",
        idempotencyKey: `differential-${definition.id}`,
      };
      const cliPlan = buildAgentV1ToolCallPlan(toolName, input, nodeEnvironment("http://127.0.0.1:1"));
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
      const schemaPayload = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
      const captured = await captureNodeMcpPayload(timezone, input);
      if (JSON.stringify(captured.body) !== JSON.stringify(schemaPayload)) {
        throw new Error(`${definition.id}: live Node MCP body diverged from shared schema output`);
      }

      cases.push({
        id: definition.id,
        arguments: input,
        nodePayload: captured.body,
        cliArgs: cliPlan.args,
        ...(definition.note ? { note: definition.note } : {}),
      });
    }
    return cases;
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
        "--locked",
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
    const cases = await buildNodeCases(timezone);
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
