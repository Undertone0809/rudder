# Run Detail Transcript V2 Proposal

Status: Draft
Date: 2026-04-05
Owners: UI

## 1. Summary

- Upgrade the run detail page from a generic transcript/log container into an inspectable execution narrative.
- Keep Rudder's default principle of human-readable first and raw detail second.
- Introduce a stable semantic presentation layer for transcript blocks so the UI can distinguish assistant markdown, thinking, bash, file operations, generic tools, events, and raw stdout.
- Use the same underlying transcript language across run detail, issue live widgets, and dashboard cards, while making the run detail page the most inspectable surface.

## 2. Problem

The current run detail page already parses transcript entries and renders them with multiple block types, but it still behaves mainly like a normalized log viewer.

Current gaps:

- The page structure is `summary card + transcript container`, not a dedicated run inspection surface.
- Tool rows are still too generic. The UI does not consistently tell the operator whether a step was bash, read/edit/grep, markdown output, or reasoning.
- The transcript lacks a stronger run narrative skeleton. Users can read every block, but scanning the sequence of work is slower than it should be.
- Progressive disclosure is incomplete. Expanded views are debug-friendly, but not yet optimized for operator review.
- The current renderer relies on local heuristics without a clear semantic contract for future runtimes.

This makes the page usable for debugging but weaker than it should be for answering the actual operator questions:

- What did the agent do?
- In what order?
- Which steps matter?
- Where did it fail?
- What exact command/input/output do I need if I want to inspect further?

## 3. Goals

1. Make the run detail page feel like an execution review surface, not just a transcript dump.
2. Preserve a clear top-to-bottom reading order for the entire run.
3. Let operators scan the run in 5-10 seconds without expanding every block.
4. Make details inspectable enough for debugging when expanded.
5. Keep the implementation runtime-portable and not hard-coded to one provider's output style.

## 4. Non-goals

- Do not redesign the entire agent detail page.
- Do not add provider-specific branding or hard-code the UI to Codex only.
- Do not replace raw mode.
- Do not introduce a brand new logging backend in this iteration.

## 5. Product framing

Rudder should not lead with raw logs and transcripts. The default surface should be human-readable intent and progress, with raw details below that.

For run detail, this means:

- the default mode should explain the run
- the page should still expose exact inputs and outputs on demand
- the UI should show the structure of work, not only the content of work

## 6. Proposed page structure

The run detail page should be reorganized into three layers:

### 6.1 Run summary

Keep the existing top summary region, but treat it as the operator header:

- status
- timing
- duration
- token/cost metrics
- retry/resume/cancel actions
- session state when relevant
- issues touched

This remains compact and operational.

### 6.2 Progress narrative

Add a structured transcript surface that reads like an execution timeline:

- assistant statements act as narrative anchors
- tool and command steps appear directly beneath the reasoning or statement they support
- failures and warnings are visually distinct and opened by default
- final result appears as a closing state block

This is the primary reading layer.

### 6.3 Raw inspection

Keep `Nice | Raw`, but make the intent explicit:

- `Nice` = review mode
- `Raw` = exact transcript payload inspection

Raw remains available for debugging and adapter work.

## 7. Proposed semantic block model

The current renderer already normalizes transcript entries into internal block types. V2 should make that layer explicit and stable enough to drive specialized components.

### 7.1 Required semantic categories

- `assistant_message`
  - Markdown-rendered narrative or explanation from the agent
- `thinking`
  - Internal reasoning or planning
- `bash`
  - Shell execution with command, cwd, duration, exit state, output
- `file_operation`
  - Read, edit, write, grep, search, open, patch-like operations
- `tool_generic`
  - Other tool calls that do not belong to bash or file operation
- `activity`
  - Started/completed internal progress markers
- `event`
  - Init, result, stderr, system, warnings, errors
- `stdout_fallback`
  - Raw unclassified output

### 7.2 Classification rules

- Keep transcript entry parsing runtime-specific.
- Add a second pass in the UI normalization layer that classifies already-parsed blocks into semantic categories.
- Use conservative heuristics:
  - if a tool call contains `command` / `cmd`, classify as `bash`
  - if the tool name or input clearly implies read/edit/grep/search/path/file access, classify as `file_operation`
  - otherwise classify as `tool_generic`
- If uncertain, prefer `tool_generic` over false precision.

## 8. Proposed component language

### 8.1 Assistant message block

- Render as the main narrative content
- Markdown first
- No heavy chrome
- This is the main reading unit

### 8.2 Thinking block

- Lower contrast than assistant content
- Collapsed by default after streaming completes
- Expandable
- Always visible enough to signal that reasoning happened

### 8.3 Bash card

- One clear bash-specific component
- Header shows:
  - command summary
  - status
  - duration if available
- Expanded body shows:
  - full command
  - cwd if available
  - input/output
  - exit code on failure

### 8.4 File operation card

- Separate component from bash
- Header shows operation verb and target summary
  - examples: `Read ui/src/pages/AgentDetail.tsx`, `Edit issue-links.ts`, `Grep getByIdentifier`
- Expanded body shows exact input/result payload

### 8.5 Generic tool card

- Same interaction model as bash/file op
- Less opinionated header
- Used only when no stronger semantic category is available

### 8.6 Event blocks

- `result` should read as the explicit run outcome
- `stderr` and error events should be danger-toned
- init and metadata events should be quieter than the main narrative

## 9. Timeline / grouping model

The visual structure should move toward a timeline.

Minimum version:

- each block gets a left-side lane for status/icon/timestamp
- assistant statements become step anchors
- immediate tool steps below an assistant message are visually attached to that message

Preferred version:

- group one assistant statement plus its subsequent tools/events into a `turn`
- a new assistant statement starts a new turn
- thinking that appears before a statement belongs to the same turn if adjacent

This grouping should improve readability without changing persisted data.

## 10. Default interaction rules

- `thinking` collapsed by default once no longer streaming
- failed blocks expanded by default
- successful bash/file/tool cards collapsed by default but with useful summaries
- raw stdout collapsed by default
- final result always visible
- live runs preserve auto-follow behavior

## 11. Run detail-specific controls

Keep controls tight and operator-oriented:

- `Nice | Raw` toggle
- `Jump to live` for streaming runs
- optional density toggle later if needed, but not required for the first pass

Do not add decorative controls that weaken scan speed.

## 12. Implementation shape

### Phase 1: Semantic layer

- Refactor transcript normalization so block classification is explicit
- Introduce a semantic block field or semantic block subtype
- Keep existing parser contracts intact

Likely files:

- `ui/src/components/transcript/RunTranscriptView.tsx`
- supporting transcript helpers if extraction becomes necessary

### Phase 2: Run detail presentation upgrade

- Redesign the run detail transcript container as a timeline-like inspection surface
- Add specialized components for `bash`, `file_operation`, `tool_generic`, and `assistant_message`
- Improve default open/closed behavior

Likely files:

- `ui/src/pages/AgentDetail.tsx`
- `ui/src/components/transcript/RunTranscriptView.tsx`

### Phase 3: Surface alignment

- Reuse the same semantic language in issue live widgets and dashboard cards
- Keep those surfaces denser and more collapsed than run detail

Likely files:

- `ui/src/components/ActiveAgentsPanel.tsx`
- `ui/src/components/CommentThread.tsx`
- `ui/src/pages/RunTranscriptUxLab.tsx`

## 13. Validation criteria

The proposal is successful if all are true:

1. An operator can skim a completed run and understand the main path without expanding every item.
2. A failed run makes the failing step visually obvious.
3. Bash and file operations are clearly distinct from each other.
4. The page still supports raw inspection without losing detail.
5. The same semantic language can be reused on compact live surfaces.

## 14. Open questions to resolve before implementation

1. Should the default label be `Nice | Raw`, or should `Nice` be renamed to `Review`?
2. Do we want explicit timestamps on every block in run detail, or only on hover/secondary metadata?
3. Should `thinking` be shown by default for all runtimes, or hidden behind a user preference later?
4. Should command duration be shown inline in the first iteration, or deferred until timing data is cleaner?

## 15. Recommended next step

Implement this proposal in two steps:

1. Lock the semantic block model inside the transcript renderer.
2. Rebuild the run detail transcript presentation on top of that model before touching compact live surfaces.

This keeps the first iteration grounded in a stable contract instead of another one-off visual patch.
