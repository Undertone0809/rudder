# Document and Data Processing Skill Optimization Adapter

    ## Sources of truth
    - Original documents, schema, extraction rules, validation samples, retention/redaction policy.

## Required inputs
- document set
- schema
- confidence threshold
- PII/PHI handling
- traceability requirement

## Risk gates
- PII redaction/minimization
- source span traceability
- manual review for low confidence
- schema validation

## Output expectations
- structured data, confidence, source spans, validation errors, redaction report

## Must not
- must not fabricate missing fields
- must not drop source traceability
- must not leak sensitive data

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
