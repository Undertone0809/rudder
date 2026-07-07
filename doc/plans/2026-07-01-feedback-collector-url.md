---
title: Feedback Collector URL And Feishu Delivery
date: 2026-07-01
kind: proposal
status: proposed
area: api
entities:
  - product_feedback
  - feedback_collector
  - feishu_webhook
  - feedback_prompt
issue:
related_plans:
  - 2026-04-27-agent-self-iteration-feedback-system.md
  - 2026-05-02.agent-self-improvement-proposal.md
supersedes: []
related_code:
  - packages/db/src/schema
  - packages/shared/src/validators/organization.ts
  - server/src/routes/orgs.ts
  - server/src/services
  - server/src/config.ts
  - ui/src/components/Layout.tsx
  - ui/src/api/orgs.ts
commit_refs: []
updated_at: 2026-07-01
---

# Feedback Collector URL And Feishu Delivery

## Goal

Add a low-friction product feedback prompt that stores structured feedback locally first and optionally delivers a sanitized notification to the Rudder team through a configured collector URL. Feishu is supported as the first external delivery target via an incoming group bot webhook.

This is not the full run-feedback / learning-loop system. It is the first product feedback intake path for learning where Rudder is helping or blocking real agent-work loops.

## Product Shape

- Rudder may ask for feedback after meaningful usage, with a minimum prompt interval of three days.
- Feedback is organization-scoped.
- Feedback is stored in Rudder before any network delivery is attempted.
- Remote delivery is opt-in and controlled by server-side configuration.
- No transcripts, prompts, raw logs, file paths, secrets, or raw diagnostics are sent by default.
- Feishu delivery is a notification sink, not the source of truth.

## Recommended First Version

### Server configuration

Add these environment-backed settings:

```text
RUDDER_FEEDBACK_COLLECTOR_URL=
RUDDER_FEEDBACK_COLLECTOR_KIND=generic_json | feishu_webhook
RUDDER_FEEDBACK_COLLECTOR_ENABLED=true | false
RUDDER_FEEDBACK_COLLECTOR_TIMEOUT_MS=5000
RUDDER_FEEDBACK_FEISHU_SECRET=
```

Behavior:

- If no collector URL is configured, feedback remains local-only.
- `generic_json` posts the canonical sanitized feedback envelope as JSON.
- `feishu_webhook` transforms the feedback envelope into a Feishu incoming webhook message.
- The webhook URL and Feishu signing secret are never returned to the browser.

### Database schema

Create `feedback_entries`:

```text
id uuid primary key
org_id uuid not null references organizations(id) on delete cascade
actor_type text not null default 'user'
actor_id text not null
source text not null default 'feedback_modal'
trigger text not null
outcome text not null
tags jsonb not null default '[]'
message text
surface text
route_path text
app_version text
platform text
locale text
diagnostics_consent boolean not null default false
diagnostics jsonb not null default '{}'
delivery_status text not null default 'not_configured'
delivery_error text
delivered_at timestamp with time zone
created_at timestamp with time zone not null default now()
updated_at timestamp with time zone not null default now()
```

Indexes:

- `(org_id, created_at)` for inbox/review.
- `(org_id, delivery_status, created_at)` for retryable delivery.
- Optional `(org_id, source, created_at)` if analytics uses source filters.

Delivery status values:

```text
not_configured
queued
sent
failed
skipped
```

For MVP, a separate delivery-attempt table is optional. Add it only if retry history matters immediately.

### Shared API contract

Add shared validators/types:

```text
feedbackOutcome:
  completed
  partially_completed
  blocked
  unclear

feedbackTag:
  agent_misunderstood
  task_state_unclear
  result_untrusted
  tool_or_integration_failed
  ui_or_workflow_complex
  too_slow
  other

feedbackTrigger:
  run_completed
  run_failed
  task_stalled
  periodic_nudge
  manual
```

Request body:

```ts
type SubmitProductFeedbackRequest = {
  source?: 'feedback_modal';
  trigger: FeedbackTrigger;
  outcome: FeedbackOutcome;
  tags?: FeedbackTag[];
  message?: string | null;
  surface?: string | null;
  routePath?: string | null;
  diagnosticsConsent?: boolean;
  diagnostics?: Record<string, unknown>;
};
```

Response body:

```ts
type SubmitProductFeedbackResponse = {
  id: string;
  deliveryStatus: 'not_configured' | 'queued' | 'sent' | 'failed' | 'skipped';
};
```

### API route

Add:

```text
POST /api/orgs/:orgId/feedback
```

Route rules:

1. `assertCompanyAccess(req, orgId)`.
2. Board users can submit product feedback.
3. Agent keys should not use the product feedback modal endpoint in MVP unless a later agent-feedback contract explicitly allows it.
4. Validate body with shared schema.
5. Sanitize message and diagnostics.
6. Insert `feedback_entries`.
7. Record material activity, for example `feedback.submitted`, with the feedback entry id and safe summary details.
8. Attempt delivery asynchronously or in a short bounded server-side call.
9. Return success after local persistence even if delivery fails.

### Feedback service

Add `server/src/services/feedback.ts` with these responsibilities:

- `createFeedback(input)` inserts local feedback.
- `deliverFeedback(entry)` decides local-only vs configured collector.
- `buildCanonicalFeedbackEnvelope(entry)` creates the generic JSON payload.
- `sendGenericJsonFeedback(url, envelope)` posts JSON.
- `sendFeishuWebhookFeedback(url, envelope, options)` posts Feishu message payload.

Canonical collector envelope:

```ts
type FeedbackCollectorEnvelope = {
  schemaVersion: 'rudder.feedback.v1';
  feedbackId: string;
  orgId: string;
  source: 'feedback_modal';
  trigger: FeedbackTrigger;
  outcome: FeedbackOutcome;
  tags: FeedbackTag[];
  message: string | null;
  surface: string | null;
  routePath: string | null;
  appVersion: string | null;
  platform: string | null;
  locale: string | null;
  diagnosticsConsent: boolean;
  diagnostics: Record<string, unknown>;
  createdAt: string;
};
```

Redaction guardrails:

- Limit `message` length, for example 2,000 chars.
- Limit diagnostic payload depth and total size.
- Remove keys matching token/secret/password/auth/cookie/header/privateKey.
- Do not include transcript, prompt, raw logs, local absolute paths, env vars, or full stack traces.

### Feishu support

Yes, Feishu is a good first sink.

Use a Feishu custom bot incoming webhook in a private Rudder feedback group. The server should transform the canonical envelope into a compact Feishu card or text message.

Recommended Feishu content:

```text
New Rudder feedback
Outcome: Partly, needed intervention
Trigger: run_failed
Tags: tool_or_integration_failed, result_untrusted
Surface: /org/acme/agents/...
Message: user-provided text
Feedback ID: ...
Created: ...
```

Do not send raw diagnostics unless `diagnosticsConsent` is true, and even then only sanitized diagnostics.

Feishu delivery can start with text messages for reliability. Interactive cards can be added later after payload validation is tested against Feishu.

### UI prompt

Add a top-level `FeedbackPrompt` component mounted in `Layout` after onboarding/tour gates.

Local storage keys should be scoped by organization:

```text
rudder.feedbackPrompt.<orgId>.lastPromptedAt
rudder.feedbackPrompt.<orgId>.lastSubmittedAt
rudder.feedbackPrompt.<orgId>.dismissCount
rudder.feedbackPrompt.<orgId>.snoozedUntil
```

Prompt eligibility:

- selected organization exists
- not onboarding
- not product tour
- not another blocking dialog
- has meaningful usage signal
- last prompt was at least 3 days ago
- last submission was at least 14 days ago
- after two dismissals, snooze for 14-30 days

Initial meaningful usage signals can be conservative:

- route visit to run/agent/issue surfaces plus recent activity count, or
- manual trigger in About/Settings, or
- explicit run completion hook if available in current UI state.

Copy:

```text
Did Rudder help move your work forward?
```

Outcome options:

- Yes, it completed what I needed
- Partly, but I still had to intervene
- No, I got blocked
- I’m not sure yet

Tags:

- Agent misunderstood the task
- Task state was unclear
- Result did not feel trustworthy
- Tool or integration failed
- UI/workflow was too complex
- Too slow
- Other

Buttons:

- Send feedback
- Not now
- Don’t ask again for a while

Remote disclosure when a collector is configured:

```text
This sends your selected answers and written comments to Rudder maintainers. No transcripts or logs are included unless you opt in.
```

For MVP, if the browser does not know whether a collector exists, use safer copy:

```text
Rudder stores this feedback locally. If this instance has maintainer feedback delivery configured, a sanitized copy may be sent to the Rudder maintainers.
```

A later `/api/feedback/config` read endpoint can expose only safe booleans such as `remoteDeliveryConfigured` and `diagnosticsSupported`.

### Tests

Server unit/integration tests:

- `POST /api/orgs/:orgId/feedback` stores valid feedback.
- wrong organization is forbidden.
- invalid outcome/tag/trigger returns 400/422.
- response does not expose collector URL or secret.
- no collector URL gives `not_configured` and still returns 201.
- generic collector sends canonical sanitized envelope.
- Feishu collector sends Feishu-shaped payload without tokens/secrets/logs.
- delivery failure stores local feedback and marks `failed` without returning 500.

Shared tests:

- feedback validator accepts intended payload.
- feedback validator rejects unknown enum values and overlong message.

UI tests:

- eligibility logic respects 3-day prompt cooldown.
- submission calls `organizationsApi.submitFeedback` and records `lastSubmittedAt`.
- dismiss records prompt/dismiss state and does not submit.
- prompt is hidden during onboarding/product tour.

E2E:

- With local test server and mocked collector, simulate eligible usage, submit feedback, verify modal closes and server records entry.
- Verify no transcript/log text appears in captured collector body.

### Verification commands

Focused implementation verification:

```sh
CI=true corepack pnpm exec vitest run \
  packages/shared/src/validators/feedback.test.ts \
  server/src/__tests__/feedback-routes.test.ts \
  ui/src/components/FeedbackPrompt.test.tsx

CI=true corepack pnpm --filter @rudderhq/server typecheck
CI=true corepack pnpm --filter @rudderhq/ui typecheck
```

Full handoff verification after implementation:

```sh
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm product-logic:check
```

Run the relevant E2E suite because this is user-visible workflow work.

## Rollout Phases

### Phase 1: Local feedback + configured collector

- DB table and route.
- UI prompt with local frequency control.
- Generic JSON and Feishu webhook sinks.
- Local persistence wins over remote delivery.

### Phase 2: Maintainer inbox

- Add a simple feedback inbox in Rudder or internal maintainer tooling.
- Add filtering by outcome, tag, org, route, and delivery status.
- Add manual retry for failed delivery.

### Phase 3: Product learning bridge

- Convert selected feedback into issue, learning proposal, or skill-update proposal.
- Link to the existing review/learning contracts.
- Keep promotion approval-gated.

## Open Questions

1. Should the first remote collector be Rudder-team-only, instance-admin-configurable, or both?
2. Should local-only OSS users see a feedback inbox immediately, or is DB/API enough for MVP?
3. Should we expose remote delivery state in the UI before sending, or use conservative copy until a safe config endpoint exists?
4. Should Feishu messages be plain text first or interactive cards first?

## Product Logic Registry Delta To Propose Later

This changes user-visible feedback capture behavior and should eventually update the guarded Product Logic Registry, likely under `doc/product/domains/review-feedback-learning/` and `doc/product/surfaces/`. Do not edit those contracts until explicitly approved.

Likely contract additions:

- Feedback modal captures product feedback as organization-scoped evidence.
- Remote feedback delivery is opt-in and sanitized.
- Feedback is not automatically promoted into agent behavior.
- Local persistence is the source of truth; Feishu/webhooks are delivery sinks.
