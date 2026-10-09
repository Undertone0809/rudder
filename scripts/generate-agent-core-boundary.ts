/** Regenerate from public-main shared Zod, never from a migration's expected output. */
import fs from "node:fs";
import { createAgentKeySchema, resetAgentSessionSchema } from "../packages/shared/src/validators/agent.js";
const cases: unknown[] = [];
for (const [operation, schema, field] of [
  ["key-create", createAgentKeySchema, "name"],
  ["reset-session", resetAgentSessionSchema, "taskKey"],
] as const) {
  const values: unknown[] = [undefined, null, false, true, 0, 1.5, "", " ", "\t\n", "a", "任务", "a\u0000b", "h.p.s", "***REDACTED***", "𝌆", [], {}, ["x"], { nested: "opaque" }];
  const inputs = [...values, ...values.map((value) => ({ [field]: value })), { [field]: "ordinary", actor: { kind: "user", id: "forged" }, unknown: "strip" }];
  for (const [index, input] of inputs.entries()) {
    const parsed = schema.safeParse(input);
    cases.push({ operation, index, ...(input === undefined ? {} : { input }), expected: parsed.success ? { status: 200, value: parsed.data } : { status: 400, error: "Validation error", details: parsed.error.issues } });
  }
}
const destination = new URL("../native/crates/d1-persistence/tests/fixtures/agent-core-zod-boundary.json", import.meta.url);
fs.writeFileSync(destination, JSON.stringify({ schemaSource: "packages/shared/src/validators/agent.ts", cases }, null, 2) + "\n");
console.log(`Wrote ${cases.length} Agent schema cases from actual Zod`);
