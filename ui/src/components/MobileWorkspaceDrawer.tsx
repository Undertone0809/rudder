import {
  CircleDot,
  Clock3,
  Target,
  LayoutDashboard,
  MessageSquare,
  Network,
  Search,
  SquarePen,
  Repeat,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { SidebarSection } from "./SidebarSection";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarProjects } from "./SidebarProjects";
import { SidebarChatSessions } from "./SidebarChatSessions";
import { SidebarAgents } from "./SidebarAgents";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { useDialog } from "../context/DialogContext";
import { useOrganization } from "../context/OrganizationContext";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";

export function MobileWorkspaceDrawer() {
  const { openNewIssue } = useDialog();
  const { selectedOrganizationId, selectedOrganization } = useOrganization();
  const sidebarNavScrollRef = useScrollbarActivityRef(
    selectedOrganizationId ? `rudder:sidebar-scroll:${selectedOrganizationId}` : undefined,
  );
  const inboxBadge = useInboxBadge(selectedOrganizationId);
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedOrganizationId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
    refetchInterval: 10_000,
  });
  const liveRunCount = liveRuns?.length ?? 0;

  function openSearch() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
  }

  const pluginContext = {
    orgId: selectedOrganizationId,
    orgPrefix: selectedOrganization?.issuePrefix ?? null,
  };

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
          <SidebarNavItem to="/org" label="Org" icon={Network} />
          <SidebarNavItem to="/heartbeats" label="Heartbeats" icon={Clock3} />
          <SidebarNavItem to="/goals" label="Goals" icon={Target} />
          <SidebarNavItem
            to="/messenger"
            label="Messenger"
            icon={MessageSquare}
            badge={inboxBadge.inbox}
            badgeTone={inboxBadge.failedRuns > 0 ? "danger" : "default"}
            alert={inboxBadge.failedRuns > 0}
          />
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-[13px] font-medium"
            missingBehavior="placeholder"
          />
        </div>

        <SidebarSection label="Work">
          <SidebarNavItem to="/issues" label="Issues" icon={CircleDot} />
          <SidebarNavItem to="/automations" label="Automations" icon={Repeat} textBadge="Beta" textBadgeTone="amber" />
        </SidebarSection>

        <SidebarProjects />

        <SidebarAgents />

        <SidebarChatSessions />

        <PluginSlotOutlet
          slotTypes={["sidebarPanel"]}
          context={pluginContext}
          className="flex flex-col gap-3"
          itemClassName="surface-panel rounded-[var(--radius-md)] p-3"
          missingBehavior="placeholder"
        />
      </nav>
    </aside>
  );
}
