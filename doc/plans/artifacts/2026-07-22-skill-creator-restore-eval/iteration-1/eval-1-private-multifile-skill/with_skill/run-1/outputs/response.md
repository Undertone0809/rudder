Use an agent-private package named `incident-handoff`. Its final installation path is:

```text
$AGENT_HOME/skills/incident-handoff/
├── SKILL.md
├── references/
│   └── checklist.md
└── scripts/
    └── validate_handoff.py
```

Do not use `$RUDDER_ORG_SKILLS_DIR`: that would make it organization-owned rather than private to the current agent.

## 1. Author and install the package

Author directly into the agent-private source-of-truth directory:

```bash
SKILL_SLUG="incident-handoff"
SKILL_DIR="$AGENT_HOME/skills/$SKILL_SLUG"

test -n "$RUDDER_AGENT_ID"
test -n "$AGENT_HOME"
test "$SKILL_DIR" != "/"
test "$SKILL_DIR" != "$AGENT_HOME"

install -d "$SKILL_DIR/references" "$SKILL_DIR/scripts"
```

Create `$AGENT_HOME/skills/incident-handoff/SKILL.md` with:

```markdown
---
name: incident-handoff
description: Create, review, or validate operational incident handoffs during shift changes, responder changes, escalation, or transfer to another team. Use when a user asks for an incident handoff, status transfer, responder briefing, escalation packet, or continuity check. Produce a concise, actionable handoff that separates confirmed facts from hypotheses and makes ownership, risk, evidence, and next actions explicit.
compatibility: Requires Python 3 to run the bundled handoff validator.
---

# Incident Handoff

Create incident handoffs that let a new responder assume control without reconstructing the incident from chat history.

## Workflow

1. Read `references/checklist.md` before drafting or reviewing a handoff.
2. Gather the incident identifier, severity, current state, impact, timeline, evidence, actions taken, unresolved questions, owners, and next update time.
3. Distinguish confirmed facts from hypotheses. Do not invent missing details; mark them as `Unknown` and identify who should resolve them.
4. Identify the active incident commander or owner and the person or team receiving the handoff.
5. Record risky, irreversible, or customer-visible actions separately from routine next steps.
6. Produce the handoff using the format below.
7. Save the Markdown document when a path is available.
8. Run `python3 scripts/validate_handoff.py <handoff.md>` from this skill directory, or use the absolute script path.
9. Correct validation failures before calling the handoff ready. Report warnings that cannot be resolved from available evidence.

## Handoff format

# Incident Handoff: [incident ID or short title]

## Control

- Severity:
- Status:
- Incident commander:
- Handing off from:
- Handing off to:
- Handoff time:
- Next update due:

## Executive summary

[Current situation in two to five sentences.]

## Customer and business impact

- Affected users or systems:
- Scope:
- Start time:
- Current impact:
- Business risk:

## Confirmed facts

- [Fact with evidence or source.]

## Working hypotheses

- [Hypothesis, confidence, and evidence needed to confirm or reject it.]

## Timeline

- [Timestamp] — [Event, observation, or action.]

## Actions completed

- [Action] — [Result] — [Owner]

## Current system state

- Healthy:
- Degraded:
- Unknown:

## Evidence and links

- [Dashboard, log query, ticket, runbook, deployment, or communication link.]

## Risks and constraints

- [Risk, safety constraint, rollback concern, or prohibited action.]

## Next actions

- [ ] [Action] — Owner: [name/team] — Due: [time] — Success signal: [signal]

## Decisions required

- [Decision, deadline, and decision owner.]

## Communications

- Last internal update:
- Last external update:
- Next audience and message:

## Open questions

- [Question] — Owner: [name/team]

## Acknowledgement

- Receiving owner:
- Acknowledged at:
- First action accepted:
```

Create `$AGENT_HOME/skills/incident-handoff/references/checklist.md` with:

```markdown
# Incident handoff checklist

Use this checklist before declaring a handoff ready.

## Control and ownership

- The incident ID or title is unambiguous.
- Severity and current status are stated.
- The active incident commander or owner is named.
- The sender and receiving owner are named.
- Handoff time and next update deadline include a timezone.
- The receiving owner has an explicit acknowledgement field.

## Situation and impact

- The executive summary describes the current situation, not the full history.
- Customer, system, and business impact are quantified where evidence permits.
- Incident start time and current scope are recorded.
- Unknown impact is labeled `Unknown`, not guessed.

## Evidence and reasoning

- Confirmed facts are separated from hypotheses.
- Important claims identify their evidence or source.
- Hypotheses include confidence or a method for testing them.
- Relevant dashboards, logs, tickets, changes, and runbooks are linked.
- Timestamps use one consistent timezone.

## Actions and safety

- Completed actions include their results and owners.
- Next actions have an owner, due time, and success signal.
- Risky or irreversible actions are clearly identified.
- Rollback constraints and prohibited actions are recorded.
- Decisions requiring authorization identify the decision owner and deadline.

## Continuity

- The current state of affected components is summarized.
- Open questions have owners.
- Internal and external communication status is recorded.
- The first action expected from the receiving owner is explicit.
- The handoff is understandable without relying on unstated chat context.
```

Create `$AGENT_HOME/skills/incident-handoff/scripts/validate_handoff.py` with:

```python
#!/usr/bin/env python3
"""Validate the structure and actionable content of an incident handoff."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REQUIRED_SECTIONS = [
    "Control",
    "Executive summary",
    "Customer and business impact",
    "Confirmed facts",
    "Working hypotheses",
    "Timeline",
    "Actions completed",
    "Current system state",
    "Evidence and links",
    "Risks and constraints",
    "Next actions",
    "Decisions required",
    "Communications",
    "Open questions",
    "Acknowledgement",
]

REQUIRED_FIELDS = [
    "Severity:",
    "Status:",
    "Incident commander:",
    "Handing off from:",
    "Handing off to:",
    "Handoff time:",
    "Next update due:",
    "Receiving owner:",
    "Acknowledged at:",
    "First action accepted:",
]

UNRESOLVED_MARKERS = (
    "[incident ID or short title]",
    "[Current situation in two to five sentences.]",
    "[name/team]",
    "[time]",
    "[signal]",
)


def section_body(text: str, heading: str) -> str:
    pattern = re.compile(
        rf"(?ms)^##\s+{re.escape(heading)}\s*$\n(.*?)(?=^##\s+|\Z)"
    )
    match = pattern.search(text)
    return match.group(1).strip() if match else ""


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate an incident-handoff Markdown document."
    )
    parser.add_argument("handoff", type=Path, help="Path to the Markdown handoff")
    args = parser.parse_args()

    if not args.handoff.is_file():
        print(f"ERROR: file not found: {args.handoff}", file=sys.stderr)
        return 2

    text = args.handoff.read_text(encoding="utf-8")
    errors: list[str] = []
    warnings: list[str] = []

    if not re.search(r"(?m)^# Incident Handoff:\s+\S+", text):
        errors.append("Missing a populated '# Incident Handoff:' title.")

    for heading in REQUIRED_SECTIONS:
        body = section_body(text, heading)
        if not body:
            errors.append(f"Missing or empty section: {heading}")

    for field in REQUIRED_FIELDS:
        match = re.search(rf"(?m)^-\s+{re.escape(field)}\s*(.*)$", text)
        if not match or not match.group(1).strip():
            errors.append(f"Missing or empty required field: {field}")

    next_actions = section_body(text, "Next actions")
    if next_actions:
        if not re.search(r"(?m)^-\s+\[[ xX]\]\s+", next_actions):
            errors.append("Next actions must contain at least one task checkbox.")
        for term in ("Owner:", "Due:", "Success signal:"):
            if term not in next_actions:
                errors.append(f"Next actions do not include '{term}'.")

    for marker in UNRESOLVED_MARKERS:
        if marker in text:
            errors.append(f"Unresolved template marker: {marker}")

    if not re.search(
        r"\b(?:UTC|GMT|Z|[A-Z]{2,5}|[+-]\d{2}:\d{2})\b", text
    ):
        warnings.append("No explicit timezone was detected.")

    if "Unknown" not in text:
        warnings.append(
            "No values are marked Unknown; confirm that missing information was not guessed."
        )

    for warning in warnings:
        print(f"WARNING: {warning}")

    for error in errors:
        print(f"ERROR: {error}", file=sys.stderr)

    if errors:
        print(
            f"FAIL: {len(errors)} error(s), {len(warnings)} warning(s).",
            file=sys.stderr,
        )
        return 1

    print(f"PASS: handoff is structurally valid; {len(warnings)} warning(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Make only the validator executable:

```bash
chmod 0755 "$SKILL_DIR/scripts/validate_handoff.py"
chmod 0644 "$SKILL_DIR/SKILL.md" "$SKILL_DIR/references/checklist.md"
```

At this point the package is installed on disk, but it is not yet enabled in Rudder.

## 2. Validate the package

First inspect the complete inventory and reject unexpected files:

```bash
find "$SKILL_DIR" -type f -print | LC_ALL=C sort
```

Expected output:

```text
$AGENT_HOME/skills/incident-handoff/SKILL.md
$AGENT_HOME/skills/incident-handoff/references/checklist.md
$AGENT_HOME/skills/incident-handoff/scripts/validate_handoff.py
```

Compile-check the bundled script without creating `__pycache__`:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m py_compile \
  "$SKILL_DIR/scripts/validate_handoff.py"
```

Run the skill-creator structural validator:

```bash
python3 \
  /Users/zeeland/projects/rudder-oss/server/resources/bundled-skills/skill-creator/scripts/quick_validate.py \
  "$SKILL_DIR"
```

Confirm the required files are present and nonempty:

```bash
test -s "$SKILL_DIR/SKILL.md"
test -s "$SKILL_DIR/references/checklist.md"
test -s "$SKILL_DIR/scripts/validate_handoff.py"
```

Then exercise `validate_handoff.py` against two fixtures stored outside the skill package:

```bash
VALID_FIXTURE="$(mktemp /tmp/incident-handoff-valid.XXXXXX.md)"
INVALID_FIXTURE="$(mktemp /tmp/incident-handoff-invalid.XXXXXX.md)"
```

Populate the valid fixture with every required section and field, ensuring the next action contains `Owner:`, `Due:`, and `Success signal:` and all times specify a timezone. Populate the invalid fixture with only a title.

Expected checks:

```bash
python3 "$SKILL_DIR/scripts/validate_handoff.py" "$VALID_FIXTURE"
test "$?" -eq 0

python3 "$SKILL_DIR/scripts/validate_handoff.py" "$INVALID_FIXTURE"
test "$?" -eq 1
```

Remove the temporary fixtures after validation:

```bash
rm "$VALID_FIXTURE" "$INVALID_FIXTURE"
```

## 3. Enable it for this agent

Because this is a full package containing references and a script, do not use the `rudder agent skills create --markdown-file` shortcut. Enable the installed package additively:

```bash
rudder agent skills enable \
  "$RUDDER_AGENT_ID" \
  "agent:incident-handoff" \
  --json
```

Capture the JSON response as the enablement record. Do not use `rudder skill import`, which is for organization skills, and do not use `skills sync`, which could replace the agent’s existing optional skill selections.

Enablement applies to future runs; it cannot retroactively add the skill to the current run’s already-loaded context.

## 4. Verify installation and runtime behavior

Verify the installed source files again:

```bash
test -f "$AGENT_HOME/skills/incident-handoff/SKILL.md"
test -f "$AGENT_HOME/skills/incident-handoff/references/checklist.md"
test -x "$AGENT_HOME/skills/incident-handoff/scripts/validate_handoff.py"

python3 \
  /Users/zeeland/projects/rudder-oss/server/resources/bundled-skills/skill-creator/scripts/quick_validate.py \
  "$AGENT_HOME/skills/incident-handoff"
```

Treat the successful `skills enable --json` response as proof of Rudder selection, separately from filesystem installation.

Finally, start a new Rudder agent run and issue an explicit smoke-test prompt:

```text
Use $incident-handoff to create a handoff for incident INC-1042. Severity is SEV-2, API writes are failing for about 18% of customers, Alice is handing command to Bob at 2026-07-22 18:30 CST, and the next update is due at 19:00 CST. Mark everything else Unknown, assign owners to open questions, and validate the resulting Markdown.
```

The verification passes only if the new run:

- Loads `incident-handoff`.
- Reads `references/checklist.md`.
- Produces all required handoff sections.
- Preserves unknown information as `Unknown`.
- Runs the installed `validate_handoff.py`.
- Reports a zero exit status or fixes validation errors before presenting the handoff.