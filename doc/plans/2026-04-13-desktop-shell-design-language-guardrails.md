# Desktop Shell Design Language Guardrails

## Summary

- Primary diagnosis: desktop-shell design standards gap.
- Secondary diagnosis: review-process gap for visible desktop shell changes.
- The current desktop shell language exists partly in code and recent feedback, but not as a durable design contract.
- This pass codifies the shell language so future contributors do not regress the translucent shell, paper-like work surfaces, or dark/light separation.

## Implementation Changes

- Extend `doc/DESIGN.md` with explicit rules for desktop shell backdrop tinting in light and dark mode.
- Clarify that the outer desktop shell is backdrop-only and must not read as a parent card around the workspace.
- Clarify that inner work surfaces stay paper-like and readable rather than inheriting full glass treatment.
- Add explicit guardrails for left-rail treatment, shell transparency ownership, and theme separation.
- Add a compact desktop UI review checklist so visible shell changes are reviewed against the same contract.

## Interfaces

- No backend, schema, route, or API changes.
- Documentation-only update affecting design governance for desktop UI work.

## Test Plan

- Review `doc/DESIGN.md` to ensure the new rules are concrete enough to guide implementation and review.
- Verify the guidance covers shell tinting, paper-like work surfaces, and desktop dark/light differentiation.
- Confirm the review checklist is scoped to visible desktop shell changes rather than generic UI changes.

## Assumptions

- `doc/DESIGN.md` remains the canonical design contract for visible Rudder UI work.
- Desktop shell regressions are best prevented through stronger written standards plus a review checklist, not by code comments alone.
- The target language should preserve the current desktop visual direction rather than reopen the design exploration.

## Related Commits

- `da18d2c` `pref: tune desktop transparent window colors`
- `280b0a3` `pref: darken desktop shell backdrop tint`
- `bc8814d` `docs: codify desktop shell design language`
