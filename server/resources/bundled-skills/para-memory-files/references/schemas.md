# Schemas and Memory Decay

## Atomic Fact Schema (items.yaml)

```yaml
- id: entity-001
  fact: "The actual fact"
  category: relationship | milestone | status | preference
  timestamp: "YYYY-MM-DD"
  source: "YYYY-MM-DD"
  status: active # active | superseded
  superseded_by: null # e.g. entity-002
  related_entities:
    - companies/acme
    - people/jeff
  last_accessed: "YYYY-MM-DD"
  access_count: 0
```

## Daily Note Conversation and Agent Work Capture Entry

Daily notes are lightweight chronological logs. Use this structure when a
Rudder chat, issue run, automation, review, close-out, or other agent execution
event contains durable signal worth retaining.

```md
## HH:MM - Memory capture

- Context: conversation, issue, automation, run, or evidence reference; project;
  and why this mattered.
- User intent: durable correction, preference, constraint, decision, or task
  interpretation.
- Conclusion/action: what changed, what was done, or where it was routed.
- Reusable lesson: future behavior, command, validation signal, or routing rule.
- Follow-up/risk: unresolved uncertainty, owner, promotion target, or none.
```

Keep entries summarized and redacted:

- Do not copy full private transcripts.
- Do not copy raw automation logs, command output, or routine close-out text
  when they add no durable signal beyond the source artifact.
- Do not store secrets, tokens, credentials, private keys, session cookies, or
  auth headers.
- Do not turn one-off sensitive context into durable memory unless the future
  behavioral lesson can be safely stated without the sensitive detail.
- If the information belongs in shared project knowledge, note the routing
  decision in the daily note and promote it to the project Library or
  organization workspace.

## Memory Decay

Facts decay in retrieval priority over time so stale info does not crowd out recent context.

**Access tracking:** When a fact is used in conversation, bump `access_count` and set `last_accessed` to today. During heartbeat extraction, scan the session for referenced entity facts and update their access metadata.

**Recency tiers (for summary.md rewriting):**

- **Hot** (accessed in last 7 days) -- include prominently in summary.md.
- **Warm** (8-30 days ago) -- include at lower priority.
- **Cold** (30+ days or never accessed) -- omit from summary.md. Still in items.yaml, retrievable on demand.
- High `access_count` resists decay -- frequently used facts stay warm longer.

**Weekly synthesis:** Sort by recency tier, then by access_count within tier. Cold facts drop out of the summary but remain in items.yaml. Accessing a cold fact reheats it.

No deletion. Decay only affects retrieval priority via summary.md curation. The full record always lives in items.yaml.

## Memory Search Result Rules

When broad recall uses file search, results are candidates, not facts. Open the
candidate file and verify the stored note or YAML item before answering.

Rank candidates with this bias:

- `summary.md` gives the fastest current entity context.
- `items.yaml` is authoritative for atomic facts; ignore facts with
  `status: superseded` except to explain history or follow `superseded_by`.
- Daily notes are authoritative for raw timeline and conversation capture.
- Newer dated shared work notes usually supersede older shared notes unless the
  older file explicitly remains active.
- Multiple matching terms in one file are stronger than one isolated match.

When a fact is used in the final answer, update access metadata when practical:

```yaml
last_accessed: "YYYY-MM-DD"
access_count: 1
```

Answers should cite the memory file path or Rudder-renderable Library reference
used, state when evidence is weak, and avoid exposing raw private transcript
text unless the exact wording is necessary and safe.
