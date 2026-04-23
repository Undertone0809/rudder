import type { ImgHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type RudderLogoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src">;

export function RudderLogo({ alt = "", className, ...props }: RudderLogoProps) {
  return (
    <img
      src="/rudder-logo.png"
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={cn(
        "inline-block shrink-0 rounded-full bg-white object-cover ring-1 ring-black/5 dark:ring-white/10",
        className
      )}
      {...props}
    />
  );
}
