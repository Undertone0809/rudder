import { readDesktopShell } from "@/lib/desktop-shell";
import { RUDDER_DISCORD_URL } from "@/lib/product-links";
import { X } from "lucide-react";
import { useState, type MouseEvent } from "react";

export const MESSENGER_DISCORD_CTA_STORAGE_KEY = "rudder:messenger:discord-cta:v1";

function hasDismissedDiscordCta() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(MESSENGER_DISCORD_CTA_STORAGE_KEY) === "dismissed";
  } catch {
    return false;
  }
}

function DiscordLogo() {
  return (
    <svg
      data-testid="discord-logo"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="size-4"
      aria-hidden
    >
      <path d="M13.545 2.907a13.227 13.227 0 0 0-3.257-1.011c-.14.25-.3.58-.408.845a12.003 12.003 0 0 0-3.658 0 8.238 8.238 0 0 0-.419-.845 13.301 13.301 0 0 0-3.26 1.012C.514 5.953-.034 8.927.241 11.872a13.582 13.582 0 0 0 4.001 2.02 9.594 9.594 0 0 0 .987-1.35 8.169 8.169 0 0 1-1.555-.76c.131-.095.259-.195.382-.297a9.705 9.705 0 0 0 8.005 0c.124.102.252.202.382.297-.497.29-1.017.544-1.56.759a9.653 9.653 0 0 0 .988 1.35 13.57 13.57 0 0 0 4.001-2.02c.323-3.415-.551-6.362-2.327-8.964ZM5.369 10.075c-.956 0-1.747-.868-1.747-1.934 0-1.065.775-1.934 1.747-1.934.978 0 1.764.87 1.747 1.934 0 1.066-.775 1.934-1.747 1.934Zm5.263 0c-.956 0-1.747-.868-1.747-1.934 0-1.065.775-1.934 1.747-1.934.978 0 1.764.87 1.747 1.934 0 1.066-.769 1.934-1.747 1.934Z" />
    </svg>
  );
}

function openDiscordInSystemBrowser(event: MouseEvent<HTMLAnchorElement>) {
  const desktopShell = readDesktopShell();
  if (!desktopShell) return;

  event.preventDefault();
  void desktopShell.forceOpenExternal?.(RUDDER_DISCORD_URL);
}

export function MessengerDiscordCta() {
  const [visible, setVisible] = useState(() => !hasDismissedDiscordCta());

  const dismiss = () => {
    try {
      window.localStorage.setItem(MESSENGER_DISCORD_CTA_STORAGE_KEY, "dismissed");
    } catch {
      // Keep the dismissal useful for the current visit when storage is unavailable.
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div
      data-testid="messenger-discord-cta"
      className="shrink-0 border-t border-[color:color-mix(in_oklab,var(--border-soft)_72%,transparent)] px-2 py-2.5"
    >
      <div className="group relative">
        <a
          href={RUDDER_DISCORD_URL}
          target="_blank"
          rel="noopener noreferrer"
          onClick={openDiscordInSystemBrowser}
          className="flex min-h-[68px] items-center gap-2.5 rounded-[calc(var(--radius-md)-1px)] border border-[color:color-mix(in_oklab,var(--border-soft)_86%,transparent)] bg-[color:color-mix(in_oklab,var(--surface-elevated)_52%,transparent)] px-3 py-2.5 pr-9 text-left transition-[background-color,border-color,transform] duration-150 hover:border-[color:color-mix(in_oklab,var(--border-strong)_78%,transparent)] hover:bg-[color:color-mix(in_oklab,var(--surface-elevated)_82%,transparent)] active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          aria-label="Join our Discord — chat with the team and other builders"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-[calc(var(--radius-sm)+1px)] bg-[color:color-mix(in_oklab,#7289da_15%,transparent)] text-[#7289da]">
            <DiscordLogo />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] font-semibold leading-4 text-foreground">
              Join our Discord
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
              Chat with the team and other builders.
            </span>
          </span>
        </a>
        <button
          type="button"
          onClick={dismiss}
          className="absolute right-1.5 top-1.5 flex size-7 items-center justify-center rounded-[calc(var(--radius-sm)-1px)] text-muted-foreground/70 transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          aria-label="Dismiss Discord invitation"
          title="Dismiss"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
