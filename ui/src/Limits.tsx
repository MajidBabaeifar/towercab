// A repo's limits on its page (UI-150 to UI-154): the form that opens a pull request to `TOWERCAB.md`,
// the pending mark, the file's reason when it can't be read, and the one-time move.

import { useState } from "preact/hooks";
import type { ActionReply, LimitsView } from "../../src/ui/view.ts";
import { openMove, saveLimits } from "./api.ts";
import { Alert, Check } from "./icons.tsx";

type Key = "workers" | "ahead";
const KEYS: { key: Key; label: string; help: string }[] = [
  {
    key: "workers",
    label: "Missions building at once",
    help: "How many changes are built and merged at the same time in this repo.",
  },
  {
    key: "ahead",
    label: "Intents ahead of build",
    help: "How many intents may be designed and planned before one is building.",
  },
];
const CONFIRM =
  "An older Towercab can't read this setting; a rollback in the next day would need a manual fix.";

interface Draft {
  text: string;
  /** "Back to default" was pressed: send `null`. */
  reset: boolean;
}

// What was typed survives a refetch or a remount (UI-67).
const drafts = new Map<string, Partial<Record<Key, Draft>>>();
const replies = new Map<string, ActionReply>();

/** UI-153: the notice at the top of the repo page and on its card when the file can't be read. */
export function FileNotice({ text, url }: { text: string; url?: string | null }) {
  return (
    <p class="why file-notice" role="alert">
      <Alert size={16} /> <span>{text}</span>
      {url ? (
        <>
          {" "}
          <a href={url} target="_blank" rel="noreferrer">
            Open the file
          </a>
        </>
      ) : null}
    </p>
  );
}

const whole = (t: string) => /^\d+$/.test(t.trim()) && Number(t) >= 1 && Number(t) <= 16;

/** The value a field starts from: what is pending in the PR, else what is in force. */
function startOf(l: LimitsView, key: Key): number {
  const p = l.pending?.changes[key];
  if (p === undefined) return l.values[key];
  return p === null ? l.defaults[key] : p;
}

export function Limits({ repo, l }: { repo: string; l: LimitsView }) {
  const [, redraw] = useState(0);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const reply = replies.get(repo) ?? null;
  const mine = drafts.get(repo) ?? {};
  const textOf = (k: Key) => mine[k]?.text ?? String(startOf(l, k));
  const set = (k: Key, d: Draft) => {
    drafts.set(repo, { ...mine, [k]: d });
    redraw((n) => n + 1);
  };
  const say = (r: ActionReply | null) => {
    if (r) replies.set(repo, r);
    else replies.delete(repo);
    redraw((n) => n + 1);
  };
  const bad = (k: Key) =>
    mine[k] && !whole(textOf(k)) ? `${k}: ${textOf(k) || "nothing"} isn't a whole number from 1 to 16` : null;
  const changes = (): Record<string, number | null> => {
    const out: Record<string, number | null> = {};
    for (const { key } of KEYS) {
      const d = mine[key];
      if (!d) continue;
      if (d.reset) out[key] = null;
      else if (whole(d.text) && Number(d.text) !== startOf(l, key)) out[key] = Number(d.text);
    }
    return out;
  };
  const dirty = Object.keys(changes()).length > 0 && !KEYS.some(({ key }) => bad(key));
  const send = async (confirmed: boolean) => {
    setBusy(true);
    setAsking(false);
    const r = await saveLimits(repo, changes(), confirmed);
    setBusy(false);
    say(r);
    if (r.ok) drafts.delete(repo);
  };
  const press = () => {
    if (!dirty || busy) return;
    if (l.waitHours !== null) setAsking(true);
    else void send(false);
  };
  return (
    <section class="repo-group repo-limits" aria-labelledby="limits-h">
      <h2 id="limits-h">Settings</h2>
      {l.fileError ? (
        <p class="meta">
          These are the last limits Towercab could read from the file; they stay in force until it is valid
          again.
        </p>
      ) : null}
      <form
        class="limits-form"
        onSubmit={(e) => {
          e.preventDefault();
          press();
        }}
      >
        {KEYS.map(({ key, label, help }) => {
          const p = l.pending?.changes[key];
          const err = bad(key);
          return (
            <div class="limit-row" key={key}>
              <label for={`limit-${key}`}>{label}</label>
              <div class="limit-field">
                <input
                  id={`limit-${key}`}
                  name={key}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={16}
                  step={1}
                  value={textOf(key)}
                  disabled={!l.canSave}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={`limit-${key}-help`}
                  onInput={(e) => set(key, { text: (e.target as HTMLInputElement).value, reset: false })}
                />
                {l.inFile[key] || (p !== undefined && p !== null) ? (
                  <button
                    type="button"
                    class="btn ghost small"
                    disabled={!l.canSave || mine[key]?.reset === true}
                    onClick={() => set(key, { text: String(l.defaults[key]), reset: true })}
                  >
                    Back to default
                  </button>
                ) : null}
                {p !== undefined && l.pending ? (
                  <span class="meta limit-pending">
                    pending: {p === null ? l.defaults[key] : p} in{" "}
                    <a href={l.pending.url} target="_blank" rel="noreferrer">
                      PR #{l.pending.pr}
                    </a>
                  </span>
                ) : null}
              </div>
              <p class="hint" id={`limit-${key}-help`}>
                {help} Default {l.defaults[key]}.
              </p>
              {err ? (
                <p class="result err" role="alert">
                  <Alert size={16} /> <span>{err}</span>
                </p>
              ) : null}
            </div>
          );
        })}
        {asking ? (
          <div class="limits-confirm" role="alertdialog" aria-label="Confirm the save">
            <p class="why">{CONFIRM}</p>
            <button type="button" class="btn primary small" onClick={() => void send(true)}>
              Save anyway
            </button>{" "}
            <button type="button" class="btn ghost small" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button type="submit" class="btn primary" disabled={!dirty || busy || !l.canSave}>
            {busy ? "Saving…" : "Save"}
          </button>
        )}
      </form>
      {reply ? (
        <p class={`result ${reply.ok ? "ok" : "err"}`} role="status">
          {reply.ok ? <Check size={16} /> : <Alert size={16} />}
          <span>{reply.message}</span>
        </p>
      ) : null}
      <p class="hint">
        {l.moved
          ? "Saved in TOWERCAB.md in the repo."
          : "Still kept by Towercab; they are being moved into the repo's TOWERCAB.md."}
      </p>
      <p class="hint limit-env">
        Kept on this machine only: {l.envNames.length ? l.envNames.join(", ") : "None set."}
      </p>
      {!l.moved && l.waitHours !== null ? (
        <p class="hint">
          Towercab moves these settings into the repo by itself in {l.waitHours} hour
          {l.waitHours === 1 ? "" : "s"}, once it has run this version for a day.
        </p>
      ) : null}
      <Move repo={repo} l={l} />
    </section>
  );
}

/** UI-154: where the one-time move stands. */
function Move({ repo, l }: { repo: string; l: LimitsView }) {
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState<ActionReply | null>(null);
  if (l.move.state === "open" && l.move.pr !== null) {
    return (
      <p class="hint limit-move">
        Moving these settings into the repo:{" "}
        <a href={l.move.url ?? "#"} target="_blank" rel="noreferrer">
          PR #{l.move.pr}
        </a>
      </p>
    );
  }
  if (l.move.state !== "closed") return null;
  return (
    <div class="limit-move">
      <p class="hint">The PR that moves these settings was closed; Towercab still keeps them.</p>
      <button
        type="button"
        class="btn small"
        disabled={!l.move.canOpen || busy}
        onClick={async () => {
          setBusy(true);
          setR(await openMove(repo));
          setBusy(false);
        }}
      >
        Open the move PR again
      </button>
      {r ? (
        <p class={`result ${r.ok ? "ok" : "err"}`} role="status">
          {r.ok ? <Check size={16} /> : <Alert size={16} />} <span>{r.message}</span>
        </p>
      ) : null}
    </div>
  );
}
