// CHAT-1..10: one intent as a chat: its header, the workers' conversations with Towercab's moves
// between them, the card of what waits on the owner, and a composer. The rest of the old intent page
// (stage map, files, PRs, settings) is in the Details panel.

import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { ChatItem, ChatMessage, ChatPage, IntentPage as Data } from "../../../src/ui/view.ts";
import { act, getJson, useLive } from "../api.ts";
import {
  ErrorNote,
  NeedsCard,
  ObserverTag,
  OnlyYou,
  ShadowTag,
  Skeleton,
  StateChip,
} from "../components.tsx";
import { External } from "../icons.tsx";
import { Markdown } from "../md.tsx";
import { IntentPage } from "./Intent.tsx";

const DETAILS_KEY = "towercab:chat-details";

function detailsDefault(): boolean {
  try {
    const kept = localStorage.getItem(DETAILS_KEY);
    if (kept !== null) return kept === "1";
  } catch {
    // No storage: start folded.
  }
  return false;
}

const fmt = (at: number) =>
  new Date(at * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function Message({ m }: { m: ChatMessage }) {
  const who = {
    prompt: "Towercab's prompt",
    agent: "Agent",
    user: "Towercab",
    owner: m.by && m.by !== "you" ? m.by : "You",
  }[m.role];
  const body =
    m.role === "prompt" ? (
      <details class="chat-prompt">
        <summary>Towercab's instructions for this run</summary>
        <pre class="chat-pre">{m.text}</pre>
      </details>
    ) : m.text ? (
      <Markdown text={m.text} />
    ) : null;
  return (
    <li class={`chat-msg role-${m.role}`}>
      <p class="chat-who">
        <span>{who}</span> <time dateTime={new Date(m.at * 1000).toISOString()}>{fmt(m.at)}</time>
        {m.status ? (
          <span class={`chat-status st-${m.status}`}>
            {m.status === "queued" ? "waiting to go in" : m.status}
          </span>
        ) : null}
      </p>
      {body}
      {m.note && m.status === "failed" ? <p class="chat-note">{m.note}</p> : null}
      {m.tools.length ? (
        <details class="chat-tools">
          <summary>
            {m.tools.length} tool call{m.tools.length === 1 ? "" : "s"}:{" "}
            {[...new Set(m.tools.map((t) => t.name))].join(", ")}
          </summary>
          <ol>
            {m.tools.map((t, i) => (
              <li key={i} class={t.error ? "tool-err" : undefined}>
                <p class="mono">{t.name}</p>
                <pre class="chat-pre">{t.input}</pre>
                {t.result !== null ? <pre class="chat-pre chat-result">{t.result}</pre> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
  );
}

function Item({ it }: { it: ChatItem }) {
  if (it.type === "message") return <Message m={it} />;
  if (it.type === "divider")
    return (
      <li class="chat-divider">
        <span>{it.text}</span> <time>{fmt(it.at)}</time>
      </li>
    );
  return (
    <li class={`chat-event tone-${it.tone ?? "muted"}`}>
      <span>{it.text}</span> <time>{fmt(it.at)}</time>
    </li>
  );
}

/** CHAT-9: the composer. Its text survives live updates: it is this component's own state. */
function Composer({ id, page }: { id: string; page: ChatPage }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (!page.composer.open) return <p class="composer-closed">{page.composer.note}</p>;
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const r = await act("chat", id, text);
    setBusy(false);
    setNote(r.message);
    if (r.ok) setText("");
  };
  return (
    <form
      class="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <label class="sr-only" for="chat-text">
        Message to this intent
      </label>
      <textarea
        id="chat-text"
        rows={3}
        value={text}
        placeholder="Write to this intent's agent…"
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          // CHAT-10: Ctrl/⌘+Enter sends; Enter alone makes a new line.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div class="composer-row">
        <p class="meta" role="status">
          {note ?? page.composer.note}
        </p>
        <button type="submit" class="btn primary" disabled={busy || !text.trim()}>
          {busy ? "Sending…" : "Send"}
        </button>
      </div>
    </form>
  );
}

/** CHAT-3, CHAT-6: the thread; the latest page first, "Earlier" pages back. Stays at the bottom while there. */
function Thread({ id, card, readOnly }: { id: string; card: ComponentChildren; readOnly: boolean }) {
  const live = useLive<ChatPage>(`/api/intents/${encodeURIComponent(id)}/chat`);
  const [older, setOlder] = useState<ChatItem[]>([]);
  const [before, setBefore] = useState<number | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const count = live.data?.items.length ?? 0;
  useEffect(() => {
    if (pinned.current) end.current?.scrollIntoView({ block: "end" });
  }, [count]);
  useEffect(() => {
    const on = () => {
      pinned.current = innerHeight + scrollY >= document.body.scrollHeight - 80;
    };
    addEventListener("scroll", on, { passive: true });
    return () => removeEventListener("scroll", on);
  }, []);
  if (live.error && !live.data) return <ErrorNote text={live.error} />;
  if (!live.data) return <Skeleton />;
  const page = live.data;
  const next = before === undefined ? page.before : before;
  const earlier = async () => {
    if (next === null) return;
    setLoading(true);
    try {
      const p = await getJson<ChatPage>(`/api/intents/${encodeURIComponent(id)}/chat?before=${next}`);
      setOlder((o) => [...p.items, ...o]);
      setBefore(p.before);
    } finally {
      setLoading(false);
    }
  };
  const items = [...older, ...page.items];
  return (
    <>
      {next !== null ? (
        <p class="chat-earlier">
          <button type="button" class="btn ghost" disabled={loading} onClick={() => void earlier()}>
            {loading ? "Loading…" : "Show earlier"}
          </button>
        </p>
      ) : null}
      {page.missing ? (
        <p class="meta chat-missing">
          {page.missing} earlier run{page.missing === 1 ? "'s conversation is" : "s' conversations are"} no
          longer on this machine.
        </p>
      ) : null}
      {items.length ? (
        <ol class="chat-thread" aria-label="Conversation" aria-live="polite">
          {items.map((it) => (
            <Item key={it.key} it={it} />
          ))}
        </ol>
      ) : (
        <p class="chat-empty">
          Nothing has run for this intent yet. Its conversation shows here once a worker starts.
        </p>
      )}
      {card}
      <div ref={end} />
      {readOnly ? null : <Composer id={id} page={page} />}
    </>
  );
}

/** CHAT-2: the header: title, repo, stage, autonomy and the PR links; Details opens the rest. */
export function ChatView({
  id,
  readOnly,
  onTitle,
}: {
  id: string;
  readOnly: boolean;
  onTitle(t: string): void;
}) {
  const live = useLive<Data>(`/api/intents/${encodeURIComponent(id)}`);
  // CHAT-1: Details starts folded; the owner's choice is remembered in this browser.
  const [details, setDetailsState] = useState(detailsDefault);
  const setDetails = (v: boolean) => {
    setDetailsState(v);
    try {
      localStorage.setItem(DETAILS_KEY, v ? "1" : "0");
    } catch {
      // Private windows refuse storage; the choice then lasts for this page only.
    }
  };
  const title = live.data?.title;
  useEffect(() => {
    if (title) onTitle(title);
  }, [title, onTitle]);
  if (live.error && !live.data)
    return (
      <main class="chat-page" id="main">
        <ErrorNote text={live.error} />
      </main>
    );
  if (!live.data) return <Skeleton />;
  const d = live.data;
  const prs = d.prs.filter((p) => p.url);
  return (
    <main class={`chat-page${details ? " with-details" : ""}`} id="main">
      <header class="chat-head">
        <div class="chat-head-main">
          <h1>
            {d.title} {d.onlyYou ? <OnlyYou /> : null}
            {d.shadow ? <ShadowTag /> : null}
            {d.observer ? <ObserverTag /> : null}
          </h1>
          <p class="meta">
            <span class="mono">{d.repo}</span> · <StateChip state={d.state} small />
            {d.autonomy ? <> · a{d.autonomy.a}</> : null}
            {prs.map((p) => (
              <a key={p.label} class="chat-pr" href={p.url!} target="_blank" rel="noopener noreferrer">
                {p.label} <External size={12} />
              </a>
            ))}
          </p>
        </div>
        <button
          type="button"
          class="btn ghost"
          aria-expanded={details}
          aria-controls="chat-details"
          onClick={() => setDetails(!details)}
        >
          {details ? "Hide details" : "Details"}
        </button>
      </header>
      <div class="chat-body">
        <section class="chat-col" aria-label="Chat">
          <Thread
            id={id}
            readOnly={readOnly}
            card={
              d.card ? (
                <div class="chat-card">
                  <NeedsCard card={d.card} readOnly={readOnly} />
                </div>
              ) : null
            }
          />
        </section>
        {details ? (
          <aside id="chat-details" class="chat-details" aria-label="Details">
            <IntentPage data={{ ...d, card: null }} readOnly={readOnly} embedded />
          </aside>
        ) : null}
      </div>
    </main>
  );
}
