---
title: Routing and capability golden cases
date: 2026-06-17
kind: proposal
status: proposed
area: benchmarks
entities:
  - golden_cases
  - create_agent_benchmark
  - messenger_chat
  - organization_skills
issue:
related_plans:
  - 2026-04-14-create-agent-benchmark-v1.md
supersedes: []
related_code:
  - cli/src/commands/benchmark-create-agent.ts
  - packages/run-intelligence-core/src/create-agent-benchmark.ts
  - server/src/services/chats.helpers.ts
  - ui/src/pages/Chat.messages.tsx
  - tests/e2e/messenger-contract.spec.ts
commit_refs: []
updated_at: 2026-06-17
---

# Routing and Capability Golden Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end golden-case benchmark suite for Rudder's issue/chat routing, agent creation, skill visibility, and GitHub data-answering workflows.

**Architecture:** Extend the existing create-agent benchmark direction into a small generic golden-case runner instead of creating a parallel benchmark system. Cases live as repo-tracked JSON, the CLI runs them against a local Rudder instance, deterministic evaluators score resulting issues/chats/agents/runs, and optional live checks are isolated behind explicit flags.

**Tech Stack:** TypeScript, Commander CLI, `@rudderhq/run-intelligence-core`, existing Rudder REST APIs, Vitest, Playwright E2E, optional GitHub REST API.

---

## Proposal Summary

Start with six end-to-end golden cases:

1. `create_agent_by_issue`
2. `create_agent_by_chat`
3. `create_issue_by_chat`
4. `skills_question_in_issue`
5. `skills_question_in_chat`
6. `github_stars_and_recent_traffic`

Each case should run through the real Rudder surfaces where possible, but the first implementation should be deterministic by default. Live model behavior and live GitHub API data are useful as an opt-in mode, not as the default benchmark mode.

The benchmark should answer four questions:

- Did Rudder route the request through the correct product surface?
- Did the agent or assistant leave inspectable evidence in the right durable object?
- Did the final state match the requested outcome?
- Did the system avoid fabricating capabilities, skills, GitHub metrics, or access it does not have?

## Recommended Scope

The first version should be a focused `routing-capability-v1` set, not a general evaluation platform.

In scope:

- Repo-tracked golden case definitions.
- A typed case parser and deterministic evaluator in `@rudderhq/run-intelligence-core`.
- CLI commands to run one case or a named set.
- Deterministic fixture mode for CI/local repeatability.
- Optional live mode for real model and GitHub checks.
- Local JSON and Markdown reports under `.artifacts/golden-cases/`.
- One Playwright smoke test that proves the UI-facing chat/issue proposal path still renders the benchmark-visible state.

Out of scope:

- Nightly scheduling.
- Langfuse annotation queues for this first generic suite.
- A generalized judge prompt system.
- A new database table for benchmark results.
- Exact expected GitHub star or traffic numbers in checked-in fixtures.

## Case Contract

Create cases under:

```text
benchmark/golden-cases/cases/*.json
benchmark/golden-cases/sets/routing-capability-v1.json
```

Each case should use this shape:

```ts
export type GoldenCaseSurface = "issue" | "chat";
export type GoldenCaseMode = "deterministic" | "live_optional";
export type GoldenCaseExpectedOutcome =
  | "agent_created"
  | "issue_created"
  | "skills_answered"
  | "external_data_answered_or_declined";

export interface GoldenCase {
  id: string;
  title: string;
  surface: GoldenCaseSurface;
  mode: GoldenCaseMode;
  prompt: string;
  expectedOutcome: GoldenCaseExpectedOutcome;
  requiredEvidence: string[];
  forbiddenClaims: string[];
  expectedState?: {
    agent?: {
      nameIncludes?: string;
      roleIncludes?: string;
      runtimeType?: string;
      requiredSkills?: string[];
    };
    issue?: {
      titleIncludes?: string;
      status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
      linkedToChat?: boolean;
    };
    chat?: {
      hasIssueProposal?: boolean;
      hasOperationProposal?: boolean;
      linkedIssueRequired?: boolean;
    };
    externalData?: {
      provider: "github";
      owner: string;
      repo: string;
      requiredMetrics: Array<"stargazers_count" | "traffic_views">;
      allowPermissionDeclineFor: Array<"traffic_views">;
    };
  };
}
```

The default set should be:

```json
[
  "create_agent_by_issue",
  "create_agent_by_chat",
  "create_issue_by_chat",
  "skills_question_in_issue",
  "skills_question_in_chat",
  "github_stars_and_recent_traffic"
]
```

## Golden Cases

### Case 1: Create Agent By Issue

The operator creates an issue assigned to the benchmark agent:

```text
Create a GitHub Release Manager agent for this organization. It should own release readiness checks, GitHub release verification, and release-note follow-up. Use the existing local trusted runtime defaults unless a stricter runtime is required.
```

Expected result:

- A new agent exists or an approval requiring creation exists.
- The new agent's name or role clearly includes release management.
- The run leaves an issue comment or run summary explaining what was created or why approval is required.
- The result is linked to the source issue, not only mentioned in a chat transcript.

Fail conditions:

- The agent writes local files as a substitute for creating a Rudder agent.
- The issue is marked done without a new agent or explicit approval path.
- The run does not leave inspectable evidence.

### Case 2: Create Agent By Chat

The operator starts a chat with the benchmark agent:

```text
Create a Research Analyst agent who can investigate product and repo questions, summarize evidence, and cite sources. Keep the setup conservative and ask for approval if agent creation needs review.
```

Expected result:

- Chat produces an operation proposal, approval, or final state that creates the agent.
- The proposal or final response names the requested responsibility.
- If an approval gate is used, the approval is visible from Messenger/chat review surfaces.
- The created agent or pending approval is organization-scoped.

Fail conditions:

- Chat responds with generic instructions but no Rudder action path.
- The proposal omits the core role.
- The assistant claims the agent was created when no agent or approval exists.

### Case 3: Create Issue By Chat

The operator starts a chat:

```text
Turn this into an issue: audit the README onboarding flow and list the three highest-impact changes for a new user trying Rudder for the first time.
```

Expected result:

- Chat creates an issue proposal.
- Approving the proposal creates a real issue linked to the conversation.
- The issue title and description preserve the audit scope and acceptance criteria.
- The issue is assigned only if the selected agent is intended to own the next step.

Fail conditions:

- Chat only answers the request without proposing an issue.
- The issue loses the README/onboarding scope.
- The issue is created in the wrong organization.

### Case 4: Ask "What Skill Do You Have?" In Issue

The operator creates or comments on an assigned issue:

```text
What skill do you have? List the skills you can actually use for this issue and say how you know they are available.
```

Expected result:

- The agent answers in an issue comment.
- The answer cites runtime-visible skill evidence, loaded-skill evidence, or the configured agent skill snapshot.
- The answer distinguishes available skills from unavailable or unverified skills.
- The answer does not invent skills merely because they are useful.

Fail conditions:

- The agent lists generic capabilities with no source.
- The answer is left only in chat.
- The answer claims access to GitHub, browser, or local tools without evidence.

### Case 5: Ask "What Skill Do You Have?" In Chat

The operator asks the same question in chat:

```text
What skill do you have? List only the skills you can actually use in this chat and separate built-in Rudder guidance from optional organization skills.
```

Expected result:

- The chat answer identifies the selected agent or assistant context.
- The answer separates built-in Rudder guidance from enabled organization/global skills when that data is available.
- If skill evidence is unavailable, the answer says so explicitly and does not guess.

Fail conditions:

- The answer contradicts the issue-surface answer without a surface-specific reason.
- The answer lists disabled skills as usable.
- The assistant claims exact skill inventory when the runtime did not expose one.

### Case 6: GitHub Stars And Recent Traffic

The operator asks in chat or issue:

```text
查询 github rudder 有多少 star，最近几天的数据访问量。
```

Expected result:

- The response resolves the target repository as `Undertone0809/rudder` unless the organization config says otherwise.
- Star count is fetched from GitHub live mode or fixture mode and includes a timestamp/source.
- Recent traffic views are fetched only when a GitHub token with repository traffic access is configured.
- If traffic access is unavailable, the response explicitly says traffic data cannot be read because GitHub traffic APIs require repository access.
- No traffic number is fabricated.

Fail conditions:

- The answer gives traffic numbers without a GitHub traffic API response or fixture.
- The answer confuses stars with clones/views.
- The answer hides permission failure behind generic wording.

## File Structure

Create:

- `benchmark/golden-cases/cases/create_agent_by_issue.json`
- `benchmark/golden-cases/cases/create_agent_by_chat.json`
- `benchmark/golden-cases/cases/create_issue_by_chat.json`
- `benchmark/golden-cases/cases/skills_question_in_issue.json`
- `benchmark/golden-cases/cases/skills_question_in_chat.json`
- `benchmark/golden-cases/cases/github_stars_and_recent_traffic.json`
- `benchmark/golden-cases/sets/routing-capability-v1.json`
- `packages/run-intelligence-core/src/golden-cases.ts`
- `packages/run-intelligence-core/src/golden-cases.test.ts`
- `cli/src/commands/benchmark-golden-cases.ts`
- `cli/src/__tests__/benchmark-golden-cases.test.ts`
- `tests/e2e/golden-cases-routing.spec.ts`

Modify:

- `packages/run-intelligence-core/src/index.ts` to export parser/evaluator APIs.
- `cli/src/index.ts` or the benchmark command registration file to expose `rudder benchmark golden`.
- `package.json` to add a script such as `benchmark:golden`.
- `doc/plans/2026-04-14-create-agent-benchmark-v1.md` only if the implementation intentionally narrows or supersedes part of that old create-agent-only direction.

Do not modify:

- Database schema.
- Public docs under `docs/` in the first implementation unless the CLI becomes user-facing.
- Existing create-agent evaluator behavior except through shared utilities that keep existing tests passing.

## Implementation Tasks

### Task 1: Add Case Schema And Parser

**Files:**

- Create: `packages/run-intelligence-core/src/golden-cases.ts`
- Create: `packages/run-intelligence-core/src/golden-cases.test.ts`
- Modify: `packages/run-intelligence-core/src/index.ts`

- [ ] **Step 1: Write parser tests**

```ts
import { describe, expect, it } from "vitest";
import { parseGoldenCase } from "./golden-cases.js";

describe("parseGoldenCase", () => {
  it("parses a valid GitHub traffic case", () => {
    expect(parseGoldenCase({
      id: "github_stars_and_recent_traffic",
      title: "GitHub stars and recent traffic",
      surface: "chat",
      mode: "live_optional",
      prompt: "查询 github rudder 有多少 star，最近几天的数据访问量。",
      expectedOutcome: "external_data_answered_or_declined",
      requiredEvidence: ["github_repo_source", "timestamp_or_fixture_id"],
      forbiddenClaims: ["fabricated_traffic"],
      expectedState: {
        externalData: {
          provider: "github",
          owner: "Undertone0809",
          repo: "rudder",
          requiredMetrics: ["stargazers_count", "traffic_views"],
          allowPermissionDeclineFor: ["traffic_views"]
        }
      }
    }).id).toBe("github_stars_and_recent_traffic");
  });

  it("rejects fabricated surfaces", () => {
    expect(() => parseGoldenCase({
      id: "bad",
      title: "Bad",
      surface: "email",
      mode: "deterministic",
      prompt: "Bad",
      expectedOutcome: "issue_created",
      requiredEvidence: [],
      forbiddenClaims: []
    })).toThrow("invalid surface");
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run:

```bash
pnpm --filter @rudderhq/run-intelligence-core test -- golden-cases.test.ts
```

Expected: test fails because `golden-cases.ts` does not exist.

- [ ] **Step 3: Add the parser and types**

```ts
export type GoldenCaseSurface = "issue" | "chat";
export type GoldenCaseMode = "deterministic" | "live_optional";
export type GoldenCaseExpectedOutcome =
  | "agent_created"
  | "issue_created"
  | "skills_answered"
  | "external_data_answered_or_declined";

export interface GoldenCase {
  id: string;
  title: string;
  surface: GoldenCaseSurface;
  mode: GoldenCaseMode;
  prompt: string;
  expectedOutcome: GoldenCaseExpectedOutcome;
  requiredEvidence: string[];
  forbiddenClaims: string[];
  expectedState?: {
    agent?: {
      nameIncludes?: string;
      roleIncludes?: string;
      runtimeType?: string;
      requiredSkills?: string[];
    };
    issue?: {
      titleIncludes?: string;
      status?: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
      linkedToChat?: boolean;
    };
    chat?: {
      hasIssueProposal?: boolean;
      hasOperationProposal?: boolean;
      linkedIssueRequired?: boolean;
    };
    externalData?: {
      provider: "github";
      owner: string;
      repo: string;
      requiredMetrics: Array<"stargazers_count" | "traffic_views">;
      allowPermissionDeclineFor: Array<"traffic_views">;
    };
  };
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => nonEmptyString(item)).filter((item): item is string => Boolean(item))
    : [];
}

export function parseGoldenCase(raw: unknown): GoldenCase {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Golden case must be an object.");
  }
  const value = raw as Record<string, unknown>;
  const id = nonEmptyString(value.id);
  const title = nonEmptyString(value.title);
  const surface = nonEmptyString(value.surface);
  const mode = nonEmptyString(value.mode);
  const prompt = nonEmptyString(value.prompt);
  const expectedOutcome = nonEmptyString(value.expectedOutcome);

  if (!id) throw new Error("Golden case is missing a non-empty id.");
  if (!title) throw new Error(`Golden case ${id} is missing a non-empty title.`);
  if (surface !== "issue" && surface !== "chat") throw new Error(`Golden case ${id} has invalid surface.`);
  if (mode !== "deterministic" && mode !== "live_optional") throw new Error(`Golden case ${id} has invalid mode.`);
  if (!prompt) throw new Error(`Golden case ${id} is missing a non-empty prompt.`);
  if (
    expectedOutcome !== "agent_created" &&
    expectedOutcome !== "issue_created" &&
    expectedOutcome !== "skills_answered" &&
    expectedOutcome !== "external_data_answered_or_declined"
  ) {
    throw new Error(`Golden case ${id} has invalid expectedOutcome.`);
  }

  return {
    id,
    title,
    surface,
    mode,
    prompt,
    expectedOutcome,
    requiredEvidence: stringArray(value.requiredEvidence),
    forbiddenClaims: stringArray(value.forbiddenClaims),
    expectedState: typeof value.expectedState === "object" && value.expectedState && !Array.isArray(value.expectedState)
      ? value.expectedState as GoldenCase["expectedState"]
      : undefined,
  };
}
```

- [ ] **Step 4: Export the parser**

Add to `packages/run-intelligence-core/src/index.ts`:

```ts
export * from "./golden-cases.js";
```

- [ ] **Step 5: Verify**

Run:

```bash
pnpm --filter @rudderhq/run-intelligence-core test -- golden-cases.test.ts
pnpm --filter @rudderhq/run-intelligence-core typecheck
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add packages/run-intelligence-core/src/golden-cases.ts packages/run-intelligence-core/src/golden-cases.test.ts packages/run-intelligence-core/src/index.ts
git commit -m "feat: add golden case contract"
```

### Task 2: Add The Six Case Fixtures

**Files:**

- Create: `benchmark/golden-cases/cases/*.json`
- Create: `benchmark/golden-cases/sets/routing-capability-v1.json`

- [ ] **Step 1: Add the six case JSON files**

```json
{
  "id": "create_agent_by_issue",
  "title": "Create agent by issue",
  "surface": "issue",
  "mode": "deterministic",
  "prompt": "Create a GitHub Release Manager agent for this organization. It should own release readiness checks, GitHub release verification, and release-note follow-up. Use the existing local trusted runtime defaults unless a stricter runtime is required.",
  "expectedOutcome": "agent_created",
  "requiredEvidence": ["source_issue_link", "created_agent_or_approval", "issue_comment_or_run_summary"],
  "forbiddenClaims": ["filesystem_agent_created", "created_without_agent_or_approval"],
  "expectedState": {
    "agent": {
      "nameIncludes": "Release",
      "roleIncludes": "release",
      "runtimeType": "local_trusted"
    }
  }
}
```

```json
{
  "id": "create_agent_by_chat",
  "title": "Create agent by chat",
  "surface": "chat",
  "mode": "deterministic",
  "prompt": "Create a Research Analyst agent who can investigate product and repo questions, summarize evidence, and cite sources. Keep the setup conservative and ask for approval if agent creation needs review.",
  "expectedOutcome": "agent_created",
  "requiredEvidence": ["chat_operation_path", "created_agent_or_approval", "organization_scope"],
  "forbiddenClaims": ["created_without_agent_or_approval", "generic_instructions_only"],
  "expectedState": {
    "agent": {
      "nameIncludes": "Research",
      "roleIncludes": "research",
      "runtimeType": "local_trusted"
    },
    "chat": {
      "hasOperationProposal": true
    }
  }
}
```

```json
{
  "id": "create_issue_by_chat",
  "title": "Create issue by chat",
  "surface": "chat",
  "mode": "deterministic",
  "prompt": "Turn this into an issue: audit the README onboarding flow and list the three highest-impact changes for a new user trying Rudder for the first time.",
  "expectedOutcome": "issue_created",
  "requiredEvidence": ["chat_issue_proposal", "linked_issue", "preserved_acceptance_scope"],
  "forbiddenClaims": ["answered_without_issue_path", "wrong_organization"],
  "expectedState": {
    "issue": {
      "titleIncludes": "README",
      "status": "todo",
      "linkedToChat": true
    },
    "chat": {
      "hasIssueProposal": true,
      "linkedIssueRequired": true
    }
  }
}
```

```json
{
  "id": "skills_question_in_issue",
  "title": "Skills question in issue",
  "surface": "issue",
  "mode": "deterministic",
  "prompt": "What skill do you have? List the skills you can actually use for this issue and say how you know they are available.",
  "expectedOutcome": "skills_answered",
  "requiredEvidence": ["issue_comment", "skill_source_or_unavailable_reason", "available_vs_unverified_distinction"],
  "forbiddenClaims": ["generic_capability_list_only", "unsourced_tool_access", "chat_only_answer"],
  "expectedState": {
    "issue": {
      "status": "todo"
    }
  }
}
```

```json
{
  "id": "skills_question_in_chat",
  "title": "Skills question in chat",
  "surface": "chat",
  "mode": "deterministic",
  "prompt": "What skill do you have? List only the skills you can actually use in this chat and separate built-in Rudder guidance from optional organization skills.",
  "expectedOutcome": "skills_answered",
  "requiredEvidence": ["chat_answer", "selected_agent_or_assistant_context", "built_in_vs_optional_distinction"],
  "forbiddenClaims": ["disabled_skill_claimed_usable", "exact_inventory_without_runtime_evidence"],
  "expectedState": {
    "chat": {
      "linkedIssueRequired": false
    }
  }
}
```

```json
{
  "id": "github_stars_and_recent_traffic",
  "title": "GitHub stars and recent traffic",
  "surface": "chat",
  "mode": "live_optional",
  "prompt": "查询 github rudder 有多少 star，最近几天的数据访问量。",
  "expectedOutcome": "external_data_answered_or_declined",
  "requiredEvidence": ["github_repo_source", "timestamp_or_fixture_id", "traffic_source_or_permission_decline"],
  "forbiddenClaims": ["fabricated_traffic", "stars_confused_with_views", "permission_failure_hidden"],
  "expectedState": {
    "externalData": {
      "provider": "github",
      "owner": "Undertone0809",
      "repo": "rudder",
      "requiredMetrics": ["stargazers_count", "traffic_views"],
      "allowPermissionDeclineFor": ["traffic_views"]
    }
  }
}
```

- [ ] **Step 2: Add the set file**

```json
[
  "create_agent_by_issue",
  "create_agent_by_chat",
  "create_issue_by_chat",
  "skills_question_in_issue",
  "skills_question_in_chat",
  "github_stars_and_recent_traffic"
]
```

- [ ] **Step 3: Add a fixture loading test**

Append to `packages/run-intelligence-core/src/golden-cases.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";

it("parses all routing-capability-v1 fixture cases", () => {
  const root = path.resolve(process.cwd(), "../..");
  const setPath = path.join(root, "benchmark/golden-cases/sets/routing-capability-v1.json");
  const caseIds = JSON.parse(fs.readFileSync(setPath, "utf8")) as string[];
  expect(caseIds).toHaveLength(6);
  for (const caseId of caseIds) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "benchmark/golden-cases/cases", `${caseId}.json`), "utf8"));
    expect(parseGoldenCase(raw).id).toBe(caseId);
  }
});
```

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @rudderhq/run-intelligence-core test -- golden-cases.test.ts
git add benchmark/golden-cases packages/run-intelligence-core/src/golden-cases.test.ts
git commit -m "test: add routing capability golden cases"
```

### Task 3: Add Deterministic Evaluator

**Files:**

- Modify: `packages/run-intelligence-core/src/golden-cases.ts`
- Modify: `packages/run-intelligence-core/src/golden-cases.test.ts`

- [ ] **Step 1: Write evaluator tests**

```ts
import { evaluateGoldenCase } from "./golden-cases.js";

it("passes a GitHub traffic response that declines unavailable traffic explicitly", () => {
  const result = evaluateGoldenCase({
    testCase: parseGoldenCase({
      id: "github_stars_and_recent_traffic",
      title: "GitHub stars and recent traffic",
      surface: "chat",
      mode: "live_optional",
      prompt: "查询 github rudder 有多少 star，最近几天的数据访问量。",
      expectedOutcome: "external_data_answered_or_declined",
      requiredEvidence: ["github_repo_source"],
      forbiddenClaims: ["fabricated_traffic"],
      expectedState: {
        externalData: {
          provider: "github",
          owner: "Undertone0809",
          repo: "rudder",
          requiredMetrics: ["stargazers_count", "traffic_views"],
          allowPermissionDeclineFor: ["traffic_views"]
        }
      }
    }),
    observed: {
      agentsCreated: [],
      issuesCreated: [],
      chatMessages: [{
        body: "Undertone0809/rudder has 1234 stars as of 2026-06-17T10:00:00Z. GitHub traffic views were not available because the token does not have repository traffic access."
      }],
      issueComments: [],
      approvalsCreated: [],
      externalData: {
        github: {
          repo: "Undertone0809/rudder",
          stargazersCount: 1234,
          trafficViews: null,
          trafficUnavailableReason: "permission_denied"
        }
      }
    }
  });
  expect(result.finalClassification).toBe("pass");
});
```

- [ ] **Step 2: Implement the evaluator**

Add types and evaluator logic that returns:

```ts
export interface GoldenCaseObservedState {
  agentsCreated: Array<{ name: string; role: string; runtimeType?: string | null }>;
  issuesCreated: Array<{ title: string; status?: string | null; linkedToChat?: boolean }>;
  chatMessages: Array<{ body: string }>;
  issueComments: Array<{ body: string }>;
  approvalsCreated: Array<{ type: string; status?: string | null; payload?: unknown }>;
  externalData?: {
    github?: {
      repo: string;
      stargazersCount: number | null;
      trafficViews: number | null;
      trafficUnavailableReason: "permission_denied" | "not_configured" | "api_error" | null;
    };
  };
}

export interface GoldenCaseEvalResult {
  caseId: string;
  finalClassification: "pass" | "fail" | "needs_review";
  checks: Array<{ name: string; value: "pass" | "fail" | "needs_review"; comment: string }>;
}
```

The evaluator must score these deterministic checks:

- outcome exists
- required evidence exists
- forbidden claims are absent
- expected final state exists
- GitHub traffic is either sourced or explicitly declined

- [ ] **Step 3: Verify and commit**

```bash
pnpm --filter @rudderhq/run-intelligence-core test -- golden-cases.test.ts
pnpm --filter @rudderhq/run-intelligence-core typecheck
git add packages/run-intelligence-core/src/golden-cases.ts packages/run-intelligence-core/src/golden-cases.test.ts
git commit -m "feat: evaluate golden case outcomes"
```

### Task 4: Add CLI Runner Skeleton

**Files:**

- Create: `cli/src/commands/benchmark-golden-cases.ts`
- Modify: CLI command registration file.
- Create: `cli/src/__tests__/benchmark-golden-cases.test.ts`

- [ ] **Step 1: Add CLI tests for command shape**

```ts
import { describe, expect, it } from "vitest";
import { createBenchmarkGoldenCasesCommand } from "../commands/benchmark-golden-cases.js";

describe("benchmark golden command", () => {
  it("registers run and run-set commands", () => {
    const command = createBenchmarkGoldenCasesCommand({} as never);
    expect(command.commands.map((item) => item.name())).toEqual(["run", "run-set", "report"]);
  });
});
```

- [ ] **Step 2: Implement the command skeleton**

The command should mirror `cli/src/commands/benchmark-create-agent.ts` conventions:

```ts
import { Command } from "commander";

export function createBenchmarkGoldenCasesCommand(baseOptions: unknown): Command {
  const command = new Command("golden")
    .description("Run Rudder golden benchmark cases");

  command.command("run")
    .argument("<case-id>")
    .option("--cases-dir <dir>", "Case directory", "benchmark/golden-cases/cases")
    .option("--artifacts-dir <dir>", "Artifacts directory", ".artifacts/golden-cases")
    .option("--live", "Allow live external/model calls")
    .action(async () => {
      throw new Error("golden run is registered but execution is not wired yet");
    });

  command.command("run-set")
    .argument("<set-name>")
    .option("--sets-dir <dir>", "Set directory", "benchmark/golden-cases/sets")
    .option("--continue-on-error", "Continue after a case fails")
    .action(async () => {
      throw new Error("golden run-set is registered but execution is not wired yet");
    });

  command.command("report")
    .argument("<run-dir>")
    .option("--markdown", "Print markdown report")
    .action(async () => {
      throw new Error("golden report is registered but execution is not wired yet");
    });

  return command;
}
```

- [ ] **Step 3: Register the command and verify help output**

```bash
pnpm --filter @rudderhq/cli typecheck
pnpm rudder benchmark golden --help
```

Expected: help output lists `run`, `run-set`, and `report`.

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/benchmark-golden-cases.ts cli/src/__tests__/benchmark-golden-cases.test.ts cli/src/index.ts
git commit -m "feat: add golden benchmark CLI surface"
```

### Task 5: Wire Deterministic Case Execution

**Files:**

- Modify: `cli/src/commands/benchmark-golden-cases.ts`
- Modify: `cli/src/__tests__/benchmark-golden-cases.test.ts`

- [ ] **Step 1: Add tests for fixture loading and report writing**

Write tests that call internal helpers with a temp directory and assert:

- a case JSON loads through `parseGoldenCase`
- a result JSON is written to `.artifacts/golden-cases/runs/<case-id>-<timestamp>/result.json`
- a Markdown report includes final classification and failed checks

- [ ] **Step 2: Implement helper functions**

Add helpers:

```ts
async function loadGoldenCase(caseId: string, casesDir: string) {
  const raw = JSON.parse(await fs.readFile(path.join(casesDir, `${caseId}.json`), "utf8"));
  return parseGoldenCase(raw);
}

async function writeGoldenCaseResult(artifactsDir: string, result: StoredGoldenCaseResult) {
  const runDir = path.join(artifactsDir, "runs", `${result.case.id}-${result.generatedAt.replace(/[:.]/g, "-")}`);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(runDir, "report.md"), buildGoldenCaseMarkdownReport(result), "utf8");
  return runDir;
}
```

- [ ] **Step 3: Implement deterministic fixture mode**

For the first pass, deterministic mode can load observed state from:

```text
benchmark/golden-cases/observed-fixtures/<case-id>.json
```

This keeps evaluator development stable before the live Rudder execution path is connected.

- [ ] **Step 4: Verify and commit**

```bash
pnpm --filter @rudderhq/cli test -- benchmark-golden-cases.test.ts
pnpm --filter @rudderhq/cli typecheck
git add cli/src/commands/benchmark-golden-cases.ts cli/src/__tests__/benchmark-golden-cases.test.ts benchmark/golden-cases/observed-fixtures
git commit -m "feat: run deterministic golden case fixtures"
```

### Task 6: Connect End-To-End Rudder Execution

**Files:**

- Modify: `cli/src/commands/benchmark-golden-cases.ts`
- Modify: `cli/src/__tests__/benchmark-golden-cases.test.ts`

- [ ] **Step 1: Add client tests with a mocked API**

Mock API calls for:

- creating an issue for issue-surface cases
- creating a chat message for chat-surface cases
- polling resulting issue/chat/run state
- listing agents, approvals, issues, and chat messages before and after

- [ ] **Step 2: Implement issue-surface run flow**

Use the existing create-agent runner pattern:

1. Snapshot agents, issues, approvals.
2. Create a benchmark issue assigned to the benchmark agent.
3. Wait for `executionRunId`.
4. Wait for run terminal status.
5. Capture post-run agents, issues, approvals, comments, and run detail.
6. Build `GoldenCaseObservedState`.
7. Evaluate and write result artifacts.

- [ ] **Step 3: Implement chat-surface run flow**

Use existing chat APIs:

1. Create or select a benchmark chat conversation.
2. Send the case prompt with the configured benchmark agent.
3. Poll until the assistant message reaches a terminal state.
4. Capture chat messages, issue proposals, operation proposals, approvals, linked issue, created issue, and created agent deltas.
5. Build `GoldenCaseObservedState`.
6. Evaluate and write result artifacts.

- [ ] **Step 4: Verify with a local dev instance**

```bash
pnpm dev
pnpm rudder benchmark golden run-set routing-capability-v1 --org-id <org-id> --benchmark-agent-id <agent-id> --continue-on-error
```

Expected:

- all six cases produce result JSON and Markdown reports
- deterministic cases do not require external network calls
- `github_stars_and_recent_traffic` passes when traffic is explicitly unavailable with a permission reason

- [ ] **Step 5: Commit**

```bash
git add cli/src/commands/benchmark-golden-cases.ts cli/src/__tests__/benchmark-golden-cases.test.ts
git commit -m "feat: run golden cases against Rudder"
```

### Task 7: Add GitHub Live/Fallback Contract

**Files:**

- Modify: `cli/src/commands/benchmark-golden-cases.ts`
- Modify: `packages/run-intelligence-core/src/golden-cases.test.ts`

- [ ] **Step 1: Add evaluator tests for GitHub failure modes**

Test these cases:

- star count present and traffic views present: pass
- star count present and traffic permission denied: pass
- star count missing: fail
- traffic number present without source or fixture: fail

- [ ] **Step 2: Implement live GitHub fetcher behind `--live`**

Use:

```text
GET https://api.github.com/repos/Undertone0809/rudder
GET https://api.github.com/repos/Undertone0809/rudder/traffic/views
```

Rules:

- The repo endpoint may run unauthenticated but should use `GITHUB_TOKEN` when present.
- The traffic endpoint must use `GITHUB_TOKEN`.
- A `403` or `404` from traffic is captured as `trafficUnavailableReason: "permission_denied"`.
- The report must include `fetchedAt`.

- [ ] **Step 3: Verify with and without token**

```bash
unset GITHUB_TOKEN
pnpm rudder benchmark golden run github_stars_and_recent_traffic --live
```

Expected: star count is fetched or rate-limited clearly; traffic is unavailable with `not_configured` or `permission_denied`.

```bash
GITHUB_TOKEN=<token-with-repo-traffic-access> pnpm rudder benchmark golden run github_stars_and_recent_traffic --live
```

Expected: star count and traffic views are included with source timestamps.

- [ ] **Step 4: Commit**

```bash
git add cli/src/commands/benchmark-golden-cases.ts packages/run-intelligence-core/src/golden-cases.ts packages/run-intelligence-core/src/golden-cases.test.ts
git commit -m "feat: support live GitHub golden case checks"
```

### Task 8: Add E2E Smoke Coverage

**Files:**

- Create: `tests/e2e/golden-cases-routing.spec.ts`

- [ ] **Step 1: Add Playwright smoke for chat issue proposal visibility**

Test that a chat-created issue proposal can render and approve into a linked issue. Reuse patterns from `tests/e2e/messenger-contract.spec.ts` and `tests/e2e/chat-skill-picker.spec.ts`.

- [ ] **Step 2: Add Playwright smoke for skill answer placement**

Seed an issue and assert that the answer/evidence lands in the issue thread for issue-surface cases and in chat messages for chat-surface cases.

- [ ] **Step 3: Verify**

```bash
pnpm test:e2e -- tests/e2e/golden-cases-routing.spec.ts
```

Expected: both smoke tests pass against the local e2e server.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/golden-cases-routing.spec.ts
git commit -m "test: cover golden case routing surfaces"
```

## Validation Plan

Run the focused checks first:

```bash
pnpm --filter @rudderhq/run-intelligence-core test -- golden-cases.test.ts
pnpm --filter @rudderhq/run-intelligence-core typecheck
pnpm --filter @rudderhq/cli typecheck
pnpm test:e2e -- tests/e2e/golden-cases-routing.spec.ts
```

Then run the broader repo checks before hand-off:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

If broad tests are noisy, record the exact failing suites and keep the focused benchmark checks as the primary proof for this change.

## Approval Recommendation

Approve this proposal if the goal is to make Rudder's highest-risk entry surfaces measurable before adding more benchmark volume. The first implementation should prefer deterministic repeatability over model-quality ambition, with live mode as a separate signal.
