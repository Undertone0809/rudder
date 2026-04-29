import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Clock3,
  IdCard,
  Info,
  Puzzle,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { Link, NavLink } from "@/lib/router";
import { accessApi } from "@/api/access";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useI18n } from "@/context/I18nContext";

function SettingsNavLink({
  to,
  label,
  icon: Icon,
  end,
}: {
  to: string;
  label: string;
  icon: typeof Settings;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-[var(--radius-md)] px-3 py-2.5 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-[color:color-mix(in_oklab,var(--surface-active)_56%,transparent)] text-foreground"
            : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_30%,transparent)] hover:text-foreground",
        )
      }
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

export function InstanceSidebar() {
  const sidebarNavScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:instance-settings");
  const { t } = useI18n();
  const { data: currentBoardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });
  const canManageAdminSettings = currentBoardAccess?.isInstanceAdmin === true;

  return (
    <aside className="surface-shell flex min-h-0 w-64 flex-1 flex-col border-r panel-divider">
      <div className="space-y-4 border-b border-[color:color-mix(in_oklab,var(--border-soft)_78%,transparent)] px-4 py-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Settings className="h-4 w-4 shrink-0" />
            <span className="text-[11px] font-semibold">{t("common.systemSettings")}</span>
          </div>
        </div>

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
        className="scrollbar-auto-hide flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-4"
      >
        <div className="space-y-1">
          <div className="px-3 text-[10px] font-semibold text-muted-foreground/70">
            {t("common.personal")}
          </div>
          <SettingsNavLink to="/instance/settings/profile" label={t("common.profile")} icon={IdCard} end />
        </div>

        {canManageAdminSettings ? (
          <div className="space-y-1">
            <div className="px-3 text-[10px] font-semibold text-muted-foreground/70">
              {t("common.desktopApp")}
            </div>
            <SettingsNavLink to="/instance/settings/general" label={t("common.general")} icon={SlidersHorizontal} end />
            <SettingsNavLink
              to="/instance/settings/notifications"
              label={t("common.systemPermissions")}
              icon={ShieldCheck}
              end
            />
            <SettingsNavLink to="/instance/settings/about" label={t("common.about")} icon={Info} end />
          </div>
        ) : null}

        {canManageAdminSettings ? (
          <div className="space-y-1">
            <div className="px-3 text-[10px] font-semibold text-muted-foreground/70">
              {t("common.runtime")}
            </div>
            <SettingsNavLink to="/instance/settings/heartbeats" label={t("common.heartbeats")} icon={Clock3} end />
          </div>
        ) : null}

        {canManageAdminSettings ? (
          <div className="space-y-1">
            <div className="px-3 text-[10px] font-semibold text-muted-foreground/70">
              {t("common.integrations")}
            </div>
            <SettingsNavLink to="/instance/settings/plugins" label={t("common.plugins")} icon={Puzzle} />
            {(plugins ?? []).length > 0 ? (
              <div className="ml-4 mt-1 flex flex-col gap-1 border-l border-[color:color-mix(in_oklab,var(--border-soft)_78%,transparent)] pl-4">
                {(plugins ?? []).map((plugin) => (
                  <NavLink
                    key={plugin.id}
                    to={`/instance/settings/plugins/${plugin.id}`}
                    className={({ isActive }) =>
                      cn(
                        "rounded-[calc(var(--radius-sm)+2px)] px-2 py-1.5 text-xs transition-colors",
                        isActive
                          ? "bg-[color:color-mix(in_oklab,var(--surface-active)_48%,transparent)] text-foreground"
                          : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_24%,transparent)] hover:text-foreground",
                      )
                    }
                  >
                    {plugin.manifestJson.displayName ?? plugin.packageName}
                  </NavLink>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
