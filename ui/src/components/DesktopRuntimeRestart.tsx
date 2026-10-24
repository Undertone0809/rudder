import { useRef, useState } from "react";
import { useI18n } from "@/context/I18nContext";
import { readDesktopShell } from "@/lib/desktop-shell";
import { SettingsItem } from "@/components/settings/SettingsScaffold";
import { Button } from "@/components/ui/button";

export function DesktopRuntimeRestart({ disabled = false }: { disabled?: boolean }) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const shell = readDesktopShell();
  if (!shell) return null;

  async function restart() {
    if (!shell || disabled || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await shell.restart();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("about.restart.failed"));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <SettingsItem
      title={t("about.restart.title")}
      description={error ? <span role="alert" className="text-destructive">{error}</span> : t("about.restart.description")}
      action={(
        <Button variant="outline" size="sm" disabled={disabled || pending} onClick={() => void restart()}>
          {pending ? t("about.restart.pending") : t("about.restart.action")}
        </Button>
      )}
    />
  );
}
