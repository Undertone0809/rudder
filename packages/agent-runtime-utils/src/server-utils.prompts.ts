import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AgentRuntimeSkillEntry,
  AgentRuntimeSkillSnapshot,
} from "./types.js";
import { RunProcessResult, RunningProcess, SpawnTarget, ChildProcessWithEvents, runningProcesses, isChildProcessAlive, MAX_CAPTURE_BYTES, MAX_EXCERPT_BYTES, SENSITIVE_ENV_KEY, RUDDER_SKILL_ROOT_RELATIVE_CANDIDATES, DEFAULT_LOCAL_CLI_CREDENTIAL_HOME_ENTRIES, LocalCliCredentialShimCommand, DEFAULT_LOCAL_CLI_OPERATOR_HOME_SHIM_COMMANDS, RudderSkillEntry, InstalledSkillTarget, PersistentSkillSnapshotOptions, normalizePathSlashes, isMaintainerOnlySkillTarget, skillLocationLabel, buildManagedSkillOrigin, compactSkillText, parseSkillFrontmatterMetadata, readSkillMetadataFromDirectory, readSkillMetadataFromPath, resolveInstalledEntryTarget, parseObject, asString, asNumber, asBoolean, asStringArray, parseJson, appendWithCap, resolvePathValue, renderTemplate, ISSUE_DOCUMENT_PROMPT_BODY_CHAR_LIMIT, IssueDocumentPromptInput, truncateIssueDocumentBody, formatDocumentHeading, readIssueDocumentPromptIssueId, buildIssueDocumentsPrompt } from "./server-utils.process.js";

export const DEFAULT_AGENT_PROMPT_TEMPLATE =
  `You are agent {{agent.id}} ({{agent.name}}). Continue your Rudder work.

{{context.rudderWorkspace.orgResourcesPrompt}}

{{context.issueDocumentsPrompt}}`;

export const ISSUE_ASSIGN_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). You have been assigned to work on an issue.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Task Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}
**Priority:** {{issue.priority}}

**Description:**
{{issue.description}}

{{context.issueDocumentsPrompt}}

Your task is to review this issue, understand what kind of work it asks for, and take the appropriate next action.

Do not assume every issue is a codebase task. If the issue is a question, screenshot check, review, planning request, coordination task, or another non-code request, answer or handle that request directly. Inspect the codebase and implement a change only when the issue actually asks for engineering work or when the relevant project resources make code changes necessary.`;

export const COMMENT_MENTION_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). You were mentioned in a comment and your attention is needed.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}

**Issue Description:**
{{issue.description}}

{{context.issueDocumentsPrompt}}

**Comment:**
From: {{comment.authorLabel}} ({{comment.authorKind}})

{{comment.body}}

Please review the comment above and respond or take action as appropriate.
An @mention is an explicit request for attention or collaboration, not an automatic transfer of issue ownership. Only checkout or self-assign when the comment explicitly asks you to take ownership and the normal issue workflow allows it.`;

export const ISSUE_COMMENTED_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). There is a new comment on an issue you own.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}

**Issue Description:**
{{issue.description}}

{{context.issueDocumentsPrompt}}

**Latest Comment:**
From: {{comment.authorLabel}} ({{comment.authorKind}})

{{comment.body}}

Review the new comment and continue the issue from the current state. Respond or take action as needed.`;

export const ISSUE_CHANGES_REQUESTED_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). A reviewer requested changes on an issue you own.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Context

**Issue:** {{issue.title}}
**ID:** {{issue.id}}
**Status:** {{issue.status}}

**Issue Description:**
{{issue.description}}

{{context.issueDocumentsPrompt}}

**Reviewer Comment:**
From: {{comment.authorLabel}} ({{comment.authorKind}})

{{comment.body}}

Review the requested changes and continue the issue from the current state. Address the reviewer feedback before handing it back for review.`;

export const ISSUE_RECOVERY_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). This is a recovery run, not a fresh task.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Recovery Context

- Original Run ID: {{context.recovery.originalRunId}}
- Failure Kind: {{context.recovery.failureKind}}
- Failure Summary: {{context.recovery.failureSummary}}
- Recovery Trigger: {{context.recovery.recoveryTrigger}}
- Recovery Mode: {{context.recovery.recoveryMode}}

## Current Issue Context

- Issue: {{issue.title}}
- ID: {{issue.id}}
- Status: {{issue.status}}
- Priority: {{issue.priority}}

- Description:
{{issue.description}}

{{context.issueDocumentsPrompt}}

Before doing anything else, inspect what the previous run already completed and any side effects it may have caused. Continue the remaining work from the current state. Avoid blindly re-running the whole task.`;

export const RECOVERY_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). This is a recovery run, not a fresh task.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Recovery Context

- Original Run ID: {{context.recovery.originalRunId}}
- Failure Kind: {{context.recovery.failureKind}}
- Failure Summary: {{context.recovery.failureSummary}}
- Recovery Trigger: {{context.recovery.recoveryTrigger}}
- Recovery Mode: {{context.recovery.recoveryMode}}

Before doing anything else, inspect what the previous run already completed and any side effects it may have caused. Continue the remaining work from the current state. Avoid blindly re-running the whole task.`;

export const ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE = `You are agent {{agent.id}} ({{agent.name}}). This is a passive issue follow-up, not a fresh assignment and not a failure recovery.

{{context.rudderWorkspace.orgResourcesPrompt}}

## Why You Were Woken

The previous run ended without sufficient issue close-out.

- Origin Run ID: {{context.passiveFollowup.originRunId}}
- Previous Run ID: {{context.passiveFollowup.previousRunId}}
- Attempt: {{context.passiveFollowup.attempt}} / {{context.passiveFollowup.maxAttempts}}
Reason: {{context.passiveFollowup.reason}}

## Current Issue Context

- Issue: {{issue.title}}
- ID: {{issue.id}}
- Status: {{issue.status}}
- Priority: {{issue.priority}}

- Description:
{{issue.description}}

{{context.issueDocumentsPrompt}}

Before changing the issue, inspect the current issue state and any side effects from the previous run. Then do exactly one close-out action: add a progress comment, mark the issue done, block it with a reason, or hand it off explicitly with explanation.`;

/**
 * Selects the base heartbeat prompt template used by runtimes before final prompt assembly.
 *
 * Prompt shape by wake trigger:
 * - assignment:
 *   "You are agent ... You have been assigned ..."
 *   Includes issue title/id/status/priority/description so the agent can start immediately.
 * - comment.mention:
 *   "You were mentioned in a comment ..."
 *   Includes issue summary plus mention comment author/body so the agent can respond without extra fetches.
 *   Mentions request attention; ownership transfer still requires an explicit handoff.
 * - issue_changes_requested:
 *   "A reviewer requested changes on an issue you own ..."
 *   Includes issue summary plus reviewer attribution/comment body so the assignee can act on feedback immediately.
 * - issue_commented:
 *   "There is a new comment on an issue you own ..."
 *   Includes issue summary plus the newest comment author/body so the assignee can continue immediately.
 * - recovery:
 *   "This is a recovery run, not a fresh task ..."
 *   Includes original run id, failure metadata, and a continue-preferred instruction to
 *   inspect prior progress/side effects before resuming.
 * - passive issue follow-up:
 *   "This is a passive issue follow-up, not a fresh assignment ..."
 *   Includes close-out lineage and tells the agent to comment, finish, block, or hand off.
 * - fallback:
 *   Generic "Continue your Rudder work."
 *
 * Concrete rendered example (comment mention):
 * "You are agent agent-456 (Backend Worker). You were mentioned in a comment and your attention is needed.
 *  Issue: Stabilize queue worker
 *  Comment: @agent please check timeout handling in retry path."
 *
 * Reasoning:
 * - Keep backward compatibility: custom configured templates always win.
 * - Keep first-turn latency low: include the minimum task context directly in prompt text.
 * - Keep behavior deterministic across runtimes: template selection is centralized here.
 *
 * See also:
 * - doc/DEVELOPING.md
 */
export function selectPromptTemplate(
  configuredTemplate: string | undefined,
  context: Record<string, unknown>,
): string {
  // If user configured a custom template, use it
  if (configuredTemplate?.trim()) {
    return configuredTemplate;
  }

  // Select based on wake source/reason
  const wakeSource = String(context.wakeSource ?? "");
  const wakeReason = String(context.wakeReason ?? "");
  const recovery = context.recovery;
  const hasRecoveryContext =
    typeof recovery === "object" &&
    recovery !== null &&
    !Array.isArray(recovery) &&
    typeof (recovery as Record<string, unknown>).originalRunId === "string";

  if (hasRecoveryContext || wakeReason === "process_lost_retry" || wakeReason === "retry_failed_run") {
    return typeof context.issue === "object" && context.issue !== null && !Array.isArray(context.issue)
      ? ISSUE_RECOVERY_PROMPT_TEMPLATE
      : RECOVERY_PROMPT_TEMPLATE;
  }
  if (wakeReason === "issue_passive_followup") {
    return ISSUE_PASSIVE_FOLLOWUP_PROMPT_TEMPLATE;
  }
  if (wakeReason === "issue_changes_requested") {
    return ISSUE_CHANGES_REQUESTED_PROMPT_TEMPLATE;
  }
  if (wakeSource === "assignment" || wakeReason === "issue_assigned") {
    return ISSUE_ASSIGN_PROMPT_TEMPLATE;
  }
  if (wakeSource === "comment.mention" || wakeReason === "issue_comment_mentioned") {
    return COMMENT_MENTION_PROMPT_TEMPLATE;
  }
  if (wakeReason === "issue_commented") {
    return ISSUE_COMMENTED_PROMPT_TEMPLATE;
  }

  return DEFAULT_AGENT_PROMPT_TEMPLATE;
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

export const RUDDER_AGENT_OPERATING_CONTRACT = [
  "# Rudder Agent Operating Contract",
  "",
  "Your home directory is `$AGENT_HOME`. Everything personal to you -- life, memory, knowledge -- lives there. Other agents may have their own folders and you may update them when necessary.",
  "",
  "Use these paths consistently:",
  "",
  "- Personal instructions live under `$AGENT_HOME/instructions`.",
  "- Personal memory lives under `$AGENT_HOME/memory`.",
  "- Tacit memory instruction lives at `$AGENT_HOME/instructions/MEMORY.md` and is automatically loaded when present.",
  "- Personal skills live under `$AGENT_HOME/skills`.",
  "- Shared organization workspace root lives under `$RUDDER_ORG_WORKSPACE_ROOT`.",
  "- Shared organization skills live under `$RUDDER_ORG_SKILLS_DIR`.",
  "- Library-backed project resources use `sourceType: \"library\"`; their `locator` points into `library:projects/<project-name>/`.",
  "- Project Context is explicit operator-curated context, not the whole knowledge boundary. When it is insufficient, inspect broader Library and org workspace know-how before concluding context is missing.",
  "- Durable generated project work files should be written under `library:projects/<project-name>/`.",
  "- Use `/tmp` only for transient scratch files and temporary verification files; do not put durable work product there.",
  "- Local trusted runtimes may expose the host operator home as `$RUDDER_OPERATOR_HOME`; use it only when a local skill or script intentionally needs operator-owned desktop app or CLI state. Do not replace `$HOME` with it.",
  "",
  "When you create or copy a skill under `$AGENT_HOME/skills/<slug>/`, check the agent's Skills snapshot before claiming it will load in future runs. If it is installed but not enabled, say exactly that future runs will not load it until enabled, and offer to enable it with `rudder agent skills enable <agent-id> <selection-ref>` when you have permission.",
  "",
  "When you write issue comments or chat replies, match the language of the user's or board's most recent substantive message unless they explicitly ask for a different language.",
  "",
  "When an issue comment is meant to get another agent's attention, mention that agent explicitly with Rudder's agent mention syntax, such as `@AgentName` in the issue composer or a structured markdown link like `[@AgentName](agent://agent-id)`. Mentioning an agent requests attention or collaboration; it does not transfer issue ownership unless the comment also makes an explicit handoff and normal checkout rules allow it.",
  "",
  "When an issue comment, done comment, or blocker comment cites visual evidence from a local screenshot/image path, attach the image with the Rudder CLI `--image <path>` option instead of leaving only the filesystem path in the text.",
  "",
  "## Memory and Shared Work Notes",
  "",
  "You MUST use the `para-memory-files` skill for all memory operations: storing facts, writing daily notes, creating entities, running weekly synthesis, recalling past context, and managing shared work notes. The skill defines your three-layer memory system (knowledge graph, daily notes, tacit knowledge), the PARA folder structure, atomic fact schemas, memory decay rules, and recall conventions.",
  "",
  "Keep stable preferences and operating lessons in `$AGENT_HOME/instructions/MEMORY.md`. Use `$AGENT_HOME/memory/YYYY-MM-DD.md` for daily notes and `$AGENT_HOME/life/` for structured long-term memory; those files are not auto-loaded.",
  "",
  "Invoke it whenever you need to remember, retrieve, or organize anything.",
  "",
  "## Safety Considerations",
  "",
  "- Never exfiltrate secrets or private data.",
  "- Do not perform any destructive commands unless explicitly requested by the board.",
].join("\n");
