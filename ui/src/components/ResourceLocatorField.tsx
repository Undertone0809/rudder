import { useState } from "react";
import type { OrganizationResourceKind } from "@rudderhq/shared";
import { FolderOpen, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readDesktopShell } from "@/lib/desktop-shell";
import {
  isLocalPathOrganizationResourceKind,
  organizationResourceLocatorPlaceholder,
} from "@/lib/resource-options";
import { cn } from "@/lib/utils";

export function suggestResourceNameFromLocator(locator: string) {
  const trimmed = locator.trim();
  if (!trimmed) return "";

  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const basename = normalized.split("/").filter(Boolean).pop() ?? normalized;

  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

type ResourceLocatorFieldProps = {
  kind: OrganizationResourceKind;
  value: string;
  onChange: (value: string) => void;
  onPickedPath?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  buttonClassName?: string;
};

export function ResourceLocatorField({
  kind,
  value,
  onChange,
  onPickedPath,
  disabled = false,
  className,
  inputClassName,
  buttonClassName,
}: ResourceLocatorFieldProps) {
  const [picking, setPicking] = useState(false);
  const desktopShell = readDesktopShell();
  const canBrowse = isLocalPathOrganizationResourceKind(kind) && desktopShell !== null;

  async function handleBrowse() {
    if (!desktopShell || !isLocalPathOrganizationResourceKind(kind) || picking) return;

    setPicking(true);
    try {
      const result = await desktopShell.pickPath({
        kind,
        title: kind === "directory" ? "Choose directory" : "Choose file",
        buttonLabel: kind === "directory" ? "Choose directory" : "Choose file",
        defaultPath: value.trim() || undefined,
      });

      if (result.canceled || !result.path) return;
      onChange(result.path);
      onPickedPath?.(result.path);
    } finally {
      setPicking(false);
    }
  }

  return (
    <div className={cn("grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]", className)}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={organizationResourceLocatorPlaceholder(kind)}
        disabled={disabled || picking}
        className={inputClassName}
      />
      {canBrowse ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void handleBrowse();
          }}
          disabled={disabled || picking}
          className={cn("shrink-0", buttonClassName)}
          aria-label={kind === "directory" ? "Browse for directory" : "Browse for file"}
        >
          {picking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
          Browse…
        </Button>
      ) : null}
    </div>
  );
}
