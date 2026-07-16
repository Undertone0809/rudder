---
title: Agent document-guided error recovery
date: 2026-07-16
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - agent_runtime_instructions
  - agent_run_recovery
  - project_resources
  - agent_runtime_config
issue:
related_plans:
  - 2026-05-02.agent-self-improvement-proposal.md
  - 2026-06-14-runtime-heartbeat-prompt-and-studio-practices.md
  - 2026-06-19-agent-startup-context-bundle.md
  - 2026-06-30-agent-v1-mcp-tools.md
  - 2026-07-14-run-intelligence-summary-and-bounded-evidence.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - packages/agent-runtime-utils/src/types.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
  - server/src/services/runtime-kernel/heartbeat.misc.ts
  - server/src/services/runtime-kernel/model-fallback.ts
  - server/src/agent-runtimes/registry.ts
  - cli/src/agent-v1-registry.ts
  - server/resources/bundled-skills/rudder/SKILL.md
commit_refs:
  - "docs: propose agent document-guided recovery"
updated_at: 2026-07-16
---

# Agent Document-Guided Error Recovery

## Overview

Rudder should let a running agent recover from a recoverable work error by
consulting authoritative documentation, applying the smallest permitted
correction, and verifying the same failing operation before it gives up.

This proposal adds two related but distinct recovery paths:

1. **In-run document-guided recovery:** while the provider's tool loop is still
   alive, a short runtime-owned instruction and a trusted documentation resolver
   guide the agent through diagnosis, documentation lookup, correction, and
   verification.
2. **One bounded issue diagnostic lineage:** when an issue-backed Agent Run
   terminates with a class of failure that documentation can plausibly explain,
   Rudder may enqueue one linked, machine-enforced read-only diagnostic run with
   the original error evidence and documentation candidates. It produces an
   evidence-backed correction suggestion; it does not repeat the failed
   mutation. Rudder must not blindly retry every failure or reuse issue-oriented
   recovery for another scene.

The recommended first release does **not** grant arbitrary self-modification of
Rudder agent configuration. A persistent runtime-config change remains
operator-approved unless a later proposal defines a narrow, allowlisted,
revision-backed self-tuning policy.

The Product Logic Registry remains read-only in this proposal. The contract
deltas required before implementation are listed explicitly below and require
separate user authorization.

## What Is The Problem?

### Current Rudder behavior

Rudder already owns most of the individual pieces:

- the shared instruction stack exposes agent instructions, `SOUL.md`,
  `TOOLS.md`, `MEMORY.md`, Project Resources, workspace context, and the current
  time;
- the operating contract tells agents to inspect broader Library and
  organization workspace knowledge when Project Context is insufficient;
- adapter configuration docs are exposed through
  `rudder agent config doc <runtime-type>`;
- `rudder runs errors <run-id>` extracts failed tool calls, stderr, runtime
  failures, and jump-to-context commands;
- Agent Runs persist logs, transcript, result, error, cost, and session
  evidence;
- model fallback can try another configured runtime/model;
- process-loss recovery can enqueue a linked run; and
- operators can manually retry failed, timed-out, or cancelled runs.

These are not yet a document-guided recovery loop:

- the runtime operating contract does not require an agent to consult
  authoritative documentation after a tool, command, API, dependency, or
  configuration error;
- Project Resources are rendered as a catalog, but Rudder does not resolve a
  failure to the most relevant trusted source or record which source was used;
- the adapter interface has no control-plane callback that can inject new
  guidance into an already-running provider loop after a tool failure;
- a terminated run's recovery prompt carries only a short failure summary and
  does not begin with `rudder runs errors` plus documentation lookup;
- ordinary failures are either left failed, manually retried, or sent through
  model fallback without a docs-first diagnosis step; and
- error classification is too coarse to distinguish a documentation-recoverable
  usage/configuration failure from runtime boot, budget, permission, approval,
  cancellation, or infrastructure failures.

The result is that an agent may repeat the same invalid operation, guess a new
parameter, or report a blocker even when the repository, attached resources,
runtime adapter docs, or official product docs already contain the answer.

### Why Hermes often feels better at this

This proposal was informed by the official NousResearch Hermes Agent source at
commit `f8bf40b18b4c3e15b848a1fd3c4fbc5b67ae6ef4` (reviewed 2026-07-16).

Hermes combines several small mechanisms:

- `HERMES_AGENT_HELP_GUIDANCE` tells the model that official Hermes docs are
  authoritative for configuring, extending, and troubleshooting itself, and
  points to a dedicated `hermes-agent` skill for proven workflows;
- Hermes's mandatory skill index routes setup, configuration, installation,
  modification, and troubleshooting requests through that skill instead of
  letting the model invent a workaround;
- tool-use and task-completion guidance require the model to take real actions,
  try an alternative when a tool/install/network path fails, and never replace
  failed execution with fabricated output;
- the Hermes skill names concrete, model-callable control surfaces such as
  `hermes config set`, `hermes config check`, `hermes doctor --fix`,
  `hermes gateway restart`, and the post-change restart/reset rules;
- config mutation is funneled through a dotted-key command with type handling,
  managed/pinned-key rejection, secret routing and masked output, readable-
  config checks, and atomic file replacement rather than casual YAML editing;
- `doctor --fix` only applies an encoded allowlist of repairs and reports the
  remaining manual issues separately; it is not permission for arbitrary
  AI-authored repair;
- the same skill explains where config, logs, sessions, skills, and source live,
  so the model can inspect state instead of guessing;
- tricky solved errors are candidates for skill creation, and stale skills are
  patched rather than silently retained; and
- sensitive settings retain hard boundaries. For example, secret-redaction
  state is snapshotted and cannot be disabled by the model inside the current
  session merely by changing an environment variable.

Hermes does not implement a generic `any tool error -> fetch documentation`
hook. Tool errors are normalized and returned to the ordinary model loop as
tool results. The stable authoritative-doc prompt, mandatory skill routing,
available read/search/web/terminal tools, and continuing loop then let the
model diagnose and act. Rudder should preserve that distinction instead of
claiming a deterministic web fetch where none exists.

The transferable lesson is not to copy Hermes's Python loop or add an
unbounded retry. It is to make the recovery procedure, authoritative sources,
safe commands, verification step, and mutation boundaries explicit and
available to the model at the moment it needs them.

Rudder must also preserve a different architectural boundary: it is the
runtime-neutral control plane, while Hermes, Codex, Claude, Gemini, OpenCode,
Pi, and Cursor are execution runtimes with different capabilities.

### Hermes adapter caveat in this repository

Rudder's current `hermes_local` compatibility adapter must not be used as proof
that this proposal already works across Hermes:

- the wrapper maps legacy `companyId` but does not fully normalize current
  Rudder context/config fields into the third-party adapter's expected shape;
- task/comment context and local auth propagation need direct black-box proof;
- Hermes transcript parsing and skill list/sync capabilities are not wired into
  the current registry entry; and
- the adapter's approval/sandbox behavior must be reconciled with Rudder's
  governed-action boundaries before self-modification is trusted.

Hermes adapter hardening is a prerequisite for claiming Hermes parity, but it
is a separate implementation slice from the provider-neutral recovery design.

## Product Decision

### Recommended behavior

Adopt a **docs-first, evidence-backed, issue-diagnose-once** recovery policy:

- every adapter participating in `AGENT.INSTRUCTIONS.001` receives the same
  short recovery discipline; an adapter outside that shared instruction path,
  including current `hermes_local`, joins only after its prerequisite work;
- the detailed procedure lives in the always-enabled Rudder skill and first-
  party tools, not as a large duplicated prompt block;
- the agent resolves sources from trusted local and official documentation
  before broad web search;
- the agent makes one smallest permitted correction at a time and reruns the
  exact failing check;
- a terminated run is automatically followed in V1 only when it is issue-
  backed, a deterministic classifier marks its terminal failure document-
  diagnosable, and the adapter can enforce the read-only diagnostic envelope;
- at most one docs-guided diagnostic admission is created per root issue run;
- the original run remains failed and linked to the recovery run; and
- source, diagnosis, applied-or-suggested correction, verification status, and
  outcome evidence are persisted.

Chat, Automation, Review, and Heartbeat Runs receive the same in-run recovery
discipline in V1, but do not use the issue diagnostic enqueuer. Chat keeps its
existing operator Retry behavior; Automation output/finalization, Review
ownership, and Heartbeat scheduling need scene-specific designs before any
terminal auto-diagnosis is enabled.

Same-run recovery never expands the original run's mutation authority. The V1
terminal diagnostic run is stricter: it is machine-enforced read-only regardless
of the original request and may only read bounded evidence/docs, write typed
recovery records, and emit its normal result/suggestion. Adapters that cannot
prove this envelope do not receive automatic terminal diagnosis.

### Source selection

Source selection must not collapse relevance, trust, and instruction authority
into one ranking. A task attachment may be highly relevant but still be data to
analyze rather than an operating rule.

The V1 resolver returns candidates from a bounded set:

1. exact files and operator-curated reference resources attached to the active
   project/task;
2. repository-local `AGENTS.md`, `README*`, `docs/**`, `doc/**`, package help,
   and versioned references inside the realized workspace and configured doc
   roots;
3. adapter configuration docs and bundled Rudder skill references;
4. organization resources explicitly registered as reference contracts; and
5. allowlisted official upstream locators registered by an adapter, resource,
   or Rudder itself.

Every candidate carries three independent properties:

- `relevance`: how closely it matches this query/failure;
- `trust`: who registered or controls the source; and
- `instructionAuthority`: whether it is an operating contract, a reference, or
  untrusted/data-only content.

Ordinary attachments and unmarked Project Resources default to `data_only` and
cannot override repository, Rudder, runtime, or user instructions. A project-
specific reference may be selected over a generic upstream guide for API
details when it is both relevant and intentionally marked as the project's
reference contract; that does not give it system-instruction authority.

V1 returns an allowlisted official web locator and provenance only. The agent
may open it through its existing authorized Browser/web tooling. Server-side
fetching, freshness extraction, and arbitrary web search are separate future
work; any retrieved web body remains untrusted data.

### Failure eligibility

| Failure class | In-run docs lookup | V1 terminal diagnosis | Required behavior |
| --- | --- | --- | --- |
| Command/tool/API usage, invalid option, schema mismatch | Yes | Issue-backed, read-only, once | Same run may correct within original authority; terminal diagnostic reads evidence/docs and suggests the correction without repeating the mutation |
| Dependency/version/configuration mismatch | Yes | Issue-backed, read-only, when runtime can still boot | Same run may act only when authorized; terminal diagnostic verifies readable state/docs and suggests next steps |
| Transient provider/network failure | Optional | No docs recovery; use existing bounded fallback/retry policy | Do not disguise availability failure as a documentation problem |
| Model-generation failure after model output | Yes when evidence points to a terminal tool/config failure | Issue-backed diagnostic only; Chat keeps manual Retry | Deduplicate admission and preserve failure class |
| Runtime boot/command-not-found before model output | No, the failed runtime cannot self-repair | No | Operator-facing runtime repair; a separate healthy diagnostic runtime may be proposed later |
| Workspace preflight/path/permission boundary | Read local policy if model is alive | No automatic mutation/retry | Preserve boundary and request operator action when required |
| Approval required/denied | No bypass | No | Wait for or respect the governed decision |
| Budget hard stop | No | No | Preserve auto-pause |
| User cancellation | No | No | Respect cancellation |
| Timeout/inactivity/process loss | Existing recovery semantics | No additional docs chain by default | Keep process recovery separate and bounded |
| Unknown/unclassified failure | Agent may investigate while alive | No | Surface evidence; do not guess eligibility |

Only a terminal `failed` issue run with a validated structured final failure and
an enforceable read-only adapter envelope is eligible. A failed tool call inside
an otherwise successful run is evidence for the in-run loop, not a terminal-
diagnosis trigger. Transcript and stderr evidence may enrich a decision but
cannot make a run eligible by themselves.

## What Will Be Changed?

### 1. Add a runtime-owned recovery discipline

Add a compact cross-scene `RUDDER_AGENT_RECOVERY_INSTRUCTION`, or an equivalent
separately measured section in the operating contract, with this behavior:

1. preserve the exact error and identify the failed action;
2. do not repeat the same action without new evidence;
3. inspect the most specific trusted documentation available;
4. compare the documented contract with the installed version and current
   configuration;
5. form one explicit hypothesis;
6. apply the smallest correction permitted by the original task's mutation
   authority and current policy; "reversible" alone does not grant permission;
7. check prior side effects and rerun the exact failed action only when it is
   idempotent; otherwise use a read-only health check or request confirmation;
8. verify from real tool/run output rather than the agent's prose; and
9. if still blocked, report the error, sources consulted, attempted correction,
   and the next required operator action.

The instruction must be loaded for heartbeat, issue, review, chat, and
automation scenes. It is not heartbeat behavior and must not be gated by
`RUDDER_AGENT_HEARTBEAT_INSTRUCTION`.

The detailed command and source-selection procedure belongs in the bundled
`rudder` skill/references so it can evolve without inflating every run prompt.

Dependency installation, external write APIs, deployments, credential changes,
and task-local configuration changes are mutations. They remain disallowed in a
read-only/proposal/review/diagnostic run and are not made permissible merely
because documentation recommends them.

### 2. Add a trusted documentation resolver

Add a first-party `agent-v1` capability, tentatively
`rudder_docs_resolve`, with a CLI fallback such as:

```text
rudder docs resolve --query <text> [--error <text>] [--scope auto|project|runtime|rudder] --json
```

Inputs:

- query or failure signature;
- optional scope and installed package/runtime hints;
- bounded result count.

Runtime-owned identity supplies organization, agent, run, project, and
workspace context. Model-supplied auth or cross-organization identifiers are
rejected like other first-party tools.

Output candidates should include:

```ts
type DocumentationCandidate = {
  candidateId: string;
  sourceType: "task_attachment" | "workspace" | "project_resource" |
    "organization_resource" | "adapter_doc" | "bundled_skill" |
    "official_web";
  title: string;
  locator: string;
  relevance: "exact" | "high" | "candidate";
  trust: "operator_curated" | "repository_local" | "rudder_managed" |
    "upstream_allowlisted" | "external_untrusted";
  instructionAuthority: "operating_contract" | "reference" | "data_only";
  version?: string | null;
  registeredAt?: string | null;
  excerpt?: string | null; // Local/registered sources only in V1.
  openWith: "filesystem" | "rudder_library" | "browser" | "cli_help";
};
```

The response wraps candidates with a stable `resolverResultId`; each
`candidateId` is unique within that run-scoped result.

The resolver selects and ranks references; it does not execute arbitrary web
content as instructions. Existing Library path safety and Browser authorization
remain in force.

For workspace sources, V1 only considers the realized run workspace and
explicitly registered doc roots. Every path is checked by filesystem realpath
containment after symlink resolution. Protected paths and secret-bearing files,
including `.env`, credentials, auth stores, `.git`, runtime state, and paths
outside the workspace/doc roots, are excluded. Per-file size, candidate count,
total excerpt bytes, and redaction are bounded. A matching filename never
weakens these rules.

### 3. Add an explicit recovery evidence tool

Resolver calls can prove that candidates were returned, but Rudder cannot
reliably infer the agent's hypothesis, correction, or verification from natural
language transcript text. Add a first-party typed capability, tentatively
`rudder_recovery_record`, for the agent to record recovery stages:

```ts
type RecoveryRecordInput = {
  stage: "diagnosis" | "source_selected" | "correction_applied" |
    "correction_suggested" | "verification" | "verification_plan" |
    "blocked";
  summary: string;
  sourceRefs?: Array<{
    resolverResultId: string;
    candidateId: string;
  }>;
  evidenceRefs?: Array<{
    kind: "run_event" | "transcript_entry" | "tool_call" |
      "resolver_result";
    id: string;
  }>;
  idempotencyKey: string;
};
```

Organization, agent, run, scene, root recovery lineage, and effective capability
envelope are runtime-derived and cannot be supplied by the model. The server
enforces stage transitions, bounded fields, current-run ownership for evidence
references, redaction, and per-stage idempotency.

Every resolver response receives a stable `resolverResultId`, and every
candidate receives a stable `candidateId` scoped to that result/run. The server
resolves tagged evidence references against real organization- and run-scoped
records; cross-run or cross-organization references are rejected.

The record is an actor-declared recovery note, not proof that an action really
happened. `correction` and `verification` must reference the actual current-run
tool/transcript/run evidence when that transport exposes stable references.
Acceptance checks both the typed record and the underlying tool output; prose
or a record call alone never counts as successful verification.

When an adapter cannot expose a stable tool/action reference, the record is
stored with `evidenceStatus=declared_unverified`. It remains useful diagnostic
context but cannot satisfy verified-recovery acceptance or the success metric.

Control-plane-owned events remain appropriate for decisions the model does not
make:

- `recovery.failure_classified`
- `recovery.run_enqueued`
- `recovery.run_suppressed`
- `recovery.needs_operator_action`

Each record must be bounded and redacted. It should retain source locators and
safe local excerpts, not secrets, full arbitrary web pages, or duplicated
transcripts.

`rudder runs errors` and Run Detail should show:

- root failed run and linked recovery run;
- failure class and eligibility decision;
- documents consulted;
- correction attempted;
- verification command/action and result; and
- why same-run recovery or terminal diagnosis stopped.

### 4. Admit one durable issue diagnostic lineage

V1 terminal diagnosis is limited to `scene=issue` with an active issue
execution owner and an adapter that can enforce a read-only diagnostic
capability envelope. It must use the same durable terminal-effects machinery
that already owns post-run control actions rather than enqueueing
opportunistically after finalization.

When the terminal compare-and-set owner finalizes a run:

1. require terminal status `failed` and an issue-backed scene;
2. classify from the control-plane terminal reason plus validated adapter
   `failurePhase`, `failureClassHint`, `recoverabilityHint`, and
   `failedOperationRef` fields;
3. use failed tool transcript entries only as supporting evidence, never as the
   sole eligibility trigger, and never infer eligibility from stderr alone;
4. check cancellation, budget, approval, organization boundary, adapter
   read-only-envelope support, model fallback, existing manual/process-loss
   retry, and diagnostic-chain budget;
5. persist the bounded classification decision and recovery intent inside the
   run's `terminalEffectsIntent` in the same terminal transition;
6. execute a new idempotent `docs_recovery` terminal effect before
   `issue_release`; and
7. enqueue the linked run with `startImmediately: false`, transfer issue
   execution ownership, and do not recompute the decision during crash replay;
8. continue remaining source terminal effects, including `issue_release`; and
9. start/resume the queued diagnostic only after the source
   `completeTerminalControlEffects` operation has completed or dead-lettered
   every effect.

The relevant terminal effect order becomes:

```text
runtime_cost -> task_session -> process_loss_retry OR docs_recovery -> issue_release
```

`process_loss_retry` and `docs_recovery` are mutually exclusive for one
terminal result. A prior manual retry or active retry suppresses automatic docs
diagnosis for that failure instance. A later operator manual retry is still
allowed after the diagnostic is terminal; only concurrent duplicate admission
is blocked.

`docs_recovery` performs durable enqueue and ownership transfer only. It never
starts the child inline. After a successful transfer, source `issue_release`
must observe that `issues.executionRunId` no longer equals the source run and
become a no-op. If `docs_recovery` dead-letters without a child/transfer,
`issue_release` must still run and unlock/promote normal work. These are product
invariants, not incidental implementation details.

Persist explicit lineage roles:

| Run | `recoveryRootRunId` | `recoveryKind` | `recoveryAttempt` | `recoveryRole` |
| --- | --- | --- | --- | --- |
| Original root | self | null | `0` | `root` |
| Initial docs diagnostic | root id | `docs_guided` | `1` | `admission` |
| Process-loss continuation of diagnostic | root id | `docs_guided` | `1` | `continuation` |

Every non-root member also stores direct `retryOfRunId`. Use a root-scoped
transaction/advisory lock plus a partial database uniqueness constraint over
`(org_id, recovery_root_run_id, recovery_kind, recovery_attempt)` where
`recovery_role = 'admission'`. This allows a process-loss continuation to keep
the same attempt without colliding with the unique diagnostic admission. It
cannot create a second `admission`. Passive issue close-out remains a separate
governance path for ordinary issue runs and is not incorrectly suppressed by
this uniqueness rule.

The diagnostic admission/continuation itself is an explicit exception to
passive close-out: its job is to produce a read-only suggestion, not to complete
the issue. Its terminal release must clear the diagnostic execution owner,
suppress `issue_passive_followup`, preserve the issue's business status, and
surface `needs_operator_action` with the suggestion. Without this role-specific
rule, a successful diagnostic would immediately queue another issue run and
silently reintroduce cross-run mutation.

The diagnostic prompt begins with `rudder runs errors <root-run>`, the persisted
classification, and bounded documentation candidates. Its machine-enforced
capability envelope permits only bounded run evidence, docs/resource reads,
typed recovery records, and the normal final suggestion/result. It cannot use
shell/file/API/deploy/config/install/external-write capabilities. Session reuse
is allowed only where the adapter session contract is healthy, the failure does
not indicate corrupt context, and reuse cannot restore a broader tool envelope.

The original run is never rewritten as succeeded, and a completed diagnostic
does not mark the issue work recovered. It leaves an inspectable suggestion for
the operator or a later explicitly authorized run. Only same-run correction or
a later normal run with verified completion evidence counts as a recovered work
loop.

### 5. Keep persistent self-configuration governed in V1

During same-run recovery, the original running agent may change files or task-
local configuration only within the authorization of the original work. The V1
terminal diagnostic cannot change them at all. Neither path may silently mutate
persistent Rudder runtime configuration merely because a task failed.

If the documented remedy requires an agent config change, V1 should emit a
structured recovery suggestion artifact containing:

- exact config path/key;
- redacted old and proposed values;
- source citation and failure evidence;
- expected effect and restart requirement;
- validation command/environment test;
- risk classification; and
- intended rollback target.

Rudder does not currently have a first-class apply/reject workflow for such a
proposal. V1 links the suggestion to the existing Agent Detail configuration
surface, where the operator makes the edit through the normal UI. A successful
operator edit then uses existing config revisions and activity logs as the
audit/rollback path. A dedicated suggestion approval API/UI would be a separate
feature and contract delta.

After an approved config edit, verification must occur in a new runtime/session
when the setting is startup-snapshotted. The verifier rereads the effective
redacted config and runs the adapter environment test/status/diagnostic path;
an edit command returning success is not sufficient evidence that the new
runtime actually uses the setting.

A later self-tuning proposal may define an explicit `auto_apply_safe_tuning`
policy for a small allowlist. It must never include command, cwd, environment,
secrets, permissions, budget, approval, sandbox, Browser enablement, or
cross-organization fields.

## Success Criteria For Change

- In a real local Agent Run, a wrong CLI option or API field causes the agent to
  consult a recorded authoritative source, correct the invocation, and complete
  the task without operator intervention.
- A document-diagnosable terminated issue run admits exactly one linked,
  read-only docs diagnostic admission and never creates a docs-retry loop.
- Runtime boot, budget stop, approval, permission, user-cancel, and unknown
  failures do not auto-recover.
- The operator can inspect the failure class, sources, correction, verification,
  root/recovery linkage, cost, and stop reason without reading raw logs only.
- Documentation lookup never crosses organization/resource/workspace
  permissions, reads protected/secret paths, or treats ordinary attachments or
  arbitrary web content as trusted operating instructions.
- Same-run recovery never expands the original authority. A terminal diagnostic
  is admitted only when the adapter enforces its read-only capability envelope,
  and no persistent agent runtime config is silently changed in V1.
- Recovery works through at least two first-party local runtime adapters before
  parity is claimed; Hermes parity requires its adapter prerequisite to pass.
- The north-star effect is measurable as recovered end-to-end agent-work loops,
  not merely more retries or longer runs.

Initial product metrics:

- eligible failed runs;
- issue diagnostic admissions created;
- same-run docs-guided recovery success rate;
- diagnostic suggestion followed by later successful run rate;
- repeated identical failure rate;
- median added tokens, cost, and latency;
- operator intervention avoided;
- false-positive recovery admission rate; and
- recovery chain prevented by each safety gate.

## Out Of Scope

- Unbounded autonomous retries.
- A general web crawler, server-side official-doc fetcher, organization-wide
  semantic search platform, or vector
  database introduced only for this feature.
- Automatic repair of a runtime that never started. A failed runtime cannot be
  asked to repair itself.
- Terminal auto-recovery for Chat, Automation, Review, or Heartbeat scenes in
  V1. Those scenes keep same-run guidance and their current terminal behavior.
- Automatic cross-run mutation or automatic repetition of the failed operation
  in V1. That requires a separately designed, machine-enforced inherited
  capability envelope.
- Bypassing approvals, budgets, permissions, sandbox policy, workspace safety,
  or organization boundaries.
- Installing dependencies, invoking external writes, deploying, or changing
  credentials/config from a run that was not originally authorized to do so.
- Arbitrary persistent self-editing of prompts, skills, runtime command, env,
  secrets, permissions, or budgets.
- Treating model fallback, process-loss recovery, and docs-guided recovery as
  the same mechanism.
- Claiming the current `hermes_local` compatibility wrapper is production-ready.
- Automatically promoting every recovered error into memory or a skill. That
  remains a governed learning decision based on recurrence and evidence.

## Non-Functional Requirements

### Cost and latency

- One docs-guided diagnostic admission maximum per root issue run.
- Documentation candidates and persisted excerpts are bounded.
- Resolver ranking should prefer eligible operator-marked/local references
  before network locators without elevating data-only attachments.
- Recovery admission must honor remaining run/agent/organization budget.

### Security

- Runtime identity is derived, not model-supplied.
- Library/workspace path validation and Browser safe-URL policy remain active.
- Official web domains are allowlisted by resource/adapter ownership; redirects
  are revalidated.
- Retrieved web text is untrusted data and must not override user, product,
  repository, or runtime instructions.
- Ordinary attachments and unmarked resources are data-only even when highly
  relevant to the error.
- Workspace source discovery is realpath-contained to registered doc roots and
  excludes symlink escapes, `.git`, `.env`, credentials, auth/runtime state,
  oversized files, and secret-shaped content.
- Error/source evidence is redacted before persistence.
- Recovery cannot grant itself a capability that was absent on the original
  run.
- A V1 terminal diagnostic uses an even smaller, adapter-enforced read-only
  capability envelope. Prompt text alone is not an enforcement mechanism; an
  adapter without enforceable tool/filesystem/API restrictions is ineligible.

### Reliability

- The terminal owner persists one classification/intent; recovery admission is
  a replayable terminal effect and atomic with the issue execution lock.
- A restart between failure and enqueue replays the persisted decision and must
  not recompute or duplicate the recovery lineage.
- The diagnostic child is queued with `startImmediately: false` and cannot run
  before every source terminal effect has completed or dead-lettered.
- Existing process-loss, model fallback, Chat Retry, passive issue follow-up,
  and operator manual Retry paths must deduplicate against docs recovery.

### Maintainability

- Failure classes and source types are shared contracts, not adapter-specific
  string matching copied across runtimes.
- Adapters may contribute documentation descriptors and bounded
  `failurePhase`/`failureClassHint`/`recoverabilityHint` metadata, but the
  control plane validates hints and owns eligibility and budgets.
- Detailed operating guidance stays in the bundled skill/references; the
  runtime-owned prompt remains compact and testable.

## User Experience Walkthrough

### Same-run recovery

1. The agent runs a command with an option unsupported by the installed
   version.
2. The tool returns a nonzero result and exact error.
3. The agent does not repeat the command unchanged.
4. It calls `rudder_docs_resolve` with the failure signature.
5. Rudder returns the repository/package docs and version-matched official
   reference with provenance.
6. The agent reads the most specific source, states a hypothesis, changes only
   the option, and reruns the original command.
7. The command succeeds. The run records the source, correction, and successful
   verification, then completes normally.

### Terminated-run diagnosis

1. An issue-backed Agent Run exits after a structured terminal tool/API usage
   failure.
2. The terminal owner persists the failed run, classification, and durable
   `docs_recovery` effect intent.
3. Admission gates confirm no cancellation, budget stop, approval wait, active
   duplicate, or prior docs-recovery attempt.
4. The replayable terminal effect queues one linked read-only diagnostic and
   transfers issue execution ownership, without starting it inline.
5. Source terminal effects converge; only then does the queued diagnostic read
   `rudder runs errors <root-run>`, resolve authoritative docs, and record a
   correction/verification suggestion without repeating the failed mutation.
6. Run Detail shows the failed root and completed diagnostic as separate,
   inspectable runs. The issue remains unrecovered until a later authorized run
   produces normal completion evidence.

### Config change required

1. Documentation shows that a persistent runtime setting is wrong.
2. The same-run agent does not silently patch persistent agent config, and the
   terminal diagnostic cannot patch any config.
3. It creates a redacted, source-backed config change suggestion with restart,
   validation, and rollback instructions.
4. The suggestion links the operator to Agent Detail; the operator edits through
   the existing normal configuration UI.
5. Rudder writes the normal config revision and activity event. A fresh
   runtime/session rereads effective config and runs the environment/status
   check before a new manual retry.

## Implementation

### Product Or Technical Architecture Changes

```text
tool/runtime error
      |
      +--> provider loop still alive
      |       -> recovery instruction
      |       -> docs resolver
      |       -> smallest correction
      |       -> same-check verification
      |
      +--> Agent Run terminates
              -> non-issue scene: preserve current terminal behavior
              -> issue scene + terminal failed
                   -> validated structured classifier
                   -> persist terminal effect intent
                   -> safety + budget + read-only envelope + dedupe gates
                   -> ineligible: preserve failure and operator action
                   -> eligible: replayably queue one diagnostic admission
                                -> wait for source effects to converge
                                -> errors evidence + docs resolver
                                -> correction/verification suggestion
```

Proposed shared types:

```ts
type AgentRunFailureClass =
  | "tool_usage"
  | "api_contract"
  | "dependency_version"
  | "runtime_configuration"
  | "transient_provider"
  | "runtime_boot"
  | "workspace_preflight"
  | "permission"
  | "approval"
  | "budget"
  | "cancelled"
  | "timeout"
  | "process_loss"
  | "model_generation"
  | "unknown";

type DocsRecoveryDecision = {
  eligible: boolean;
  failureClass: AgentRunFailureClass;
  reason: string;
  rootRunId: string;
  attempt: 0 | 1;
  scene: "issue";
  mutationAuthority: "diagnosis_only";
  failedOperationRef?: string | null;
};
```

The classifier should prefer, in order:

1. control-plane terminal reason;
2. workspace/admission failure type;
3. validated adapter `failurePhase`, `failureClassHint`,
   `recoverabilityHint`, and `failedOperationRef`;
4. adapter `errorCode` / bounded `errorMeta` plus normalized failed tool
   transcript entries as supporting evidence; and
5. `unknown`.

Raw stderr heuristics may annotate diagnostics but must not independently make a
run eligible for terminal diagnosis.

### Delivery slices

1. **Hermes-compatible discipline:** add compact cross-scene recovery
   instruction, update the bundled Rudder skill/reference, and add prompt-order
   and scene-matrix tests.
2. **Trusted local docs resolver:** add source descriptors, independent
   relevance/trust/authority fields, `agent-v1` MCP/CLI capability,
   organization/realpath/protected-path enforcement, provenance evidence, and
   tests. Official web sources are locator-only in V1.
3. **Explicit evidence tool and same-run E2E:** add
   `rudder_recovery_record` and prove a real runtime consults docs and corrects a seeded
   invalid command/API call without operator help.
4. **Issue classifier and durable diagnose-once admission:** add adapter result
   hints plus a proved read-only diagnostic capability, shared validated types,
   terminal intent persistence, a replayable enqueue-only `docs_recovery`
   effect, root role fields/partial uniqueness, deferred child start,
   retry/fallback dedupe, budget gates, and run evidence.
5. **Issue Run surfaces:** show classification, documents, corrections, verification,
   linkage, and stop reason in Run Detail and `rudder runs errors`.
6. **Hermes adapter prerequisite:** separately normalize config/context/auth,
   remove unsafe approval assumptions, wire transcript/skill capabilities, and
   black-box test Hermes before adding it to the adapter parity claim.

Each slice should be independently releasable behind an agent/org recovery
policy flag until the false-positive rate is understood.

### Breaking Change

No existing API or storage behavior needs to be removed. The feature is
additive, but issue `diagnose_once` behavior is user-visible and therefore must not
be enabled globally until its gates and E2E evidence pass. Existing manual
Retry, Chat Retry, process-loss recovery, passive follow-up, and model fallback
remain available under explicit dedupe/precedence rules.

### Security

No new third-party dependency is required for the first implementation. The
resolver should compose existing workspace, Library/resource, adapter-doc,
skill, CLI, and Browser surfaces.

If a new HTTP route backs `rudder_docs_resolve`, it must:

- require runtime-derived organization/agent/run identity;
- enforce organization and project resource visibility;
- return bounded redacted results;
- validate official-domain redirects and protocols;
- avoid server-side fetching in V1 and never fetch arbitrary model-supplied
  URLs;
- enforce realpath containment, registered doc roots, protected-path
  exclusions, file/count/byte bounds, and excerpt redaction; and
- activity-log any future dedicated config-suggestion application separately
  from documentation reads; normal operator edits keep their existing config
  revision/activity behavior.

The `rudder_recovery_record` route/tool must derive runtime identity, validate
current-run evidence references and stage order, enforce idempotency, and label
its payload as actor-declared evidence rather than independently verified
execution.

## What Is Your Testing Plan (QA)?

### Goal

Prove that recovery is genuinely documentation-guided, bounded, permission-
safe, visible, and more successful than an unchanged retry.

### Prerequisites

- an isolated local Rudder instance and disposable organization;
- two supported local runtime adapters with real model/tool loops;
- seeded project workspace docs and an attached Project Resource;
- one allowlisted official-doc fixture/server for deterministic tests;
- explicit test budgets and recovery policy; and
- a Hermes environment only for the separate adapter prerequisite matrix.

### Automated scenarios

1. Same-run invalid CLI option resolves local version-matched docs, changes the
   option, reruns the exact command, and succeeds.
2. Same-run API schema mismatch prefers an operator-marked project reference
   over a generic official locator, while an ordinary attachment remains
   `data_only`; both decisions retain provenance.
3. A structured terminated issue tool-usage failure persists a terminal intent,
   queues exactly one read-only diagnostic before issue release, transfers
   ownership, waits for source terminal-effect convergence, and produces an
   evidence-backed suggestion without repeating the mutation.
4. A process-loss continuation retains the same root/kind/attempt with
   `recoveryRole=continuation` and creates no second diagnostic admission.
   Ordinary issue runs retain valid passive close-out, while diagnostic roles
   explicitly suppress it and emit `needs_operator_action` instead.
5. Runtime boot failure remains failed with `repair_runtime` guidance and no
   docs recovery.
6. Budget pause, approval required/denied, permission failure, workspace
   boundary, missing adapter read-only enforcement, and user cancellation each
   suppress terminal diagnosis as defined by the eligibility table.
7. Model fallback success suppresses docs recovery; exhausted fallback admits
   it only when the final structured failure is docs-eligible.
8. Chat, Automation, Review, and Heartbeat terminal failures never enter the
   V1 issue diagnostic enqueuer; Chat continues to expose only its existing Retry
   semantics.
9. Malicious instructions inside an attachment or web page cannot override the
   recovery prompt, gain instruction authority, or cross
   organization/realpath/protected-path boundaries.
10. Unknown stderr-only failures and non-terminal failed tool calls remain
    ineligible.
11. A required persistent config change produces a suggestion artifact but no
    mutation or nonexistent apply/reject workflow.
12. Crash/restart after terminal transition replays the persisted decision and
    enqueues exactly once without reclassifying stderr.
13. Typed recovery records reference real resolver/action evidence; prose or a
    record without real tool output fails acceptance.
14. Cross-run/cross-organization and nonexistent evidence references are
    rejected; adapters without stable action refs store
    `declared_unverified`.
15. A successful `docs_recovery` ownership transfer makes source
    `issue_release` a no-op; a dead-lettered enqueue still lets source
    `issue_release` unlock/promote work.
16. The queued diagnostic cannot start until all source terminal effects have
    completed or dead-lettered.
17. Machine enforcement blocks shell, file writes, external writes, install,
    deploy, and config mutation from the terminal diagnostic.
18. Diagnostic terminal release clears its execution owner without queuing
    passive follow-up or changing issue business status.
19. Run Detail and `rudder runs errors` expose the same bounded classification,
    source, correction, verification, and linkage evidence.

### Required E2E coverage

Feature acceptance requires real user-visible E2E coverage for:

- one same-run recovery through the actual local runtime;
- one terminal diagnose-once issue flow through Agent Run UI, including
  deferred start and read-only suggestion;
- one non-eligible failure with an operator action and no recovery run;
- trust/authority behavior using a marked project reference plus a data-only
  attachment; and
- the one-admission limit plus process-loss continuation under a repeated
  failure.

Lower-level tests should cover classifier tables, adapter-hint validation,
prompt ordering, source relevance/trust/authority, realpath/symlink/protected-
path/org authorization, redaction, record stage/idempotency validation, durable
terminal-effect replay, root uniqueness, session reuse selection,
fallback/manual/process-loss/passive-follow-up dedupe, authority snapshots, and
budget gates, deferred child start, ownership transfer/release, dead-letter
continuation, tagged evidence ownership, and read-only capability enforcement.

### Pass / Fail

Status: proposal only; no implementation verification has been run.

Proposal artifact validation on 2026-07-16:

- `git diff --check`: pass.
- `node scripts/product-logic-check.mjs --json`: pass; the guarded Product
  Logic Registry remains unchanged.
- `pnpm -r typecheck`: pass.
- `pnpm build`: pass, with existing CSS/chunk-size and packaged-dependency
  warnings.
- `pnpm test:run`: the first full run reached one unrelated issue-comment
  activity assertion failure; that exact test passed when rerun alone. A second
  full run passed 3,699 tests but failed 32 suites after embedded PostgreSQL
  initialization errors plus three state-pollution assertions. Treat the full
  suite as environment-unstable for this proposal-only worktree, not as feature
  acceptance.
- `pnpm lint`: blocked by pre-existing import-organization findings in
  `packages/shared/src/index.ts` and `ui/src/pages/Chat.side-panel.tsx`; this
  proposal does not modify or auto-fix those files.

Pass requires:

- all focused unit/integration/E2E scenarios above;
- `pnpm product-logic:check` after the separately authorized registry update;
- `pnpm lint`;
- `pnpm -r typecheck`;
- `pnpm test:run`;
- `pnpm build`; and
- real black-box evidence for every runtime included in the parity claim.

## Proposed Product Logic Contract Delta

Implementation changes agent-visible and user-visible behavior, so these
guarded contracts would need an explicitly authorized update:

- `AGENT.INSTRUCTIONS.001`: add the cross-scene recovery instruction, source
  priority, and prompt/metadata evidence.
- `CONTEXT.RESOURCES.001`: add independent relevance, trust, instruction-
  authority, provenance, and resolver eligibility for bounded attached/project/
  organization/workspace resources.
- `AGENT.CONTROL.TOOLS.001`: add the docs resolver and recovery-record
  capabilities, derived identity, evidence validation, CLI fallback, and safe
  error semantics.
- `AGENT.RUNTIME.ADAPTERS.001`: define adapter-contributed docs descriptors and
  structured failure hints plus enforceable read-only diagnostic capability
  declaration without promising provider parity.
- `AGENT.RUNTIME.PERMISSIONS.001`: define the machine-enforced diagnostic
  envelope, adapter eligibility, forbidden mutation surfaces, and the rule that
  prompt text cannot substitute for enforcement.
- `RUN.EXECUTION.001`: add validated structured terminal failure hints,
  classification, authority snapshot, and persisted docs-guided recovery
  decision after adapter execution.
- `RUN.ADMISSION.001`: add issue-only, replayable enqueue/ownership-transfer
  terminal effect, deferred child start after terminal convergence, root role/
  partial uniqueness, issue-lock interaction, retry/fallback/process-loss/
  passive-follow-up precedence, diagnostic-role passive suppression,
  `needs_operator_action`, and chain budget.
- `RUN.RESULT.001`: persist failure class, sources, hypothesis, correction,
  verification, linkage, and stop reason.
- `RUN.CHAT.AGENT.001`: add same-run docs discipline while explicitly excluding
  V1 terminal docs recovery and preserving model fallback, Chat Retry, and
  runtime-boot behavior.
- `AGENT.IDENTITY.CONFIG.001`: state that V1 recovery cannot silently mutate
  persistent runtime config; recovery can emit a suggestion, while only an
  operator edit uses the existing revision/activity/rollback path.
- `CONTROL.RUN.INTELLIGENCE.001`: expose bounded recovery evidence through run
  intelligence and `rudder runs errors`.

No `doc/product/**` file should be edited until the user approves this concrete
delta or a revised one.

## Documentation Changes If Approved

- update the authorized Product Logic contracts above and `registry.yml`;
- update `server/resources/bundled-skills/rudder/SKILL.md` plus sibling
  references for the detailed recovery procedure and docs resolver;
- update generated/stable CLI reference and its generator/tests together;
- document issue diagnostic policy and Run Detail evidence in public `docs/`;
- add adapter-author guidance for documentation descriptors and structured
  failure hints; and
- document the separate Hermes adapter readiness state without claiming parity
  before black-box proof.

## Proposal Review Record

This proposal was iterated through two read-only agent review rounds before
handoff.

### Round 1: Rudder runtime and recovery review

The reviewer found eight issues. The proposal was revised to:

- limit V1 terminal behavior to issue-backed runs;
- make admission a replayable terminal effect before issue release;
- add root lineage, dedupe, and process-loss/manual/passive-follow-up
  precedence;
- prohibit recovery from expanding the original authority;
- separate source relevance, trust, and instruction authority;
- add a typed recovery-evidence capability;
- require a validated structured terminal failure; and
- correct the Hermes SHA, generic-hook description, web-fetch scope, and config
  suggestion UX.

### Round 2: adversarial Hermes and implementation review

The reviewer found two P1 and four P2 gaps. The proposal was revised to:

- make cross-run V1 behavior machine-enforced read-only diagnosis rather than
  automatic mutation;
- queue diagnostic children with `startImmediately: false` until all source
  terminal effects converge;
- distinguish root, diagnostic admission, and process-loss continuation roles,
  with a partial unique constraint only for admission;
- replace free-form evidence strings with tagged, stable, organization/run-
  validated references and an explicit unverified state;
- add ownership-transfer, dead-letter, deferred-start, read-only-envelope,
  evidence-isolation, and diagnostic passive-follow-up tests; and
- add `AGENT.RUNTIME.PERMISSIONS.001` to the proposed guarded contract delta.

Both reviews assessed the proposal only. They do not claim implementation or
runtime acceptance.

## Open Issues For Discussion

1. Should issue terminal diagnosis default to `suggest` or `diagnose_once`?
   Recommendation: ship same-run guidance first, keep terminal diagnosis behind
   an org/agent flag, collect classifier and false-positive evidence, then
   default eligible local-trusted issue runs with proved read-only enforcement
   to `diagnose_once`; keep other adapters and authenticated/public deployments
   at `suggest` until policy experience is stronger.
2. Should docs recovery reuse the same provider session? Recommendation: reuse
   only when the adapter session contract is healthy and the failure is not
   context corruption; otherwise start a fresh session with bounded evidence.
3. Is runtime configuration self-tuning part of this feature? Recommendation:
   no for V1. First prove document-guided work recovery; design allowlisted,
   revision-backed self-tuning separately.
4. Who owns official-domain allowlists? Recommendation: adapter docs own runtime
   domains, Project/Organization Resources own project domains, and core Rudder
   docs own Rudder domains. V1 returns locators only and does not maintain one
   global catch-all list or server-side fetcher.
5. When should a solved failure become a skill or memory? Recommendation: only
   after recurrence, explicit feedback, or evaluation evidence; a single
   recovery result is evidence, not automatic learning promotion.
6. When may a terminal diagnostic apply a correction automatically?
   Recommendation: not in V1. A later proposal must define a typed inherited
   capability envelope for tools, workspace roots, installs, external writes,
   deploy/config actions, and approval state. If the envelope cannot be derived
   deterministically from admission data, the mutation remains forbidden.
