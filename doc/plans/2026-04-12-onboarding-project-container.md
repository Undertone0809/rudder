# Onboarding Project Container

Date: 2026-04-12
Status: Implemented plan record

## Summary

Onboarding keeps its issue-first success path while making the first work artifact feel structured. For a brand-new organization's first launch only, Rudder ensures there is a visible `onboarding` project and places the starter issue inside it.

## Decisions

- Keep the final redirect on the created issue detail page.
- Reuse an existing non-archived project whose name is exactly `onboarding`.
- If none exists, create a normal visible project:
  - `name`: `onboarding`
  - `status`: `planned`
  - `description`: `null`
- Do not use this project when onboarding is reopened only to add another agent to an existing organization.

## Validation

- Browser onboarding E2E should assert the `onboarding` project exists and owns the starter issue.
- Release-smoke onboarding should assert the same linkage.
