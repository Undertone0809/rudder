# Agent Creation

Use this workflow for an explicit request to create, hire, or configure a
Rudder Agent. A question about Agent behavior or configuration is read-only.
Only an explicit user request to perform the action authorizes mutation, and
normal organization, permission, approval, and safety boundaries still apply.

For exact installed command syntax, use [CLI reference](cli-reference.md) after
checking live capabilities and `--help`. Use [API reference](api-reference.md)
only for internal debugging or compatibility work.

## Section Map

- [Verify authority and context](#verify-authority-and-context)
- [Discover a current runtime configuration](#discover-a-current-runtime-configuration)
- [Design the durable Agent identity](#design-the-durable-agent-identity)
- [Submit the governed hire](#submit-the-governed-hire)
- [Handle direct creation or approval](#handle-direct-creation-or-approval)
- [Report evidence](#report-evidence)

## Verify Authority And Context

Before designing or creating an Agent:

1. Verify the actor, organization, and authentication with
   `rudder agent me --json` or an equivalent exposed typed identity
   capability.
2. Board access may create an Agent. An Agent actor needs
   `canCreateAgents=true` in the same organization.
3. If identity or authorization is unavailable, stop and report the missing
   authority. Do not ask for or print `RUDDER_API_KEY`, create files as a
   substitute, or cross an organization boundary.
4. If the request is advisory rather than an explicit request to create or
   change an Agent, remain read-only and return the verified guidance.

For a source issue, preserve its identity for the hire payload rather than
creating an unlinked Agent and repairing the relationship later.

## Discover A Current Runtime Configuration

Inspect exposed typed capabilities first. If a governed typed Agent-hire
capability is exposed by the current runtime, prefer it. The standard Rudder
control-plane tool set currently has no Agent-hire mutation tool, so verify and
use `rudder agent hire` as the canonical installed fallback.

Discover before drafting:

1. Read `rudder agent config index` to learn which runtime configuration
   documents this instance exposes.
2. Read one relevant `rudder agent config doc <agent-runtime-type>` document.
3. Compare related Agents with `rudder agent list`,
   `rudder agent config list`, and, where necessary,
   `rudder agent config get`.
4. Reuse a proven pattern only after checking that its working directory,
   model, runtime options, and responsibilities fit the new role.
5. If the role needs `desiredSkills` on day one, inspect the organization skill
   inventory and import or validate required skills before hiring. Follow
   [Organization skills](organization-skills.md) for that workflow.

Installed help and live capability evidence win over this reference when a
version differs. Do not hand-create Agent directories, configuration records,
or instruction files as a fallback.

## Design The Durable Agent Identity

An Agent is a durable team member. Draft the smallest complete payload that
defines its organizational responsibility and runnable configuration:

- `name` is optional; when omitted, Rudder assigns a distinct personal name.
- `role` is one fixed enum value: `ceo`, `cto`, `cmo`, `cfo`, `engineer`,
  `designer`, `pm`, `qa`, `devops`, `researcher`, or `general`.
- `title` carries the specific job title. For example, use role `engineer` and
  title `Founding Engineer`, never a new `founding_engineer` role.
- `reportsTo` identifies an in-organization manager and must preserve the
  intended reporting line.
- `capabilities` states the work this Agent owns and the boundaries it should
  not silently cross.
- `agentRuntimeType`, `agentRuntimeConfig`, and `runtimeConfig` must follow the
  current adapter documentation and a valid local environment.
- `desiredSkills` contains only skills already available to the organization
  and actually needed for the role.
- `sourceIssueId` or `sourceIssueIds` links the hire to the originating work.
- Omit `icon` for a normal hire so Rudder assigns its default avatar. Supply an
  icon only when the operator provided an explicit supported reference.

For supported local runtimes, `agentRuntimeConfig.promptTemplate` becomes the
managed `SOUL.md`. Write durable role/persona guidance rather than a one-line
command. A substantial role should define:

- an opening identity statement;
- mission and owned outcome;
- durable responsibilities;
- boundaries and escalation points;
- decision principles;
- communication voice; and
- continuity rules for what should become memory or instruction updates.

Do not copy Rudder's shared filesystem, memory, safety, or operating contract
into `promptTemplate`; the runtime injects that shared contract separately.
Keep secrets out of the payload unless the verified adapter contract requires a
supported secret mechanism.

## Submit The Governed Hire

After the payload and authority are verified, use the exposed governed typed
capability if one exists. Otherwise invoke the installed canonical command:

`rudder agent hire --org-id <org-id> --payload <json> --json`

Verify its exact syntax in [CLI reference](cli-reference.md) or installed
`rudder agent hire --help` immediately before execution. Do not replace it with
manual filesystem changes or `rudder approval create --type hire_agent`.
The canonical hire surface owns both permission checks and the organization's
direct-create versus approval-required policy.

## Handle Direct Creation Or Approval

The canonical response has two governed branches:

- Direct creation: `approval: null`; the returned Agent is created in its
  ordinary post-hire state.
- Approval required: the returned Agent is `pending_approval`, and the response
  includes an approval record.

For `pending_approval`:

1. Inspect it with `rudder approval get` and keep the source issue visible.
2. Use a markdown approval comment when review context or revision evidence is
   needed.
3. If the board requests changes, revise the existing payload and use
   `rudder approval resubmit`; do not create a duplicate hire.
4. Use `rudder approval issues` to inspect linked issues after the server has
   created the canonical linkage.
5. After approval, close a linked issue only when the approved hire resolves
   it; otherwise leave a linked next-action comment.

Never treat a `pending_approval` Agent as runnable, assignable, or fully hired.
Approval, rejection, and revision semantics remain server-owned.

## Report Evidence

Do not report success merely because a payload was drafted or files were
written. Success requires the canonical hire operation to return:

- `agent.id` for the created or pending Agent; and
- `approval.id` when approval is required.

Report the organization, Agent identity, role/title, reporting line, runtime,
source issue, and direct versus approval branch without exposing secrets.
If execution was not explicitly requested, report only the verified proposed
configuration and the current command or capability that would govern it.
