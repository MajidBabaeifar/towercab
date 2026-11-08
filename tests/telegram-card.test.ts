import { describe, expect, test } from "vitest";
import {
  buildTrack,
  type CardView,
  cardLines,
  cardText,
  clip,
  pingText,
  TRACK,
  trackIndex,
  trackLines,
  WIDTH,
  wrap,
} from "../src/telegram/card.ts";

const view = (over: Partial<CardView> = {}): CardView => ({
  intent: "261108-1018",
  mission: 1,
  title: "Add export",
  repo: "web",
  track: buildTrack(3, 0, false),
  status: "Building",
  ask: "Review and merge the code",
  question: false,
  onlyYou: false,
  waitId: "1.0",
  final: null,
  link: "https://github.com/owner/web/pull/7",
  ...over,
});

const width = (s: string) => [...s].length;

describe("telegram: the card is a block of characters", () => {
  test("telegram: the card has header, status, track and link", () => {
    const text = cardText(view());
    expect(text.startsWith("<pre>")).toBe(true);
    const [block, link] = text.split("</pre>\n") as [string, string];
    expect(link).toBe("https://github.com/owner/web/pull/7");
    expect(block.slice("<pre>".length).split("\n")).toEqual([
      "◆ 261108-1018",
      "Add export",
      "web",
      "▶ YOU: Review and merge the",
      "code",
      "spec ● plan ● build ●",
      "review ◐ merge ○",
    ]);
    // Nothing the browser would read as markup: titles are escaped.
    expect(cardText(view({ title: "A <b> & C" }))).toContain("A &lt;b&gt; &amp; C");
    expect(cardText(view({ link: null }))).not.toContain("http");
  });

  test("telegram: the card asks the owner on the first lines", () => {
    const lines = cardLines(view());
    expect(lines.findIndex((l) => l.startsWith("▶ YOU:"))).toBeLessThanOrEqual(3);
    // Without a question, what is happening now takes its place.
    expect(cardLines(view({ ask: null, waitId: null })).join("\n")).toContain("Building");
    expect(cardLines(view({ ask: null, final: "✅ done" })).join("\n")).toContain("✅ done");
    expect(cardLines(view({ question: true })).join("\n")).toContain("Reply to answer.");
  });

  test("telegram: the track marks done, current and next", () => {
    expect(buildTrack(2, 0, false).map((t) => t.mark)).toEqual(["●", "●", "◐", "○", "○"]);
    expect(buildTrack(0, 0, false).map((t) => t.mark)).toEqual(["◐", "○", "○", "○", "○"]);
    expect(buildTrack(4, 0, true).map((t) => t.mark)).toEqual(["●", "●", "●", "●", "●"]);
    // Stages the intent never visited are not listed.
    expect(buildTrack(3, 2, false).map((t) => t.name)).toEqual(["build", "review", "merge"]);
    expect(trackIndex("approval:spec", null)).toBe(0);
    expect(trackIndex("blocked", "ci")).toBe(2);
    expect(TRACK).toHaveLength(5);
  });
});

describe("telegram: built for a phone", () => {
  test("telegram: every card line fits 28 characters", () => {
    const long = "word ".repeat(60);
    for (const v of [
      view(),
      view({ title: long, ask: long, repo: "r".repeat(60), intent: "i".repeat(60) }),
      view({ ask: "x".repeat(100) }),
      view({ ask: null, final: `⚠ unverified: ${long}` }),
      view({ ask: "Décider ✅ 🗑 ▶ ◐ ○", onlyYou: true, question: true }),
    ])
      for (const line of cardLines(v)) expect(width(line), line).toBeLessThanOrEqual(WIDTH);
    expect(width(pingText({ title: long, ask: long }))).toBeLessThanOrEqual(60);
    expect(wrap("a".repeat(40))).toEqual([`${"a".repeat(27)}…`]);
  });

  test("telegram: a long track is split over two lines", () => {
    const lines = trackLines(buildTrack(2, 0, false));
    expect(lines).toEqual(["spec ● plan ● build ◐", "review ○ merge ○"]);
    expect(trackLines(buildTrack(3, 2, false))).toEqual(["build ● review ◐ merge ○"]);
    // Never in the middle of a stage, however narrow.
    expect(trackLines(buildTrack(2, 0, false), 12)).toEqual([
      "spec ●",
      "plan ●",
      "build ◐",
      "review ○",
      "merge ○",
    ]);
  });

  test("telegram: a long title is cut", () => {
    const lines = cardLines(
      view({ title: "Export every invoice of every month as one big spreadsheet file now" }),
    );
    const title = lines.slice(1, lines.indexOf("web"));
    expect(title).toHaveLength(2);
    expect(title[1]!.endsWith("…")).toBe(true);
    expect(clip("short", 28)).toBe("short");
  });
});
