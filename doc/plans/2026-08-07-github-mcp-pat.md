---
title: GitHub MCP PAT provider
status: active
area: integrations
---

# GitHub MCP PAT provider

## Decision

Register GitHub as a curated managed MCP provider backed by a GitHub personal
access token (PAT) for the first release. The provider uses the fixed
Streamable HTTP endpoint `https://api.githubcopilot.com/mcp/` and account scope.
It is intentionally not part of Rudder's OAuth registry because this
deployment has no GitHub OAuth client configuration.

## Security boundary

The PAT is accepted only as mutation input and is stored through the existing
organization secret service. Public connection summaries expose only
`hasCredentials`; safe config contains the fixed endpoint and account scope.
The organization/agent target, agent access mode, connection lifecycle, and
managed proxy remain shared with the existing curated providers.

## Implementation slices

1. Add the provider enum, catalog, server registry, safe config, PAT validator,
   and canonical uniqueness predicate.
2. Add provider-aware connection setup and credential forwarding through the
   existing encrypted secret and managed client paths.
3. Add organization/agent permission, lifecycle, and runtime forwarding tests.
4. Add settings setup UI and a real end-to-end connection/discovery check.

## Explicit non-goals

- No GitHub OAuth flow or dynamically registered OAuth client.
- No PAT exposure to the browser, Agent prompt, run transcript, or logs.
- No new provider-specific runtime adapter; forwarding remains through the
  existing Rudder managed proxy.
