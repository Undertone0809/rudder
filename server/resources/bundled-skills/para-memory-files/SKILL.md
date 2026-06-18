---
name: para-memory-files
description: >
  File-based memory system using Tiago Forte's PARA method. Use this skill
  whenever you need to store, retrieve, update, or organize knowledge across
  sessions. Covers three memory layers: (1) Knowledge graph in PARA folders
  with atomic YAML facts, (2) Daily notes as raw timeline, (3) Tacit
  knowledge about user patterns. Also handles shared work files, memory decay,
  weekly synthesis, Rudder chat and agent work capture, and file-based recall.
  Trigger on any memory operation: saving facts, writing daily notes, creating
  entities, running weekly synthesis, recalling past context, or managing
  shared work notes.
allowed-tools: []
disable: true
---

# PARA Memory Files

Persistent, file-based memory organized by Tiago Forte's PARA method. Three layers: a knowledge graph, daily notes, and tacit knowledge. All paths are relative to `$AGENT_HOME`.

## Three Memory Layers

### Layer 1: Knowledge Graph (`$AGENT_HOME/life/` -- PARA)

Entity-based storage. Each entity gets a folder with two tiers:

1. `summary.md` -- quick context, load first.
2. `items.yaml` -- atomic facts, load on demand.

```text
$AGENT_HOME/life/
  projects/          # Active work with clear goals/deadlines
    <name>/
      summary.md
      items.yaml
  areas/             # Ongoing responsibilities, no end date
    people/<name>/
    companies/<name>/
  resources/         # Reference material, topics of interest
    <topic>/
  archives/          # Inactive items from the other three
  index.md
```

**PARA rules:**

- **Projects** -- active work with a goal or deadline. Move to archives when complete.
- **Areas** -- ongoing (people, companies, responsibilities). No end date.
- **Resources** -- reference material, topics of interest.
- **Archives** -- inactive items from any category.

**Fact rules:**

- Save durable facts immediately to `items.yaml`.
- Weekly: rewrite `summary.md` from active facts.
- Never delete facts. Supersede instead (`status: superseded`, add `superseded_by`).
- When an entity goes inactive, move its folder to `$AGENT_HOME/life/archives/`.

**When to create an entity:**

- Mentioned 3+ times, OR
- Direct relationship to the user (family, coworker, partner, client), OR
- Significant project or company in the user's life.
- Otherwise, note it in daily notes.

For the atomic fact YAML schema and memory decay rules, see [references/schemas.md](references/schemas.md).

### Layer 2: Daily Notes (`$AGENT_HOME/memory/YYYY-MM-DD.md`)

Raw timeline of events -- the "when" layer.

- Write continuously during conversations and agent work when a
  memory-worthy signal appears.
- Extract durable facts to Layer 1 during heartbeats.
- Treat daily notes as the first capture layer, not the final destination for
  stable preferences, entity facts, or shared project knowledge.

#### Conversation and Agent Work Capture Policy

Rudder chat conversations and agent execution events are memory sources when
they contain durable signal, not because every chat line or routine action
deserves retention. Capture a concise daily-note entry when a conversation,
automation, issue run, review, close-out, or other agent work includes any of
these:

- User corrections that change how the agent should behave next time.
- New or changed preferences, constraints, boundaries, or decisions.
- Issue proposal intent, acceptance criteria, or priority reasoning that is not
  already explicit in the issue.
- Automation design rationale, recurring workflow choices, or escalation rules.
- Agent work patterns that should be repeatable, such as a better triage path,
  validation shortcut, environment workaround, review handoff, or runbook step.
- Project/product/engineering judgment that will affect future work.
- Attachment or screenshot evidence that changes task interpretation.
- Reusable execution lessons, setup friction, validation findings, or failure
  modes that future runs should know.

Do not capture:

- Greetings, thanks, scheduling chatter, or low-signal status updates.
- Routine issue comments, heartbeat updates, command outputs, close-out
  summaries, or automation logs that add no new decision, correction, lesson, or
  reusable evidence beyond the source artifact.
- Full private chat transcripts. Summarize the durable signal instead.
- Secrets, tokens, credentials, private keys, session cookies, or auth headers.
- One-time sensitive context that is not needed for future work.
- Organization-level facts as private personal memory. Record only the routing
  decision in the daily note, then promote the fact to shared project knowledge.
- Speculation, weak inferences, or unverified assumptions as facts.

Recommended daily-note entry format:

```md
## HH:MM - Memory capture

- Context: conversation, issue, automation, run, or evidence reference; project;
  and why this mattered.
- User intent: the durable need, correction, preference, or decision.
- Conclusion/action: what changed or what was done.
- Reusable lesson: future behavior, command, routing rule, or validation signal.
- Follow-up/risk: unresolved uncertainty, owner, or promotion target.
```

Reference the Rudder conversation, issue, or local evidence path when available,
but keep the note short enough that it can be safely scanned later.

#### Promotion and Routing Rules

Use daily notes as the intake log, then route the information:

- Stable personal operating preferences or recurring user patterns ->
  `$AGENT_HOME/instructions/MEMORY.md`.
- Entity facts about people, companies, projects, or resources ->
  `$AGENT_HOME/life/<para-bucket>/<entity>/items.yaml`.
- Project proposals, decisions, reusable know-how, and shared work notes ->
  `$RUDDER_PROJECT_LIBRARY_ROOT` when project context exists, otherwise the
  relevant path under `$RUDDER_ORG_WORKSPACE_ROOT`.
- Skill behavior problems or repeated workflow failures -> propose or make a
  skill patch in the relevant skill package. Do not hide organization-wide
  behavior fixes only in one agent's personal memory.
- Secrets or sensitive one-time context -> do not write them to memory; record
  only a redacted operational lesson if future behavior genuinely depends on it.

During heartbeat synthesis, review recent chat captures and promote anything
that has become stable, repeated, or shared. Leave the daily note as the audit
trail even after promotion.

### Layer 3: Tacit Knowledge (`$AGENT_HOME/instructions/MEMORY.md`)

How the user operates -- patterns, preferences, lessons learned.

- Not facts about the world; facts about the user.
- Update whenever you learn new operating patterns.
- This file is part of the instruction bundle and is automatically loaded at runtime when present.

## Write It Down -- No Mental Notes

Memory does not survive session restarts. Files do.

- Want to remember something -> WRITE IT TO A FILE.
- "Remember this" -> update `$AGENT_HOME/memory/YYYY-MM-DD.md` or the relevant entity file.
- Stable user preferences or operating lessons -> update `$AGENT_HOME/instructions/MEMORY.md`.
- Learn a lesson -> update AGENTS.md, TOOLS.md, or the relevant skill file.
- Shared project knowledge -> update the project Library or organization
  workspace, then cite it with a Rudder-renderable link when reporting back.
- Make a mistake -> document it so future-you does not repeat it.
- On-disk text files are always better than holding it in temporary context.

## Memory Recall -- Use The Files Directly

Use the on-disk structure directly. Do not require a semantic index just to
recall memory.

Recall order:

1. If you already know the entity, open `summary.md` first, then `items.yaml`
   only if the summary is insufficient.
2. For recent events, read today's and nearby `memory/YYYY-MM-DD.md` files.
3. For unknown keywords or broad recall, use `rg` across `$AGENT_HOME/life/`
   and `$AGENT_HOME/memory/`.

```bash
rg -n "Christmas" "$AGENT_HOME/life" "$AGENT_HOME/memory"
rg -n "specific phrase" "$AGENT_HOME/life" "$AGENT_HOME/memory"
```

The files are the source of truth. Search is only a way to locate the right
file, then verify against the stored fact or note.

## Shared Work Notes

Keep durable project work notes under `$RUDDER_PROJECT_LIBRARY_ROOT` when a project is in scope and local filesystem access is available. These files are shared project context, not personal memory. Use `$RUDDER_PROJECT_LIBRARY_PATH/<relative-file>` when asking Rudder for a renderable reference to one of those files. Use `rg` to search relevant Library files and prefer the newest dated file when several match. Shared notes go stale; if a newer note exists, do not confuse yourself with an older version. If you notice staleness, update the file to note what supersedes it.
