import { cn } from "../lib/utils";

interface FeishuLogoIconProps {
  className?: string;
}

export function FeishuLogoIcon({ className }: FeishuLogoIconProps) {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center justify-center">
      <img src="/brands/feishu-logo.svg" alt="" className={cn("h-4 w-4 shrink-0", className)} />
    </span>
  );
}
