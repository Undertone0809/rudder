import { cn } from "../lib/utils";
import { OpenCodeLogoIcon } from "./OpenCodeLogoIcon";

interface RuntimeLogoIconProps {
  runtimeType: string;
  className?: string;
}

export type RuntimeLogoSource = {
  src: string;
  sourceUrl: string;
  sourceSha256: string;
  className?: string;
};

export const runtimeLogoSources: Record<string, RuntimeLogoSource> = {
  claude_local: {
    src: "/brands/claude-logo.svg",
    sourceUrl: "https://cdn.simpleicons.org/claude",
    sourceSha256: "5119ef950a0d648b3fd62865791e73f07f32e18ddab84e4f21160f8c641c0f5f",
  },
  codex_local: {
    src: "/brands/openai-logo.svg",
    sourceUrl: "https://upload.wikimedia.org/wikipedia/commons/6/66/OpenAI_logo_2025_%28symbol%29.svg",
    sourceSha256: "1da76493b0ffed215d15e33b0ef5c9bd81c11ea170eac1f7690fecad0453410b",
    className: "dark:invert",
  },
  gemini_local: {
    src: "/brands/google-gemini-logo.svg",
    sourceUrl: "https://cdn.simpleicons.org/googlegemini",
    sourceSha256: "404eba6940a54e63d40edcce2d2e7cb2b3dbfec765e7a1d523662b6f4e0d6747",
  },
  pi_local: {
    src: "/brands/pi-logo.svg",
    sourceUrl: "https://pi.dev/logo-auto.svg",
    sourceSha256: "03d509c104b9570063fa268fd3235ed7e0e41dafd93124ca94cae3726f58f117",
  },
  cursor: {
    src: "/brands/cursor-logo.svg",
    sourceUrl: "https://cdn.simpleicons.org/cursor",
    sourceSha256: "68c88e317a03fefb7d8ed68b9fe86ef33c0a002765fa6bfc84cdc43d7bb9f4fe",
    className: "dark:invert",
  },
};

export function RuntimeLogoIcon({ runtimeType, className }: RuntimeLogoIconProps) {
  const baseClassName = cn("h-3.5 w-3.5 shrink-0", className);
  if (runtimeType === "opencode_local") {
    return (
      <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center">
        <OpenCodeLogoIcon className={baseClassName} />
      </span>
    );
  }

  const source = runtimeLogoSources[runtimeType];
  if (!source) return null;
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center">
      <img src={source.src} alt="" className={cn(baseClassName, source.className)} />
    </span>
  );
}
