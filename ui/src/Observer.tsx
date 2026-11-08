// The observer's panel (UI-242): its last run, this week's proposals against the limit, and today's spend
// against its cap. With the observer off the panel is not shown.

import type { ObserverView } from "../../src/ui/view.ts";
import { useLive } from "./api.ts";
import { Section, Time } from "./components.tsx";

const TRIGGERS: Record<string, string> = { daily: "the daily run" };

export function ObserverPanel() {
  const { data } = useLive<ObserverView>("/api/observer");
  if (!data?.enabled) return null;
  const run = data.lastRun;
  return (
    <Section title="Observer" id="observer" class="observer-panel">
      <p class="meta" data-testid="observer-spend">
        {data.spentToday} of {data.cap} today
        {data.capReached ? " · today's cap is reached, so it won't run again until tomorrow" : ""}
      </p>
      <p class="meta" data-testid="observer-week">
        {data.proposalsThisWeek} of {data.maxPerWeek} proposals this week
      </p>
      {run ? (
        <p data-testid="observer-last">
          Last run <Time when={run.at} short /> · {TRIGGERS[run.trigger] ?? `after ${run.trigger}`} ·{" "}
          {run.outcome === "done"
            ? `${run.proposals} proposed, ${run.comments} added to existing work`
            : run.outcome === "capped"
              ? "stopped: its budget was used up"
              : run.outcome === "running"
                ? "running now"
                : `failed${run.why ? `: ${run.why}` : ""}`}
        </p>
      ) : (
        <p class="empty-line">The observer hasn't run yet.</p>
      )}
      <p class="meta" data-testid="observer-report">
        {data.lastReport ? `Weekly report sent ${data.lastReport}` : "No weekly report yet"}
      </p>
    </Section>
  );
}
