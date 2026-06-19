import { promises as fs } from "node:fs";
import path from "node:path";
import type { RudderSkillEntry } from "./server-utils.process.js";

export type RenderRudderSkillPromptSectionOptions = {
  selectedEntries: RudderSkillEntry[];
  maxSkillChars?: number;
  maxTotalChars?: number;
};

function compactSkillMarkdown(markdown: string, maxChars: number): string {
  const normalized = markdown.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars)).trimEnd()}\n\n[truncated by Rudder]`;
}

export async function renderRudderSkillPromptSection(
  options: RenderRudderSkillPromptSectionOptions,
): Promise<string> {
  const maxSkillChars = Math.max(500, options.maxSkillChars ?? 12_000);
  const maxTotalChars = Math.max(maxSkillChars, options.maxTotalChars ?? 60_000);
  const sections: string[] = [];
  let usedChars = 0;

  for (const entry of options.selectedEntries) {
    const skillPath = path.join(entry.source, "SKILL.md");
    const markdown = await fs.readFile(skillPath, "utf8").catch(() => null);
    if (!markdown) continue;

    const body = [
      `## ${entry.runtimeName}`,
      "",
      `Source: ${skillPath}`,
      "",
      compactSkillMarkdown(markdown, maxSkillChars),
    ].join("\n");
    const projected = usedChars + body.length;
    if (projected > maxTotalChars) {
      sections.push("[Additional Rudder enabled skills were omitted because the skill prompt payload reached the configured size limit.]");
      break;
    }
    sections.push(body);
    usedChars = projected;
  }

  if (sections.length === 0) return "";

  return [
    "Rudder enabled skills:",
    "Only the skills listed in this section are enabled by Rudder for this run. Treat any adapter-native skills discovered from the operator home as outside Rudder's enabled skill set.",
    "",
    ...sections,
  ].join("\n");
}
