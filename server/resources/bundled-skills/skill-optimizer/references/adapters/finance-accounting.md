# Finance and Accounting Skill Optimization Adapter

    ## Sources of truth
    - Source documents, ledger, bank statements, invoices, ERP, accounting policy, tax guidance.

## Required inputs
- entity/period
- currency
- materiality threshold
- source documents
- preparer/reviewer

## Risk gates
- segregation of duties
- audit trail
- approval before filing/payment/trade
- reconciliation checks

## Output expectations
- reconciliation table, exceptions, variance explanation, approval state, source links

## Must not
- must not initiate unauthorized trades/payments/filings
- must not hide assumptions
- must not overwrite ledger data silently

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
