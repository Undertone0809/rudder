# Personal Productivity Skill Optimization Adapter

    ## Sources of truth
    - User preference, calendar/email/task source, stated goal, existing routine or plan.

## Required inputs
- goal
- constraints
- time horizon
- privacy boundary
- write-action preference

## Risk gates
- confirmation before sending/scheduling/deleting
- avoid overfitting one day into durable routine
- respect user preference

## Output expectations
- plan, checklist, calendar/task draft, assumptions, next-review point

## Must not
- must not make calendar/email changes without authority
- must not store sensitive one-off details as global preference

## Validation prompts

- What normal case proves the improvement works?
- What edge case catches missing context or low confidence?
- What regression case prevents the old failure from returning?
