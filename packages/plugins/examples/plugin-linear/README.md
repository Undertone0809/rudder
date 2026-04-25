# @rudder/plugin-linear

Import-first Linear connector for Rudder.

This first version focuses on:

- browsing Linear issues from a dedicated plugin page
- importing one, many, or all matching issues into a chosen Rudder project
- storing a one-to-one Rudder issue to Linear issue link
- showing the latest linked Linear issue details in the Rudder issue view

Configuration is token-first by design. The operator should paste a Linear
token and choose the Rudder organization; Rudder then reads teams and workflow
states from Linear and fills the mapping automatically. Raw ids and status
overrides belong behind the advanced mapping disclosure, never in the default
setup path. Settings labels should use normal sentence/title casing rather than
normal sentence casing rather than all-uppercase treatment.

It intentionally does not implement bidirectional sync, comments, webhooks, or status pushback.

Because v1 imports leave assignees unset, any Linear state mapping to Rudder `in_progress` is downgraded to `todo` during import to preserve Rudder's issue invariants.
