import { describe, expect, test } from "vitest";
import { ChatRig, labels } from "./helpers/telegram.ts";

describe("telegram: commands", () => {
  test("telegram: status lists what runs and what needs you", async () => {
    const rig = new ChatRig({ ui_url: "https://tc.example/" });
    rig.runningRows = [{ intent: "i-9", title: "Build the export", step: "build" }];
    rig.wait("i-1", { title: "Add login" });
    rig.proposals = [
      { pr: 3, head: "a".repeat(40), title: "Idea", repo: "web", url: "https://github.com/o/i/pull/3" },
    ];
    rig.db.setMeta("paused", "1");
    rig.say("/status");
    await rig.chat.pass();
    await rig.deliver();
    const text = rig.sent().find((s) => s.text.includes("Paused"))!.text;
    expect(text).toContain("Paused: 1 step finishing.");
    expect(text).toContain("▶ Build the export: build https://tc.example/?intent=i-9");
    expect(text).toContain("⏳ Add login: Review and merge the code https://tc.example/?intent=i-1");
    expect(text).toContain("💡 Idea: proposed https://github.com/o/i/pull/3");
    expect(rig.sent().find((s) => s.text === text)!.keyboard).toBeUndefined();
  });

  test("telegram: status is capped and says how many more", async () => {
    const rig = new ChatRig({}, { shadow: { enabled: true } });
    rig.runningRows = Array.from({ length: 13 }, (_, i) => ({
      intent: `r-${i}`,
      title: `Run ${i}`,
      step: "build",
    }));
    rig.say("/status");
    await rig.run();
    const lines = rig.sent()[0]!.text.split("\n");
    expect(lines.filter((l) => l.startsWith("▶"))).toHaveLength(10);
    expect(lines).toContain("and 3 more");
    expect(lines.at(-1)).toMatch(/^Shadow: /);
  });

  test("telegram: status when idle", async () => {
    const rig = new ChatRig();
    rig.say("/status");
    await rig.run();
    expect(rig.sent()[0]!.text).toBe("Nothing is running and nothing needs you.");
  });

  test("telegram: focus sends the top wait with buttons", async () => {
    const rig = new ChatRig();
    const w = rig.wait("i-1");
    rig.focusPick = { wait: w.view, proposal: null, more: 2 };
    rig.say("/focus");
    await rig.chat.pass();
    await rig.deliver();
    const m = rig.sent().find((s) => s.text.includes("2 more waiting"))!;
    expect(labels(m)).toEqual(["Merge", "Start over", "Drop"]);
    expect(m.text).toContain("Add export (web)");
    expect(m.text.endsWith("https://github.com/owner/web/pull/7")).toBe(true);
  });

  test("telegram: focus picks as the focus tab does", async () => {
    const rig = new ChatRig();
    const a = rig.wait("i-1", { title: "Low" });
    const b = rig.wait("i-2", { title: "High" });
    // The page's pick (the inbox's first item) is what the chat shows, whatever the order of the waits.
    rig.focusPick = { wait: b.view, proposal: null, more: 1 };
    rig.say("/focus");
    await rig.run();
    const texts = rig.sent().map((s) => s.text);
    expect(texts.filter((t) => t.includes("High (web)") && t.includes("1 more waiting"))).toHaveLength(1);
    expect(texts.filter((t) => t.includes("1 more waiting") && t.includes("Low"))).toHaveLength(0);
    void a;
  });

  test("telegram: focus offers accept and close for a proposal", async () => {
    const rig = new ChatRig();
    const p = {
      pr: 5,
      head: "b".repeat(40),
      title: "Idea",
      repo: "web",
      url: "https://github.com/o/i/pull/5",
    };
    rig.focusPick = { wait: null, proposal: p, more: 0 };
    rig.say("/focus");
    await rig.run();
    const m = rig.sent()[0]!;
    expect(labels(m)).toEqual(["Accept", "Close"]);
    expect(m.text).toContain("Idea (web)");
  });

  test("telegram: focus says nothing needs you", async () => {
    const rig = new ChatRig();
    rig.say("/focus");
    await rig.run();
    expect(rig.sent()[0]!.text).toBe("Nothing needs you.");
  });

  test("telegram: queue lists the order with states", async () => {
    const rig = new ChatRig();
    rig.queueRows = [
      { title: "First", repo: "web", state: "running" },
      { title: "Second", repo: "web", state: "waiting on you" },
      { title: "Third", repo: "api", state: "held back: waiting for 261101-1" },
    ];
    rig.say("/queue");
    await rig.run();
    expect(rig.sent()[0]!.text).toBe(
      "1. First (web) · running\n2. Second (web) · waiting on you\n3. Third (api) · held back: waiting for 261101-1",
    );
  });

  test("telegram: queue is capped", async () => {
    const rig = new ChatRig();
    rig.queueRows = Array.from({ length: 12 }, (_, i) => ({ title: `T${i}`, repo: "web", state: "next" }));
    rig.say("/queue");
    await rig.run();
    const lines = rig.sent()[0]!.text.split("\n");
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toBe("and 2 more");
  });

  test("telegram: empty queue", async () => {
    const rig = new ChatRig();
    rig.say("/queue");
    await rig.run();
    expect(rig.sent()[0]!.text).toBe("The queue is empty.");
  });
});
