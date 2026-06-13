import { DEFAULT_PROJECT_ICON, PROJECT_ICONS, type ProjectIconName } from "@rudderhq/shared";
import {
  BookOpen,
  Calendar,
  Code,
  Database,
  Folder,
  Globe,
  Lightbulb,
  Megaphone,
  Package,
  Palette,
  Plane,
  Rocket,
  Shield,
  Target,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

const projectIconValues = new Set<string>(PROJECT_ICONS);

export const PROJECT_ICON_COMPONENTS: Record<ProjectIconName, LucideIcon> = {
  folder: Folder,
  book: BookOpen,
  plane: Plane,
  globe: Globe,
  code: Code,
  rocket: Rocket,
  target: Target,
  lightbulb: Lightbulb,
  wrench: Wrench,
  shield: Shield,
  database: Database,
  megaphone: Megaphone,
  palette: Palette,
  users: Users,
  calendar: Calendar,
  package: Package,
};

export function normalizeProjectIconName(icon: string | null | undefined): ProjectIconName {
  const normalized = icon?.trim().toLowerCase();
  return projectIconValues.has(normalized ?? "") ? (normalized as ProjectIconName) : DEFAULT_PROJECT_ICON;
}

export function getProjectIconComponent(icon: string | null | undefined): LucideIcon {
  return PROJECT_ICON_COMPONENTS[normalizeProjectIconName(icon)];
}
