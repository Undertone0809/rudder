# Rudder Docs Host Verification

This record separates skill availability from observable skill use. A
Rudder-selected or materialized skill is available to a run; it is only
reported as used below when the transcript shows an attributable read, source
lookup, or answer.

## Official Sources

- `https://docs.rudderhq.dev/llms.txt` returned the official documentation
  index.
- `git ls-remote https://github.com/Undertone0809/rudder.git main` resolved the
  official source repository.

Result: the two preferred remote source routes were available during
verification.

## Real Rudder Codex Runtime

Verification used an isolated worktree instance, organization, agent home, and
real `codex_local` chat run. The agent's skill surface exposed the canonical
selection key `bundled:rudder/rudder-docs`, runtime name `rudder-docs`, and
`alwaysEnabled: true`.

### Negative greeting

- Prompt: `hi`
- Run: `b59023ac-a34f-4991-aa9a-ed3fcf5acd58`
- Status: succeeded
- Reply: `Hi. What do you need help with?`
- Evidence: the adapter materialized seven Rudder-managed skills, but the
  transcript contained no skill read, tool call, documentation lookup, or
  Rudder Docs source consultation. The reasoning classified the request as a
  greeting and answered directly.

Result: canonical default availability did not force observable use.

### Explicit Rudder documentation question

- Prompt: asked where official Rudder documentation discovery should start and
  which official source repository to use when documentation is insufficient;
  explicitly requested the `rudder-docs` skill and exact URLs.
- Run: `8b017827-d4d9-4a26-aee8-2b005cef4361`
- Status: succeeded
- Evidence: the transcript read
  `server/resources/bundled-skills/rudder-docs/SKILL.md`, performed targeted web
  lookup, and answered with `https://docs.rudderhq.dev/llms.txt` first and
  `https://github.com/Undertone0809/rudder` as the official source fallback.

Result: a matching request activated the skill and followed its intended
source order.

## Prompt-Injected OpenCode Runtime

Verification injected the complete Rudder Docs body, matching the current
prompt-based adapter behavior, and used the available
`opencode/deepseek-v4-flash-free` model.

- Negative prompt `hi`: returned only `Hi`; no tool event, docs lookup, or
  skill-driven action occurred even though the body was already in context.
- Positive source-routing prompt: returned
  `https://docs.rudderhq.dev/llms.txt` followed by
  `https://github.com/Undertone0809/rudder` and made no repository edits.

Result: the body-level self-gate works for a representative prompt-injected
host.

## Direct OpenClaw Discovery

An isolated OpenClaw profile installed the package at
`~/.openclaw/skills/rudder-docs/SKILL.md`. `openclaw skills list --json`
reported:

- canonical name `rudder-docs`;
- the intended routing description;
- `eligible: true`;
- `modelVisible: true`; and
- `userInvocable: true`.

The isolated behavioral model invocation could not authenticate to its
configured provider and returned HTTP 401. Therefore this check establishes
direct OpenClaw discovery and router availability, but does not claim a
successful OpenClaw model-behavior run.

## Conclusion

The available evidence supports all three intended boundaries:

1. Rudder can keep `rudder-docs` selected and discoverable by default.
2. Native and prompt-injected hosts can avoid a documentation workflow for a
   greeting.
3. A matching Rudder question can read the skill and route to official docs,
   then official source.

The OpenClaw behavioral check remains explicitly bounded by provider
authentication rather than being inferred from discovery metadata.
