// The stage map of the intent page (UI-73 to UI-77): the path an intent really took, one node per stage,
// its rounds and the steps back, and the files of the stage that is open, shown inline.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type {
  AttemptView,
  StageFileView,
  StageId,
  StageNodeView,
  VisitOutcome,
  VisitView,
} from "../../src/ui/view.ts";
import { Time } from "./components.tsx";
import { Alert, Bell, Check, ChevronDown, FileText, Restart, Spinner, XCircle } from "./icons.tsx";
import { navigate, usePath } from "./router.tsx";

const NARROW = "(max-width: 720px)";

/** True on a phone-sized screen, where the files open inside the list (UI-77). */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
  useEffect(() => {
    const q = matchMedia(NARROW);
    const on = () => setNarrow(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return narrow;
}

function OutcomeIcon({ outcome }: { outcome: VisitOutcome }) {
  switch (outcome) {
    case "passed":
      return <Check size={14} />;
    case "red":
      return <XCircle size={14} />;
    case "sent back":
      return <Restart size={14} />;
    case "waiting on you":
      return <Bell size={14} />;
    case "working now":
      return <Spinner size={14} class="spin" />;
    case "skipped":
      return <Alert size={14} class="smap-skip-icon" />;
    case "not reached":
      return (
        <svg
          class="icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="8" stroke-dasharray="3 3" />
        </svg>
      );
  }
}

const CLASS: Record<VisitOutcome, string> = {
  passed: "ok",
  red: "red",
  "sent back": "back",
  "waiting on you": "wait",
  "working now": "work",
  skipped: "skip",
  "not reached": "idle",
};

function nodeLabel(n: StageNodeView): string {
  const bits = [`${n.name}: ${n.outcome}`];
  if (n.time) bits.push(n.time);
  if (n.visits.length > 1) bits.push(`${n.visits.length} rounds`);
  if (n.note) bits.push(n.note);
  return bits.join(", ");
}

/** Words of a step back, as text: "sent back to Building: checks failed"; a red after the merge rolls back (UI-123). */
function returnText(v: VisitView, names: Map<StageId, string>): string {
  if (v.returnTo === "rollback") return `rolled back: ${v.returnLabel ?? "it failed live"}`;
  return `sent back to ${names.get(v.returnTo!) ?? v.returnTo}: ${v.returnLabel ?? "it needed more work"}`;
}

function Rounds({ node }: { node: StageNodeView }) {
  if (node.visits.length < 2) return null;
  return (
    <ol class="smap-rounds" aria-label="Rounds">
      {node.visits.map((v) => (
        <li key={v.round} class={`smap-round smap-${CLASS[v.outcome]}`}>
          <OutcomeIcon outcome={v.outcome} />
          <span>
            Round {v.round}
            <span class="smap-round-out"> · {v.outcome}</span>
          </span>
          <span class="meta num">{v.time}</span>
        </li>
      ))}
    </ol>
  );
}

function Returns({ node, names }: { node: StageNodeView; names: Map<StageId, string> }) {
  const back = node.visits.filter((v) => v.returnTo);
  if (!back.length) return null;
  return (
    <ul class="smap-returns">
      {back.map((v) => (
        <li key={v.round}>
          <svg
            class="smap-return-arrow"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M9 14 4 9l5-5" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
          <span>
            {node.visits.length > 1 ? `Round ${v.round} ` : ""}
            {returnText(v, names)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The raw path of a run file, each part encoded. */
function rawUrl(id: string, path: string): string {
  return `/api/runs/${encodeURIComponent(id)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

const TAIL = 200;

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** One file, inline: the last 200 lines, "Show all", "Open raw" (UI-75). */
function Viewer({ id, file }: { id: string; file: StageFileView }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const path = file.path!;
  // A changed file is read again without clearing what is shown, so the reader keeps their place.
  useEffect(() => {
    const ctl = new AbortController();
    fetch(rawUrl(id, path), { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error("This file is gone.");
        const body = await r.text();
        setText(/\.json$/.test(path) ? prettyJson(body.trim()) : body);
        setError(null);
      })
      .catch((e: Error) => {
        if (ctl.signal.aborted) return;
        setError(e.message || "Can't reach Towercab. Is it still running?");
      });
    return () => ctl.abort();
  }, [id, path, file.size, file.at.at]);
  useEffect(() => setAll(false), [path]);
  if (error && text === null) return <p class="smap-note">{error}</p>;
  if (text === null) return <p class="smap-note">Loading…</p>;
  const lines = text.replace(/\n$/, "").split("\n");
  const cut = !all && lines.length > TAIL;
  const shown = cut ? lines.slice(-TAIL) : lines;
  return (
    <div class="viewer">
      <div class="viewer-bar">
        <span class="viewer-name">{file.kind}</span>
        <span class="meta mono">{file.name}</span>
        <span class="viewer-actions">
          {cut ? (
            <button type="button" class="link-btn" onClick={() => setAll(true)}>
              Show all {lines.length} lines
            </button>
          ) : null}
          <a href={rawUrl(id, path)} target="_blank" rel="noopener noreferrer">
            Open raw
          </a>
        </span>
      </div>
      {cut ? (
        <p class="viewer-cut meta">
          Showing the last {TAIL} of {lines.length} lines.
        </p>
      ) : null}
      <pre class="viewer-text">{shown.join("\n")}</pre>
    </div>
  );
}

function FileRow({
  file,
  open,
  onOpen,
}: {
  file: StageFileView;
  open: boolean;
  onOpen(f: StageFileView): void;
}) {
  const body = (
    <>
      <FileText size={14} />
      <span class="file-main">
        <span class="file-kind">{file.kind}</span>
        <span class="meta mono file-name">{file.name}</span>
      </span>
      <span class="meta num">{file.size}</span>
      <span class="meta">
        <Time when={file.at} />
      </span>
    </>
  );
  return (
    <li class={open ? "file-open" : undefined}>
      {file.path ? (
        <button type="button" class="file-btn" aria-pressed={open} onClick={() => onOpen(file)}>
          {body}
        </button>
      ) : (
        <div class="file-btn file-static">{body}</div>
      )}
    </li>
  );
}

/** The files of the open stage, by round, "Details" folded (UI-75). */
function Panel({
  id,
  node,
  file,
  onOpen,
}: {
  id: string;
  node: StageNodeView;
  file: string | null;
  onOpen(f: StageFileView): void;
}) {
  const rounds = new Map<number | null, StageFileView[]>();
  for (const f of node.files) rounds.set(f.round, [...(rounds.get(f.round) ?? []), f]);
  const keys = [...rounds.keys()].sort((a, b) => (a ?? 1e9) - (b ?? 1e9));
  const selected = node.files.find((f) => f.path === file) ?? null;
  const manyRounds = keys.length > 1;
  return (
    <section class="smap-panel" aria-label={`${node.name}: files`}>
      <h3 class="smap-panel-title">{node.name}</h3>
      {node.visits.length === 0 && node.files.length === 0 ? (
        <p class="smap-note">{node.note ?? "Nothing has happened here yet."}</p>
      ) : null}
      {node.owner && node.decision ? (
        <p class="smap-note">
          {node.decision.who} {node.decision.what} <Time when={node.decision.at} />.
        </p>
      ) : null}
      {node.owner && node.current ? (
        <p class="smap-note">Waiting for you: {node.name.toLowerCase()}.</p>
      ) : null}
      {node.visits.length > 0 && node.files.length === 0 && !node.owner ? (
        <p class="smap-note">This stage wrote no files.</p>
      ) : null}
      {keys.map((k) => {
        const group = rounds.get(k)!;
        const main = group.filter((f) => !f.details);
        const details = group.filter((f) => f.details);
        return (
          <div key={k ?? "none"} class="smap-group">
            {manyRounds ? <h4>{k === null ? "Other files" : `Round ${k}`}</h4> : null}
            {main.length ? (
              <ul class="files">
                {main.map((f) => (
                  <FileRow key={f.name} file={f} open={f.path === file} onOpen={onOpen} />
                ))}
              </ul>
            ) : null}
            {details.length ? (
              <details class="smap-details" open={details.some((f) => f.path === file) || undefined}>
                <summary>Details</summary>
                <ul class="files">
                  {details.map((f) => (
                    <FileRow key={f.name} file={f} open={f.path === file} onOpen={onOpen} />
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
      {selected?.path ? <Viewer id={id} file={selected} /> : null}
    </section>
  );
}

function setQuery(change: Record<string, string | null>): void {
  const q = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(change)) {
    if (v === null) q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(`${location.pathname}${s ? `?${s}` : ""}`, { replace: true, keepScroll: true });
}

/** UI-73 to UI-77. `moves` is the folded "All moves" list under the map. */
export function StageMap({
  id,
  attempts,
  moves,
}: {
  id: string;
  attempts: AttemptView[];
  moves: ComponentChildren;
}) {
  const path = usePath();
  const narrow = useNarrow();
  const list = useRef<HTMLOListElement>(null);
  const query = new URLSearchParams(path.split("?")[1] ?? "");
  if (!attempts.length) return null;
  const want = Number(query.get("attempt"));
  const attempt = attempts.find((a) => a.attempt === want) ?? attempts[attempts.length - 1]!;
  const map = attempt.map;
  const names = new Map<StageId, string>(map.stages.map((s) => [s.id, s.name]));
  const chosen = query.get("stage");
  const openId: StageId | null =
    chosen === "none" ? null : ((map.stages.find((s) => s.id === chosen)?.id ?? map.open) as StageId | null);
  const openNode = map.stages.find((s) => s.id === openId) ?? null;
  const file = query.get("file");

  const choose = (n: StageNodeView) => setQuery({ stage: n.id === openId ? "none" : n.id, file: null });
  const openFile = (f: StageFileView) => setQuery({ stage: f.stage, file: f.path === file ? null : f.path });
  const move = (e: KeyboardEvent) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("button.smap-btn") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let to = at;
    if (e.key in keys) to = Math.min(buttons.length - 1, Math.max(0, at + keys[e.key]!));
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = buttons.length - 1;
    else return;
    e.preventDefault();
    buttons[to]?.focus();
  };

  // UI-272: a run of two or more stages not reached yet folds into one row.
  const groups: (StageNodeView | StageNodeView[])[] = [];
  for (const n of map.stages) {
    const idle = n.outcome === "not reached" && !n.current;
    const last = groups[groups.length - 1];
    if (idle && Array.isArray(last)) last.push(n);
    else if (idle && last && !Array.isArray(last) && last.outcome === "not reached" && !last.current) {
      groups[groups.length - 1] = [last, n];
    } else groups.push(n);
  }
  const node = (n: StageNodeView) => {
    const isOpen = n.id === openId;
    return (
      <li
        key={n.id}
        class={`smap-node smap-${CLASS[n.outcome]}${n.owner ? " smap-owner" : ""}${isOpen ? " smap-open" : ""}`}
      >
        <button
          type="button"
          class="smap-btn"
          aria-expanded={isOpen}
          aria-current={n.current ? "step" : undefined}
          aria-label={nodeLabel(n)}
          onClick={() => choose(n)}
        >
          <span class="smap-name">{n.name}</span>
          <span class="smap-out">
            <OutcomeIcon outcome={n.outcome} />
            {n.outcome}
          </span>
          {n.time ? <span class="smap-time num">{n.time}</span> : null}
          <ChevronDown size={14} class="smap-chev" />
        </button>
        {n.note ? <p class="smap-why">{n.note}</p> : null}
        <Rounds node={n} />
        <Returns node={n} names={names} />
        {narrow && isOpen && openNode ? (
          <Panel id={id} node={openNode} file={file} onOpen={openFile} />
        ) : null}
      </li>
    );
  };

  return (
    <div class="smap">
      {attempts.length > 1 ? (
        <fieldset class="smap-attempts" aria-label="Attempt">
          {attempts.map((a) => (
            <button
              key={a.attempt}
              type="button"
              class="seg-btn"
              aria-pressed={a.attempt === attempt.attempt}
              onClick={() =>
                setQuery({
                  attempt: a.attempt === attempts.length ? null : String(a.attempt),
                  stage: null,
                  file: null,
                })
              }
            >
              Attempt {a.attempt}
            </button>
          ))}
        </fieldset>
      ) : null}
      <ol class="smap-list" ref={list} onKeyDown={move} aria-label="Stages in pipeline order">
        {groups.map((g) =>
          Array.isArray(g) ? (
            <li key={`more-${g[0]!.id}`} class="smap-more">
              <details open={g.some((n) => n.id === openId) || undefined}>
                <summary>{g.length} more stages to go</summary>
                <ol class="smap-list smap-list-inner">{g.map((n) => node(n))}</ol>
              </details>
            </li>
          ) : (
            node(g)
          ),
        )}
      </ol>
      {map.offPath ? (
        <p class="smap-off meta" title={map.offPath.reason}>
          Not part of this repo's path: {map.offPath.names.join(", ")}
        </p>
      ) : null}
      <dl class="smap-totals">
        <div>
          <dt>Towercab working</dt>
          <dd class="num">{map.towercab}</dd>
        </div>
        <div>
          <dt>Waiting on you</dt>
          <dd class="num">{map.owner}</dd>
        </div>
      </dl>
      {!narrow && openNode ? <Panel id={id} node={openNode} file={file} onOpen={openFile} /> : null}
      {moves}
    </div>
  );
}
