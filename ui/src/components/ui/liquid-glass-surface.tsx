import * as React from "react";

type LiquidGlassVariant = "modal" | "menu" | "preview" | "tooltip";

const displacementByVariant: Record<LiquidGlassVariant, number> = {
  modal: 18,
  menu: 13,
  preview: 11,
  tooltip: 6,
};

function LiquidGlassSurface({ variant }: { variant: LiquidGlassVariant }) {
  const filterId = `rudder-liquid-glass-${React.useId().replace(/:/g, "")}`;
  const displacement = displacementByVariant[variant];
  const surfaceRef = React.useRef<HTMLSpanElement>(null);

  React.useLayoutEffect(() => {
    const host = surfaceRef.current?.parentElement;
    if (!host?.classList.contains("liquid-glass-host")) return;

    const filterValue = `url("#${filterId}")`;
    host.style.setProperty("--liquid-glass-filter", filterValue);
    host.dataset.liquidGlassVariant = variant;

    return () => {
      if (host.style.getPropertyValue("--liquid-glass-filter") === filterValue) {
        host.style.removeProperty("--liquid-glass-filter");
      }
      if (host.dataset.liquidGlassVariant === variant) {
        delete host.dataset.liquidGlassVariant;
      }
    };
  }, [filterId, variant]);

  return (
    <span
      ref={surfaceRef}
      aria-hidden="true"
      className="liquid-glass-surface pointer-events-none"
      data-liquid-glass-variant={variant}
      data-rudder-liquid-glass=""
    >
      <svg
        aria-hidden="true"
        className="liquid-glass-defs"
        focusable="false"
      >
        <defs>
          <filter
            colorInterpolationFilters="sRGB"
            data-liquid-glass-filter=""
            height="160%"
            id={filterId}
            width="160%"
            x="-30%"
            y="-30%"
          >
            <feTurbulence
              baseFrequency="0.012 0.024"
              numOctaves="1"
              result="liquid-noise"
              seed="17"
              type="fractalNoise"
            />
            <feDisplacementMap
              in="SourceGraphic"
              in2="liquid-noise"
              result="liquid-displaced"
              scale={displacement}
              xChannelSelector="R"
              yChannelSelector="B"
            />
            <feOffset dx="-0.7" dy="0" in="liquid-displaced" result="liquid-red-shift" />
            <feColorMatrix
              in="liquid-red-shift"
              result="liquid-red"
              values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            />
            <feOffset dx="0.7" dy="0" in="liquid-displaced" result="liquid-blue-shift" />
            <feColorMatrix
              in="liquid-blue-shift"
              result="liquid-blue"
              values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            />
            <feBlend in="liquid-displaced" in2="liquid-red" mode="screen" result="liquid-red-blend" />
            <feBlend in="liquid-red-blend" in2="liquid-blue" mode="screen" />
          </filter>
        </defs>
      </svg>
      <span
        className="liquid-glass-warp"
        data-liquid-glass-warp=""
      />
      <span className="liquid-glass-tint" data-liquid-glass-tint="" />
      <span className="liquid-glass-highlight" data-liquid-glass-highlight="" />
    </span>
  );
}

export { LiquidGlassSurface, type LiquidGlassVariant };
