import { readDesktopShell } from "@/lib/desktop-shell";
import { localAppIdentityMatches, type LocalAppOpaqueIdentity } from "@/lib/local-apps";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AppWindow } from "lucide-react";
import { useEffect, useState } from "react";

export function LocalAppIdentityIcon({
  className,
  iconDataUrl,
  identity,
  testId,
}: {
  className?: string;
  iconDataUrl?: string | null;
  identity?: LocalAppOpaqueIdentity | null;
  testId?: string;
}) {
  const localApps = readDesktopShell()?.localApps;
  if (!iconDataUrl && identity && localApps?.supported) {
    return (
      <ResolvedLocalAppIdentityIcon
        className={className}
        identity={identity}
        testId={testId}
      />
    );
  }
  return <LocalAppIconVisual className={className} resolved={iconDataUrl ?? null} testId={testId} />;
}

function ResolvedLocalAppIdentityIcon({
  className,
  identity,
  testId,
}: {
  className?: string;
  identity: LocalAppOpaqueIdentity;
  testId?: string;
}) {
  const localApps = readDesktopShell()!.localApps!;
  const definitionsQuery = useQuery({
    queryKey: queryKeys.localApps.definitions,
    queryFn: () => localApps!.list(),
    staleTime: 1_000,
  });
  const resolved = definitionsQuery.data?.find((definition) => localAppIdentityMatches(definition, identity))?.iconDataUrl
    ?? null;
  return <LocalAppIconVisual className={className} resolved={resolved} testId={testId} />;
}

function LocalAppIconVisual({
  className,
  resolved,
  testId,
}: {
  className?: string;
  resolved: string | null;
  testId?: string;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [resolved]);

  if (resolved && !failed) {
    return (
      <img
        alt=""
        className={cn("object-contain", className)}
        data-testid={testId}
        src={resolved}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <AppWindow
      aria-hidden
      className={className}
      data-testid={testId}
    />
  );
}
