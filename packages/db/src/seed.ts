import { deriveOrganizationUrlKey } from "@rudder/shared";
import { createDb } from "./client.js";
import { organizations, agents, goals, projects, issues } from "./schema/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const db = createDb(url);

console.log("Seeding database...");

const [organization] = await db
  .insert(organizations)
  .values({
    name: "Rudder Demo Co",
    urlKey: deriveOrganizationUrlKey("Rudder Demo Co"),
    description: "A demo autonomous organization",
    status: "active",
    budgetMonthlyCents: 50000,
  })
  .returning();

const [ceo] = await db
  .insert(agents)
  .values({
    orgId: organization!.id,
    name: "CEO Agent",
    role: "ceo",
    title: "Chief Executive Officer",
    status: "idle",
    agentRuntimeType: "process",
    agentRuntimeConfig: { command: "echo", args: ["hello from ceo"] },
    budgetMonthlyCents: 15000,
  })
  .returning();

const [engineer] = await db
  .insert(agents)
  .values({
    orgId: organization!.id,
    name: "Engineer Agent",
    role: "engineer",
    title: "Software Engineer",
    status: "idle",
    reportsTo: ceo!.id,
    agentRuntimeType: "process",
    agentRuntimeConfig: { command: "echo", args: ["hello from engineer"] },
    budgetMonthlyCents: 10000,
  })
  .returning();

const [goal] = await db
  .insert(goals)
  .values({
    orgId: organization!.id,
    title: "Ship V1",
    description: "Deliver first control plane release",
    level: "organization",
    status: "active",
    ownerAgentId: ceo!.id,
  })
  .returning();

const [project] = await db
  .insert(projects)
  .values({
    orgId: organization!.id,
    goalId: goal!.id,
    name: "Control Plane MVP",
    description: "Implement core board + agent loop",
    status: "in_progress",
    leadAgentId: ceo!.id,
  })
  .returning();

await db.insert(issues).values([
  {
    orgId: organization!.id,
    projectId: project!.id,
    goalId: goal!.id,
    title: "Implement atomic task checkout",
    description: "Ensure in_progress claiming is conflict-safe",
    status: "todo",
    priority: "high",
    assigneeAgentId: engineer!.id,
    createdByAgentId: ceo!.id,
  },
  {
    orgId: organization!.id,
    projectId: project!.id,
    goalId: goal!.id,
    title: "Add budget auto-pause",
    description: "Pause agent at hard budget ceiling",
    status: "backlog",
    priority: "medium",
    createdByAgentId: ceo!.id,
  },
]);

console.log("Seed complete");
process.exit(0);
