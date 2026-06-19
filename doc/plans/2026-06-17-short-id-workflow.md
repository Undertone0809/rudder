---
title: Short ID workflow
date: 2026-06-17
kind: proposal
status: implemented
area: api
entities:
  - short_ids
  - agent_cli
  - markdown_mentions
  - messenger_chat
issue:
related_plans:
  - 2026-03-13-TOKEN-OPTIMIZATION-PLAN.md
  - 2026-06-05-agent-renderable-content-library-identity.md
  - 2026-06-14-rudder-operating-skill-reframe.md
supersedes: []
related_code:
  - packages/shared/src/project-mentions.ts
  - cli/src/agent-v1-registry.ts
  - cli/src/commands/client/common.ts
  - server/src/routes/agents.ts
  - server/src/routes/issues.ts
  - server/src/routes/automations.ts
  - server/src/routes/chats.ts
  - server/src/routes/assets.ts
  - ui/src/components/MarkdownBody.tsx
  - ui/src/components/RudderEntityPreview.tsx
  - ui/src/lib/mention-chips.ts
commit_refs: []
updated_at: 2026-06-17
---

# Short ID Workflow Proposal

## Problem

Rudder currently asks both humans and agents to carry long UUIDs through normal
work:

- runtime prompts say `You are agent d573266f-af95-44e6-9303-e903a54662b8`
- issue context still exposes raw issue UUIDs beside human identifiers
- markdown mentions use links such as `agent://<uuid>` and `chat://<uuid>`
- asset and attachment URLs use UUIDs in markdown image syntax
- CLI arguments and JSON output usually expose UUIDs for agents, automations,
  chats, comments, assets, and library records

This is not only cosmetic. Long IDs increase copy/paste friction, make comments
harder to scan, and waste tokens in the exact surfaces that agents repeatedly
read and author.

## User Jobs

1. A board user mentions an agent, issue, chat, document, or attachment without
   copying a long UUID.
2. A running agent reads heartbeat context and can refer to its own agent,
   current issue, wake comment, related chat, automation, and library items with
   compact stable references.
3. A CLI user can pass the same compact reference back into `rudder` commands.
4. A markdown reader sees rich chips/previews, while the stored markdown remains
   plain, durable, and copyable.
5. A debugger can fall back to the full UUID when a short reference is
   ambiguous, stale, or crosses organization boundaries.

## Current Evidence

- Issues already have human identifiers (`ENG-123`) and `/api/issues/:id`
  normalizes identifiers to UUIDs.
- Agents already support non-UUID references through `normalizeAgentReference`;
  projects have a similar reference resolver.
- Shared markdown mention helpers in `packages/shared/src/project-mentions.ts`
  intentionally store stable identity in schemes such as `agent://`,
  `issue://`, `chat://`, `library-doc://`, and `library-entry://`.
- UI rendering already parses those schemes into chips and preview popovers via
  `ui/src/lib/mention-chips.ts`, `MarkdownBody`, and `RudderEntityPreview`.
- The stable agent-facing CLI contract covers `agent`, `issue`, `automation`,
  `chat`, `runs`, `approval`, `skill`, and `library`.

## Recommendation

Add a first-class short reference contract instead of only shortening display
text.

The contract is:

```text
<kind-prefix>_<uuid-prefix>
```

Examples:

- `agt_d573266f`
- `org_23ae707f`
- `aut_8a15bb2c`
- `cht_14ff96a7`
- `cmt_091492ab`
- `ast_14ff96a7`
- `doc_7b3a21c9`
- `lib_f02ad8e1`

Rules:

1. The full UUID remains the durable database primary key and API compatibility
   fallback.
2. Existing issue identifiers remain preferred for issues. `ENG-123` is better
   than `iss_<prefix>`.
3. Short refs are organization-scoped when the object is organization-scoped.
   A resolver must use actor org, route org, or explicit `--org-id`.
4. A short ref resolves by kind + UUID prefix. If zero matches, return 404. If
   multiple matches, return 409 with a longer ref suggestion or ask for the full
   UUID.
5. Stored markdown may use either full IDs or short refs in mention schemes.
   Renderers and extractors must parse both. For P0 action-bearing links such as
   wake mentions, services should canonicalize accepted short refs back to full
   IDs before durable persistence unless that path explicitly stores an
   adaptive collision-proof alias.
6. API responses should expose `shortRef` next to `id` on agent-visible and
   user-visible payloads. They should not replace `id`.
7. CLI human output should prefer `shortRef`; `--json` should return both `id`
   and `shortRef`.

## Why This Shape

### Option A: display-only truncation

This is easy, but it does not let agents author compact references. It also
creates false confidence because a copied display string may not be accepted by
the API or CLI.

### Option B: persisted per-table slugs

This is the cleanest long-term product model for some objects, but it requires
schema migrations, backfill, uniqueness rules, rename policies, import/export
behavior, and collision UX before the first user benefit.

### Option C: typed UUID-prefix refs with server resolution

This gives the immediate journey benefit without a migration. It also preserves
the route to persisted aliases later because all call sites depend on a resolver
contract, not on direct UUID slicing.

Recommendation: implement Option C first.

### Durability boundary

Typed UUID-prefix refs are not durable enough to become the only identity stored
inside long-lived markdown. A future object with the same prefix in the same
organization can make an old compact link ambiguous.

P0 therefore treats short refs as an authoring, display, CLI, and runtime
readback convenience:

- users and agents may type or pass `agt_<prefix>` / `cmt_<prefix>`
- command and API entry points resolve the short ref at the boundary
- durable action links that change behavior, such as `agent://...?intent=wake`,
  are canonicalized to full IDs on write when practical
- read surfaces may present compact refs next to labels and full IDs
- future P1 persisted aliases can replace this boundary once there is a
  collision-proof storage model

This keeps copy/paste and CLI interaction short without making old comments
depend on a prefix that might collide later.

## Object Coverage

P0:

- agent: `agt_<prefix>`
- issue: existing identifier first, fallback `iss_<prefix>`
- issue comment: `cmt_<prefix>`

P0.5:

- chat conversation: `cht_<prefix>`
- automation: `aut_<prefix>`
- organization: `org_<prefix>` for CLI/context output, not cross-org lookup by
  default
- asset: `ast_<prefix>`
- library document: `doc_<prefix>`
- library entry: `lib_<prefix>`

P1:

- automation run: `run_<prefix>` when run debugging flows need it
- approval: `apv_<prefix>`
- project: preserve project shortname/urlKey when available, fallback
  `prj_<prefix>`
- goal: `gol_<prefix>`

## Markdown Contract

Mention schemes should continue to carry identity:

```markdown
[Wesley](agent://agt_d573266f?intent=wake)
[Launch thread](chat://cht_14ff96a7)
[Comment](issue://ENG-123?c=cmt_091492ab)
![image.png](/api/assets/ast_14ff96a7/content)
```

Rendering rules:

- chips display labels, not raw refs
- hover previews resolve short refs through the same API paths
- copy-as-markdown preserves the compact authoring form when that is the source
- extraction helpers must return the parsed ref, not assume UUID shape

## CLI Contract

Add a small reference surface and then thread it into existing commands:

```sh
rudder agent get agt_d573266f
rudder issue context ENG-123 --wake-comment-id cmt_091492ab
rudder ref resolve agt_d573266f --org-id org_23ae707f
rudder chat get cht_14ff96a7
rudder automation get aut_8a15bb2c
```

The resolver command is important for agents because it gives a discoverable
escape hatch when a compact ref is ambiguous or when a runtime receives a
reference outside the command it wants to run.

P0 command behavior must not depend on agents manually calling `rudder ref
resolve` first. The agent-facing commands in the P0 actor loop must directly
accept the compact reference:

- `rudder agent get agt_<prefix>`
- `rudder issue context <identifier-or-id> --wake-comment-id cmt_<prefix>`

`rudder ref resolve` is the debugging and discovery escape hatch, not the only
way short refs work.

For JSON output, selected payloads should expose both:

```json
{
  "id": "d573266f-af95-44e6-9303-e903a54662b8",
  "shortRef": "agt_d573266f"
}
```

Human output should list `shortRef` before full `id` where the full UUID is not
the user's next likely copy target.

## API Shape

Add shared helpers:

- `shortRefFor(kind, id)`
- `parseShortRef(value)`
- `isShortRef(value)`
- `matchesShortRef(kind, value)`

Add server resolver helpers:

- resolve by exact UUID
- resolve by existing domain reference where available
- resolve by typed short ref within the actor organization
- return explicit ambiguity errors

Do not add a migration in P0.

## First Implementation Slice

The first slice should prove one complete user/agent loop, not every object
type:

1. Add shared short-ref helpers and tests for `agent` and `issue_comment`.
2. Teach agent mention builders/parsers to accept `agent://agt_<prefix>` without
   assuming UUID shape.
3. Teach issue comment lookup paths to accept `cmt_<prefix>` where a
   `wakeCommentId` or comment route currently expects a UUID.
4. Teach issue-comment wake extraction to resolve `agent://agt_<prefix>?intent=wake`
   within the issue organization. This is the core P0 behavior; today the
   extraction path filters wake mentions through `isUuidLike`, so a short ref
   would be dropped before wakeup.
5. Canonicalize short agent wake hrefs to full agent IDs before persisting
   issue comment bodies in P0, or explicitly prove that the storage path can
   preserve a collision-proof alias. The default P0 implementation should
   canonicalize because it requires no migration.
6. Add direct command support for:
   - `rudder agent get agt_<prefix>`
   - `rudder issue context <issue> --wake-comment-id cmt_<prefix>`
7. Add `rudder ref resolve` only if it can reuse the same resolver without
   broadening the slice.
8. Update the bundled `rudder` skill and CLI reference so agents discover the
   compact ref contract and the full UUID fallback.
9. Add E2E or actor-run-chain coverage for the P0 loop:
   - board or agent creates an issue comment containing
     `[Wesley](agent://agt_<prefix>?intent=wake)`
   - Rudder queues the wake for the correct agent
   - the run or CLI can read context with `--wake-comment-id cmt_<prefix>`
   - UI markdown still renders the agent chip/preview instead of raw URL text

## Non-goals For P0

- No persisted slug columns or migrations.
- No global cross-organization short ID lookup.
- No replacement of UUIDs in JSON contracts.
- No promise that a bare eight-character prefix is globally unique.
- No silent fallback to a wrong object on ambiguity.
- No claim that UUID-prefix refs are durable stored identities. In P0, compact
  input is resolved at write/read boundaries and action links can be
  canonicalized to full IDs for storage.
- No short asset content URLs in P0. Asset URLs are a file-serving path with
  caching and auth implications, not just a markdown rendering token.
- No chat, automation, library, approval, run, project, or goal short-ref route
  support until the P0 wake-comment loop is proven.

## Acceptance Criteria

- A user-visible markdown link can store `agent://agt_<prefix>` and render as
  the same rich agent chip/preview as `agent://<uuid>` before submit, or can be
  accepted at submit and canonicalized to `agent://<uuid>` while preserving the
  short visible label/chip behavior.
- A wake mention using a short agent ref queues the same `comment.mention` wake
  for the same agent that the full UUID mention queues.
- Persisted wake-comment markdown is durable: either the link href is
  canonicalized to the full agent ID or the stored alias is collision-proof.
- `rudder issue context <issue> --wake-comment-id cmt_<prefix>` returns the
  same wake comment that the full UUID comment id returns.
- `rudder agent get agt_<prefix>` returns the same agent as the full UUID.
- CLI human output makes short refs obvious, while `--json` preserves full IDs.
- Ambiguous short refs fail with 409 and a clear message.
- E2E or actor-run-chain evidence proves one complete loop from short-ref
  authoring to wake queue/readback and rendered UI.

## Resolver Contract

Server-side short-ref resolution must be centralized enough that UI, CLI, and
runtime paths do not each invent different ambiguity behavior.

For P0:

- org source is route org, issue org, explicit `--org-id`, or authenticated
  agent org
- exact UUID always wins when the input is UUID-like
- domain identifiers still win for issues
- typed short refs only match their declared kind
- 404 means no object matched in scope
- 409 means multiple objects matched the prefix in scope; the error must ask
  for the full UUID or a longer reference
- board and agent actors use the same resolver but still pass through existing
  org access checks

The resolver should be a service/helper used by existing route param
normalizers. Do not add a second public identity system in P0.

## P0 Resolver Matrix

| kind | prefix | org source | accepted surfaces | ambiguity behavior | body fields |
| --- | --- | --- | --- | --- | --- |
| agent | `agt_` | explicit `orgId`, authenticated agent org, or issue org for comment parsing | `agent://...`, `rudder agent get`, agent route param | 409 with full ID / longer-ref guidance | only wake mention hrefs in P0; other agent body fields stay UUID-only |
| issue | existing identifier, fallback `iss_` later | existing issue resolver | existing issue routes and CLI issue args | existing identifier behavior; `iss_` deferred | unchanged |
| issue comment | `cmt_` | containing issue org and issue id | `--wake-comment-id`, `/issues/:id/comments/:commentId` if needed for the loop | 404 within issue when no match; 409 if same issue has prefix collision | unchanged |

Body validators for `preferredAgentId`, `routedAgentId`, `assigneeAgentId`,
`projectId`, `parentIssueId`, and similar nested fields remain UUID-only in P0.
Short refs are resolved before validation only for explicitly selected P0
fields. This prevents accidental broad API contract changes.

## First Review Round

Ptolemy reviewed v0 with a `conditional accept` stage verdict. Resolved changes
in v1:

- narrowed P0 from broad object coverage to one agent/comment/CLI/UI loop
- moved chat, automation, asset, library, organization, run, approval, project,
  and goal support out of P0
- made the current `isUuidLike` wake-mention filter a named P0 blocker
- clarified that `rudder ref resolve` is an escape hatch, not a prerequisite
  for normal commands
- added a resolver contract with org source, 404/409 behavior, UUID fallback,
  and actor access boundaries

Planck and Banach reviewed v0 with `conditional accept` stage verdicts.
Resolved changes in v2:

- documented that typed UUID-prefix refs are not durable stored identities in
  P0
- made canonicalization of action-bearing short links the default P0 storage
  rule
- added a P0 resolver matrix by kind, org source, accepted surface, ambiguity
  behavior, and body-field boundary
- explicitly deferred nested body-field support such as `assigneeAgentId` and
  `preferredAgentId`
- narrowed the first implementation slice to `agent` + `issue comment` and
  moved chat/assets/automation/library out of the first pass

## Review Questions

1. Is typed UUID-prefix resolution enough for P0, or does the user journey need
   persisted aliases immediately?
2. Which object type should be cut from P0 if the implementation gets too
   broad?
3. Does allowing short refs inside existing schemes create parser or security
   risks that require a separate `rudder://` scheme first?
4. Is the CLI resolver command necessary in P0, or can existing commands absorb
   short refs without a new top-level command?

## Implementation Notes

P0 shipped only the `agent` and `issue_comment` loop:

- `agt_<uuid-prefix>` is exposed on agent payloads and accepted by agent route
  resolution.
- `cmt_<uuid-prefix>` is exposed on issue-comment payloads and accepted by
  heartbeat context, issue comment `get`, and issue comment pagination anchors.
- short agent wake links in issue comments are canonicalized to full UUID
  `agent://...` hrefs before persistence; unresolved or ambiguous short refs
  fail instead of becoming durable action links.
- markdown rendering accepts short agent refs as Rudder mention chips.
- CLI human output lists `shortRef` before full `id` when a payload provides it.
- bundled `rudder` skill docs and CLI reference describe the P0 short-ref
  contract and full-UUID fallback.

Verification completed:

- `pnpm lint`
- `pnpm --filter @rudderhq/shared typecheck`
- `pnpm --filter @rudderhq/cli typecheck`
- `pnpm --filter @rudderhq/server typecheck`
- `pnpm test:run packages/shared/src/short-refs.test.ts packages/shared/src/project-mentions.test.ts ui/src/components/MarkdownBody.test.tsx server/src/__tests__/bundled-rudder-skill-docs.test.ts cli/src/__tests__/capability-parity.test.ts`

Verification blocked by local embedded PostgreSQL bootstrap before test bodies:

- `pnpm test:run server/src/__tests__/issues-service.test.ts -t "short agent wake|render-only"`
- `pnpm test:run cli/src/__tests__/agent-cli-e2e.test.ts -t "CLI-only heartbeat path"`
- `pnpm test:e2e tests/e2e/issue-comment-agent-wake.spec.ts`

The shared failure was `Postgres init script exited with code 1` after
`running bootstrap script ...`, so these suites did not exercise the new
business assertions in this local run.
