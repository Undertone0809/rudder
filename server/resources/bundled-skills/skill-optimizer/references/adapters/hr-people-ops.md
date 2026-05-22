# HR and People Operations Skill Optimization Adapter

    ## Sources of truth
    - Job criteria, HR policy, employment-law guidance, interview rubric, performance records.

## Required inputs
- role/level
- documented criteria
- decision owner
- jurisdiction or policy scope
- confidentiality needs

## Risk gates
- bias mitigation
- protected-class avoidance
- human decision owner
- audit trail for employment decisions

## Output expectations
- criteria-based summary, evidence links, risk flags, human-review state

## Must not
- must not make autonomous hiring/firing decisions
- must not infer protected attributes
- must not expose confidential employee data

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
