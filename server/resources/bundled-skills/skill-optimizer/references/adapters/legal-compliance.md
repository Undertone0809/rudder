# Legal and Compliance Skill Optimization Adapter

    ## Sources of truth
    - Applicable law/regulation, jurisdiction, contract/source document, internal policy, attorney/compliance owner.

## Required inputs
- jurisdiction
- document version
- party names if needed
- review owner
- filing/effective date

## Risk gates
- attorney/compliance review
- citation/source requirement
- privilege/confidentiality handling
- approval before filing/sending

## Output expectations
- issue list, source citations, risk level, review notes, not-legal-advice language when appropriate

## Must not
- must not provide unauthorized legal advice
- must not fabricate citations
- must not submit filings without approval

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
