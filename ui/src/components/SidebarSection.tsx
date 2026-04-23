import type { ReactNode } from "react";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

interface SidebarSectionProps {
  label: string;
  children: ReactNode;
}

export function SidebarSection({ label, children }: SidebarSectionProps) {
  return (
    <div className="space-y-0.5">
      <SidebarSectionHeader label={label} />
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}
