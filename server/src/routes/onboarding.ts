import { Router } from "express";
import type { Db } from "@rudderhq/db";
import { agentService, issueService, logActivity, organizationService, projectService } from "../services/index.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

const ONBOARDING_PROJECT_NAME = "Getting Started";
const ONBOARDING_PROJECT_DESCRIPTION = `Learn how Rudder works by completing one guided collaboration loop.

This project is not a generic product tour. It teaches the core Rudder workflow:

chat → issue → agent execution → activity → review → context → real work.

Complete the core issues to experience the basic loop. Then use the next issues to bring real work and reusable context into Rudder.`;

type OnboardingIssueGroup = "welcome" | "core" | "recommended" | "advanced";

type OnboardingIssueTemplate = {
  title: string;
  description: string;
  status: "backlog" | "todo" | "done";
  priority: "low" | "medium" | "high";
  group: OnboardingIssueGroup;
  nextTitle?: string;
  chatPrompt?: string;
};

const WELCOME_DESCRIPTION = `Welcome to Rudder.

Rudder is where you collaborate with agents the way you would work with a human team.

You are not just prompting a bot here. You are setting up a working relationship.

In Rudder:

- Chat is for quick questions, clarification, and routing.
- Issues are where durable work happens.
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

const ONBOARDING_ISSUES: OnboardingIssueTemplate[] = [
  {
    title: "👋 Welcome to Rudder — work with agents like a team",
    status: "done",
    priority: "high",
    group: "welcome",
    description: WELCOME_DESCRIPTION,
  },
  {
    title: "1. Understand how Rudder work happens",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "2. Ask your agent one quick question",
    description: `Rudder works best when each kind of work happens in the right place.

The main surfaces are Chat, Issues, Projects, and Activity.

Chat is for quick questions, clarification, and routing. Use it when you are still figuring out what you want, or when the request is too small to become durable work.

Issues are for work that should be tracked. Use an issue when something needs an owner, status, context, execution, review, or a durable result.

Projects group related issues. Use a project when several pieces of work belong together and you want to see their progress in one place.

Activity shows what happened. Use it to understand progress, failures, status changes, comments, and agent actions.

Try it now:

1. Open Chat from the sidebar.
2. Open Issues from the sidebar.
3. Open this Getting Started project.
4. Open the Activity section on this issue or another issue.
5. Mark this issue as Done when you understand where each kind of work belongs.

You’ll know it worked when:

- You know when to use chat.
- You know why durable work should live on an issue.
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
    chatPrompt: "What can you help me with in this workspace, and what is a good first issue for us to try in Rudder?",
    description: `Start by talking to your agent before giving it durable work.

In human teams, you often ask a teammate a quick question before assigning them a full task. Rudder works the same way. Chat is the lightweight place to ask, clarify, and get oriented.

Try it now:

1. Open Chat from the sidebar.
2. Ask your first agent one simple question.

Good examples:

- “What can you help me with in this workspace?”
- “How should I give you a task in Rudder?”
- “What is a good first issue for us to try?”
- “What information do you need from me before you can work well?”

3. Read the agent’s reply.
4. Come back and mark this issue as Done.

If you do not have an active agent yet, create or activate your first agent before continuing.

You’ll know it worked when:

- Your agent replies in chat.
- You understand something about the agent’s role or how to work with it.
- You have experienced the difference between a quick chat and tracked work.

Next step: create and run your first agent issue.`,
  },
  {
    title: "3. Create and run your first agent issue",
    status: "todo",
    priority: "high",
    group: "core",
    nextTitle: "4. Review the result and close the loop",
    chatPrompt: "Help me turn this into a small first Rudder issue: Summarize how Rudder works in 5 bullets and suggest one useful next step for a new user.",
    description: `Chat is useful for figuring things out. Issues are where work becomes durable.

A request should usually become an issue when it needs:

- an owner
- a status
- context that should not be lost
- agent execution
- review
- a clear result
- a follow-up path

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
    description: `Now bring one real task into Rudder.

Choose something real, but keep it small. The goal is not to migrate your entire workflow at once. The goal is to let Rudder take responsibility for one piece of work and leave a result you can review.

Pick a task that is useful, safe for an agent to attempt, easy for you to review, and small enough to finish or make progress on today.

Try it now:

1. Choose one real task from your current work.
2. Create a new issue for it.
3. Include what you want done, why it matters, relevant context, what a good result looks like, and what the agent should avoid.
4. Attach or mention any relevant files, links, or context.
5. Assign the issue to your agent when it is ready.
6. Move it to Todo to start the work.

Good first real tasks:

- “Summarize this project and identify the next 3 issues.”
- “Review this document and suggest improvements.”
- “Turn these notes into an implementation plan.”
- “Inspect this bug report and propose likely causes.”
- “Draft a checklist for repeating this workflow.”

You’ll know it worked when:

- One real task exists as a Rudder issue.
- The issue has enough context for an agent to start.
- The task is assigned or ready to assign.
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

You do not need to define a perfect company goal on day one. It is normal for goals to become clearer after you have run a few issues. But once real work starts moving, it should connect back to a larger direction.

Try it now:

1. Open the real task you created.
2. Ask: “What larger outcome does this support?”
3. Create a simple goal, or choose an existing one.
4. Link the issue or project to that goal.
5. Leave a short note explaining why this work matters.

You’ll know it worked when at least one real issue is linked to a goal and the goal explains why the work matters.`,
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
  const routePrefix = input.organizationPrefix
    ? `/${encodeURIComponent(input.organizationPrefix)}`
    : "";
  return `${routePrefix}/messenger/chat?${params.toString()}`;
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
        `Next issue: [${template.nextTitle}](${issueHref(nextIssue, input.organizationPrefix)}).`,
      );
    }
  }
  if (template.chatPrompt) {
    lines.push(`Open chat ready to continue: [Start from this prompt](${buildChatHref({
      prompt: template.chatPrompt,
      projectId: input.projectId,
      agentId: input.agentId,
      organizationPrefix: input.organizationPrefix,
    })}).`);
  }
  if (lines.length === 0) return description;
  return `${description.trim()}\n\n${lines.join("\n")}`;
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
        organizationPrefix: organization.issuePrefix,
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
