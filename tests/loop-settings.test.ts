// REPO-15, REPO-18: the running loop reads each repo's TOWERCAB.md on its passes, so a change made in
// the repo applies, and a file that can't be read is reported.

import { expect, test } from "vitest";
import { errorKey } from "../src/repo/settings.ts";
import { TARGET } from "./helpers/flows.ts";
import { Pipe } from "./helpers/pipe.ts";
import { pushFiles } from "./helpers/world.ts";

const fm = (body: string) => `---\n${body}\n---\n`;

test("loop: a change made in the repo applies on a pass", async () => {
  const p = new Pipe(TARGET, {});
  await p.start({ repos: { web: { github: "owner/web", workers: 2 } } });
  p.loop.d.limits = true;
  const web = () => p.loop.d.config.repos.get("web")!;
  await p.loop.pass();
  await p.loop.limitsIdle();
  await p.loop.pass();
  expect(web().workers).toBe(2);
  // Someone edits the file in the repo: the next poll (a minute on) picks it up.
  pushFiles(p.bares.web!, { "TOWERCAB.md": fm("workers: 5\nahead: 7") });
  p.clock.advance(61);
  await p.loop.pass();
  await p.loop.limitsIdle();
  await p.loop.pass();
  expect(web()).toMatchObject({ workers: 5, ahead: 7 });
  // An invalid file is reported and the limits in force stay.
  pushFiles(p.bares.web!, { "TOWERCAB.md": fm("workers: 99") });
  p.clock.advance(61);
  await p.loop.pass();
  await p.loop.limitsIdle();
  await p.loop.pass();
  expect(p.db.meta(errorKey("web"))).toBe("workers: 99 isn't a whole number from 1 to 16");
  expect(web().workers).toBe(5);
});
