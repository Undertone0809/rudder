import { healthApi } from "@/api/health";
import { Button } from "@/components/ui/button";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useQuery } from "@tanstack/react-query";
import {
  CircleDot,
  Clock3,
  LayoutDashboard,
  MessageSquare,
  Repeat,
  Search,
  SquarePen,
  Target,
} from "lucide-react";
import { agentRunsApi } from "../api/agent-runs";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { queryKeys } from "../lib/queryKeys";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarChatSessions } from "./SidebarChatSessions";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarSection } from "./SidebarSection";

export function MobileWorkspaceDrawer() {
  const { openNewIssue } = useDialog();
  const { selectedOrganizationId } = useOrganization();
  const sidebarNavScrollRef = useScrollbarActivityRef(
    selectedOrganizationId ? `rudder:sidebar-scroll:${selectedOrganizationId}` : undefined,
  );
  const inboxBadge = useInboxBadge(selectedOrganizationId);
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
  });
  const goalsEnabled = healthQuery.data?.features?.experimentalGoalsEnabled === true;
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedOrganizationId!),
    queryFn: () => agentRunsApi.liveRunsForCompany(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  return (
    <aside className="surface-shell flex min-h-0 w-64 flex-1 flex-col border-r panel-divider">
      <div className="flex min-h-14 shrink-0 items-center gap-2 px-3 py-3">
        <div className="min-w-0 flex-1">
          <OrganizationSwitcher />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0 text-muted-foreground"
          onClick={openSearch}
        >
          <Search className="h-4 w-4" />
        </Button>
      </div>

      <nav
        ref={sidebarNavScrollRef}
        className="scrollbar-auto-hide flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 pb-4 pt-2"
      >
        <div className="flex flex-col gap-1">
          <Button
            variant="default"
            onClick={() => openNewIssue()}
            className="h-10 w-full justify-start gap-2.5 px-3.5 text-[13px] font-medium"
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className="truncate">New Issue</span>
          </Button>
          <SidebarNavItem to="/dashboard" label="Dashboard" icon={LayoutDashboard} liveCount={liveRunCount} />
          <SidebarNavItem to="/heartbeats" label="Heartbeats" icon={Clock3} />
          {goalsEnabled ? <SidebarNavItem to="/goals" label="Goals" icon={Target} /> : null}
          <SidebarNavItem
            to="/messenger"
            label="Messenger"
            icon={MessageSquare}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
        </div>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem to="/automations" label="Automations" icon={Repeat} textBadgeTone="amber" />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarChatSessions />

      </nav>
    </aside>
  );
}
