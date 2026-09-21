import type { InstanceLocale } from "@rudderhq/shared";
import { Boxes, Clock3, DollarSign, History, LayoutDashboard, LibraryBig, type LucideIcon } from "lucide-react";
import { SKILLS_LIBRARY_DIRECTORY_HREF } from "./skill-library-routes";

type ProjectsContextItem = {
  key: string;
  to: string;
  icon: LucideIcon;
  label: string;
  active: boolean;
};

// Projects groups project navigation and organization-wide tools. Library
// keeps its own remembered destination, including existing document links.
export function buildProjectsContextItems({
  relativePath,
  searchParams,
  libraryPath,
  locale,
}: {
  relativePath: string;
  searchParams: URLSearchParams;
  libraryPath: string;
  locale: InstanceLocale;
}): ProjectsContextItem[] {
  const isSkillsLibraryRoute = /^\/skills(?:\/|$)/.test(relativePath)
    || (/^\/library(?:\/|$)/.test(relativePath)
      && (searchParams.get("directory") === "skills" || searchParams.has("skill")));

  return [
    { key: "dashboard", to: "/dashboard", icon: LayoutDashboard, label: "Dashboard", active: /^\/dashboard(?:\/|$)/.test(relativePath) },
    {
      key: "library",
      to: libraryPath,
      icon: LibraryBig,
      label: locale === "zh-CN" ? "文档" : "Library",
      active: /^\/(?:library|resources|workspaces)(?:\/|$)/.test(relativePath)
        && !/^\/workspaces\/backups(?:\/|$)/.test(relativePath)
        && !isSkillsLibraryRoute,
    },
    { key: "heartbeats", to: "/heartbeats", icon: Clock3, label: "Heartbeats", active: /^\/heartbeats(?:\/|$)/.test(relativePath) },
    { key: "skills", to: SKILLS_LIBRARY_DIRECTORY_HREF, icon: Boxes, label: "Skills", active: isSkillsLibraryRoute },
    { key: "costs", to: "/costs", icon: DollarSign, label: "Costs", active: /^\/costs(?:\/|$)/.test(relativePath) },
    { key: "activity", to: "/activity", icon: History, label: "Activity", active: /^\/activity(?:\/|$)/.test(relativePath) },
  ];
}
