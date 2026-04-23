import { describe, expect, it } from "vitest";
import {
  semanticBadgeToneClasses,
  semanticNoticeToneClasses,
  semanticTextToneClasses,
} from "./semanticTones";

const lightForegroundPattern = /^text-(sky|emerald|amber|red)-(50|100|200)$/;

describe("semantic tone classes", () => {
  it("uses dark readable foregrounds for light-theme notice surfaces", () => {
    for (const tone of Object.keys(semanticNoticeToneClasses) as Array<keyof typeof semanticNoticeToneClasses>) {
      const classes = semanticNoticeToneClasses[tone].split(" ");
      const lightForegrounds = classes.filter((token) => token.startsWith("text-"));

      expect(lightForegrounds).toHaveLength(1);
      expect(lightForegrounds[0]).not.toMatch(lightForegroundPattern);
      expect(classes.some((token) => token.startsWith("dark:text-"))).toBe(true);
    }
  });

  it("keeps badge and plain-text tones on readable light-theme colors", () => {
    for (const classSet of [semanticBadgeToneClasses, semanticTextToneClasses]) {
      for (const tone of Object.keys(classSet) as Array<keyof typeof classSet>) {
        const classes = classSet[tone].split(" ");
        const lightForegrounds = classes.filter((token) => token.startsWith("text-"));

        expect(lightForegrounds).toHaveLength(1);
        expect(lightForegrounds[0]).not.toMatch(lightForegroundPattern);
      }
    }
  });
});
