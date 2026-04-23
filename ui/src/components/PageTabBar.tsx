import type { ReactNode } from "react";
import { TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useSidebar } from "../context/SidebarContext";

export interface PageTabItem {
  value: string;
  label: ReactNode;
  mobileLabel?: string;
  tooltip?: ReactNode;
}

interface PageTabBarProps {
  items: PageTabItem[];
  value?: string;
  onValueChange?: (value: string) => void;
  align?: "center" | "start";
  triggerClassName?: string;
}

export function PageTabBar({
  items,
  value,
  onValueChange,
  align = "center",
  triggerClassName,
}: PageTabBarProps) {
  const { isMobile } = useSidebar();

  if (isMobile && value !== undefined && onValueChange) {
    return (
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        className="h-9 rounded-md border border-border bg-background px-2 py-1 text-base focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {items.map((item) => (
          <option key={item.value} value={item.value}>
            {item.mobileLabel ?? (typeof item.label === "string" ? item.label : item.value)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <TabsList variant="line" className={align === "start" ? "justify-start" : undefined}>
      {items.map((item) => (
        <TabsTrigger
          key={item.value}
          value={item.value}
          className={cn(item.tooltip && "group/tab-trigger", triggerClassName)}
        >
          {item.tooltip ? (
            <span className="relative inline-flex items-center justify-center">
              <span>{item.label}</span>
              <span
                role="tooltip"
                className="pointer-events-none invisible absolute top-[calc(100%+0.375rem)] left-1/2 z-20 w-max -translate-x-1/2 rounded-md bg-foreground px-3 py-1.5 text-xs text-background opacity-0 shadow-sm transition-[opacity,visibility] group-hover/tab-trigger:visible group-hover/tab-trigger:opacity-100 group-focus-visible/tab-trigger:visible group-focus-visible/tab-trigger:opacity-100"
              >
                {item.tooltip}
              </span>
            </span>
          ) : (
            item.label
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}
