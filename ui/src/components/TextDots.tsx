import type { CSSProperties, ComponentPropsWithoutRef } from "react";
import { cn } from "@/lib/utils";

type TextDotsProps = ComponentPropsWithoutRef<"span"> & {
  text: string;
};

export function TextDots({ text, className, ...props }: TextDotsProps) {
  return (
    <span
      role="status"
      aria-label={`${text}...`}
      className={cn("rudder-text-dots inline-flex items-baseline whitespace-nowrap align-baseline", className)}
      {...props}
    >
      <span>{text}</span>
      <span className="rudder-text-dots__dots" aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="rudder-text-dots__dot"
            style={{ "--rudder-text-dot-index": index } as CSSProperties}
          >
            .
          </span>
        ))}
      </span>
    </span>
  );
}
