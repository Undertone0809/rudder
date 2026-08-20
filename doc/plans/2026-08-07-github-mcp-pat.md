---
title: GitHub MCP OAuth provider migration
status: superseded
area: integrations
superseded_by: R6Z-93
---

# GitHub MCP OAuth provider migration

## Historical Decision

The initial R6Z-63 implementation registered GitHub as a curated managed MCP
provider backed by a mutation-only personal access token (PAT). It used the
fixed Streamable HTTP endpoint `https://api.githubcopilot.com/mcp/` and account
scope while this deployment lacked a GitHub OAuth client configuration.

R6Z-93 supersedes that credential flow with a server-configured GitHub OAuth
App, an official browser authorization flow, and an encrypted managed OAuth
grant. The current implementation accepts no PAT input.

## Current Security Boundary

The OAuth client ID and secret are deployment configuration. OAuth access and
refresh tokens remain in encrypted organization secrets. Public connection
summaries expose only `hasCredentials`; safe config contains the fixed endpoint
and account scope. GitHub `read_only` authorization requests only
`read:org read:user user:email read:packages read:project`; the provider's
broader metadata is never used as an implicit scope request.

## Implementation slices

1. Add the provider enum, catalog, server registry, safe config, and canonical
   uniqueness predicate.
2. Add provider-aware OAuth setup and encrypted grant forwarding through the
   existing managed client paths.
3. Add organization/agent permission, lifecycle, scope-policy, and runtime
   forwarding tests.
4. Add settings setup UI and a real end-to-end authorization/discovery check.

## Explicit Non-goals For The Superseded PAT Design

- No current PAT entry or PAT payload.
- No PAT exposure to the browser, Agent prompt, run transcript, or logs.
- No new provider-specific runtime adapter; forwarding remains through the
  existing Rudder managed proxy.
