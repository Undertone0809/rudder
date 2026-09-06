export type MacWindowMode = "opaque" | "transparent" | "transparent_vibrant";

export function resolveMacWindowMode(value: string | null | undefined): MacWindowMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "opaque") return "opaque";
  if (normalized === "transparent") return "transparent";
  if (normalized === "transparent_vibrant" || normalized === "transparent-vibrant") {
    return "transparent_vibrant";
  }
  return "transparent_vibrant";
}
