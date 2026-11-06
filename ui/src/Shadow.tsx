// The shadow's panel (UI-237, UI-238): its recent actions, each linked to what it touched, what waits
// for the owner's yes in Telegram, today's spend against its cap, and Reset.

import { useState } from "preact/hooks";
import type { ShadowView } from "../../src/ui/view.ts";
import { act, useLive } from "./api.ts";
import { Section, ShadowTag, Time } from "./components.tsx";
import { Link } from "./router.tsx";

export function ShadowPanel({ readOnly }: { readOnly: boolean }) {
  const { data } = useLive<ShadowView>("/api/shadow");
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  // UI-237: with the shadow off the panel is not shown.
  if (!data?.enabled) return null;
  const reset = async () => {
    setBusy(true);
    const r = await act("shadowReset");
    setBusy(false);
    setAsking(false);
    setSaid(r.message);
  };
  return (
    <Section title="Shadow" id="shadow" class="shadow-panel">
      <p class="meta" data-testid="shadow-spend">
        {data.spentToday} of {data.cap} today
      </p>
      {data.pending.map((p) => (
        <p key={`${p.action}:${p.intent}`} class="shadow-pending">
          Waiting for your yes in Telegram: {p.action} {p.intent}
        </p>
      ))}
      {data.actions.length ? (
        <ul class="shadow-actions">
          {data.actions.map((a) => (
            <li key={a.id} class={`shadow-action shadow-${a.outcome}`}>
              <ShadowTag /> <span class="shadow-text">{a.text}</span>
              <span class="meta">
                {" "}
                <Time when={a.at} short />
                {a.intent ? (
                  <>
                    {" · "}
                    <Link href={`/i/${a.intent}`}>intent</Link>
                  </>
                ) : null}
                {a.pr ? (
                  <>
                    {" · "}
                    <a href={a.pr.url} target="_blank" rel="noopener noreferrer">
                      PR #{a.pr.number}
                    </a>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="empty-line">The shadow hasn't done anything yet.</p>
      )}
      {readOnly ? null : asking ? (
        <div class="shadow-ask">
          <span>Forget the whole conversation?</span>
          <button type="button" class="btn" disabled={busy} onClick={reset}>
            Yes, reset
          </button>
          <button type="button" class="btn ghost" disabled={busy} onClick={() => setAsking(false)}>
            Keep it
          </button>
        </div>
      ) : (
        <button type="button" class="btn ghost shadow-reset" onClick={() => setAsking(true)}>
          Reset
        </button>
      )}
      {said ? (
        <p class="meta" role="status">
          {said}
        </p>
      ) : null}
    </Section>
  );
}
