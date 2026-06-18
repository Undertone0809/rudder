# Conversation and Agent Work Capture Evals

Use these lightweight cases when changing the `para-memory-files` skill's
Rudder chat and agent work capture behavior. They are written for human or
agent review, not a dedicated automated harness.

### Case: User Corrects Memory Behavior

Input:

A user says: "No, do not just leave this in your personal MEMORY.md. This
should become an org skill rule so other agents stop missing chat context."

Expected behavior:

- Write a concise daily-note chat capture with context, user intent,
  conclusion/action, reusable lesson, and follow-up/risk.
- Route the stable behavior change toward the relevant skill package or skill
  patch proposal.
- Update personal MEMORY.md only if there is also a personal operating
  preference for this agent.

Must not:

- Copy the full transcript into memory.
- Treat the correction as only a personal preference.
- Hide the organization-wide fix in one agent's private memory.

### Case: Issue Close-Out Without New Signal

Input:

An issue comment says: "Done, tests passed, commit abc123." It repeats the
same evidence already present in the issue and contains no new preference,
decision, correction, or reusable lesson.

Expected behavior:

- No daily-note capture is required.
- If the agent needs an audit trail, rely on the issue itself as the source of
  truth.

Must not:

- Record low-signal close-out chatter just because it happened in chat.
- Promote repeated issue status into personal memory.

### Case: Automation Work Produces Reusable Lesson

Input:

During a scheduled CI patrol automation, the agent discovers that a recurring
workflow failure should be repaired directly when credentials and local
reproduction are available, and only escalated when the platform is down or a
non-substitutable secret is missing.

Expected behavior:

- Write a concise daily-note memory capture that names the automation context,
  durable escalation rule, action taken, reusable lesson, and follow-up risk.
- Promote the shared operating rule to the relevant project know-how, skill, or
  agent instruction when it affects future agents or recurring automations.
- Keep raw logs, credentials, and noisy command output out of memory.

Must not:

- Ignore the event because it came from automation instead of chat.
- Store the complete automation transcript or secrets in a personal memory file.
- Hide an organization-wide automation rule only in one agent's private memory.

### Case: Low-Signal Chat

Input:

A chat contains greetings, thanks, and "I'll check later" with no task
definition or durable preference.

Expected behavior:

- Do not write a memory entry.
- Continue the conversation normally.

Must not:

- Create a daily note from politeness or temporary scheduling chatter.

### Case: Project-Level Decision

Input:

A user explains that future Rudder proposals for non-trivial architecture work
must live in the project Library first, receive two critique rounds, and only
then be implemented.

Expected behavior:

- Capture the chat signal in the daily note.
- Promote the project-level policy to shared project knowledge under the
  project Library or organization workspace.
- If it changes agent behavior generally, propose or update the relevant skill.

Must not:

- Store the policy only in `$AGENT_HOME/instructions/MEMORY.md`.
- Skip the shared knowledge artifact when the rule affects multiple agents.

### Case: Attachment Changes Task Interpretation

Input:

A user attaches a screenshot and says the real problem is not the visible
button style but the workflow confusion shown by the screenshot.

Expected behavior:

- Capture the daily-note context, including the conversation or issue reference
  and a short description of how the attachment changed the task.
- Route any reusable product or execution lesson to shared project knowledge
  when it affects future project work.
- Keep the attachment details summarized and avoid sensitive visual content
  that is not needed for future behavior.

Must not:

- Preserve the entire image transcript or private visual details in personal
  memory.
- Ignore the attachment-driven reinterpretation when forming future task
  context.

### Case: Broad Memory Recall Needs Search Triage

Input:

A user asks: "What do we know about my previous preferences for agent review
handoffs?" There is no known entity path, and the relevant notes may live across
life summaries, daily notes, or shared project Library files.

Expected behavior:

- Build a focused memory-search query set from concrete terms, synonyms,
  likely entities, and date/project hints before reading files.
- Search the likely memory roots and return a short ranked candidate list
  grouped by source type, preferring entity `summary.md`, active facts, recent
  daily notes, and newest shared work notes.
- Open only the strongest candidate files, verify claims against stored facts
  or notes, and cite the file paths used.
- State uncertainty when matches are weak or conflicting.

Must not:

- Dump raw `rg` output as the answer.
- Read every matching file without ranking.
- Treat keyword matches as facts before opening and verifying the source file.
- Ignore newer dated notes or superseded facts when older matches exist.
