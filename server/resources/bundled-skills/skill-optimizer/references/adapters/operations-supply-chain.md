# Operations and Supply Chain Skill Optimization Adapter

    ## Sources of truth
    - ERP/WMS/TMS data, vendor contracts, SLA, inventory records, safety rules, contingency plans.

## Required inputs
- facility/region
- time horizon
- constraints
- SLA/safety targets
- vendor/customer impact

## Risk gates
- approval for order changes/cancellations
- safety escalation
- contingency planning
- traceability

## Output expectations
- plan, constraints, assumptions, exception list, owner/action table

## Must not
- must not change orders/vendors silently
- must not ignore safety constraints
- must not hide capacity assumptions

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
