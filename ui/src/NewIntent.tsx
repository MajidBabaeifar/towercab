// The "New intent" form (UI-213..218): a form shaped like the intent template, an overlap check when
// Create is pressed, and a choice (create anyway, add to one, cancel) when something overlaps.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ActionReply, ReposPage, TopBar } from "../../src/ui/view.ts";
import { checkIntent, createIntent, type IntentDraft, useLive } from "./api.ts";
import { Alert, Check } from "./icons.tsx";
import { NEW_INTENT_EVENT } from "./keys.ts";
import { Modal } from "./Modal.tsx";
import { Link, navigate } from "./router.tsx";

type Match = NonNullable<ActionReply["matches"]>[number];

/** UI-213: INT-33's naming rule in plain words, with its example, shown next to the title. */
export const NAMING_RULE =
  "Write it as a user story: the product, then what someone can do or see, 4 to 20 words.";
export const NAMING_EXAMPLE = "Towercab lets the owner write a new intent in a form";

const KINDS: Record<string, string> = {
  open: "Open intent",
  parked: "Parked",
  done: "Done",
  dropped: "Dropped",
  pr: "Intent PR",
};

const SECTIONS = [
  ["problem", "Problem"],
  ["outcome", "Proposed outcome"],
  ["affected", "Affected users and systems"],
  ["constraints", "Constraints"],
  ["questions", "Open questions"],
] as const;

interface Fields {
  repo: string;
  title: string;
  u: number | null;
  i: number | null;
  a: number | null;
  problem: string;
  outcome: string;
  affected: string;
  constraints: string;
  questions: string;
}

const EMPTY: Fields = {
  repo: "",
  title: "",
  u: null,
  i: null,
  a: null,
  problem: "",
  outcome: "",
  affected: "",
  constraints: "",
  questions: "",
};

// UI-218: what was typed survives a refusal, a cancel and a remount; a success clears it.
let saved: Fields = { ...EMPTY };

/** UI-217: said once after the page moves on. */
export interface Notice {
  text: string;
  href?: string;
}
const NOTICE = "towercab:notice";
let notice: Notice | null = null;
function say(n: Notice): void {
  notice = n;
  dispatchEvent(new Event(NOTICE));
}

const draftOf = (f: Fields): IntentDraft => ({
  repo: f.repo,
  title: f.title.trim(),
  ...(f.u !== null ? { u: f.u } : {}),
  ...(f.i !== null ? { i: f.i } : {}),
  ...(f.a !== null ? { a: f.a } : {}),
  ...Object.fromEntries(SECTIONS.flatMap(([k]) => (f[k].trim() ? [[k, f[k]]] : []))),
});

/** A 1 to 5 (or a0 to a5) choice that may stay unset: pressing the chosen one again clears it. */
function Pick({
  label,
  from,
  to,
  value,
  onPick,
  prefix = "",
}: {
  label: string;
  from: number;
  to: number;
  value: number | null;
  onPick(n: number | null): void;
  prefix?: string;
}) {
  const group = useRef<HTMLSpanElement>(null);
  const move = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const all = [...(group.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    all[(at + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]?.focus();
    e.preventDefault();
  };
  const choices = Array.from({ length: to - from + 1 }, (_, n) => from + n);
  return (
    <span class="autonomy-line">
      <span class="meta">{label}</span>
      {/* biome-ignore lint/a11y/useSemanticElements: a segmented control, not a form group */}
      <span class="segmented" role="group" aria-label={label} ref={group} onKeyDown={move}>
        {choices.map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={n === value}
            class={`seg${n === value ? " current" : ""}`}
            onClick={() => onPick(n === value ? null : n)}
          >
            {prefix}
            {n}
          </button>
        ))}
      </span>
    </span>
  );
}

function Note({ ok, children }: { ok: boolean; children: ComponentChildren }) {
  return (
    <p class={`result ${ok ? "ok" : "err"}`} role={ok ? "status" : "alert"}>
      {ok ? <Check size={16} /> : <Alert size={16} />}
      <span>{children}</span>
    </p>
  );
}

type Phase = "form" | "checking" | "matches" | "failed" | "creating";

function NewIntentForm({ top, close }: { top: TopBar | null; close(): void }) {
  const repos = useLive<ReposPage>("/api/repos").data;
  const names = (repos?.chips ?? []).map((c) => c.repo).filter(Boolean);
  const contributor = top?.role === "contributor";
  const [f, setF] = useState<Fields>(saved);
  const [phase, setPhase] = useState<Phase>("form");
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<Match[]>([]);
  const [titleNote, setTitleNote] = useState<string | null>(null);
  const set = <K extends keyof Fields>(k: K, v: Fields[K]) => {
    const next = { ...f, [k]: v };
    saved = next;
    setF(next);
  };
  useEffect(() => {
    if (!f.repo && names.length === 1) set("repo", names[0]!);
  });

  const create = async (addTo?: string) => {
    setPhase("creating");
    setError(null);
    const r = await createIntent(draftOf(f), addTo);
    if (!r.ok) {
      setError(r.message);
      setPhase("form");
      return;
    }
    saved = { ...EMPTY };
    close();
    if (r.proposal) {
      say({ text: r.message, ...(r.url ? { href: r.url } : {}) });
      navigate("/");
    } else {
      say({ text: r.message });
      navigate(`/i/${r.id}`);
    }
  };

  const submit = async () => {
    if (!f.repo || !f.title.trim() || phase !== "form") return;
    setPhase("checking");
    setError(null);
    const r = await checkIntent(draftOf(f));
    if (!r.ok) {
      setError(r.message);
      setPhase("failed");
      return;
    }
    setTitleNote(r.titleNote ?? null);
    if (!r.matches?.length) {
      await create();
      return;
    }
    setMatches(r.matches);
    setPhase("matches");
  };

  const busy = phase === "checking" || phase === "creating";
  const locked = phase !== "form";
  return (
    <Modal label="New intent" onClose={close} focus="select, input" class="new-intent">
      <h2 class="modal-title">New intent</h2>
      <form
        class="new-intent-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label for="ni-repo">Repo</label>
        <select
          id="ni-repo"
          value={f.repo}
          disabled={locked}
          required
          onChange={(e) => set("repo", (e.currentTarget as HTMLSelectElement).value)}
        >
          <option value="">Pick a repo</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label for="ni-title">Title</label>
        <input
          id="ni-title"
          type="text"
          autoComplete="off"
          value={f.title}
          disabled={locked}
          required
          aria-describedby="ni-rule"
          onInput={(e) => set("title", (e.currentTarget as HTMLInputElement).value)}
        />
        <p class="hint" id="ni-rule">
          {NAMING_RULE} For example: “{NAMING_EXAMPLE}”.
        </p>
        {titleNote ? (
          <p class="hint title-note" role="note">
            {titleNote}
          </p>
        ) : null}
        <div class="new-intent-scores">
          <Pick label="Urgency" from={1} to={5} value={f.u} onPick={(n) => set("u", n)} />
          <Pick label="Importance" from={1} to={5} value={f.i} onPick={(n) => set("i", n)} />
          <Pick
            label="Autonomy"
            from={0}
            to={contributor ? 4 : 5}
            prefix="a"
            value={f.a}
            onPick={(n) => set("a", n)}
          />
        </div>
        {SECTIONS.map(([k, label]) => (
          <div class="new-intent-field" key={k}>
            <label for={`ni-${k}`}>{label}</label>
            <textarea
              id={`ni-${k}`}
              rows={k === "problem" ? 4 : 3}
              value={f[k]}
              disabled={locked}
              onInput={(e) => set(k, (e.currentTarget as HTMLTextAreaElement).value)}
            />
          </div>
        ))}

        {phase === "checking" ? (
          <p class="meta" role="status" aria-live="polite">
            Checking your intent against the existing ones…
          </p>
        ) : null}
        {phase === "creating" ? (
          <p class="meta" role="status" aria-live="polite">
            {contributor ? "Proposing…" : "Creating…"}
          </p>
        ) : null}
        {error && phase !== "failed" ? <Note ok={false}>{error}</Note> : null}

        {phase === "matches" ? (
          <section class="overlaps" aria-label="Possible overlaps">
            <h3 class="modal-title">These may overlap with what you wrote</h3>
            <ul>
              {matches.map((m) => (
                <li key={m.ref}>
                  <span class="meta">{KINDS[m.kind] ?? m.kind}</span>{" "}
                  {m.kind === "pr" && m.url ? (
                    <a href={m.url} target="_blank" rel="noopener">
                      {m.title}
                    </a>
                  ) : (
                    <Link href={`/i/${m.ref}`}>{m.title}</Link>
                  )}
                  <p>{m.how}</p>
                  {m.pastDesign ? (
                    <p class="meta">
                      Already past design. Write a new intent and link{" "}
                      <Link href={`/i/${m.ref}`}>{m.ref}</Link>.
                    </p>
                  ) : null}
                  {m.canAdd && !contributor ? (
                    <button type="button" class="btn" onClick={() => void create(m.ref)}>
                      Add my text to this one
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {phase === "failed" ? (
          <section class="overlaps" aria-label="The check failed">
            <Note ok={false}>{error}</Note>
            <p class="meta">If you go on, your intent is written without the check.</p>
          </section>
        ) : null}

        <div class="modal-actions">
          {phase === "form" || phase === "checking" || phase === "creating" ? (
            <>
              <button type="submit" class="btn primary" disabled={busy || !f.repo || !f.title.trim()}>
                {phase === "checking"
                  ? "Checking…"
                  : phase === "creating"
                    ? "Creating…"
                    : contributor
                      ? "Propose"
                      : "Create"}
              </button>
              <button type="button" class="btn" disabled={busy} onClick={close}>
                Cancel
              </button>
            </>
          ) : phase === "matches" ? (
            <>
              <button type="button" class="btn primary" onClick={() => void create()}>
                {contributor ? "Propose anyway" : "Create anyway"}
              </button>
              <button type="button" class="btn" onClick={() => setPhase("form")}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" class="btn primary" onClick={() => void create()}>
                Create without the check
              </button>
              <button type="button" class="btn" onClick={() => setPhase("form")}>
                Cancel
              </button>
            </>
          )}
        </div>
        {contributor ? <p class="hint">A maintainer will accept or close your intent.</p> : null}
      </form>
    </Modal>
  );
}

/** The dialog, opened by the top bar's button or Cmd-K, and the line said once after it succeeds. */
export function NewIntentHost({ top }: { top: TopBar | null }) {
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState<Notice | null>(null);
  useEffect(() => {
    const show = () => setOpen(true);
    const hear = () => setSaid(notice);
    addEventListener(NEW_INTENT_EVENT, show);
    addEventListener(NOTICE, hear);
    return () => {
      removeEventListener(NEW_INTENT_EVENT, show);
      removeEventListener(NOTICE, hear);
    };
  }, []);
  useEffect(() => {
    if (!said) return;
    const t = setTimeout(() => setSaid(null), 10_000);
    return () => clearTimeout(t);
  }, [said]);
  const allowed = top !== null && !top.readOnly && top.role !== "viewer";
  return (
    <>
      {allowed ? (
        <button
          type="button"
          class="btn primary new-intent-fab"
          aria-label="New intent"
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true">+</span>
        </button>
      ) : null}
      {said ? (
        <div class="banner banner-ok" role="status">
          <Check size={16} />
          <span>{said.text}</span>
          {said.href ? (
            <a href={said.href} target="_blank" rel="noopener">
              Open the pull request
            </a>
          ) : null}
          <button type="button" class="link-btn" onClick={() => setSaid(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {open ? <NewIntentForm top={top} close={() => setOpen(false)} /> : null}
    </>
  );
}
