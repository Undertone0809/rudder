# Generic SaaS Dashboard Data

Use this when the user needs realistic SaaS product, billing, or operations
data outside the Rudder domain.

## Useful Entities

- accounts
- users
- plans
- subscriptions
- invoices
- usage events
- feature adoption events
- support tickets
- incidents
- churn-risk notes

## Good State Mix

- new trial
- activated paid customer
- expansion candidate
- failed payment
- high usage overage
- churn risk
- enterprise account awaiting security review
- dormant account

## Metrics To Include

- MRR
- ARR
- activation rate
- WAU/MAU
- seats used vs seats purchased
- usage by feature
- support response time
- incident count
- churn risk score

## Example Story Spine

A B2B SaaS company is reviewing a launch month. The dashboard should show that
new enterprise trials are growing, one customer has a failed payment, one
account is overusing API calls, and two accounts need customer-success follow-up
before renewal.

## Output Tips

- Use fixed dates over relative labels when generating CSV/JSON.
- Include at least one outlier and one missing/partial value for realistic
  dashboard testing.
- Keep money in cents for programmatic data unless the user asks for display
  strings.
