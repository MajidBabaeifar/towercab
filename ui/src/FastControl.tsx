// FAST-1, FAST-9: put an intent in the fast lane, and confirm a mark that did not come from the owner.

import { useState } from "preact/hooks";
import type { ActionReply, FastView } from "../../src/ui/view.ts";
import { setFast } from "./api.ts";

export function FastControl({
  intent,
  view,
  readOnly,
}: {
  intent: string;
  view: FastView;
  readOnly: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionReply | null>(null);
  const off = readOnly || view.locked || busy;
  const go = async (on: boolean) => {
    setBusy(true);
    setResult(await setFast(intent, on));
    setBusy(false);
  };
  return (
    <span class="fast-lane">
      <span class="meta">Fast lane</span>{" "}
      {!view.on ? (
        <button type="button" class="btn small" disabled={off} onClick={() => void go(true)}>
          Put in the fast lane
        </button>
      ) : (
        <>
          {view.confirmed ? (
            <span class="meta">in the fast lane</span>
          ) : (
            <span class="meta">fast lane: waiting for your confirmation</span>
          )}{" "}
          {view.confirmed ? null : (
            <button type="button" class="btn primary small" disabled={off} onClick={() => void go(true)}>
              Confirm
            </button>
          )}{" "}
          <button type="button" class="btn small" disabled={off} onClick={() => void go(false)}>
            Take out
          </button>
        </>
      )}
      {result && !result.ok ? (
        <span class="meta error" role="status">
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
