# Rudder Compatibility

Read this reference whenever the run exposes Rudder context such as
`RUDDER_AGENT_ID`, `RUDDER_ORG_ID`, `AGENT_HOME`, or
`RUDDER_ORG_SKILLS_DIR`. Rudder decides which skills are enabled for a run, so
filesystem discovery by Codex, Claude, or another provider is not sufficient.

Inside Rudder, this is the default compatibility guide. Do not also load a
guide from `references/compatibility/` unless the user explicitly requests
provider-native compatibility, packaging, evaluation, or a cross-host
comparison.

## Choose Ownership Before Writing

Use the narrowest durable owner that matches the user's intent:

- **Current agent only:** install the complete package under
  `$AGENT_HOME/skills/<slug>`.
- **Organization or team:** install the complete package under
  `$RUDDER_ORG_SKILLS_DIR/<slug>` and import it into the organization Skill
  Library.

Do not use `~/.agents/skills`, a provider-native skill directory, or a temporary
runtime mount as Rudder's source of truth. Those locations may be discoverable,
but Rudder loads only the skills resolved for the agent and invocation.

## Agent-Private Skills

For a `SKILL.md`-only package, the first-party creation command can create and
enable it in one operation:

```bash
rudder agent skills create "$RUDDER_AGENT_ID" \
  --name "<name>" \
  --slug "<slug>" \
  --markdown-file <path-to-SKILL.md> \
  --enable \
  --json
```

For a package with scripts, references, assets, or agent metadata, write the
whole directory to `$AGENT_HOME/skills/<slug>`, validate it there, and then
enable it additively:

```bash
rudder agent skills enable "$RUDDER_AGENT_ID" "agent:<slug>" --json
```

Do not claim the skill will load merely because its files exist. Report the
installed and enabled states separately, and remember that enablement affects
future runs rather than rewriting the current run's loaded context.

## Organization Skills

Importing or replacing an organization skill is a governed mutation. Proceed
only when the user explicitly requested organization sharing and the current
actor has organization Skill management permission. Inspect the current
library first so an existing same-name package is not overwritten by surprise.

After writing and validating the complete package at
`$RUDDER_ORG_SKILLS_DIR/<slug>`, register its full file inventory:

```bash
rudder skill import \
  --org-id "$RUDDER_ORG_ID" \
  --source "$RUDDER_ORG_SKILLS_DIR/<slug>" \
  --json
```

Use the returned key or selection reference when enabling the skill for an
agent:

```bash
rudder agent skills enable "<agent-id>" "<returned-selection-ref>" --json
```

Importing and enabling are separate operations. `skills enable` is additive;
do not use `skills sync` unless the user explicitly wants to replace the full
optional skill set and every desired existing selection has been preserved.

## Eval And Review Workspace

Bundled Rudder skills and provider materializations are read-only inputs. Keep
evaluation outputs elsewhere:

- With project context, prefer
  `$RUDDER_PROJECT_LIBRARY_ROOT/skill-evals/<slug>-workspace/`.
- Without project context, use
  `$RUDDER_ORG_WORKSPACE_ROOT/artifacts/YYYY-MM-DD/skill-evals/<slug>-workspace/`.

Keep the normal `iteration-N/eval-name/{with_skill,old_skill}/` layout inside
that directory. Generate the review viewer there and return a Rudder-visible
Library link when the environment provides the Library reference command.

Never print or request `RUDDER_API_KEY`. Use the injected Rudder CLI context and
the typed Rudder tools when available.
