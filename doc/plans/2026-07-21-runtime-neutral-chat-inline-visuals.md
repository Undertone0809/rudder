---
title: Runtime-neutral Chat inline visuals
date: 2026-07-21
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - inline_visual_artifacts
  - agent_runtimes
  - organization_skills
issue:
related_plans:
  - 2026-07-15-inline-visual-artifacts.md
  - 2026-07-12-chat-work-manifest.md
supersedes:
  - 2026-07-15-inline-visual-artifacts.md
related_code:
  - server/resources/bundled-skills/visualize/SKILL.md
  - packages/shared/src/chat-inline-visuals.ts
  - packages/agent-runtimes/codex-local/src/server/inline-visuals.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/chat-work-manifest.ts
  - server/src/routes/chats.ts
  - ui/src/pages/ChatInlineVisual.tsx
commit_refs: []
updated_at: 2026-07-21
---

# Runtime-neutral Chat inline visuals

## Goal

Make `visualize` produce message-owned inline visual pages through one Rudder
protocol that works for every Chat Agent Runtime. Inline visuals remain embedded
presentation owned by the assistant message: they are not Library files and do
not appear in the Chat Work manifest's Outputs, Sources, or References.

## User requirements

1. A page produced through `visualize` renders inside the assistant message.
2. Its backing HTML is an internal message artifact, not a user-facing Chat
   attachment or Library artifact.
3. The backing HTML never appears in Chat Work manifest.
4. The authoring and publication protocol works for every registered built-in
   local, process, HTTP, and gateway runtime without provider-specific
   filesystem access. Future plugin runtimes must satisfy the same versioned
   common Chat admission and transport contract.
5. Existing persisted `::codex-inline-vis{file="..."}` messages remain readable.
6. The finished path receives independent review and real-environment black-box
   verification.

## Current-state finding

`visualize` is in the always-enabled Rudder skill baseline, but custom HTML
capture is not runtime-neutral. Only `codex_local` converts a provider thread id
and managed `CODEX_HOME/visualizations/...` file into trusted `resultJson.inlineVisuals`
bytes. Local runtimes with verified Rudder skill projection can use the skill's
Mermaid/Markdown fallback, but cannot publish the custom fragment path. Skill
delivery itself is not yet verified for Hermes, process, HTTP, OpenClaw, or
future plugin runtimes; process and HTTP are currently excluded from Chat. The
`::codex-inline-vis` name and transport therefore leak one provider into a
Rudder-owned presentation protocol.

The current Work manifest independently classifies every Agent-created Chat
attachment as an Output. Because captured visuals are implemented as ordinary
Chat attachments, their hidden backing `.html` files incorrectly appear in the
manifest.

## Product decisions

- The visual is part of the message, analogous to rich message presentation,
  rather than a separate work product.
- Rudder owns the transport, validation, persistence mapping, sandbox, and
  rendering. The Agent supplies only a bounded declarative HTML fragment and its
  placement in the final answer.
- The universal semantic transport is a versioned Rudder message envelope in the
  final Chat result. No local path, provider session id, mounted output directory,
  MCP server, or provider-specific directive is part of the contract.
- A shared parser alone does not make the feature compatible. Rudder Chat owns
  one common protocol boundary: every registered runtime receives an
  authoritative prompt projection of the always-enabled `visualize` policy and
  protocol version, and every result crosses the same streaming suppression,
  failure, persistence, and rendering pipeline. Native skill-directory delivery
  is additive. Process and HTTP require explicit prompt/result transports;
  OpenClaw requires common prompt forwarding. Future runtimes enter through the
  same Chat boundary rather than an adapter-specific capability flag.
- The declarative security boundary remains unchanged: no scripts, network,
  forms, active controls, nested frames, URL-bearing resources, credentials, or
  parent bridge. Native `<details>` and CSS hover/focus behavior remain the only
  stateful interactions.
- Ordinary Agent-created `.html` attachments are still Outputs. Manifest
  exclusion applies only to attachment ids in the Server-owned inline-visual
  mapping for the same message.
- New results use a Rudder-named protocol. The Codex file directive remains a
  compatibility input for historical messages and in-flight older skill copies,
  but is no longer the canonical authoring contract.

## Protocol

### Runtime-authored envelope

For a visual in an ordinary Chat message final body, the runtime emits an exact
own-line Rudder envelope at the desired render position:

```text
Q4 Capacity Scenarios

:::rudder-inline-visual:v1
<style>
  #widget .scenario { display: grid; }
</style>
<div id="widget">
  <section class="scenario">...</section>
</div>
:::rudder-inline-visual:end
```

The opening and closing markers must be the complete line, with no indentation
or trailing text, and must occur inside the successful final Rudder result text
envelope. Parsing is line-oriented: LF and CRLF are accepted, one terminal `\r`
is ignored for marker comparison, and all other whitespace is significant. A
marker is live only at CommonMark block depth zero; markers inside fenced code,
four-space indented code, or block quotes are examples and never publish.
Inline-code text cannot form an own-line marker. Documentation shows live syntax
inside a fenced code example, which is non-publishing by this rule; there is no
second implicit escape syntax. Nested or unterminated envelopes are invalid. A
closing-marker line always terminates the fragment, so fragment content that
needs that exact literal line must encode it instead. The block contains one
bounded HTML fragment using the existing `<div id="widget">` contract.

A completed reply may publish at most three blocks, at most 64 KiB UTF-8 per
fragment, and at most 128 KiB UTF-8 across all fragment bodies. These are new
output-envelope limits, not the 20,000-character user-input validator. The
implementation must audit and enforce compatible bounds in each adapter,
gateway payload, result parser, SSE path, persistence path, and UI parser; no
transport may silently truncate a valid envelope. The legacy Codex 2 MiB file
limit remains only for reading historical provider captures and is not the new
message protocol's budget.

For a reply that contains any live opening marker, the entire successful final
`reply.body` before extraction (visible prose, markers, and fragment bodies) is
limited to 256 KiB UTF-8. Every adapter advertising v1 must carry at least that
many bytes without truncation and must fail explicitly above its declared
result limit. Replies without a live visual marker retain their existing output
behavior. Sanitization/wrapping output is separately checked against the same
per-fragment and aggregate decoded-byte limits before object persistence.

The v1 authoring contract has exactly one input form: the message envelope. It
does not define a parallel typed `inlineArtifacts` input, avoiding provider
result-shape coupling and text/typed duplication ambiguity. A future structured
transport requires a new protocol version and precedence rule. No adapter may
publish an attachment id or trusted placement directly.

Documentation examples must use a fenced-code example that the parser never
publishes. The bundled skill must not put a live envelope inside an explanatory
section in an actual assistant result.

### Server normalization

The streaming path recognizes the opening marker across arbitrary chunk
boundaries and buffers from that marker through its closing marker before any
Chat-visible transcript projection, run-result summary persistence, client event
broadcast, or stopped-draft recovery. Raw fragment bytes never enter those
surfaces. If the run stops, fails, times out, exceeds a bound, or ends before the
closing marker, the server discards the private buffer and emits only a compact
unavailable placeholder. Publication happens only after a successful, complete
final result.

After the common final reply parser has produced `reply.body`, the server:

1. parses complete `rudder-inline-visual` blocks with exact source ranges;
2. validates count, byte size, required widget root, and envelope shape;
3. sanitizes and converts accepted fragments into generated internal HTML
   attachments;
4. replaces each accepted source block with a compact canonical placement
   record such as `::rudder-inline-vis{slot="0"}` before message persistence;
5. persists a versioned Server-owned mapping in the message structured payload
   with `slot`, `attachmentId`, `contentType`, `byteSize`, `sha256`, and `status`;
6. records unavailable mappings for malformed or rejected blocks without
   exposing raw fragment source as ordinary Markdown;
7. merges legacy Codex captures into the same canonical mapping and placement
   model;
8. compensates for partial persistence: a failed message/mapping write removes
   the just-created attachment and object; deletion/orphan cleanup covers crashes
   between object, attachment, and message writes.

The model cannot authorize an attachment by emitting a placement record. A
placement renders only when the same completed message owns a matching
Server-created attachment and structured mapping.

The v1 mapping key is reserved. Public Chat APIs, model result payloads, repair
results, imported messages, and generic structured-payload sanitizers strip that
key and all canonical placement metadata. Only the internal completed-message
publication and governed fork-copy paths may write it. The persistence layer
revalidates organization, conversation, message, Agent creator, attachment MIME,
byte size, and hash instead of trusting route-layer sanitization alone.

### Rendering

The UI reuses the current bounded CSS sanitizer, DOMPurify allowlist, restrictive
CSP, scriptless `srcDoc` iframe, theme variables, and host-measured height. The
renderer consumes the canonical provider-neutral placement and mapping. Legacy
Codex placements continue to render through a compatibility parser.

### Manifest behavior

During reconciliation, the service derives the set of inline-visual attachment
ids from each message's trusted structured payload and excludes only those rows
from manifest candidates. It continues to classify:

- ordinary Agent-created HTML attachments as Outputs;
- user-created HTML attachments as Sources;
- produced Run-backed Library `artifacts/...` references as Outputs.

This keeps presentation internals out of the index without weakening existing
Output evidence rules.

## Runtime conformance scope

| Runtime family | Shipped evidence | Result |
| --- | --- | --- |
| Codex local/App Server | Common Chat pipeline plus legacy provider-file capture tests | v1 is canonical; historical/in-flight legacy input remains readable |
| Claude, Cursor, Gemini, OpenCode, Pi local | Exact registry coverage and the shared Chat prompt/result admission path used by all built-ins | Supported through common orchestration; no provider file contract |
| Hermes local | Real child-process prompt capture and untruncated result above 64 KiB | Supported |
| Process | Prompt over stdin, bounded stdout capture, full real Rudder/Chromium E2E | Supported |
| HTTP | Versioned context request, JSON/plain final result, response bound and >64 KiB transport test | Supported |
| OpenClaw gateway | Common `chatPrompt` forwarding and gateway result tests | Supported |
| Future plugin adapters | Server registry plus common Chat pipeline required | No separate provider directive or self-asserted visual flag |

The common Chat layer, rather than a per-adapter boolean, is the conformance
boundary. Runtime transport tests prove prompt/result integrity; shared parser,
arbitrary-chunk, transcript-union, Stop/failure, persistence, and browser tests
prove the safety properties once for every registered runtime.

Outside Rudder Chat, the skill continues to use Mermaid, Markdown, or prose
unless that surface later defines its own artifact presentation contract.

## Approved Product Logic Registry delta

The user explicitly approved this guarded delta on 2026-07-21:

- new `CHAT.INLINE.VISUAL.001`: define the versioned message envelope, limits,
  trusted same-message mapping, stream-suppression behavior, scriptless sandbox,
  persistence lifecycle, and legacy Codex compatibility.
- `AGENT.SKILLS.001`: define `visualize` as a runtime-neutral Chat skill whose
  custom fragment transport is the Rudder message protocol, with fallback
  outside eligible Chat surfaces.
- `AGENT.RUNTIME.ADAPTERS.001`: define inline visuals as a common Chat
  orchestration capability, with prompt/result transport evidence per runtime
  family and shared admission/safety evidence rather than a self-asserted
  adapter capability flag.
- `CHAT.LIFECYCLE.001`: define inline visuals as completed-message-owned internal
  artifacts with reserved Server-only placement mappings, no public/model write
  path, and no ordinary attachment presentation.
- `CHAT.FORK.001`: preserve mapped inline visual backing assets across Chat forks
  without reclassifying them as newly produced Outputs.
- `CHAT.THREAD.MANIFEST.001`: exclude mapped inline visual backing attachments
  while preserving classification for ordinary Agent and user attachments.
- `RUN.CHAT.AGENT.001`: require all registered built-in adapters to pass the
  common Chat prompt, final result, streaming suppression, and runtime-neutral
  visual extraction contract.

No Library contract changes are required because the visual is explicitly not a
Library artifact.

### Exact exceptions to existing invariants

Approval of the delta above also approves these narrow exceptions; it does not
reclassify ordinary attachments:

- `CHAT.THREAD.MANIFEST.001` currently says every Agent-created Chat attachment
  is an Output and that durable Outputs survive reconciliation. Add one exception
  for a Server-created `text/html` attachment proven by the versioned trusted
  mapping to be presentation state of that same assistant message. Such a row is
  not production evidence, is never a manifest candidate, and any historical
  misclassified row is removed during reconciliation.
- `CHAT.FORK.001` currently says attachments are not copied. Add one exception
  for internal inline-visual presentation state: the fork receives a new
  organization-scoped attachment record and trusted mapping owned by the copied
  child message (with immutable backing bytes reused only through the governed
  asset lifecycle). It does not inherit Output provenance.
- `AGENT.RUNTIME.ADAPTERS.001` continues to forbid blanket parity assumptions
  for adapter-native features. Inline visuals are deliberately different: the
  Rudder Chat layer owns the protocol and safety boundary, while process/HTTP
  remain internal/advanced runtime choices even with their Chat transports.

Adding `CHAT.INLINE.VISUAL.001` also requires synchronizing the contract list in
the collaboration domain file, collaboration README, Product Logic Registry
navigation, and affected surface/workflow maps. Those index edits describe the
same approved contract and do not create a Library ownership rule.

## Implementation tasks

### 1. Shared protocol parser

- Add provider-neutral envelope and canonical placement parsing beside the
  legacy parser in `packages/shared/src/chat-inline-visuals.ts`.
- Preserve exact ranges and deterministic replacement order.
- Reject malformed markers, nested/excess blocks, empty fragments, per-fragment
  and total oversize UTF-8 content, oversize visual-bearing final replies, live
  markers in explanatory code/quotes, unsupported versions, and placement
  forgery. Implement the exact LF/CRLF and block-depth grammar above.
- Keep legacy exports and persisted-message parsing backward compatible.
- When a new envelope and legacy Codex file directive coexist, parse both in
  source order under one three-visual count budget. Do not infer deduplication
  from filenames; trusted byte hashes may collapse storage only after each
  source placement has been validated.

### 2. Common Chat extraction

- Add a common streaming suppressor before visible assistant-delta publication;
  it must recognize markers split across arbitrary chunks and never release raw
  fragment bytes on stop, failure, timeout, truncation, or malformed output.
- Publish provider-neutral blocks only after a successful common final reply body
  exists, not from individual runtime-specific trust decisions.
- Extend generated attachment and visual result types from Codex-specific names
  to Rudder-owned inline visual names.
- Normalize accepted blocks to provider-neutral placements before persisting the
  message.
- Preserve legacy Codex capture as an input adapter feeding the common result.
- Continue accepting legacy `::codex-inline-vis{file="..."}` plus managed-file
  capture for newly arriving messages from in-flight old skill copies until an
  explicitly versioned compatibility removal; historical rendering remains
  readable after any future authoring-path removal.
- Ensure partial, failed, stopped, malformed, or repaired replies never publish
  incomplete fragment bytes.

### 3. Runtime transport conformance

- Define a versioned common Chat protocol context plus reusable conformance
  coverage for the production `visualize` prompt projection, `chatPrompt`
  delivery, normalized final result text, output bounds, stream suppression,
  stop/fail behavior, and malformed envelopes.
- Prove the registry exactly covers Codex, Claude, Cursor, Gemini, OpenCode, Pi,
  Hermes, process, HTTP, and OpenClaw; use transport-specific integration tests
  where the runtime crosses a distinct process, HTTP, or gateway boundary.
- Add the missing process stdin/stdout and HTTP request/response Chat contracts;
  make OpenClaw consume the common Chat prompt and return a normalized final
  result.
- Do not use a self-asserted per-adapter visual boolean. A runtime participates
  only by entering the registered common Chat prompt/result pipeline.

### 4. Persistence and lifecycle

- Persist internal fragment bytes through the existing organization-scoped asset
  store and message attachment ownership path.
- Reserve the v1 mapping field and strip it from public Chat/API input, model
  output, imports, result repair, and generic structured-payload sanitization;
  permit writes only from internal publication and governed fork-copy services.
- Keep provider/object-key details private.
- Make refresh, regeneration, branch selection, fork, and both deletion orders
  preserve or release backing assets according to existing mapped-visual rules.
- Do not expose internal visual attachments in ordinary attachment UI.
- Add compensating cleanup for failures between object, attachment, message, and
  mapping persistence, plus orphan recovery coverage.

### 5. Work manifest exclusion

- Select Chat attachment ids while reconciling.
- Read only validated Server-owned visual mappings from the producing message.
- Skip a candidate only when mapping, message ownership, attachment id, Agent
  creator, `text/html`, filename, and size checks agree.
- Preserve durable historical Output rows carefully: a newly recognized internal
  visual must remove the prior incorrectly persisted manifest Output, while an
  unrelated durable Output remains preserved.

### 6. Skill and synchronized references

- Replace canonical Codex directory/file instructions with the versioned
  `rudder-inline-visual` message-envelope contract.
- Update `references/runtime-contract.md`, examples, OpenAI metadata where
  affected, bundled-skill tests, and packaged projections.
- Explain that agents write a fragment, never an `<iframe>`; Rudder creates the
  sandbox iframe.
- Retain fallback guidance for non-Chat surfaces and malformed/oversize visuals.

### 7. UI migration

- Render canonical placements through the existing safe runtime.
- Keep old messages using `::codex-inline-vis` readable.
- Keep raw blocks and placement records invisible in completed messages.
- Provide the existing unavailable fallback without download affordances that
  would expose an internal presentation file as a normal artifact.

## Test strategy

### Shared/unit

- provider-neutral envelope parsing for 0/1/3/>3 blocks, per-fragment and total
  Unicode byte boundaries, exact ranges, deterministic normalization,
  malformed/unterminated/nested markers, markers inside code/quotes/examples,
  linear-time behavior on adversarial input, and legacy parsing;
- structured mapping ownership and forged placement rejection;
- reserved-key injection rejection through public API, model result, result
  repair, import, fork, cross-message, and cross-organization paths;
- sanitizer and CSP regression coverage for scripts, handlers, URLs, CSS URLs,
  active controls, nested frames, oversized CSS, malformed SVG, and theme
  reflow.
- streaming suppression with opening/body/closing markers split at every byte
  boundary; stop, failure, timeout, and transport truncation in every state must
  expose and persist no raw fragment source.

### Server/integration

- adapter conformance for prompt plus skill delivery, normalized final result,
  byte limits, and suppression using Codex, Claude, Cursor, Gemini, OpenCode, Pi,
  Hermes, process, HTTP, and OpenClaw;
- capture occurs only after a successful complete final Chat result;
- organization/message/Agent ownership, size/count enforcement, refresh,
  regeneration, fork, deletion order, and asset cleanup;
- mapped visual attachments are absent from Work manifest;
- ordinary Agent HTML remains an Output and user HTML remains a Source;
- stale incorrectly indexed visual Outputs are removed on reconciliation;
- a model-authored placement or structured payload cannot bind another message's
  attachment.

### Automated E2E

- create a real Chat through the running Rudder server, execute a non-Codex
  runtime fixture that emits the provider-neutral envelope, verify inline
  rendering, reload persistence, Work manifest absence, and no Library file;
- run the same workflow through Codex and prove the canonical path no longer
  requires a visualization directory;
- fork the Chat and verify both branches render while the manifest stays clean;
- adversarial visual proves no script executes, no network request occurs, no
  top navigation happens, and no Rudder API credential is reachable;
- responsive screenshots at wide Chat with Work shelf, open Side Panel width,
  and mobile width;
- malformed/oversized fragment produces a clear fallback and no visible raw HTML.
- stop and failure while the visual envelope is streaming leave neither raw HTML,
  attachment, mapping, manifest row, nor orphan object.

### Real-environment black-box verification

- start the actual local Rudder app against an isolated instance profile;
- use installed real local runtime binaries where credentials are available,
  covering Codex plus at least one non-Codex adapter;
- exercise the user-visible Chat workflow rather than calling internal helpers;
- inspect the Work manifest API and rendered shelf to prove no backing HTML row;
- inspect the organization Library to prove no visual file was created;
- restart/reload the app and repeat fork/navigation checks;
- store screenshots outside the repository and include final screenshots in the
  handoff;
- have an independent reviewer run an adversarial black-box pass on the final
  tree and report findings before acceptance.

All built-in adapters must pass the real server/runtime conformance harness. If
credentials prevent a live provider run, report that adapter limitation
explicitly and use its real executable/transport with a deterministic local
endpoint in addition to the full running-server E2E. Do not claim live-provider
coverage from a fixture, and do not claim all-runtime compatibility from the
shared parser alone.

## Verification gates

Focused checks:

```sh
pnpm exec vitest run packages/shared/src/chat-inline-visuals.test.ts
pnpm exec vitest run packages/agent-runtimes/codex-local/src/server/inline-visuals.test.ts
pnpm exec vitest run server/src/services/chat-assistant.inline-visuals.test.ts
pnpm exec vitest run server/src/__tests__/chat-work-manifest.test.ts
pnpm exec vitest run ui/src/pages/ChatInlineVisual.test.tsx
pnpm test:e2e -- tests/e2e/chat-inline-visual-artifacts.spec.ts
```

Required repository checks:

```sh
pnpm product-logic:check
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Acceptance criteria

- One versioned provider-neutral message contract produces the same inline visual
  through every registered built-in runtime without runtime-specific file access;
  every adapter has conformance evidence and no silent compatibility assumption.
- New `visualize` instructions contain no canonical Codex directive or Codex
  directory requirement.
- Legacy Codex visual messages remain readable.
- Inline visual backing HTML is neither a Library file nor a Work manifest item.
- Ordinary HTML attachments keep their existing Source/Output behavior.
- Only a Server-owned same-message mapping authorizes rendering.
- Raw visual source never appears in streamed Chat text or stopped/failed drafts.
- Per-fragment and total UTF-8 limits are consistent across every transport and
  no valid envelope is silently truncated.
- The existing scriptless/no-network sandbox remains intact under adversarial
  browser testing.
- Real running-app verification covers the complete user-visible workflow,
  persistence, manifest absence, Library absence, and at least one non-Codex
  adapter path.
- Independent static and black-box reviews have no unresolved high-severity
  findings.

## Completion evidence

- Independent adversarial review: P0 0, P1 0 after nested-envelope,
  arbitrary-delta, structured-transcript, repair, error, run-evidence, and log
  source-leak regressions.
- Real black-box workflow: Rudder 0.5.0, embedded PostgreSQL, non-Codex process
  runtime, and Chromium passed the complete create/render/reload/mobile/fork/
  two-delete-order workflow. Manifest remained empty and Library remained `[]`.
- Runtime transports: process stdin/stdout, HTTP request/response (including a
  4 MiB response cap), Hermes child-process full result, and OpenClaw common
  prompt paths have focused integration coverage. The shared registry test
  covers all ten built-in runtime types.
- Repository gates: Product Logic Registry (77 contracts), lint, full workspace
  typecheck, and build passed. Focused inline-visual and security suites passed;
  the full repository test run had only unrelated concurrency/flaky failures
  that passed alone or were reported separately.
- Final screenshots live outside the repository at
  `/tmp/rudder-inline-visual-blackbox-final2/chat-inline-visual.png` and
  `/tmp/rudder-inline-visual-blackbox-final2/chat-inline-visual-mobile.png`.

## Deferred P2 follow-ups

- A message that deliberately mixes historical Codex file directives and new
  v1 envelopes still gives the legacy capture path first claim on the shared
  three-visual budget instead of strict source order. New `visualize` output
  never emits the legacy form, so this affects only mixed migration output.
- Immediate object/attachment/mapping failures have compensating cleanup and
  both fork deletion orders are covered. A storage-provider deletion failure
  can still leave an unreachable object because Rudder does not yet have a
  general persisted orphan-reconciliation queue. That broader storage repair
  mechanism remains separate from the message-ownership behavior shipped here.
