import {
  index,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  text,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { organizations } from "./organizations.js";

export const agentEnabledSkills = pgTable(
  "agent_enabled_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    skillKey: text("skill_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    agentEnabledSkillsAgentIdx: index("agent_enabled_skills_agent_idx").on(table.agentId),
    agentEnabledSkillsOrgIdx: index("agent_enabled_skills_org_idx").on(table.orgId),
    agentEnabledSkillsUniqueIdx: uniqueIndex("agent_enabled_skills_agent_skill_idx").on(
      table.agentId,
      table.skillKey,
    ),
  }),
);
