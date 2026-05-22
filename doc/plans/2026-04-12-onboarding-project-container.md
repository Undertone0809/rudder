# Onboarding Project Container

Date: 2026-04-12
Status: Superseded plan record
Superseded by: 2026-05-08-onboarding-getting-started-dashboard.md

## Summary

This plan records the previous issue-first onboarding behavior. It has been superseded by the Getting Started dashboard handoff plan, which keeps a starter project but no longer creates or opens a starter issue for brand-new organizations.

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
