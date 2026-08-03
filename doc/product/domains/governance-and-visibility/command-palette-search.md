---
title: Command Palette Search
domain: governance-and-visibility
status: active
coverage: detailed
spec_depth: logic_contract
contract_ids:
  - SEARCH.AI.001
related_code:
  - packages/shared/src/types/ai-search.ts
  - packages/shared/src/validators/ai-search.ts
  - server/src/routes/ai-search.ts
  - server/src/services/ai-search.ts
  - ui/src/api/orgs.ts
  - ui/src/components/CommandPalette.tsx
  - ui/src/lib/global-search-scope.ts
related_tests:
  - server/src/__tests__/ai-search-routes.test.ts
  - server/src/services/ai-search.test.ts
  - ui/src/components/CommandPalette.test.tsx
  - tests/e2e/global-search-chat.spec.ts
related_plans: []
edit_policy: user_confirmed_only
---

# Command Palette Search

## SEARCH.AI.001

### Contract Summary

The organization command palette provides regular organization-scoped search
across Issues, Chats, Projects, Agents, Skills, and Library. When regular
search has settled without a visible match, the palette may offer `AI Search`
when the selected organization has a configured `reasoning` Intelligence
Profile. AI Search uses that organization Smart Model to rank a bounded set of
visible records and returns navigable matches.

### Intent / User Job

An operator can find an organization record by meaning rather than exact text,
without leaving the command palette or manually searching each content type.
The operator can also select a specific search category first and ask AI Search
within that category.

### Why / Design Reasoning

Regular search remains the fast and predictable default. AI Search is deferred
until regular results are settled and empty so the model is an explicit
fallback, not an invisible replacement for deterministic search. The selected
category is sent to the server and limits the model candidate set so an Issues
search cannot return an unrelated Chat or Project.

### Actors / Objects / State

- Board operator, selected organization, command palette, regular search
  results, and optional search scope.
- Organization `reasoning` Intelligence Profile with `configured`, `disabled`,
  or other non-ready status.
- AI Search request, bounded organization candidates, Smart Model response,
  and validated result navigation target.
- Palette states: idle, regular-searching, AI Search available, AI Search
  running, results, empty, and retryable failure.

### Entry Points / Inputs

- Open the command palette from the Search rail action or configured shortcut.
- Enter a query of at least two characters.
- Optionally confirm `Issues`, `Chats`, `Projects`, `Agents`, `Skills`, or
  `Library` as the selected scope before entering the query.
- Select the `AI Search` command after regular search has settled with no
  visible match.
- `POST /api/orgs/:orgId/ai-search` accepts the trimmed query and optional
  selected scope in board organization context.

### Product Logic Flow

1. The palette loads the selected organization's Intelligence Profiles and
   enables the fallback only when its `reasoning` profile is configured.
2. The palette runs deterministic search for the active scope. It waits for
   the relevant remote search to settle and suppresses AI Search while results
   are visible or a regular request is still fetching.
3. If no regular result is visible, the palette renders one concise `AI
   Search` command. The command has no query echo or explanatory subtitle.
4. Selecting it sends the query and the active scope, if any, to the
   organization-scoped route. It does not automatically invoke the model
   while the operator is typing.
5. The server checks board organization access, collects only records allowed
   for the selected scope, and invokes the configured organization reasoning
   profile with a bounded prompt. Without a scope it may use all supported
   organization record kinds.
6. The server accepts only model match keys from the candidate allow-list and
   returns canonical titles, previews/reasons, and server-selected navigation
   hrefs. Unknown model keys are discarded.
7. The palette shows a single-line `AI Search` summary with the number of
   matched records and navigable result rows. A model failure keeps a retry
   action available; an empty model response shows `Found 0 results`.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Regular match | Deterministic search returns a visible record | Show the regular result | Invoke AI Search automatically | CommandPalette tests and E2E |
| Global fallback | No scope, regular search settled empty, reasoning profile configured | Show `AI Search` and allow an explicit model request | Show the old Smart Model prompt or query subtitle | CommandPalette tests and E2E |
| Scoped fallback | A supported scope is selected and its regular search settled empty | Show `AI Search`; send the selected scope and return only that scope's candidates | Return records from another category | Service, route, UI, and E2E tests |
| Profile unavailable | Reasoning profile is missing, disabled, or not configured | Hide `AI Search` | Invoke the organization model | CommandPalette tests and E2E |
| Regular request pending | Relevant deterministic request is still fetching | Keep `AI Search` hidden | Race model search against stale regular results | CommandPalette tests and E2E |
| Model failure | AI Search request fails | Show an error and retry action | Close the palette or silently ignore failure | CommandPalette tests |
| Untrusted model key | Model returns a key outside the candidate set | Drop that result | Navigate to a model-supplied arbitrary href | AI Search service tests |

### Actor-Visible Input

The operator sees the query, the selected scope chip when applicable, and a
single `AI Search` action after deterministic search is empty. The operator
does not see the model prompt or the bounded candidate payload.

### Operator-Visible Output

AI Search shows its label, the number of matched records, and result rows with
titles, compact context, and category labels. Selecting a row navigates within
the selected organization using the validated href. Disabled or unavailable
Intelligence leaves the regular search experience unchanged.

### Persisted Evidence

The query and AI Search response are transient command-palette state and are
not saved as a new organization record. The underlying product-intelligence
execution uses the existing organization runtime path and context metadata;
result navigation is derived only from the server-side candidate allow-list.

### Canonical Scenarios

1. An organization with configured reasoning searches an unmatched phrase from
   the global palette, selects `AI Search`, and opens the returned Project.
2. The operator selects `Issues`, searches an unmatched phrase, selects `AI
   Search`, and receives only Issue candidates.
3. The same organization has a disabled reasoning profile; deterministic
   empty search shows no AI Search command.
4. A model returns a fabricated result key; the server returns no fabricated
   navigation target and keeps valid matches only.

### Invariants / Non-Goals

- Organization access and board authorization remain enforced by the API.
- Hidden Issues, hidden or terminated Agents, hidden Chats, archived Projects,
  and inactive Library entries are excluded from candidates.
- AI Search is an explicit fallback and does not replace deterministic search,
  run on every keystroke, or create a Chat/Issue as a side effect.
- The model cannot choose an arbitrary URL or cross-organization record.
- This contract does not define semantic indexing, long-term search history,
  or a general-purpose external web search feature.

### Drift Boundaries

- Adding a new command-palette scope requires updating the shared request
  schema, server candidate mapping, UI scope mapping, tests, and this contract.
- Changing which records are visible to deterministic search must be reviewed
  against the AI candidate exclusions as well.
- Changing Intelligence Profile readiness or board authorization must preserve
  the hidden/unavailable fallback branch.
- Changing model output shape or navigation requires preserving key allow-list
  validation and the result navigation invariant.

### Traceability

- UI: `ui/src/components/CommandPalette.tsx` and
  `ui/src/lib/global-search-scope.ts`.
- API and candidate filtering: `server/src/routes/ai-search.ts` and
  `server/src/services/ai-search.ts`.
- Shared contract: `packages/shared/src/types/ai-search.ts` and
  `packages/shared/src/validators/ai-search.ts`.
- Tests: `ui/src/components/CommandPalette.test.tsx`,
  `server/src/__tests__/ai-search-routes.test.ts`,
  `server/src/services/ai-search.test.ts`, and
  `tests/e2e/global-search-chat.spec.ts`.
