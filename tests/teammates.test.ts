// A teammate's approval (PIP-142, PIP-143, PIP-145, PIP-147): who counts and which approvals count.

import { expect, test } from "vitest";
import type { PrReview } from "../src/github/prs.ts";
import { readCodeowners } from "../src/github/teammates.ts";
import type { GitHub } from "../src/handlers.ts";
import {
  approval,
  codeOwnersOf,
  parseCodeowners,
  reviewersOf,
  reviewWarning,
  type TeamInput,
  tooFewListed,
  waitWhy,
} from "../src/teammates.ts";
import { failResult, okResult } from "./helpers/tools.ts";

const base = (o: Partial<TeamInput> = {}): TeamInput => ({
  listed: ["alice", "bob"],
  me: "owner",
  bot: "towercab[bot]",
  author: "towercab[bot]",
  codeowners: null,
  files: ["src/a.ts"],
  ...o,
});

const review = (
  author: string,
  state: string,
  commit: string | null = "h1",
  at = "2026-11-05T10:00:00Z",
): PrReview => ({
  author,
  state,
  body: "",
  at,
  commit,
});

const facts = (reviews: PrReview[], same: string[] = []) => ({
  head: "h1",
  reviews,
  sameDiff: new Set(same),
});

test("pipeline: a listed reviewer's approval counts", () => {
  expect(approval(base(), facts([review("Alice", "APPROVED")]))).toEqual({ kind: "approved", by: ["alice"] });
  expect(approval(base(), facts([]))).toEqual({ kind: "waiting", who: ["alice", "bob"] });
  expect(waitWhy(["alice", "bob"])).toBe("Waiting for teammate review from alice, bob.");
});

test("pipeline: the owner's approval is not a teammate approval", () => {
  // Listed or a code owner, the owner, the bot and the PR's author never count.
  const t = base({
    listed: ["owner", "towercab", "carol", "alice"],
    author: "alice",
    codeowners: "* @owner @towercab[bot]\n",
  });
  expect(reviewersOf(t)).toEqual(["carol"]);
  const owner = approval(base(), facts([review("owner", "APPROVED"), review("towercab[bot]", "APPROVED")]));
  expect(owner.kind).toBe("waiting");
});

test("pipeline: an approval of an older head with a changed diff is stale", () => {
  const old = review("alice", "APPROVED", "h0");
  expect(approval(base(), facts([old])).kind).toBe("waiting");
  // A review whose commit gh didn't say is stale too.
  expect(approval(base(), facts([review("alice", "APPROVED", null)])).kind).toBe("waiting");
});

test("pipeline: an approval survives an update that only brings the branch up to date", () => {
  const old = review("alice", "APPROVED", "h0");
  expect(approval(base(), facts([old], ["h0"]))).toEqual({ kind: "approved", by: ["alice"] });
});

test("pipeline: a changed diff cancels the approval and asks again", () => {
  const old = review("alice", "APPROVED", "h0");
  // h0's diff is not among the commits whose own changes equal the head's.
  expect(approval(base(), facts([old], ["h9"])).kind).toBe("waiting");
});

test("pipeline: a dismissed approval is not counted again", () => {
  const reviews = [
    review("alice", "APPROVED", "h1", "2026-11-05T10:00:00Z"),
    review("alice", "DISMISSED", "h1", "2026-11-05T11:00:00Z"),
  ];
  expect(approval(base(), facts(reviews)).kind).toBe("waiting");
  // A later request for changes replaces an earlier approval as well.
  const changed = [
    review("alice", "APPROVED", "h1", "2026-11-05T10:00:00Z"),
    review("alice", "CHANGES_REQUESTED", "h1", "2026-11-05T11:00:00Z"),
  ];
  expect(approval(base(), facts(changed)).kind).toBe("waiting");
  // A plain comment after an approval leaves it.
  const commented = [
    review("alice", "APPROVED", "h1", "2026-11-05T10:00:00Z"),
    review("alice", "COMMENTED", "h1", "2026-11-05T11:00:00Z"),
  ];
  expect(approval(base(), facts(commented)).kind).toBe("approved");
});

test("pipeline: the last matching CODEOWNERS pattern wins", () => {
  const rules = parseCodeowners(
    "# owners\n* @root\n/src/ @alice @bob  # the code\n*.md @docs\n/src/legacy/ @legacy\n",
  );
  expect(codeOwnersOf(["src/a.ts"], rules)).toEqual(["alice", "bob"]);
  expect(codeOwnersOf(["src/legacy/x.ts"], rules)).toEqual(["legacy"]);
  expect(codeOwnersOf(["README.md"], rules)).toEqual(["docs"]);
  expect(codeOwnersOf(["lib/x.ts"], rules)).toEqual(["root"]);
  expect(codeOwnersOf(["src/a.ts", "README.md"], rules)).toEqual(["alice", "bob", "docs"]);
  // A pattern without a slash matches at any depth; a leading slash anchors it.
  const deep = parseCodeowners("docs @d\n/top.txt @t\n");
  expect(codeOwnersOf(["a/docs/x.md"], deep)).toEqual(["d"]);
  expect(codeOwnersOf(["a/top.txt"], deep)).toEqual([]);
  expect(codeOwnersOf(["top.txt"], deep)).toEqual(["t"]);
});

test("pipeline: a code owner of a changed path counts", () => {
  const t = base({ listed: [], codeowners: "/src/ @carol\n/docs/ @dave\n", files: ["src/a.ts"] });
  expect(reviewersOf(t)).toEqual(["carol"]);
  expect(approval(t, facts([review("carol", "APPROVED")]))).toEqual({ kind: "approved", by: ["carol"] });
  // An owner of an unchanged path does not count.
  expect(approval(t, facts([review("dave", "APPROVED")])).kind).toBe("waiting");
});

test("pipeline: someone the host was asked to review but is neither listed nor a code owner does not count", () => {
  // `reviewersOf` takes no host requests: whoever asked, a requested login that is not listed or a code owner is out.
  const t = base({ codeowners: "/src/ @carol\n" });
  expect(reviewersOf(t)).toEqual(["alice", "bob", "carol"]);
  expect(approval(t, facts([review("mallory", "APPROVED")])).kind).toBe("waiting");
});

test("pipeline: an unlisted approval does not count even if the host approved", () => {
  // The rules never look at the host's decision to widen who counts; with a list only it and the owners count.
  const t = base({ codeowners: null });
  expect(approval(t, facts([review("mallory", "APPROVED")])).kind).toBe("waiting");
});

test("pipeline: a team owner counts for nobody", () => {
  const t = base({ listed: [], codeowners: "* @org/team me@example.com @carol\n" });
  expect(reviewersOf(t)).toEqual(["carol"]);
  expect(reviewersOf(base({ listed: [], codeowners: "* @org/team me@example.com\n" }))).toEqual([]);
});

test("pipeline: an unreadable CODEOWNERS means no code owners", () => {
  expect(reviewersOf(base({ listed: [], codeowners: null }))).toEqual([]);
  // A file list that can't be read (or was cut off) means no code owners too; the listed still count.
  expect(reviewersOf(base({ listed: ["alice"], codeowners: "* @carol\n", files: null }))).toEqual(["alice"]);
});

test("pipeline: no reviewers and no code owners asks the owner", () => {
  expect(approval(base({ listed: [], codeowners: null }), facts([review("alice", "APPROVED")]))).toEqual({
    kind: "nobody",
  });
});

test("pipeline: CODEOWNERS is read from the base branch", async () => {
  const calls: string[][] = [];
  const gh = {
    gh: async (_repo: string, args: string[]) => {
      calls.push(args);
      return args.some((a) => a.includes(".github/CODEOWNERS")) ? failResult("404") : okResult("* @carol\n");
    },
  } as unknown as GitHub;
  expect(await readCodeowners(gh, "owner/web", "trunk")).toBe("* @carol\n");
  expect(calls.map((a) => a.find((x) => x.startsWith("repos/")))).toEqual([
    "repos/owner/web/contents/.github/CODEOWNERS?ref=trunk",
    "repos/owner/web/contents/CODEOWNERS?ref=trunk",
  ]);
  const none = { gh: async () => failResult("404") } as unknown as GitHub;
  expect(await readCodeowners(none, "owner/web", "main")).toBeNull();
});

test("pipeline: too few reviewers for the host's rule sets a warning", () => {
  const w = reviewWarning({
    repoName: "web",
    required: 2,
    reviewers: ["alice"],
    approved: false,
    decision: "REVIEW_REQUIRED",
  });
  expect(w).toBe(
    "GitHub needs 2 approvals and your reviewers can give 1: add reviewers with towercab repo set web reviewers=…",
  );
  expect(tooFewListed(["alice"], "owner", 2)).toBe(true);
  expect(tooFewListed(["alice", "owner"], "owner", 2)).toBe(true);
  expect(tooFewListed(["alice", "bob"], "owner", 2)).toBe(false);
});

test("pipeline: a host that still wants approval after the reviewers' sets a warning", () => {
  const w = reviewWarning({
    repoName: "web",
    required: 1,
    reviewers: ["alice"],
    approved: true,
    decision: "REVIEW_REQUIRED",
  });
  expect(w).toMatch(/^GitHub still wants an approval you have not got/);
});

test("pipeline: the warning clears when the list is fixed", () => {
  const ok = { repoName: "web", required: 2, reviewers: ["alice", "bob"], approved: false, decision: "" };
  expect(reviewWarning(ok)).toBeNull();
  expect(reviewWarning({ ...ok, required: null, reviewers: [] })).toBeNull();
});
