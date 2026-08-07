import { Button } from "@/components/ui/button";
import { Pause, Play } from "lucide-react";

export function RunButton({
  onClick,
  disabled,
  label = "Run now",
  size = "sm",
}: {
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  size?: "sm" | "default";
}) {
  return (
    <Button
      variant="outline"
      size={size}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      <Play className="h-3.5 w-3.5 sm:mr-1" />
      <span className="agent-detail-action-label hidden sm:inline">{label}</span>
    </Button>
  );
}

export function PauseResumeButton({
  isPaused,
  onPause,
  onResume,
  disabled,
  size = "sm",
}: {
  isPaused: boolean;
  onPause: () => void;
  onResume: () => void;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  if (isPaused) {
    return (
      <Button
        variant="outline"
        size={size}
        onClick={onResume}
        disabled={disabled}
        aria-label="Resume"
        title="Resume"
      >
        <Play className="h-3.5 w-3.5 sm:mr-1" />
        <span className="agent-detail-action-label hidden sm:inline">Resume</span>
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      size={size}
      onClick={onPause}
      disabled={disabled}
      aria-label="Pause"
      title="Pause"
    >
      <Pause className="h-3.5 w-3.5 sm:mr-1" />
      <span className="agent-detail-action-label hidden sm:inline">Pause</span>
    </Button>
  );
}
