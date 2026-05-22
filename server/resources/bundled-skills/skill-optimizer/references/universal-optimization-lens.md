# Universal Optimization Lens

Use this when a skill optimization is complex, cross-domain, or likely to recur.

## 1. Purpose and scope

- What durable job does this skill own?
- What is explicitly outside scope?
- What user role or team does it serve?
- Does the skill preserve its original identity after the patch?

## 2. Triggering and boundaries

- What should trigger the skill?
- What near-miss queries should not trigger it?
- Which other skills might compete with it?
- Does the description include enough context without becoming keyword spam?

## 3. Inputs and assumptions

- What required inputs must be discovered before work begins?
- What source of truth should be used?
- What units, locale, time zone, standard, or policy applies?
- What should happen when information is missing?

## 4. Workflow and decision rules

- Which steps must happen before others?
- Where are the branch points?
- What are stop conditions?
- Which rules should be deterministic rather than left to judgment?

## 5. Tools and authority

- Which tools are required?
- Which operations are read-only vs write actions?
- Where is dry-run needed?
- What needs explicit approval?

## 6. Outputs and interfaces

- What artifact should be produced?
- What template or schema should be followed?
- What links, citations, IDs, or files must be included?
- Who consumes the output next?

## 7. Quality and evaluation

- What does success mean?
- What validation cases prove the change?
- What regression case prevents old behavior from breaking?
- Is there a deterministic verifier or checklist?

## 8. Safety, privacy, and policy

- What sensitive data could appear?
- What regulated advice or consequential decision is involved?
- What needs consent, review, or audit trail?
- What data should be minimized, redacted, or excluded?

## 9. Failure and recovery

- What should the skill do when blocked?
- What retries are safe?
- What rollback or cleanup path is required?
- What partial result is useful?

## 10. Maintainability

- Is the core `SKILL.md` concise?
- Should details move into references or scripts?
- Are examples realistic?
- Is there a changelog and version note?
