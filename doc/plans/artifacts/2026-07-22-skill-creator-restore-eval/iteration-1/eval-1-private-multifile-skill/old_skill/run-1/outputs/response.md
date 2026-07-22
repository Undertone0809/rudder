I inspected only `/tmp/rudder-skill-creator-old-private.tBz0nO/old_skill/SKILL.md`. It contains no additional scaffolding, installation, or enablement conventions. No mutations were executed.

The Rudder variables were not visible in the read-only shell, so paths below intentionally resolve from the supplied environment at execution time.

## Paths

- Authoring/staging:
  `/tmp/rudder-skill-creator-old-private.tBz0nO/incident-handoff`
- Current-agent installation:
  `$AGENT_HOME/skills/incident-handoff`
- Shared organization directory, deliberately unused:
  `$RUDDER_ORG_SKILLS_DIR`

Final layout:

```text
$AGENT_HOME/skills/incident-handoff/
├── SKILL.md
├── references/
│   └── checklist.md
└── scripts/
    └── validate_handoff.py
```

## 1. Preflight

Run before authoring:

```zsh
set -euo pipefail

: "${RUDDER_AGENT_ID:?RUDDER_AGENT_ID is required}"
: "${RUDDER_ORG_ID:?RUDDER_ORG_ID is required}"
: "${AGENT_HOME:?AGENT_HOME is required}"
: "${RUDDER_ORG_SKILLS_DIR:?RUDDER_ORG_SKILLS_DIR is required}"

STAGE="/tmp/rudder-skill-creator-old-private.tBz0nO/incident-handoff"
TARGET="${AGENT_HOME%/}/skills/incident-handoff"

printf 'Agent:  %s\nOrg:    %s\nStage:  %s\nTarget: %s\n' \
  "$RUDDER_AGENT_ID" "$RUDDER_ORG_ID" "$STAGE" "$TARGET"

test ! -e "$STAGE" || {
  print -u2 "Refusing to overwrite staging path: $STAGE"
  exit 1
}

test ! -e "$TARGET" || {
  print -u2 "Refusing to overwrite installed skill: $TARGET"
  exit 1
}
```

## 2. Author the three files

Create private staging directories:

```zsh
umask 077
install -d -m 700 "$STAGE/references" "$STAGE/scripts"
```

### `SKILL.md`

Write this to `$STAGE/SKILL.md`:

```markdown
---
name: incident-handoff
description: Create, review, or validate a structured operational incident handoff when incident ownership changes, including shift changes, escalation, or transfer to another responder.
---

# Incident Handoff

Create a concise, factual handoff that lets the receiving responder continue incident work without reconstructing context.

## Workflow

1. Gather confirmed facts, current ownership, timestamps, evidence, decisions, and open work.
2. Do not invent missing information. State unknowns explicitly.
3. Do not include passwords, tokens, credentials, or other secret values.
4. Use the required structure below.
5. Review `references/checklist.md`.
6. Validate the finished Markdown file:

   `python3 "$AGENT_HOME/skills/incident-handoff/scripts/validate_handoff.py" HANDOFF.md`

7. Resolve every validation error before declaring the handoff ready.

## Required structure

# Incident Handoff

## Incident Identity

- Incident ID: value
- Severity: value
- Status: value
- Started: ISO-8601 timestamp
- Handoff time: ISO-8601 timestamp
- Outgoing owner: value
- Incoming owner: value

## Executive Summary

State what happened, the present condition, and why ownership is changing.

## Customer Impact

Describe affected customers, functions, regions, duration, and magnitude. Write `None confirmed` when appropriate.

## Current State

Describe system health, active mitigations, and whether impact is improving, stable, or worsening.

## Timeline

List material events chronologically with timezone-qualified timestamps.

## Actions Taken

Record completed or attempted actions and their observed results.

## Evidence and Links

Provide relevant dashboards, logs, traces, tickets, runbooks, and communication links. Do not copy secret values.

## Risks and Unknowns

List unresolved questions, assumptions, hazards, and conditions that could worsen the incident. Write `None known` when appropriate.

## Next Actions

List ordered actions with an owner, due time, and status.

## Ownership and Escalation

Identify the current decision-maker, escalation contacts, and the conditions that require escalation.

## Communications

Record the latest stakeholder update, its timestamp, audience, and the next planned update.

## Acknowledgement

Record whether the incoming owner accepted the handoff and at what time.
```

### `references/checklist.md`

Write this to `$STAGE/references/checklist.md`:

```markdown
# Incident handoff checklist

## Accuracy

- Separate confirmed facts from hypotheses.
- Use absolute, timezone-qualified ISO-8601 timestamps.
- State unknown information explicitly.
- Record the result of each attempted action.
- Confirm links point to the intended incident resources.
- Exclude passwords, tokens, credentials, and secret values.

## Operational continuity

- Identify outgoing and incoming owners.
- Explain the current customer impact and system state.
- Record active mitigations and rollback considerations.
- List next actions in priority order.
- Give every next action an owner, due time, and status.
- State escalation contacts and escalation conditions.
- Record the next communication deadline.

## Transfer

- The incoming owner has reviewed the handoff.
- The incoming owner can access the linked evidence and tools.
- Any access gaps are documented and assigned.
- The acknowledgement includes a timestamp.
- The outgoing owner remains available until acceptance or an explicit fallback is documented.
```

### `scripts/validate_handoff.py`

Write this to `$STAGE/scripts/validate_handoff.py`:

```python
#!/usr/bin/env python3
"""Validate a Markdown incident handoff without external dependencies."""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

REQUIRED_SECTIONS = (
    "Incident Identity",
    "Executive Summary",
    "Customer Impact",
    "Current State",
    "Timeline",
    "Actions Taken",
    "Evidence and Links",
    "Risks and Unknowns",
    "Next Actions",
    "Ownership and Escalation",
    "Communications",
    "Acknowledgement",
)

REQUIRED_FIELDS = (
    "Incident ID",
    "Severity",
    "Status",
    "Started",
    "Handoff time",
    "Outgoing owner",
    "Incoming owner",
)

PLACEHOLDER_RE = re.compile(
    r"<[^>\n]+>|\b(?:TBD|TODO|FIXME|REPLACE_ME)\b",
    re.IGNORECASE,
)


def parse_sections(text: str) -> tuple[list[str], dict[str, str]]:
    matches = list(re.finditer(r"(?m)^##\s+(.+?)\s*$", text))
    names = [match.group(1).strip() for match in matches]
    bodies: dict[str, str] = {}

    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        bodies[match.group(1).strip()] = text[start:end].strip()

    return names, bodies


def field_value(body: str, field: str) -> str | None:
    match = re.search(
        rf"(?mi)^-\s*{re.escape(field)}:\s*(.*?)\s*$",
        body,
    )
    return match.group(1).strip() if match else None


def valid_timestamp(value: str) -> bool:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return parsed.tzinfo is not None


def validate(text: str) -> list[str]:
    errors: list[str] = []

    if not re.search(r"(?m)^# Incident Handoff\s*$", text):
        errors.append("missing exact top-level heading: # Incident Handoff")

    names, sections = parse_sections(text)

    for section in REQUIRED_SECTIONS:
        count = names.count(section)
        if count == 0:
            errors.append(f"missing section: ## {section}")
        elif count > 1:
            errors.append(f"duplicate section: ## {section}")
        elif not sections.get(section, "").strip():
            errors.append(f"empty section: ## {section}")

    present_required = [name for name in names if name in REQUIRED_SECTIONS]
    if present_required != list(REQUIRED_SECTIONS):
        errors.append("required sections are not in the prescribed order")

    identity = sections.get("Incident Identity", "")
    values: dict[str, str] = {}

    for field in REQUIRED_FIELDS:
        value = field_value(identity, field)
        if not value:
            errors.append(f"missing or empty identity field: {field}")
        else:
            values[field] = value

    for field in ("Started", "Handoff time"):
        value = values.get(field)
        if value and not valid_timestamp(value):
            errors.append(
                f"{field} must be an ISO-8601 timestamp with timezone: {value!r}"
            )

    placeholders = sorted(set(match.group(0) for match in PLACEHOLDER_RE.finditer(text)))
    if placeholders:
        errors.append("unresolved placeholders: " + ", ".join(placeholders))

    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("handoff", type=Path, help="Markdown handoff to validate")
    args = parser.parse_args()

    try:
        text = args.handoff.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        print(f"ERROR: cannot read {args.handoff}: {exc}", file=sys.stderr)
        return 2

    errors = validate(text)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    print(f"VALID: {args.handoff}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Set permissions:

```zsh
chmod 600 "$STAGE/SKILL.md" "$STAGE/references/checklist.md"
chmod 700 "$STAGE/scripts/validate_handoff.py"
```

## 3. Validate before installation

Confirm the package contains exactly the requested files:

```zsh
ACTUAL="$(
  cd "$STAGE"
  find . -type f -print | LC_ALL=C sort
)"
EXPECTED=$'./SKILL.md\n./references/checklist.md\n./scripts/validate_handoff.py'

test "$ACTUAL" = "$EXPECTED" || {
  print -u2 "Unexpected package contents:"
  print -u2 -- "$ACTUAL"
  exit 1
}
```

Perform non-writing Python syntax validation:

```zsh
python3 -c '
import ast
import pathlib
import sys
ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
' "$STAGE/scripts/validate_handoff.py"
```

Then test both validator outcomes using a temporary directory:

```zsh
TEST_DIR="$(mktemp -d)"
trap 'rm -rf -- "$TEST_DIR"' EXIT

cat > "$TEST_DIR/good.md" <<'EOF'
# Incident Handoff

## Incident Identity
- Incident ID: INC-123
- Severity: SEV-2
- Status: Mitigated
- Started: 2026-07-22T09:00:00+08:00
- Handoff time: 2026-07-22T10:00:00+08:00
- Outgoing owner: Alice
- Incoming owner: Bob

## Executive Summary
API errors are mitigated; monitoring continues during ownership transfer.

## Customer Impact
Elevated API error rates affected some customers.

## Current State
Error rates have returned to baseline.

## Timeline
- 2026-07-22T09:00:00+08:00 — Alert fired.

## Actions Taken
- Rolled back the latest deployment; error rates decreased.

## Evidence and Links
- Incident dashboard: https://example.invalid/dashboard

## Risks and Unknowns
None known.

## Next Actions
- Monitor error rate | Owner: Bob | Due: 2026-07-22T10:30:00+08:00 | Status: Open

## Ownership and Escalation
Bob owns the incident; escalate if errors exceed the alert threshold.

## Communications
Last update sent at 2026-07-22T09:50:00+08:00; next update due at 10:30.

## Acknowledgement
Bob accepted the handoff at 2026-07-22T10:00:00+08:00.
EOF

"$STAGE/scripts/validate_handoff.py" "$TEST_DIR/good.md"

printf '# Incident Handoff\n' > "$TEST_DIR/bad.md"
if "$STAGE/scripts/validate_handoff.py" "$TEST_DIR/bad.md"; then
  print -u2 "Validator incorrectly accepted an invalid handoff"
  exit 1
fi
```

## 4. Install for only the current agent

Resolve and guard the target before copying:

```zsh
AGENT_ROOT="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$AGENT_HOME")"
ORG_ROOT="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RUDDER_ORG_SKILLS_DIR")"
SKILLS_ROOT="$AGENT_ROOT/skills"
TARGET="$SKILLS_ROOT/incident-handoff"
INSTALL_TMP="$SKILLS_ROOT/.incident-handoff.install.$$"

case "$TARGET/" in
  "$AGENT_ROOT/"*) ;;
  *)
    print -u2 "Target escapes AGENT_HOME: $TARGET"
    exit 1
    ;;
esac

case "$TARGET/" in
  "$ORG_ROOT/"*)
    print -u2 "Refusing organization-scoped installation: $TARGET"
    exit 1
    ;;
esac

test ! -e "$TARGET"
test ! -e "$INSTALL_TMP"

install -d -m 700 "$SKILLS_ROOT"
install -d -m 700 "$INSTALL_TMP/references" "$INSTALL_TMP/scripts"
install -m 600 "$STAGE/SKILL.md" "$INSTALL_TMP/SKILL.md"
install -m 600 "$STAGE/references/checklist.md" \
  "$INSTALL_TMP/references/checklist.md"
install -m 700 "$STAGE/scripts/validate_handoff.py" \
  "$INSTALL_TMP/scripts/validate_handoff.py"

mv "$INSTALL_TMP" "$TARGET"
```

Nothing should be copied, linked, or registered under `$RUDDER_ORG_SKILLS_DIR`.

## 5. Enablement

The supplied skill-creator definition specifies no Rudder enablement CLI. Therefore, the justified enablement mechanism is agent-scoped discovery by installing at:

```text
$AGENT_HOME/skills/incident-handoff/SKILL.md
```

After installation, begin a fresh Rudder turn/session for the same `$RUDDER_AGENT_ID` so any startup-time skill index is refreshed. Do not add an organization registration step.

## 6. Verify installation and behavior

Verify disk contents and equality:

```zsh
test -f "$TARGET/SKILL.md"
test -f "$TARGET/references/checklist.md"
test -x "$TARGET/scripts/validate_handoff.py"

diff -qr "$STAGE" "$TARGET"

find "$TARGET" -type f -print | LC_ALL=C sort
"$TARGET/scripts/validate_handoff.py" "$TEST_DIR/good.md"
```

In a fresh session for the same agent, use this behavioral prompt:

```text
Create an incident handoff for a SEV-2 API incident whose ownership is
moving from Alice to Bob. Use the incident-handoff skill, state unknowns
explicitly, and validate the final Markdown with its bundled validator.
Report the validator exit status.
```

Successful verification requires:

- The current agent discovers and follows `incident-handoff`.
- The output uses all required sections.
- The bundled validator exits `0`.
- Another agent cannot discover it through `$RUDDER_ORG_SKILLS_DIR`.
- No files were installed outside `$AGENT_HOME/skills/incident-handoff`.