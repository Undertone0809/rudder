# Agent Prompt Context Injection Optimization

## Problem Statement

Currently, all agent wakeups use the same generic prompt template regardless of trigger source:

```
"You are agent {{agent.id}} ({{agent.name}}). Continue your Rudder work."
```

This causes poor execution effectiveness because:

1. **Agent lacks context** about WHY it was woken up
2. **Wasted tool calls** - Agent must fetch basic context (issue title, comment content) itself
3. **Poor user experience** - Agent starts with "Let me check what issue I'm working on..."

## Goals

1. Inject relevant context into agent prompt based on wakeup trigger source
2. Reduce unnecessary tool calls for fetching basic context
3. Make agent immediately productive upon wakeup
4. Maintain backward compatibility with existing behavior

## Non-Goals

1. Full user-customizable prompt templates (out of scope for now)
2. Multi-language prompt localization
3. Per-agent prompt template storage in database

## Current Data Flow

```
Issue Assign/Comment → heartbeat.wakeup()
                     ↓
                contextSnapshot { issueId, commentId, wakeReason }
                     ↓
                executeRun() builds context
                     ↓
                Adapter.execute()
                     ↓
                templateData { agent, run, context }
                     ↓
                renderTemplate(promptTemplate, templateData)
                     ↓
                Generic prompt sent to agent
```

## Proposed Solution

### Option A: Source-Aware Prompt Templates (Recommended)

Add hardcoded source-specific prompt templates selected based on `context.wakeSource`:


| Trigger Source        | Template Variables                                             | Example Content                                  |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| `assignment`          | `{{issue.title}}`, `{{issue.description}}`, `{{issue.status}}` | "You have been assigned to issue: X"             |
| `comment.mention`     | `{{issue.title}}`, `{{comment.body}}`                          | "You were mentioned in a comment on issue X"     |
| `process_lost_retry`  | `{{context.retryOfRunId}}`                                     | "Your previous run was interrupted, resuming..." |
| `on_demand` (default) | `{{agent.id}}`, `{{agent.name}}`                               | "Continue your Rudder work"                      |


**Implementation:**

1. Add `selectPromptTemplate(context)` function in `@rudder/agent-runtime-utils`
2. Enrich `contextSnapshot` with entity data at wakeup sites
3. Update all agent runtimes to use `selectPromptTemplate()`

**Pros:**

- Simple, no database changes
- Works immediately for all agents
- Easy to extend with new trigger types

**Cons:**

- Templates are hardcoded (not user-customizable)
- Need to update all 6 agent runtimes

### Option B: Configurable Per-Agent Templates (Future)

Store prompt templates in database per agent, allow users to customize.

**Pros:**

- Maximum flexibility
- User can tune prompts for their specific workflow

**Cons:**

- Requires database schema changes
- UI needed for template editing
- Migration complexity
- Potential for users to break agent behavior with bad templates

**Decision:** Implement Option A now, consider Option B as future enhancement.

## Detailed Design

### 1. Server-Side Context Enrichment

Modify wakeup call sites to include entity data in `contextSnapshot`:

#### Issue Assignment Wakeup (`server/src/routes/issues.ts`)

```typescript
wakeups.set(issue.assigneeAgentId, {
  source: "assignment",
  triggerDetail: "system",
  reason: "issue_assigned",
  payload: { issueId: issue.id, mutation: "update" },
  contextSnapshot: {
    issueId: issue.id,
    source: "issue.update",
    wakeSource: "assignment",           // NEW
    wakeReason: "issue_assigned",       // NEW
    issue: {                            // NEW - full issue context
      id: issue.id,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
    }
  },
});
```

#### Comment Mention Wakeup (`server/src/routes/issues.ts`)

```typescript
wakeups.set(mentionedId, {
  source: "automation",
  triggerDetail: "system",
  reason: "issue_comment_mentioned",
  payload: { issueId: id, commentId: comment.id },
  contextSnapshot: {
    issueId: id,
    taskId: id,
    commentId: comment.id,
    wakeCommentId: comment.id,
    wakeReason: "issue_comment_mentioned",
    wakeSource: "comment.mention",      // NEW - explicit wake source
    source: "comment.mention",
    issue: {                            // NEW
      id: issue.id,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
    },
    comment: {                          // NEW
      id: comment.id,
      body: comment.body,
      authorAgentId: comment.authorAgentId,
      authorUserId: comment.authorUserId,
    },
  },
});
```

#### Issue Creation Wakeup (`server/src/services/issue-assignment-wakeup.ts`)

Same pattern - include full `issue` object in `contextSnapshot`.

### 2. Prompt Template Selection

Add to `@rudder/agent-runtime-utils/src/server-utils.ts`:

```typescript
export const DEFAULT_AGENT_PROMPT_TEMPLATE =
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Rudder work.";

export const ISSUE_ASSIGN_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). You have been assigned to work on an issue.

## Task Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}
**Priority:** {{issue.priority}}

**Description:**
{{issue.description}}

Your task is to review this issue and begin working on it. Use the available tools to explore the codebase, understand the requirements, and implement a solution.`;

export const COMMENT_MENTION_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). You were mentioned in a comment and your attention is needed.

## Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}

**Issue Description:**
{{issue.description}}

**Comment:**
{{comment.body}}

Please review the comment above and respond or take action as appropriate.`;

export const RETRY_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). Your previous run was interrupted and is being resumed.

**Previous Run ID:** {{context.retryOfRunId}}
**Reason:** {{context.retryReason}}

Continue from where you left off.`;

export function selectPromptTemplate(
  configuredTemplate: string | undefined,
  context: Record<string, unknown>,
): string {
  // If user configured a custom template, use it (future feature)
  if (configuredTemplate?.trim()) {
    return configuredTemplate;
  }

  // Select based on wake source/reason
  const wakeSource = String(context.wakeSource ?? "");
  const wakeReason = String(context.wakeReason ?? "");

  if (wakeSource === "assignment" || wakeReason === "issue_assigned") {
    return ISSUE_ASSIGN_PROMPT_TEMPLATE;
  }
  if (wakeSource === "comment.mention" || wakeReason === "issue_comment_mentioned") {
    return COMMENT_MENTION_PROMPT_TEMPLATE;
  }
  if (wakeReason === "process_lost_retry") {
    return RETRY_PROMPT_TEMPLATE;
  }

  return DEFAULT_AGENT_PROMPT_TEMPLATE;
}
```

### 3. Agent Runtime Updates

Each agent runtime's `execute()` function needs to:

1. Import `selectPromptTemplate`
2. Call it to get the appropriate prompt template
3. Extend `templateData` with `issue`, `comment`, `wakeReason`, `wakeSource`

Example for `claude-local`:

```typescript
// Before:
const promptTemplate = asString(
  config.promptTemplate,
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Rudder work.",
);

// After:
const promptTemplate = selectPromptTemplate(
  asString(config.promptTemplate, ""),
  context,
);

// Before:
const templateData = {
  agentId: agent.id,
  orgId: agent.orgId,
  runId,
  organization: { id: agent.orgId },
  agent,
  run: { id: runId, source: "on_demand" },
  context,
};

// After:
const templateData = {
  agentId: agent.id,
  orgId: agent.orgId,
  runId,
  organization: { id: agent.orgId },
  agent,
  run: {
    id: runId,
    source: context.wakeSource ?? "on_demand",
    wakeReason: context.wakeReason ?? null,
  },
  context,
  issue: context.issue ?? null,
  comment: context.comment ?? null,
  wakeReason: context.wakeReason ?? null,
  wakeSource: context.wakeSource ?? null,
};
```

## Files to Modify

### Server-side


| File                                             | Changes                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `server/src/routes/issues.ts`                    | Enrich assignment, status change, and comment mention wakeups with issue/comment data |
| `server/src/services/issue-assignment-wakeup.ts` | Enrich issue creation wakeups with issue data                                         |


### Agent Runtimes (all need same changes)


| File                                                           | Changes                                       |
| -------------------------------------------------------------- | --------------------------------------------- |
| `packages/agent-runtimes/claude-local/src/server/execute.ts`   | Use selectPromptTemplate, extend templateData |
| `packages/agent-runtimes/codex-local/src/server/execute.ts`    | Use selectPromptTemplate, extend templateData |
| `packages/agent-runtimes/cursor-local/src/server/execute.ts`   | Use selectPromptTemplate, extend templateData |
| `packages/agent-runtimes/gemini-local/src/server/execute.ts`   | Use selectPromptTemplate, extend templateData |
| `packages/agent-runtimes/opencode-local/src/server/execute.ts` | Use selectPromptTemplate, extend templateData |
| `packages/agent-runtimes/pi-local/src/server/execute.ts`       | Use selectPromptTemplate, extend templateData |


### Shared Utilities


| File                                               | Changes                                                  |
| -------------------------------------------------- | -------------------------------------------------------- |
| `packages/agent-runtime-utils/src/server-utils.ts` | Add selectPromptTemplate function and template constants |


### Tests


| File                                                  | Changes                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `server/src/__tests__/issue-lifecycle-routes.test.ts` | Update assertions to match new contextSnapshot structure |
| `server/src/__tests__/automations-service.test.ts`    | Update assertions to match new contextSnapshot structure |


## Potential Issues & Mitigations

### 1. Backward Compatibility

**Risk:** Existing agent runs that rely on the generic prompt format might behave differently.

**Mitigation:** 

- Default template remains as fallback
- Only triggers with explicit `wakeSource` get specialized prompts
- Manual/on-demand runs continue to use default template

### 2. Context Size Limits

**Risk:** Large issue descriptions or comments might exceed prompt size limits.

**Mitigation:**

- Consider truncating description/comment if too long (future enhancement)
- Monitor token usage in agent runtime

### 3. All Adapters Must Be Updated

**Risk:** Inconsistent behavior if some adapters not updated.

**Mitigation:**

- Update all 6 local adapters in single PR
- The `selectPromptTemplate` is in shared utils, so behavior is consistent

### 4. Test Failures

**Risk:** Tests that assert exact `contextSnapshot` structure will fail.

**Mitigation:**

- Use `expect.objectContaining()` in tests instead of exact match
- Update affected test files

## Verification Plan

1. **TypeScript Check**
  ```bash
   pnpm -r typecheck
  ```
2. **Unit Tests**
  ```bash
   pnpm test:run
  ```
3. **Manual Testing**
  - Create issue and assign to agent
  - Verify prompt in run logs contains issue title/description
  - Add comment mentioning agent
  - Verify prompt contains comment content
  - Verify manual chat wakeup still uses default prompt

## Rollback Plan

If issues are discovered:

1. Revert the PR
2. All wakeups will fall back to default prompt template
3. No data migration needed (contextSnapshot is ephemeral)

## Future Enhancements

1. **Configurable Templates**: Allow per-agent custom prompt templates stored in DB
2. **Truncation**: Truncate long descriptions/comments with "..." indicator
3. **More Trigger Types**: Add specialized prompts for approval requests, budget alerts, etc.
4. **Template Versioning**: Track template versions for reproducibility

## Decision Log


| Date       | Decision                            | Rationale                                    |
| ---------- | ----------------------------------- | -------------------------------------------- |
| 2026-04-07 | Hardcoded templates vs Configurable | Hardcoded is simpler, sufficient for V1      |
| 2026-04-07 | Include full issue vs partial       | Full issue gives agent complete context      |
| 2026-04-07 | wakeSource in contextSnapshot       | Explicit source field for template selection |


