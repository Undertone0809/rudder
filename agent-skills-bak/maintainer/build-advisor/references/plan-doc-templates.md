# Plan Doc Templates

Use this reference whenever `build-advisor` writes, prepares, or asks the user
to approve a plan document under `doc/plans/`.

## Canonical Files

- `doc/plans/_template-proposal.md` is the source of truth for `kind: proposal`.
- `doc/plans/_template-implementation.md` is the source of truth for
  `kind: implementation`.
- `doc/plans/_taxonomy.md` is the source of truth for `area` and `entities`.
- `doc/DEVELOPING.md` explains the plan metadata contract and authoring rules.

Do not duplicate these templates into `SKILL.md`. Read the relevant repo
template at authoring time so future template changes are picked up.

## When To Use The Proposal Template

Use `doc/plans/_template-proposal.md` when the user asks to write a proposal,
or when the work is still deciding product behavior, UX direction, architecture
shape, workflow policy, or scope.

Good fits:

- open-ended feature design
- architecture or workflow proposals that need approval
- standards or governance interventions
- competing options where the recommended direction must be made
  decision-ready

For proposal docs, preserve the proposal template's main sections. The
advisor's in-chat `Recommended Proposal` can inform the content, but the file
should follow the repo template rather than the chat response outline.

## When To Use The Implementation Template

Use `doc/plans/_template-implementation.md` when the direction is already
approved and the next artifact is a scoped delivery plan.

Good fits:

- approved feature delivery
- implementation sequencing after a proposal has been accepted
- bounded technical changes with clear success criteria
- work where the main question is execution order, validation, and risk control

Do not stretch the proposal template into execution tracking. Once the decision
has been made, use the implementation template.

## Authoring Sequence

1. Read `doc/plans/_taxonomy.md`.
2. Inspect nearby prior plans by `area`, `entities`, `related_plans`, and
   slug/title search when relevant.
3. Choose `kind: proposal` or `kind: implementation` based on the decision
   state.
4. Read the matching template file before drafting.
5. Fill the template with concrete evidence, scope boundaries, validation
   expectations, and open decisions.
6. After implementation work lands, update `commit_refs` in the plan when the
   repo rules require it.

If no existing `entity` fits, mint one stable `snake_case` noun and state that
inference in the advisor response or plan notes.
