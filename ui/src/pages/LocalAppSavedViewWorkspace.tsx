import { useOrganization } from "@/context/OrganizationContext";
import { useParams } from "@/lib/router";
import { MessengerSavedViewWorkspace } from "./MessengerSavedViewWorkspace";

export function LocalAppSavedViewWorkspace() {
  const { selectedOrganizationId } = useOrganization();
  const { savedViewId } = useParams<{ savedViewId: string }>();

  if (!selectedOrganizationId || !savedViewId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Opening Local App...
      </div>
    );
  }

  return (
    <MessengerSavedViewWorkspace
      organizationId={selectedOrganizationId}
      routeMode="local_app"
      savedViewId={savedViewId}
    />
  );
}
