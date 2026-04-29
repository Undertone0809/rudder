import { useQuery } from "@tanstack/react-query";
import {
  ActivitySquare,
  ArrowLeft,
  Building2,
  Check,
  Clock3,
  IdCard,
  Info,
  Puzzle,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "@/lib/router";
import { accessApi } from "@/api/access";
import { healthApi } from "@/api/health";
import { pluginsApi } from "@/api/plugins";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useOrganization } from "@/context/OrganizationContext";
import { useSidebar } from "@/context/SidebarContext";
import { getOrganizationSettingsPath } from "@/lib/organization-settings-path";
import { sortOrganizationsByStoredOrder } from "@/lib/organization-order";
import { OrganizationPatternIcon } from "./OrganizationPatternIcon";
import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { SidebarNavItem } from "./SidebarNavItem";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useViewedOrganization } from "@/hooks/useViewedOrganization";
import { useI18n } from "@/context/I18nContext";
import { preserveSettingsOverlayState } from "@/lib/settings-overlay-state";

export function SettingsSidebar({
  showOrganizationSwitcher = true,
  showBackButton = true,
  variant = "panel",
}: {
  showOrganizationSwitcher?: boolean;
  showBackButton?: boolean;
  variant?: "panel" | "modal";
}) {
  const sidebarNavScrollRef = useScrollbarActivityRef("rudder:sidebar-scroll:settings");
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { organizations } = useOrganization();
  const { viewedOrganizationId } = useViewedOrganization();
  const { data: currentBoardAccess } = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    retry: false,
  });
  const { data: plugins } = useQuery({
    queryKey: queryKeys.plugins.all,
    queryFn: () => pluginsApi.list(),
  });
  const { data: health } = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const canManageAdminSettings = currentBoardAccess?.isInstanceAdmin === true;
  const canManageLocalLangfuse = health?.deploymentMode === "local_trusted";
  const overlayState = preserveSettingsOverlayState(location.state);
  const sidebarOrganizations = sortOrganizationsByStoredOrder(
    organizations.filter((organization) => organization.status !== "archived"),
  );

  const modalVariant = variant === "modal";

  function handleOrganizationSelect(organization: (typeof sidebarOrganizations)[number]) {
    navigate(getOrganizationSettingsPath(organization.issuePrefix), overlayState ? { state: overlayState } : undefined);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <aside
      data-testid="workspace-sidebar"
      className={cn(
        "flex min-h-0 shrink-0 flex-col",
        modalVariant
          ? "settings-modal-sidebar w-[184px]"
          : "workspace-context-sidebar w-[248px]",
      )}
    >
      {!modalVariant ? (
        <div className="flex shrink-0 flex-col gap-2 border-b panel-divider px-3 py-3">
          <div className="flex items-center gap-2 px-2.5 text-muted-foreground">
            <Settings className="h-4 w-4 shrink-0" />
            <span className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">{t("common.systemSettings")}</span>
          </div>
          {showOrganizationSwitcher ? <OrganizationSwitcher /> : null}
          {showBackButton ? (
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
          ) : null}
        </div>
      ) : null}

      <nav
        ref={sidebarNavScrollRef}
        className={cn(
          "scrollbar-auto-hide flex min-h-0 flex-1 flex-col overflow-y-auto",
          modalVariant ? "gap-3 px-2 py-4" : "gap-5 px-3 py-3",
        )}
      >
        <div className="space-y-1">
          <div className={cn(
            "px-3 font-medium text-muted-foreground/78",
            modalVariant ? "text-[11px]" : "text-[12px]",
          )}>
            {t("common.personal")}
          </div>
          <SidebarNavItem
            to="/instance/settings/profile"
            state={overlayState}
            label={t("common.profile")}
            icon={IdCard}
            end
            variant={modalVariant ? "compact" : "default"}
          />
        </div>

        {canManageAdminSettings ? (
          <>
            <div className="space-y-1">
              <div className={cn(
                "px-3 font-medium text-muted-foreground/78",
                modalVariant ? "text-[11px]" : "text-[12px]",
              )}>
                {t("common.desktopApp")}
              </div>
              <SidebarNavItem
                to="/instance/settings/general"
                state={overlayState}
                label={t("common.general")}
                icon={SlidersHorizontal}
                end
                variant={modalVariant ? "compact" : "default"}
              />
              <SidebarNavItem
                to="/instance/settings/notifications"
                state={overlayState}
                label={t("common.systemPermissions")}
                icon={ShieldCheck}
                end
                variant={modalVariant ? "compact" : "default"}
              />
              <SidebarNavItem
                to="/instance/settings/organizations"
                state={overlayState}
                label={t("common.organizations")}
                icon={Building2}
                end
                variant={modalVariant ? "compact" : "default"}
              />
              <SidebarNavItem
                to="/instance/settings/about"
                state={overlayState}
                label={t("common.about")}
                icon={Info}
                end
                variant={modalVariant ? "compact" : "default"}
              />
            </div>

            <div className="space-y-1">
              <div className={cn(
                "px-3 font-medium text-muted-foreground/78",
                modalVariant ? "text-[11px]" : "text-[12px]",
              )}>
                {t("common.runtime")}
              </div>
              <SidebarNavItem
                to="/instance/settings/heartbeats"
                state={overlayState}
                label={t("common.heartbeats")}
                icon={Clock3}
                end
                variant={modalVariant ? "compact" : "default"}
              />
            </div>

            <div className="space-y-1">
              <div className={cn(
                "px-3 font-medium text-muted-foreground/78",
                modalVariant ? "text-[11px]" : "text-[12px]",
              )}>
                {t("common.integrations")}
              </div>
              {canManageLocalLangfuse ? (
                <SidebarNavItem
                  to="/instance/settings/langfuse"
                  state={overlayState}
                  label={t("common.langfuse")}
                  icon={ActivitySquare}
                  end
                  variant={modalVariant ? "compact" : "default"}
                />
              ) : null}
              <SidebarNavItem
                to="/instance/settings/plugins"
                state={overlayState}
                label={t("common.plugins")}
                icon={Puzzle}
                variant={modalVariant ? "compact" : "default"}
              />
              {(plugins ?? []).length > 0 ? (
                <div className="ml-4 mt-1 flex flex-col gap-1 border-l border-[color:color-mix(in_oklab,var(--border-soft)_78%,transparent)] pl-4">
                  {(plugins ?? []).map((plugin) => (
                    <NavLink
                      key={plugin.id}
                      to={`/instance/settings/plugins/${plugin.id}`}
                      state={overlayState}
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
          </>
        ) : null}

        {sidebarOrganizations.length > 0 ? (
          <div className={cn("space-y-1 pt-2", !modalVariant && "mt-auto")}>
            <div className={cn(
              "px-3 font-medium text-muted-foreground/78",
              modalVariant ? "text-[11px]" : "text-[12px]",
            )}>
              {t("common.yourOrganizations")}
            </div>
            <div className="space-y-1">
              {sidebarOrganizations.map((organization) => {
                const selected = organization.id === viewedOrganizationId;
                return (
                  <button
                    key={organization.id}
                    type="button"
                    onClick={() => handleOrganizationSelect(organization)}
                    aria-label={organization.name}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-[calc(var(--radius-md)-2px)] px-3 py-2 text-left transition-colors",
                      selected
                        ? "bg-[color:var(--surface-active)] text-foreground"
                        : "text-muted-foreground hover:bg-[color:color-mix(in_oklab,var(--surface-active)_24%,transparent)] hover:text-foreground",
                    )}
                    aria-pressed={selected}
                  >
                    <OrganizationPatternIcon
                      organizationName={organization.name}
                      logoUrl={organization.logoUrl}
                      brandColor={organization.brandColor}
                      className="h-5 w-5 shrink-0 rounded-md text-[10px]"
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={organization.name}>
                      {organization.name}
                    </span>
                    {selected ? <Check className="h-3.5 w-3.5 shrink-0 text-[color:var(--accent-strong)]" /> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
