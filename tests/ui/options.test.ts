import { expect, test } from "vitest";
import { asksFirst } from "../../ui/src/options.ts";

test("ui: an option that asks for something first only fills the reply", () => {
  expect(asksFirst("Delete the branch on GitHub, then reply here")).toBe(true);
  expect(asksFirst("Fix it in the settings, then answer")).toBe(true);
  // Other options send at one click.
  expect(asksFirst("Carry on with the build")).toBe(false);
  expect(asksFirst("Allow")).toBe(false);
  expect(asksFirst("Then reply later is a name")).toBe(false);
});
