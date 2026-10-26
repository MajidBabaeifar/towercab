// Intent fixtures for the intents, priority and pick tests.

import { splitDir } from "../../src/intents/id.ts";
import { IntentFile } from "../../src/intents/intent.ts";
import { listingOf } from "../../src/intents/store.ts";
import type { Intent, Listing, Unreadable } from "../../src/intents/types.ts";

/** A small `intent.md`: `repo`, the extra front matter lines, a blank line and the title. */
export function intentMd(repo: string, extra: string, title: string): string {
  return `---\nrepo: ${repo}\n${extra}---\n\n# Intent: ${title}\n`;
}

/** The intent `text` read from folder `dir` (`intents/<id>-<slug>` or `done/…`). */
export function intentAt(dir: string, text: string): Intent {
  const f = IntentFile.parse(text);
  const parts = splitDir(dir.split("/")[1]!)!;
  [f.id, f.slug, f.dir] = [parts.id, parts.slug, dir];
  return f.intent;
}

/** An intent in `dir` for `repo` (default `towercab`), titled after its slug. */
export function at(dir: string, extra = "", repo = "towercab", title?: string): Intent {
  return intentAt(dir, intentMd(repo, extra, title ?? dir.split("/")[1]!));
}

export function listing(intents: Intent[], legacy = "", unreadable: Unreadable[] = []): Listing {
  return listingOf(intents, legacy, unreadable);
}

export const ids = (list: Intent[]) => list.map((i) => i.id);
