# Healthcare Operations Skill Optimization Adapter

    ## Sources of truth
    - EHR or approved clinical system, current care protocol, clinician instruction, scheduling/billing policy.

## Required inputs
- patient context only when necessary
- task owner
- clinical vs administrative boundary
- consent or authorization state

## Risk gates
- clinician review for clinical content
- PHI minimization
- urgent red-flag escalation
- audit trail for patient-facing actions

## Output expectations
- source-of-truth references, patient-safe summary, escalation notes, human-review status

## Must not
- must not diagnose
- must not recommend treatment autonomously
- must not expose PHI unnecessarily

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
