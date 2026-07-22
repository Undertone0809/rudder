import type { Db } from "@rudderhq/db";
import {
  activityLog,
  issues as issueRows,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerThreadUserStates,
} from "@rudderhq/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Router } from "express";
import { agentService, issueService, logActivity, organizationService, projectService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const ONBOARDING_PROJECT_NAME = "Getting Started";
const ONBOARDING_MESSENGER_GROUP_ICON = "folder::teal";
const ONBOARDING_PROJECT_DESCRIPTION =
  "Complete one real work loop: start a small task in Chat or an Issue, inspect the result, and decide what happens next.";

type OnboardingIssueGroup = "welcome" | "core" | "recommended" | "advanced";

type OnboardingIssueTemplate = {
  title: string;
  description: string;
  status: "backlog" | "todo" | "done";
  priority: "low" | "medium" | "high";
  group: OnboardingIssueGroup;
  nextTitle?: string;
  nextLabel?: string;
  chatPrompt?: string;
  openIssues?: boolean;
  openMessenger?: boolean;
};

const LEGACY_WELCOME_DESCRIPTION = `Welcome to Rudder.

Rudder is where you collaborate with agents the way you would work with a human team.

You are not just prompting a bot here. You are setting up a working relationship.

In Rudder:

- Chat moves tasks forward through an ongoing conversation.
- Issues move tasks forward through structured status, ownership, and review.
- Projects group related work.
- Agents have roles, responsibilities, and execution boundaries.
- Agents can build durable memory through shared context and instructions.
- Activity makes agent work visible.
- Reviews and comments keep feedback attached to the work.
- Reusable workflows help agents improve how they work with you over time.
- Goals explain why the work exists, but you do not need to define every goal on day one.

Start with the Getting Started project in the sidebar.

It will guide you through your first collaboration loop:

1. Understand how Rudder work happens.
2. Ask your agent one quick question.
3. Create and run your first agent issue.
4. Review the result and close the loop.
5. Create a project and add shared resources.
6. Add shared context.
7. Bring one real task into Rudder.

No action is required on this welcome issue. Keep it as a quick reference while you learn how Rudder works.`;

const LEGACY_ONBOARDING_ISSUES: OnboardingIssueTemplate[] = [
  {
    title: "👋 Welcome to Rudder — work with agents like a team",
    status: "done",
    priority: "high",
    group: "welcome",
    description: LEGACY_WELCOME_DESCRIPTION,
  },
  {
    title: "1. Understand how Rudder work happens",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "2. Ask your agent one quick question",
    description: `Rudder works best when each kind of work happens in the right place.

The main surfaces are Chat, Issues, Projects, and Activity.

Chat is a conversation-driven way to work. Use it to clarify, execute, refine, and complete a task in one ongoing thread.

Issues are a structure-driven way to work. Use an issue when explicit owner, status, priority, dependencies, acceptance criteria, or review state will help.

Both can carry real agent work from request to result. Creating an issue adds coordination structure; it does not make a Chat task more real.

Projects group related chats and issues. Use a project when several pieces of work belong together and you want to see their progress in one place.

Activity shows what happened. Use it to understand progress, failures, status changes, comments, and agent actions.

Try it now:

1. Open Chat from the sidebar.
2. Open Issues from the sidebar.
3. Open this Getting Started project.
4. Open the Activity section on this issue or another issue.
5. Mark this issue as Done when you understand where each kind of work belongs.

You’ll know it worked when:

- You know that Chat and issues can both move tasks forward.
- You know when structured issue fields will help.
- You know where project-level work is grouped.
- You know where to look when you want to understand what changed.

Next step: ask your agent one quick question.`,
  },
  {
    title: "2. Ask your agent one quick question",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "3. Create and run your first agent issue",
    chatPrompt: "What can you help me accomplish in this workspace, and what is a good first task for us to try in Chat?",
    description: `Start by moving one small task forward with your agent in Chat.

Chat is not only a place to ask questions before real work starts. It is a conversation-driven task surface where you can clarify a request, run the work, inspect results, and keep refining the outcome.

Try it now:

1. Open Chat from the sidebar.
2. Ask your first agent one simple question.

Good examples:

- “What can you help me with in this workspace?”
- “Help me complete one small task in this workspace.”
- “What is a good first task for us to try in Chat?”
- “What information do you need from me before you can work well?”

3. Read the agent’s reply.
4. Come back and mark this issue as Done.

If you do not have an active agent yet, create or activate your first agent before continuing.

You’ll know it worked when:

- Your agent replies in chat.
- You understand something about the agent’s role or how to work with it.
- You have experienced conversation-driven task work.

Next step: create and run your first agent issue.`,
  },
  {
    title: "3. Create and run your first agent issue",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "4. Review the result and close the loop",
    chatPrompt: "Help me turn this into a small first Rudder issue: Summarize how Rudder works in 5 bullets and suggest one useful next step for a new user.",
    description: `You have now seen how Chat can move a task forward conversationally. Issues offer a second, structure-driven way to work.

Use an issue when the task benefits from:

- an owner
- a status
- explicit priority or dependencies
- acceptance criteria
- structured review
- a shared queue or handoff path

Creating an issue adds this coordination structure. It is not required merely because a task is executable, important, long-running, or worth revisiting.

Now create your first small agent issue.

Use your own request, or use this safe example:

“Summarize how Rudder works in 5 bullets and suggest one useful next step for a new user.”

Try it now:

1. Create a new issue.
2. Give it a clear title.
3. Add a short description.
4. Include the expected result.
5. Assign it to your first agent.
6. Leave reviewer blank for this first run unless you already know who should review it.
7. Move it to Todo or another runnable state.
8. Open the issue Activity section and watch what happens.

Use a low-risk task for this first run. Avoid tasks that need secrets, production access, irreversible actions, or external spending.

If you do not have an active agent yet, create or activate your first agent before continuing.

You’ll know it worked when:

- A new issue exists.
- It is assigned to your agent.
- The agent starts working or leaves activity.
- You can see the work happening on the issue.

Next step: review the result and close the loop.`,
  },
  {
    title: "4. Review the result and close the loop",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "5. Create a project and add shared resources",
    description: `Agent collaboration improves when feedback stays attached to the work.

In a human team, you rarely just receive work and walk away. You review it, ask for revisions, approve it, or create a follow-up. Rudder keeps that feedback loop on the issue so the context does not disappear.

Try it now:

1. Open the issue your agent worked on.
2. Read the result.
3. Check the Activity section to understand what happened.
4. Decide what to do next.

If the result is useful:

- Leave a short comment explaining what was useful.
- Move the issue to Done.

If the result needs revision:

- Leave a comment with specific feedback.
- Ask the agent to revise.
- Keep the issue open until the next result is reviewed.

If the work needs another step:

- Create a follow-up issue.
- Link it from the current issue.

You’ll know it worked when:

- The agent’s result has been reviewed.
- Your feedback is attached to the issue.
- The next step is clear.
- The issue is either Done or has a clear follow-up.

Next step: create a project and add shared resources.`,
  },
  {
    title: "5. Create a project and add shared resources",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "6. Add shared context your agent should remember",
    description: `Rudder gets more useful when work has a project home and agents can see the resources that matter.

Create a small project for the kind of work you want to move into Rudder, then add one resource or workspace note that an agent should be able to reference.

Try it now:

1. Create a project for a real area of work.
2. Add a short project description that explains what belongs there.
3. Add one resource, file, or note that helps an agent understand the work.
4. Open the project and confirm the resource is easy to find.
5. Link or mention that project from a future issue.

Keep the project small. You are not designing the whole operating system yet; you are giving future agent work a useful home.

You’ll know it worked when:

- A project exists for real work.
- At least one useful resource or note is available.
- You know where future related issues should go.

Next step: add shared context your agent should remember.`,
  },
  {
    title: "6. Add shared context your agent should remember",
    status: "backlog",
    priority: "medium",
    group: "recommended",
    nextTitle: "7. Bring one real task into Rudder",
    description: `Good teammates remember the context they need to work well.

Agents should not need you to repeat the same background every time. Rudder should accumulate shared context across work, so future issues become easier to start and easier to review.

Use this issue to write down the basic information your agent should know about this workspace.

Try it now:

1. Think about what your agent needed during the first issue.
2. Identify one piece of context you do not want to repeat again.
3. Add it to shared workspace context, knowledge, or an appropriate document.
4. Mention or link that context from one future issue.

Useful context may include:

- what this workspace is for
- what product, company, or project you are working on
- what your agent should optimize for
- your preferred output style
- links, repos, files, or docs that matter
- constraints the agent should respect
- what “done” usually means
- things the agent should not do without approval

Keep it short and real. Do not try to document the whole workspace on day one.

You’ll know it worked when:

- There is at least one reusable context note.
- The context came from something you actually needed.
- You can point an agent to this context instead of re-explaining it.

Next step: bring one real task into Rudder.`,
  },
  {
    title: "7. Bring one real task into Rudder",
    status: "backlog",
    priority: "high",
    group: "recommended",
    nextTitle: "8. Link this work to a goal",
    description: `Now bring one real task into Rudder using Chat or an issue.

Choose something real, but keep it small. The goal is not to migrate your entire workflow at once. The goal is to let Rudder take responsibility for one piece of work and leave a result you can review.

Pick a task that is useful, safe for an agent to attempt, easy for you to review, and small enough to finish or make progress on today.

Try it now:

1. Choose one real task from your current work.
2. Choose Chat for a conversation-driven workflow, or create an issue for structured tracking.
3. Include what you want done, why it matters, relevant context, what a good result looks like, and what the agent should avoid.
4. Attach or mention any relevant files, links, or context.
5. Start the agent in Chat, or assign and move the issue to Todo when it is ready.

Good first real tasks:

- “Summarize this project and identify the next 3 issues.”
- “Review this document and suggest improvements.”
- “Turn these notes into an implementation plan.”
- “Inspect this bug report and propose likely causes.”
- “Draft a checklist for repeating this workflow.”

You’ll know it worked when:

- One real task is moving through a Rudder Chat or issue.
- The chosen work surface has enough context for an agent to start.
- The task is running or ready to run.
- You know what result you expect to review.

Next step: continue with the Advanced Getting Started issues when you are ready.`,
  },
  {
    title: "8. Link this work to a goal",
    status: "backlog",
    priority: "medium",
    group: "advanced",
    nextTitle: "9. Capture one reusable workflow",
    description: `Rudder work should eventually answer one question: why does this task exist?

You do not need to define a perfect company goal on day one. It is normal for goals to become clearer after you have run a few tasks through Chat or issues. But once real work starts moving, it should connect back to a larger direction.

Try it now:

1. Open the real task you created.
2. Ask: “What larger outcome does this support?”
3. Create a simple goal, or choose an existing one.
4. Link the issue to that goal, or link the Chat's project to the goal.
5. Leave a short note explaining why this work matters.

You’ll know it worked when a real Chat or issue is connected to a goal directly or through its project, and the goal explains why the work matters.`,
  },
  {
    title: "9. Capture one reusable workflow",
    status: "backlog",
    priority: "medium",
    group: "advanced",
    nextTitle: "10. Add a second agent with a different role",
    description: `The best Rudder workflows compound over time.

After an agent completes a useful task, do not let the process disappear into a single comment thread. Capture the repeatable parts so future work can start faster and with better instructions.

Try it now:

1. Pick one issue where the agent produced something useful.
2. Look for the repeatable pattern: what input the agent needed, what steps it followed, what you reviewed, what should repeat, and what it should avoid.
3. Write a short reusable workflow or checklist.
4. Link it back to the original issue.
5. Use it on one future issue.

This is one way agents self-iterate in Rudder: their future work improves because your feedback and reusable workflow context become part of the operating system.`,
  },
  {
    title: "10. Add a second agent with a different role",
    status: "backlog",
    priority: "low",
    group: "advanced",
    nextTitle: "11. Set up a recurring loop or automation",
    description: `Human teams work better when responsibilities are clear. Agent teams work the same way.

After your first agent has completed useful work, consider adding a second agent with a different role. Do not create another agent just to have more agents. Create one when the work would benefit from a separate responsibility.

Good second-agent roles include reviewer, researcher, planner, QA assistant, documentation assistant, release coordinator, or support triage agent.

You’ll know it worked when the second agent has a distinct role and at least one issue clearly belongs to that agent.`,
  },
  {
    title: "11. Set up a recurring loop or automation",
    status: "backlog",
    priority: "low",
    group: "advanced",
    description: `Some work should not wait for you to remember it.

Once you have run a few issues manually, look for a recurring pattern. Rudder can help turn repeated work into a regular loop, heartbeat, or automation, while still keeping the result visible and reviewable.

Good recurring loops include weekly project summaries, daily issue triage, release readiness checks, inbox or blocker review, documentation freshness checks, and cost or activity summaries.

You’ll know it worked when one recurring loop exists, the cadence is clear, the expected output is clear, and the agent knows when to ask for review instead of acting silently.`,
  },
];

const LEGACY_ONBOARDING_TITLES = new Set(
  LEGACY_ONBOARDING_ISSUES.map((template) => template.title),
);

const ONBOARDING_ISSUES: OnboardingIssueTemplate[] = [
  {
    title: "👋 Welcome to Rudder — quick reference",
    status: "done",
    priority: "low",
    group: "welcome",
    nextTitle: "1. Run one real task",
    description: `Rudder moves real work through agent execution and human review.

Chat is conversation-driven; Issues add structured ownership, status, and review when that structure helps.

Start with the first guided action below.`,
  },
  {
    title: "1. Run one real task",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "2. Review the result and close the loop",
    nextLabel: "Review the result",
    chatPrompt: "Help me start one small, useful, low-risk task I can review today. Ask for any context, files, or constraints you need before you begin.",
    openIssues: true,
    description: `Choose a small, useful, low-risk task you can review today.

1. Describe the result you want.
2. Add the context, files, and constraints the agent needs.
3. Start in Chat, or create an Issue when ownership, status, or structured review will help.

Done when the agent leaves a result or clear progress update you can inspect. Mark this guide issue Done, then review the result.`,
  },
  {
    title: "2. Review the result and close the loop",
    status: "todo",
    priority: "high",
    group: "core",
    openMessenger: true,
    description: `Open the Chat or Issue where the agent worked. Inspect the result and its Activity or run evidence. Accept it, request a specific revision, or create a clear follow-up.

Done when both the result and your decision are recorded on the real work item. Mark this guide issue Done.

Next things to try: connect a project or goal, add shared context, capture a workflow, add a specialist agent, or automate a recurring loop.`,
  },
];

const ONBOARDING_V2_TITLES = new Set(
  ONBOARDING_ISSUES.map((template) => template.title),
);

function issueRef(issue: { identifier?: string | null; id: string }) {
  return issue.identifier ?? issue.id;
}

function issueHref(
  issue: { identifier?: string | null; id: string },
  organizationPrefix?: string | null,
) {
  const routePrefix = organizationPrefix
    ? `/${encodeURIComponent(organizationPrefix)}`
    : "";
  return `${routePrefix}/issues/${encodeURIComponent(issueRef(issue))}`;
}

function organizationRoutePrefix(organizationPrefix?: string | null) {
  return organizationPrefix
    ? `/${encodeURIComponent(organizationPrefix)}`
    : "";
}

function buildChatHref(input: {
  prompt: string;
  projectId: string;
  agentId?: string | null;
  organizationPrefix?: string | null;
}) {
  const params = new URLSearchParams();
  params.set("prefill", input.prompt);
  params.set("projectId", input.projectId);
  if (input.agentId) {
    params.set("agentId", input.agentId);
  }
  const routePrefix = organizationRoutePrefix(input.organizationPrefix);
  return `${routePrefix}/messenger/chat?${params.toString()}`;
}

function buildIssuesHref(input: {
  projectId: string;
  organizationPrefix?: string | null;
}) {
  const params = new URLSearchParams({ projectId: input.projectId });
  return `${organizationRoutePrefix(input.organizationPrefix)}/issues?${params.toString()}`;
}

function buildMessengerHref(organizationPrefix?: string | null) {
  return `${organizationRoutePrefix(organizationPrefix)}/messenger`;
}

function appendActionLinks(
  template: OnboardingIssueTemplate,
  description: string,
  input: {
    projectId: string;
    agentId?: string | null;
    organizationPrefix?: string | null;
    issueByTitle: ReadonlyMap<string, { identifier?: string | null; id: string }>;
  },
) {
  const lines: string[] = [];
  if (template.nextTitle) {
    const nextIssue = input.issueByTitle.get(template.nextTitle);
    if (nextIssue) {
      lines.push(
        `[${template.nextLabel ?? template.nextTitle}](${issueHref(nextIssue, input.organizationPrefix)})`,
      );
    }
  }
  if (template.chatPrompt) {
    lines.push(`[Start in Chat](${buildChatHref({
      prompt: template.chatPrompt,
      projectId: input.projectId,
      agentId: input.agentId,
      organizationPrefix: input.organizationPrefix,
    })})`);
  }
  if (template.openIssues) {
    lines.push(`[Open Issues](${buildIssuesHref({
      projectId: input.projectId,
      organizationPrefix: input.organizationPrefix,
    })})`);
  }
  if (template.openMessenger) {
    lines.push(`[Open Messenger](${buildMessengerHref(input.organizationPrefix)})`);
  }
  if (lines.length === 0) return description;
  return `${description.trim()}\n\n${lines.map((line) => `- ${line}`).join("\n")}`;
}

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function seedGettingStartedMessengerState(
  db: Db,
  input: {
    orgId: string;
    userId: string;
    issues: Array<{ id: string }>;
  },
) {
  const issueIds = [...new Set(input.issues.map((issue) => issue.id))];
  if (issueIds.length === 0) return;

  const now = new Date();
  let [group] = await db
    .select()
    .from(messengerCustomGroups)
    .where(and(
      eq(messengerCustomGroups.orgId, input.orgId),
      eq(messengerCustomGroups.userId, input.userId),
      eq(messengerCustomGroups.name, ONBOARDING_PROJECT_NAME),
    ))
    .orderBy(asc(messengerCustomGroups.createdAt))
    .limit(1);

  if (!group) {
    const [lastGroup] = await db
      .select({ sortOrder: messengerCustomGroups.sortOrder })
      .from(messengerCustomGroups)
      .where(and(
        eq(messengerCustomGroups.orgId, input.orgId),
        eq(messengerCustomGroups.userId, input.userId),
      ))
      .orderBy(desc(messengerCustomGroups.sortOrder))
      .limit(1);

    [group] = await db
      .insert(messengerCustomGroups)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        name: ONBOARDING_PROJECT_NAME,
        icon: ONBOARDING_MESSENGER_GROUP_ICON,
        sortOrder: (lastGroup?.sortOrder ?? -1) + 1,
        pinnedAt: now,
        updatedAt: now,
      })
      .returning();
  }

  if (!group) return;

  const latestIssueActivityRows = (await db.execute(sql<{ issueId: string; latestActivityAt: Date | string | null }>`
    select
      ${issueRows.id} as "issueId",
      greatest(
        ${issueRows.createdAt},
        ${issueRows.updatedAt},
        coalesce(max(${activityLog.createdAt}), ${issueRows.createdAt})
      ) as "latestActivityAt"
    from ${issueRows}
    left join ${activityLog}
      on ${activityLog.orgId} = ${issueRows.orgId}
      and ${activityLog.entityType} = 'issue'
      and ${activityLog.entityId} = ${issueRows.id}::text
    where ${issueRows.orgId} = ${input.orgId}
      and ${inArray(issueRows.id, issueIds)}
    group by ${issueRows.id}, ${issueRows.createdAt}, ${issueRows.updatedAt}
  `)) as Array<{ issueId: string; latestActivityAt: Date | string | null }>;
  const latestActivityByIssueId = new Map(
    latestIssueActivityRows.map((row) => [row.issueId, normalizeDate(row.latestActivityAt) ?? now]),
  );
  const aggregateReadAt = [...latestActivityByIssueId.values()]
    .sort((a, b) => b.getTime() - a.getTime())[0] ?? now;

  await db.transaction(async (tx) => {
    for (const [index, issueId] of issueIds.entries()) {
      const threadKey = `issue:${issueId}`;
      const readAt = latestActivityByIssueId.get(issueId) ?? aggregateReadAt;
      await tx
        .insert(messengerCustomGroupEntries)
        .values({
          orgId: input.orgId,
          userId: input.userId,
          groupId: group.id,
          threadKey,
          sortOrder: index,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            messengerCustomGroupEntries.orgId,
            messengerCustomGroupEntries.userId,
            messengerCustomGroupEntries.threadKey,
          ],
          set: {
            groupId: group.id,
            sortOrder: index,
            updatedAt: now,
          },
        });

      await tx
        .insert(messengerThreadUserStates)
        .values({
          orgId: input.orgId,
          userId: input.userId,
          threadKey,
          lastReadAt: readAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            messengerThreadUserStates.orgId,
            messengerThreadUserStates.threadKey,
            messengerThreadUserStates.userId,
          ],
          set: {
            lastReadAt: readAt,
            updatedAt: now,
          },
        });
    }

    await tx
      .insert(messengerThreadUserStates)
      .values({
        orgId: input.orgId,
        userId: input.userId,
        threadKey: "issues",
        lastReadAt: aggregateReadAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messengerThreadUserStates.orgId,
          messengerThreadUserStates.threadKey,
          messengerThreadUserStates.userId,
        ],
        set: {
          lastReadAt: aggregateReadAt,
          updatedAt: now,
        },
      });
  });
}

export function onboardingRoutes(db: Db) {
  const router = Router();
  const projects = projectService(db);
  const issues = issueService(db);
  const agents = agentService(db);
  const organizations = organizationService(db);

  router.post("/orgs/:orgId/onboarding/getting-started", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    assertBoard(req);

    const actor = getActorInfo(req);
    const operatorUserId = req.actor.userId ?? "local-board";
    const includeTutorial = req.body?.includeTutorial !== false;
    const organization = await organizations.getById(orgId);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const existingProjects = await projects.list(orgId);
    let project = existingProjects.find(
      (entry) => !entry.archivedAt && entry.name === ONBOARDING_PROJECT_NAME,
    );
    let createdProject = false;

    if (!project) {
      project = await projects.create(orgId, {
        name: ONBOARDING_PROJECT_NAME,
        status: "planned",
        description: ONBOARDING_PROJECT_DESCRIPTION,
      });
      createdProject = true;

      await logActivity(db, {
        orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "project.created",
        entityType: "project",
        entityId: project.id,
        details: { name: project.name },
      });
    }

    const existingIssues = await issues.list(orgId, { projectId: project.id });
    type ExistingIssue = (typeof existingIssues)[number];
    type CreatedIssue = Awaited<ReturnType<typeof issues.create>>;

    /**
     * Existing starter content is operator-owned once it predates v2 or any
     * issue has been deliberately hidden. Return before every write so explicit
     * reseeds cannot partially modernize issue fields, project metadata,
     * Messenger membership, or read markers.
     *
     * Traceability:
     * - doc/plans/2026-07-22-getting-started-onboarding-issues-simplification.md
     * - ORG.ONBOARDING.001
     */
    const allProjectIssueRows = await db
      .select({ title: issueRows.title, hiddenAt: issueRows.hiddenAt })
      .from(issueRows)
      .where(and(
        eq(issueRows.orgId, orgId),
        eq(issueRows.projectId, project.id),
      ));
    const hasLegacyTitle = allProjectIssueRows.some((issue) =>
      LEGACY_ONBOARDING_TITLES.has(issue.title),
    );
    const hasV2Title = allProjectIssueRows.some((issue) =>
      ONBOARDING_V2_TITLES.has(issue.title),
    );
    const hasHiddenIssue = allProjectIssueRows.some((issue) => issue.hiddenAt !== null);
    const shouldFreezeExistingProject = allProjectIssueRows.length > 0
      && (hasLegacyTitle || !hasV2Title || hasHiddenIssue);
    if (shouldFreezeExistingProject) {
      res.status(200).json({
        project,
        issues: existingIssues,
        createdProject: false,
        createdIssueCount: 0,
        includeTutorial,
      });
      return;
    }

    if (!createdProject && project.description !== ONBOARDING_PROJECT_DESCRIPTION) {
      project = await projects.update(project.id, {
        description: ONBOARDING_PROJECT_DESCRIPTION,
      }) ?? project;
    }

    const issueByTitle = new Map<string, ExistingIssue | CreatedIssue>(
      existingIssues.map((issue) => [issue.title, issue]),
    );
    const seededIssues: Array<ExistingIssue | CreatedIssue> = [];
    let createdIssueCount = 0;

    const activeAgents = await agents.list(orgId);
    const firstAgentId = activeAgents[0]?.id ?? null;
    const templates = includeTutorial
      ? ONBOARDING_ISSUES
      : ONBOARDING_ISSUES.filter((template) => template.group === "welcome");

    for (const [index, template] of templates.entries()) {
      let issue = issueByTitle.get(template.title);
      if (!issue) {
        issue = await issues.create(orgId, {
          projectId: project.id,
          title: template.title,
          description: template.description,
          status: template.status,
          priority: template.priority,
          assigneeUserId: operatorUserId,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          boardOrder: (index + 1) * 1000,
        });
        createdIssueCount += 1;
        issueByTitle.set(template.title, issue);

        await logActivity(db, {
          orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.created",
          entityType: "issue",
          entityId: issue.id,
          details: {
            title: issue.title,
            identifier: issue.identifier,
            onboardingGroup: template.group,
          },
        });
      }

      if (template.group === "welcome") {
        await issues.followIssue(orgId, issue.id, operatorUserId);
      }

      seededIssues.push(issue);
    }

    for (const template of templates) {
      const issue = issueByTitle.get(template.title);
      if (!issue) continue;
      const linkedDescription = appendActionLinks(template, template.description, {
        projectId: project.id,
        agentId: firstAgentId,
        organizationPrefix: organization.urlKey,
        issueByTitle,
      });
      if (issue.description !== linkedDescription) {
        const updated = await issues.update(issue.id, { description: linkedDescription });
        if (updated) {
          issueByTitle.set(template.title, updated);
          const seededIndex = seededIssues.findIndex((entry) => entry.id === issue.id);
          if (seededIndex >= 0) {
            seededIssues[seededIndex] = updated;
          }
        }
      }
    }

    await seedGettingStartedMessengerState(db, {
      orgId,
      userId: operatorUserId,
      issues: seededIssues,
    });

    res.status(createdProject || createdIssueCount > 0 ? 201 : 200).json({
      project,
      issues: seededIssues,
      createdProject,
      createdIssueCount,
      includeTutorial,
    });
  });

  return router;
}
