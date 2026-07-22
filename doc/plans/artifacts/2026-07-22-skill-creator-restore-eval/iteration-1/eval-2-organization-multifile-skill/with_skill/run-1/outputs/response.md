The durable package belongs at:

```text
$RUDDER_ORG_SKILLS_DIR/customer-summary/
├── SKILL.md
├── references/
│   └── style-guide.md
└── scripts/
    └── check_output.py
```

Use this exact workflow. Replace only `<source-package-dir>` and `<agent-id>`.

1. Set explicit paths and verify Rudder context:

```bash
SOURCE_DIR="<source-package-dir>"
SKILL_SLUG="customer-summary"
TARGET_DIR="$RUDDER_ORG_SKILLS_DIR/$SKILL_SLUG"
TARGET_AGENT_ID="<agent-id>"
VALIDATOR="/Users/zeeland/projects/rudder-oss/server/resources/bundled-skills/skill-creator/scripts/quick_validate.py"

test -n "$RUDDER_ORG_ID"
test -n "$RUDDER_ORG_SKILLS_DIR"
test -d "$SOURCE_DIR"
```

2. Inspect the organization Skill Library before creating or replacing anything:

```bash
rudder skill list \
  --org-id "$RUDDER_ORG_ID" \
  --json
```

If `customer-summary` already exists, stop and follow the organization’s approved replacement process. Do not overwrite it implicitly.

3. Verify the source package has the complete expected inventory:

```bash
test -f "$SOURCE_DIR/SKILL.md"
test -f "$SOURCE_DIR/references/style-guide.md"
test -f "$SOURCE_DIR/scripts/check_output.py"

find "$SOURCE_DIR" -type f -print | sort
```

Confirm the inventory includes all three files and no unintended files.

4. Install the complete package into durable organization-owned storage:

```bash
test ! -e "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$SOURCE_DIR"/. "$TARGET_DIR"/
```

Do not place it under `~/.agents/skills`, `~/.codex/skills`, an agent-private directory, or a temporary runtime mount.

5. Verify the copied inventory and validate the installed package:

```bash
test -f "$TARGET_DIR/SKILL.md"
test -f "$TARGET_DIR/references/style-guide.md"
test -f "$TARGET_DIR/scripts/check_output.py"

find "$TARGET_DIR" -type f -print | sort

python "$VALIDATOR" "$TARGET_DIR"
python -m py_compile "$TARGET_DIR/scripts/check_output.py"
```

`check_output.py` itself should only be run against a suitable sample output according to its interface; package validation must not invent an input for it.

6. Import the directory—not merely `SKILL.md`—into the organization Skill Library:

```bash
rudder skill import \
  --org-id "$RUDDER_ORG_ID" \
  --source "$TARGET_DIR" \
  --json
```

Save the returned skill key or selection reference as `<returned-selection-ref>`. Importing the directory registers the complete inventory, including `references/style-guide.md` and `scripts/check_output.py`.

7. Confirm the imported organization skill:

```bash
rudder skill list \
  --org-id "$RUDDER_ORG_ID" \
  --json
```

Verify that `customer-summary` appears and matches the import result.

8. Enable it additively for the selected agent:

```bash
rudder agent skills enable \
  "$TARGET_AGENT_ID" \
  "<returned-selection-ref>" \
  --json
```

Use the exact selection reference returned by the import. Do not use `rudder agent skills sync`: `enable` preserves the agent’s existing optional skills, while `sync` replaces the full optional-skill set.

The skill becomes available to future runs of that agent; it does not alter the skill context already loaded into an active run.