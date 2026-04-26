# @rudderhq/plugin-linear

Import-first Linear connector for Rudder.

This first version focuses on:

- browsing Linear issues from a dedicated plugin page
- importing one, many, or all matching issues into a chosen Rudder project
- storing a one-to-one Rudder issue to Linear issue link
- showing the latest linked Linear issue details in the Rudder issue view

Configuration is token-first by design. The operator should paste a Linear
token and choose the Rudder organization; Rudder then reads teams and workflow
states from Linear automatically. The default setup path exposes team choices
and optional status rules using Linear names only. Raw ids and implementation
mapping language should not appear in the user-facing setup path. Settings
labels should use normal sentence/title casing rather than all-uppercase
treatment.

It intentionally does not implement bidirectional sync, comments, webhooks, or status pushback.

Because v1 imports leave assignees unset, any Linear state mapping to Rudder `in_progress` is downgraded to `todo` during import to preserve Rudder's issue invariants.
