import {
  ArrowLeft,
  Boxes,
  Clock3,
  DollarSign,
  History,
  Network,
  Settings,
} from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { SidebarNavItem } from "./SidebarNavItem";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useI18n } from "@/context/I18nContext";

export function OrganizationSettingsSidebar({ showOrganizationSwitcher = true }: { showOrganizationSwitcher?: boolean }) {
  const sidebarNavScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:organization-settings");
  const { t } = useI18n();
  return (
    <aside
      data-testid="workspace-sidebar"
      className="workspace-context-sidebar flex min-h-0 w-[258px] shrink-0 flex-col"
    >
      <div className="flex shrink-0 flex-col gap-2 border-b panel-divider px-3 py-3">
        {showOrganizationSwitcher ? <OrganizationSwitcher /> : null}
        <Button
          variant="ghost"
          className="h-9 w-full justify-start gap-2 rounded-[var(--radius-md)] px-2.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
          asChild
        >
          <Link to="/dashboard">
            <ArrowLeft className="h-4 w-4" />
            {t("common.backToWorkspace")}
          </Link>
        </Button>
      </div>

      <nav
        ref={sidebarNavScrollRef}
        className="scrollbar-auto-hide flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-3"
      >
        <div className="space-y-1">
          <div className="px-3 text-[12px] font-medium text-muted-foreground/78">
            {t("common.organizationSettings")}
          </div>
          <SidebarNavItem to="/organization/settings" label={t("common.general")} icon={Settings} end />
          <SidebarNavItem to="/org" label={t("common.structure")} icon={Network} />
          <SidebarNavItem to="/heartbeats" label={t("common.heartbeats")} icon={Clock3} />
          <SidebarNavItem to="/skills" label={t("common.skills")} icon={Boxes} />
          <SidebarNavItem to="/costs" label={t("common.costs")} icon={DollarSign} />
          <SidebarNavItem to="/activity" label={t("common.activity")} icon={History} />
        </div>
      </nav>
    </aside>
  );
}
