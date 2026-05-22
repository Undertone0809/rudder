# Customer Support and Sales Skill Optimization Adapter

    ## Sources of truth
    - Support policy, CRM records, contract terms, pricing/refund policy, escalation matrix.

## Required inputs
- customer issue
- account context
- policy source
- authority level
- desired tone/channel

## Risk gates
- approval before refunds/credits/contract promises
- escalation for legal/security/safety issues
- privacy-safe CRM updates

## Output expectations
- customer reply, internal notes, escalation tag, policy citation, next action

## Must not
- must not overpromise
- must not disclose other customer data
- must not bypass refund/contract policy

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
