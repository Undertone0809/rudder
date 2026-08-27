import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
const developing = fs.readFileSync(path.join(repoRoot, "doc/engineering/DEVELOPING.md"), "utf8");
const reviewer = fs.readFileSync(
  path.join(repoRoot, ".agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md"),
  "utf8",
);

test("contributor verification stays risk-based", () => {
  for (const verificationClass of ["FULL_GATE", "SPECIALIZED", "SCOPED", "NO_BUILD"]) {
    assert.match(agents, new RegExp("\\| `" + verificationClass + "` \\|", "u"));
    assert.match(developing, new RegExp("`" + verificationClass + "`", "u"));
  }

  assert.match(agents, /For `FULL_GATE`, freeze the candidate and run the broad command set once:/u);
  assert.match(developing, /For `FULL_GATE`, freeze the candidate and run the broad commands once:/u);
  assert.match(agents, /use `SPECIALIZED` unless a `FULL_GATE` trigger also applies/u);
  assert.match(developing, /Do not run typecheck, tests, or build merely for reassurance/u);
  assert.match(developing, /Public docs, CSS, or documentation image change \| `SPECIALIZED`/u);
  assert.match(developing, /Refresh of non-public generated documentation with unchanged generation logic \| `NO_BUILD`/u);
  assert.match(developing, /prefer `\$ego-browser` as the\s+first testing path/u);
  assert.doesNotMatch(developing, /@browser-use/u);
  assert.doesNotMatch(agents, /Run this full check before claiming done:/u);
});

test("independent verifier work remains terminal and evidence-driven", () => {
  assert.match(agents, /black-box acceptance only when all of these are true:/u);
  assert.match(agents, /The verifier is a terminal acceptance role, not a generic test runner/u);
  assert.match(agents, /Do not invent a\s+black-box surface merely to obtain a verdict/u);
  assert.match(agents, /reviewer final handoff verdict of `accept`/u);
  assert.match(developing, /use an independent verifier only for concrete terminal behavior/u);
  assert.match(reviewer, /When verifier eligibility is not met, record the verifier as not\s+required/u);
  assert.match(reviewer, /otherwise the verifier is explicitly\s+recorded as not required/u);
  assert.doesNotMatch(reviewer, /A distinct verifier returned `PASS` for the exact current candidate\./u);
  assert.doesNotMatch(agents, /For every non-trivial task, spawn distinct reviewer and verifier agents/u);
});

test("hand-offs distinguish omitted higher-class checks from failures", () => {
  assert.match(agents, /Report checks intentionally omitted by the selected class as out of\s+scope/u);
  assert.match(developing, /An intentionally omitted higher-class check is not a failed check/u);
  assert.match(developing, /Intentionally omitted: higher-class checks and why they do not test this claim/u);
});
