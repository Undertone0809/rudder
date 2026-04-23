import {
  Check,
  ChevronsUpDown,
  Plus,
  Settings,
} from "lucide-react";
import { useOrganization } from "../context/OrganizationContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { OrganizationPatternIcon } from "./OrganizationPatternIcon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useScrollbarActivityRef } from "@/hooks/useScrollbarActivityRef";
import { useLocation, useNavigate } from "@/lib/router";
import { cn } from "@/lib/utils";
import { sortOrganizationsByStoredOrder } from "@/lib/organization-order";
import {
  buildSettingsOverlayState,
  rememberSettingsOverlayBackgroundPath,
} from "@/lib/settings-overlay-state";

export function OrganizationSwitcher({ compact = false }: { compact?: boolean }) {
  const { organizations, selectedOrganization, setSelectedOrganizationId } = useOrganization();
  const { openOnboarding } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const menuScrollRef = useScrollbarActivityRef();
  const navigate = useNavigate();
  const location = useLocation();
  const settingsOverlayState = buildSettingsOverlayState(location);
  const sidebarOrganizations = sortOrganizationsByStoredOrder(
    organizations.filter((organization) => organization.status !== "archived"),
  );

  function closeMobileSidebar() {
    if (isMobile) setSidebarOpen(false);
  }

  function selectOrganization(organizationId: string) {
    setSelectedOrganizationId(organizationId);
    closeMobileSidebar();
  }

  function addOrganization() {
    openOnboarding();
    closeMobileSidebar();
  }

  function goToOrganizationSettings() {
    rememberSettingsOverlayBackgroundPath(`${location.pathname}${location.search}${location.hash}`);
    navigate("/organization/settings", settingsOverlayState ? { state: settingsOverlayState } : undefined);
    closeMobileSidebar();
  }

  const trigger = compact ? (
    <Button
      variant="ghost"
      className="h-11 w-11 rounded-full p-0 hover:bg-[color:var(--surface-active)]"
      aria-label="Organization menu"
    >
      {selectedOrganization ? (
        <OrganizationPatternIcon
          organizationName={selectedOrganization.name}
          logoUrl={selectedOrganization.logoUrl}
          brandColor={selectedOrganization.brandColor}
          className="h-10 w-10 shrink-0 rounded-full text-sm"
        />
      ) : (
        <span className="text-xs font-semibold text-muted-foreground">--</span>
      )}
    </Button>
  ) : (
    <Button
      variant="ghost"
      className="h-auto w-full justify-between rounded-[var(--radius-md)] px-2.5 py-2 text-left hover:bg-[color:var(--surface-active)]"
    >
      <div className="flex items-center gap-2 min-w-0">
        {selectedOrganization ? (
          <OrganizationPatternIcon
            organizationName={selectedOrganization.name}
            logoUrl={selectedOrganization.logoUrl}
            brandColor={selectedOrganization.brandColor}
            className="h-9 w-9 shrink-0 rounded-xl text-sm"
          />
        ) : null}
        <div className="min-w-0">
          <div className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground/75">
            Organization
          </div>
          <span
            className="mt-0.5 block truncate text-sm font-semibold text-foreground"
            title={selectedOrganization?.name ?? "Select organization"}
          >
            {selectedOrganization?.name ?? "Select organization"}
          </span>
        </div>
      </div>
      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
    </Button>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="surface-overlay w-[340px] overflow-hidden p-0 text-foreground"
      >
        <div
          ref={menuScrollRef}
          className="scrollbar-auto-hide max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto p-1"
        >
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {sidebarOrganizations.map((organization) => (
            <DropdownMenuItem
              key={organization.id}
              onClick={() => selectOrganization(organization.id)}
              className={cn(
                "gap-3 rounded-[calc(var(--radius-md)-2px)] px-2.5 py-2",
                organization.id === selectedOrganization?.id && "bg-[color:var(--surface-active)]",
              )}
            >
              <OrganizationPatternIcon
                organizationName={organization.name}
                logoUrl={organization.logoUrl}
                brandColor={organization.brandColor}
                className="h-7 w-7 shrink-0 rounded-lg text-xs"
              />
              <span className="min-w-0 flex-1 truncate" title={organization.name}>
                {organization.name}
              </span>
              {organization.id === selectedOrganization?.id ? <Check className="h-4 w-4 text-[color:var(--accent-strong)]" /> : null}
            </DropdownMenuItem>
          ))}
          {sidebarOrganizations.length === 0 && (
            <DropdownMenuItem disabled>No organizations</DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={addOrganization}
            className="gap-3 rounded-[calc(var(--radius-md)-2px)] px-2.5 py-2"
          >
            <Plus className="h-4 w-4" />
            Add organization
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={goToOrganizationSettings}
            className="gap-3 rounded-[calc(var(--radius-md)-2px)] px-2.5 py-2"
          >
            <Settings className="h-4 w-4" />
            Organization settings
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
