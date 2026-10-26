// Prompt templates (`prompts/*.md`, `{{key}}`), with data fenced so it can't close its own fence.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROMPTS_DIR = resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "prompts");

/** A template filled with `vars`; an unknown `{{key}}` is a bug, a missing var an empty string. */
export function render(name: string, vars: Record<string, string>, dir = PROMPTS_DIR): string {
  const text = readFileSync(join(dir, `${name}.md`), "utf8");
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`bug: prompts/${name}.md uses {{${key}}} but it wasn't given`);
    return vars[key]!;
  });
}

/** Data placed between `<tag>` and `</tag>`: any `</tag` inside it is escaped. */
export function fence(text: string, tag: string): string {
  return text.replaceAll(`</${tag}`, `&lt;/${tag}`);
}

/** The intent file as the worker sees it (with `## Answers`), fenced for `<intent>`. */
export function intentData(text: string): string {
  return fence(text.trim(), "intent");
}
