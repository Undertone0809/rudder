# Domain Adapter Patterns

A domain adapter is a small reference file used by Skill Optimizer when a target skill belongs to a specialized area. It prevents the core optimizer from becoming a giant checklist.

## Adapter shape

```md
# <Domain> Skill Optimization Adapter

## Sources of truth
- ...

## Required inputs
- ...

## Risk gates
- ...

## Output templates
- ...

## Validation cases
- ...

## Must not
- ...
```

## Generic adapter prompts

Ask these questions for any domain:

- What source of truth beats model memory?
- What irreversible or consequential actions exist?
- What review owner is required?
- What private or sensitive information appears?
- What artifact is handed to the next person or system?
- What deterministic checks can verify the work?

## Adapter selection rule

Use an adapter only when it is relevant to the target skill. Do not force every adapter item into the target skill. Convert adapter guidance into a patch only when the current evidence or target skill scope supports it.

## Example domain hooks

Healthcare operations: clinician review, patient safety, PHI minimization, source-of-truth records, no autonomous diagnosis or treatment.

Legal and compliance: jurisdiction, authority, citations, privilege, legal hold, attorney review, no unauthorized legal advice.

Finance and accounting: audit trail, source documents, reconciliation, materiality, approvals, no unauthorized trades or filings.

Education and training: learning objective, accessibility, age appropriateness, rubric, academic integrity, standards alignment.

Research: primary sources, citation provenance, reproducibility, data extraction schema, uncertainty, conflict of evidence.

HR and people operations: bias mitigation, confidentiality, documented criteria, employment-law review, human decision owner.

Customer support and sales: policy source, tone, escalation, refund/contract authority, CRM update approval, no overpromising.

Operations and supply chain: constraints, SLAs, safety, vendor risk, inventory assumptions, escalation and contingency plan.

Creative and brand: brand voice, rights and licenses, review owner, channel constraints, localization, accessibility.

Document and data processing: schema, extraction confidence, PII redaction, traceability, validation sample, error handling.

Software and agent tooling: tests, CI, secrets, prompt injection, rollback, deployment approvals, deterministic scripts.
