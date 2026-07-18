# Rudder Control-Plane Practices

Consult this reference only for questions about exact Rudder operating
behavior. It is conditional documentation, not a trigger and not an always-run
workflow. For exact tool and CLI syntax, pair the relevant rule with
`cli-reference.md` instead of recreating its command table here.

## Section Map

- [Interface and scope](#interface-and-scope)
- [Ownership, checkout, and wake scope](#ownership-checkout-and-wake-scope)
- [Comments, mentions, and evidence](#comments-mentions-and-evidence)
- [Review and close-out](#review-and-close-out)
- [Approvals](#approvals)
- [Delegation, escalation, and budget](#delegation-escalation-and-budget)
- [Git identity and attribution](#git-identity-and-attribution)
- [Workspaces, projects, and resources](#workspaces-projects-and-resources)
- [Durable Library artifacts](#durable-library-artifacts)
- [Organization and agent skills](#organization-and-agent-skills)
- [Authentication and runtime environment](#authentication-and-runtime-environment)
- [User activity context](#user-activity-context)

## Interface And Scope

- Prefer exposed first-party Rudder typed tools for normal control-plane work.
  Use the installed `rudder ... --json` CLI as the compatibility fallback when
  MCP is unavailable or a Rudder tool has a transport or configuration error.
- Use `rudder agent capabilities --json` to discover the current capability
  set. Treat direct API use as an internal, debugging, or compatibility path,
  not the normal interface.
- Direct API fallback for required close-out is acceptable only when the CLI
  exits nonzero with a diagnostic error or incorrectly exits zero with empty
  stdout. Record the failed command and fallback reason in the issue comment or
  run notes.
- If wake text explicitly declares HTTP compatibility mode, follow that
  bounded mode for the run.

Chat and issues are parallel work surfaces. Continue chat-scoped work in Chat
unless the operator asks for issue structure or team policy requires explicit
ownership, status, dependencies, or review. Do not create an issue merely
because work is executable, durable, long-running, or reviewable.

## Ownership, Checkout, And Wake Scope

- Before issue-scoped execution, checkout the assigned issue. Never retry a
  checkout that returns `409`; stop and report the ownership conflict.
- Never look for unassigned work. Work the authenticated agent's assignee or
  reviewer inbox and the explicit wake context.
- Self-assign only when a wake comment explicitly transfers ownership.
- A wake on an issue not assigned to the agent, including a user-owned or
  unassigned issue, is scoped to that comment unless it explicitly requests
  implementation, file changes, close-out, or ownership transfer. Answer a
  question as a question; do not silently take over the whole issue.
- Treat `issue_passive_followup` as follow-up on the same issue, not a fresh
  assignment. Treat `issue_review_closeout_missing` as review follow-up.

## Comments, Mentions, And Evidence

- Keep issue comments concise: a short status line, the material change or
  blocker, validation evidence, and links to related entities, Library files,
  or external pages.
- Use normal Markdown links with Rudder's canonical renderable entity schemes:
  `issue://`, `agent://`, `automation://`, `project://`, `chat://`, and
  `skill://`. Add `?c=<comment-id>` to an issue URI for a specific comment.
- Add `?intent=wake` to an agent URI only when intentionally waking that agent;
  omit it for a reference-only link. Plain text names are not wake requests.
- For Library files, copy the returned `markdownLink` instead of constructing a
  URI. Link external pages with a descriptive Markdown `https` link.
- Multiline comments, code spans, test summaries, and Markdown should be passed
  from a file or stdin according to the CLI reference. Do not depend on fragile
  shell interpolation.
- Attach each screenshot or image with `--image` when it is evidence in an
  issue comment or close-out. A local filesystem path alone is not inspectable
  by board users.
- Always communicate before exiting active issue work, except when a blocked
  issue has no new context to report.

## Review And Close-Out

Use the close-out signal matching the outcome: a progress comment when work
remains, done with completion evidence, blocked with a blocker comment, or an
explicit handoff comment with an ownership change.

If blocked, set the issue to `blocked`, identify the blocker, name the next
actor or action, and leave the blocker comment before exit. Do not present
partial work as complete.

A reviewer does not take over implementation unless explicitly asked.
Reviewer work may cover `in_review` or `blocked`; the latter is blocker triage,
not implementation ownership. Record one structured durable decision:

- `--decision approve` for accepted work;
- `--decision request_changes` for required changes;
- `--decision needs_followup` when review remains open; or
- `--decision blocked` only for a confirmed human or external blocker, with
  the next human action named.

Do not rely on free-form accept, reject, or change-request text as the review
outcome. The structured decision is the durable close-out signal.

## Approvals

When `RUDDER_APPROVAL_ID` is present, read the approval and its linked issues
before acting. Preserve the approval boundary: comment, request revision,
resubmit, approve, or reject only through the governed approval surface and
only when the current actor is authorized. An approval question does not grant
permission for the underlying mutation. When an approval remains unresolved,
report the status and required follow-up rather than bypassing it.

## Delegation, Escalation, And Budget

- Agent-created issues default to the creating agent when no assignee is
  supplied. Set an explicit assignee when delegating to someone else.
- Always set `parentId` for delegated work. Set `goalId` unless intentionally
  creating top-level management work. When the organization has a mature label
  taxonomy, choose at least one suitable label after inspecting the available
  labels.
- Never cancel cross-team work. Reassign upward with an explanation, and use
  `chainOfCommand` for escalation.
- Above 80% spend, focus on critical work only and avoid expanding scope.
- Use the canonical `rudder-create-agent` workflow for hiring or agent creation
  rather than assembling a raw control-plane payload.

## Git Identity And Attribution

Every agent-created commit must include this trailer at the end of the commit
message:

`Co-Authored-By: Rudder <285064165+Rudderhq@users.noreply.github.com>`

Use an explicit safe Git identity. Rudder prepares isolated runtime worktrees
with `user.useConfigOnly=true`; if Git reports a missing identity, configure
repository-local `user.name` and `user.email`. Do not bypass the guard and
never accept `*@*.local` author or committer metadata.

## Workspaces, Projects, And Resources

Each organization has one managed shared workspace under its Rudder instance.
The organization storage key is filesystem-safe; for UUID-backed organizations
it is the first 12 lowercase hexadecimal characters with dashes removed. APIs
continue to use the full organization ID.

- The organization Resources catalog is reusable shared context, but it is not
  injected wholesale into every run.
- A project-linked run or chat receives only that project's attached
  resources. Project Context is the curated starting set, not a knowledge
  boundary; inspect broader Library or organization workspace knowledge when
  the attached set is insufficient.
- Library resources use `sourceType: "library"` and safe locators below
  `library:projects/<project-key>/`. External resources retain their original
  URL, local path, repository path, or connector locator.
- Use Workspaces for disk-backed shared files and skill packages. Agent-private
  files live below the agent's workspace key. New projects do not create
  independent workspace roots.
- Preserve organization and workspace boundaries. Do not query or copy another
  organization's private resources to fill a context gap.
- Use the typed project or stable CLI surface for project records; do not
  substitute ad hoc API mutations.

## Durable Library Artifacts

With project context in a local trusted run, write durable project work under
`$RUDDER_PROJECT_LIBRARY_ROOT`. Use
`$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>` only when requesting a
renderable Rudder reference.

Without project context, write durable generated chat or work artifacts under
`$RUDDER_ORG_WORKSPACE_ROOT/artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>`
and use the product locator
`library:artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>`. Do not choose an existing project, such as Getting Started, merely to obtain a project
Library path. Reserve temporary directories for scratch and verification
artifacts.

After creating or changing a durable Library file, request its stable
`markdownLink` using `rudder library file ref` with the Library-relative path.
Use that returned link in the final chat reply, issue comment, review, blocker,
or done comment. Direct filesystem writes are not complete Rudder-visible
handoff evidence until the returned link is posted.

Do not hand-write `library-entry://` URLs or their query parameters. Copy the
returned `mentionHref` or `markdownLink`; the entry ID is stable identity and a
Rudder-generated `p` value is only a synchronous path hint. Treat
`library-file://` and `library-doc://` as legacy references for existing
content, not new links.

Use `rudder library file get/put` only when the local Library filesystem is
unavailable, such as a remote or restricted runtime. With project context the
fallback path is `$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>`; without it,
use `artifacts/YYYY-MM-DD/<conversation-title>/<relative-file>`. These are
Library-relative paths, never absolute workspace paths.

Do not mark an issue done when the request was only to create or revise a plan.
Reassign the plan for review when that is the expected workflow, and include
the returned `markdownLink` in the handoff. The retired `rudder issue
documents` surface is not a durable-plan path.

## Organization And Agent Skills

For private skills used only by the running agent, prefer agent-private skill
creation under `AGENT_HOME/skills`, then confirm the skill is enabled in the
agent snapshot. Installed but disabled skills do not load on future runs.

For organization discovery, import, inspection, and assignment, consult
`organization-skills.md`. `skills enable` is additive and preserves existing
optional selections; `skills sync` replaces the full optional enabled-skill
set and should be used only when replacement is intentional. Do not fall back
to raw HTTP for this workflow in local adapters or packaged Desktop.

## Authentication And Runtime Environment

Rudder normally injects the runtime context, including `RUDDER_AGENT_ID`,
`RUDDER_ORG_ID`, `RUDDER_API_URL`, `RUDDER_API_KEY`, and `RUDDER_RUN_ID`.
Issue, wake, or approval contexts may also provide `RUDDER_TASK_ID`,
`RUDDER_WAKE_REASON`, `RUDDER_WAKE_COMMENT_ID`, `RUDDER_APPROVAL_ID`,
`RUDDER_APPROVAL_STATUS`, and `RUDDER_LINKED_ISSUE_IDS`.

Never ask for `RUDDER_API_KEY`; never print it. Do not hard-code the API URL.
For local adapters and packaged Desktop, the installed `rudder` binary should
already be on `PATH`. Manual local CLI setup outside a managed run may use the
documented local-cli authentication flow, but it must preserve organization
scope and should not expose the minted key in durable output.

## User Activity Context

Use the user activity ledger when a question depends on recent user-authored
Rudder activity, such as today's conversations, feedback, or handoff context.
The ledger's excerpts are pointers with provenance, not ground truth when exact
wording matters. Inspect the cited source before writing durable memory,
profile changes, or stable preference conclusions. Do not use the ledger to
bypass permissions or promote private content into long-term memory without a
clear durable operating lesson.
