import type { ReactNode } from "react";
import { cn } from "../lib/utils";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";

interface RuntimeLogoIconProps {
  runtimeType: string;
  className?: string;
}

function ClaudeLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true" focusable="false">
      <path
        d="M12 2.75l2.05 6.2 6.2 2.05-6.2 2.05L12 20.25l-2.05-7.2-6.2-2.05 6.2-2.05L12 2.75z"
        fill="#D97757"
      />
      <path
        d="M12 7.05l.95 2.98 2.98.97-2.98.97-.95 2.98-.95-2.98-2.98-.97 2.98-.97.95-2.98z"
        fill="#FFF7ED"
        opacity="0.9"
      />
    </svg>
  );
}

function CodexLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" fill="#111827" />
      <path
        d="M12 4.4c2.15 0 3.95 1.2 4.88 2.9m-9.76 0A5.6 5.6 0 0 1 12 4.4m4.88 12.3A5.6 5.6 0 0 1 12 19.6m-4.88-2.9A5.6 5.6 0 0 1 7.12 7.3M5.58 12c0-2.15 1.2-3.95 2.9-4.88m8.4 0c1.7.93 2.9 2.73 2.9 4.88m-2.9 4.88c1.7-.93 2.9-2.73 2.9-4.88m-14.2 0c0 2.15 1.2 3.95 2.9 4.88"
        stroke="white"
        strokeWidth="1.35"
        strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="2.35" fill="white" />
    </svg>
  );
}

function GeminiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true" focusable="false">
      <path
        d="M12 2.4c1.22 5.02 2.58 6.38 7.6 7.6-5.02 1.22-6.38 2.58-7.6 7.6-1.22-5.02-2.58-6.38-7.6-7.6 5.02-1.22 6.38-2.58 7.6-7.6z"
        fill="#7C3AED"
      />
      <path
        d="M17.25 13.25c.58 2.38 1.22 3.02 3.6 3.6-2.38.58-3.02 1.22-3.6 3.6-.58-2.38-1.22-3.02-3.6-3.6 2.38-.58 3.02-1.22 3.6-3.6z"
        fill="#60A5FA"
      />
    </svg>
  );
}

function PiLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" fill="#F45B2A" />
      <path
        d="M6.5 8.2h11M8.25 8.2c.6 0 1.05.18 1.35.54.31.35.46.86.46 1.53v5.53M14.15 8.2v7.6M14.15 12.85c.57 0 1.03-.16 1.38-.47.36-.32.54-.8.54-1.45"
        stroke="white"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CursorLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden="true" focusable="false">
      <path d="M5 3.8l13.6 8.62-6.16 1.24-3.4 5.54L5 3.8z" fill="#111827" />
      <path d="M9.04 19.2l3.4-5.54 6.16-1.24" stroke="white" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

export function RuntimeLogoIcon({ runtimeType, className }: RuntimeLogoIconProps) {
  const baseClassName = cn("h-3.5 w-3.5 shrink-0", className);
  let icon: ReactNode = null;

  if (runtimeType === "claude_local") icon = <ClaudeLogo className={baseClassName} />;
  if (runtimeType === "codex_local") icon = <CodexLogo className={baseClassName} />;
  if (runtimeType === "gemini_local") icon = <GeminiLogo className={baseClassName} />;
  if (runtimeType === "opencode_local") icon = <OpenCodeLogoIcon className={baseClassName} />;
  if (runtimeType === "pi_local") icon = <PiLogo className={baseClassName} />;
  if (runtimeType === "cursor") icon = <CursorLogo className={baseClassName} />;

  if (!icon) return null;
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center">
      {icon}
    </span>
  );
}
