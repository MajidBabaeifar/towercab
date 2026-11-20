// FRAME-1..6: the app's frame: a sidebar of open intents by repo, the main pane beside it. On a phone
// the sidebar is a drawer behind a menu button.

import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SidebarView, SideItem, TopBar } from "../../src/ui/view.ts";
import { useLive } from "./api.ts";
import { Logo } from "./icons.tsx";
import { openNewIntent } from "./keys.ts";
import { Link } from "./router.tsx";

const STAGE_WORDS: Record<SideItem["stage"], string> = {
  queue: "queued",
  spec: "spec",
  plan: "plan",
  code: "code",
  ship: "ship",
};

/** FRAME-2: the state as one of five words the sidebar shows. */
export function sideState(i: SideItem): { word: string; tone: string } {
  if (i.needsYou) return { word: "waiting on you", tone: "needs" };
  const k = i.state.key;
  if (k === "working" || k === "ci") return { word: "working", tone: "working" };
  if (k === "stalled" || k === "paused") return { word: "blocked", tone: "blocked" };
  if (k === "done") return { word: "done", tone: "done" };
  if (k === "unverified") return { word: "live", tone: "live" };
  return { word: i.state.label.toLowerCase(), tone: "idle" };
}

function Row({ item, current }: { item: SideItem; current: string | null }) {
  const s = sideState(item);
  const on = current === item.intent;
  return (
    <li>
      <Link
        href={`/i/${encodeURIComponent(item.intent)}`}
        class={`side-row${on ? " on" : ""}`}
        aria-current={on ? "page" : undefined}
        title={item.title}
      >
        <span class={`side-dot tone-${s.tone}`} aria-hidden="true" />
        <span class="side-title">{item.title}</span>
        <span class="side-meta">
          {STAGE_WORDS[item.stage]} · <span class={`tone-${s.tone}`}>{s.word}</span>
        </span>
      </Link>
    </li>
  );
}

function Sidebar({
  top,
  path,
  onlyNeeds,
  setOnlyNeeds,
  close,
}: {
  top: TopBar | null;
  path: string;
  onlyNeeds: boolean;
  setOnlyNeeds(v: boolean): void;
  close(): void;
}) {
  const live = useLive<SidebarView>("/api/sidebar");
  const current = /^\/i\/([^/]+)/.exec(path)?.[1] ?? null;
  const cur = current ? decodeURIComponent(current) : null;
  const repos = (live.data?.repos ?? [])
    .map((r) => ({ ...r, items: onlyNeeds ? r.items.filter((i) => i.needsYou) : r.items }))
    .filter((r) => r.items.length);
  const needs = live.data?.needs ?? top?.needs ?? 0;
  const canWrite = top && !top.readOnly && top.role !== "viewer";
  return (
    <nav class="sidebar" aria-label="Intents">
      <div class="side-head">
        <Link href="/" class="brand" aria-label="Towercab: what needs you">
          <Logo size={24} />
          <span>Towercab</span>
        </Link>
        <button type="button" class="btn ghost side-close" aria-label="Close the menu" onClick={close}>
          ×
        </button>
      </div>
      {canWrite ? (
        <button type="button" class="btn primary side-new" onClick={openNewIntent}>
          + New intent
        </button>
      ) : null}
      <ul class="side-pinned">
        <li>
          <Link
            href="/"
            class={`side-pin${onlyNeeds ? " on" : ""}`}
            aria-pressed={onlyNeeds}
            onClick={() => setOnlyNeeds(!onlyNeeds || path !== "/")}
          >
            Needs you <span class={`side-count${needs ? " hot" : ""}`}>{needs}</span>
          </Link>
        </li>
        <li>
          <Link href="/overview" class={`side-pin${path.startsWith("/overview") ? " on" : ""}`}>
            Overview
          </Link>
        </li>
        <li>
          <Link href="/repos" class={`side-pin${path.startsWith("/repos") ? " on" : ""}`}>
            Repos
          </Link>
        </li>
      </ul>
      <div class="side-list">
        {live.error && !live.data ? <p class="side-empty">{live.error}</p> : null}
        {live.data && !repos.length ? (
          <p class="side-empty">
            {onlyNeeds ? "Nothing waits on you." : "No open intents. Write one with + New intent."}
          </p>
        ) : null}
        {repos.map((r) => (
          <section key={r.repo || "-"} class="side-repo" aria-label={r.repo || "Unknown repo"}>
            <h2 class="side-repo-name">{r.repo || "Unknown repo"}</h2>
            <ul>
              {r.items.map((i) => (
                <Row key={i.intent} item={i} current={cur} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </nav>
  );
}

/** FRAME-1, FRAME-6: the sidebar and the main pane; on a phone the sidebar opens over it. */
export function Frame({
  top,
  path,
  children,
  bar,
}: {
  top: TopBar | null;
  path: string;
  children: ComponentChildren;
  bar: ComponentChildren;
}) {
  const [open, setOpen] = useState(false);
  const [onlyNeeds, setOnlyNeeds] = useState(false);
  // FRAME-6: picking a row closes the drawer.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [open]);
  return (
    <div class={`frame${open ? " drawer-open" : ""}`}>
      <Sidebar
        top={top}
        path={path}
        onlyNeeds={onlyNeeds}
        setOnlyNeeds={setOnlyNeeds}
        close={() => setOpen(false)}
      />
      {open ? (
        <button type="button" class="scrim" aria-label="Close the menu" onClick={() => setOpen(false)} />
      ) : null}
      <div class="frame-main">
        <header class="frame-bar">
          <button
            type="button"
            class="btn ghost menu-btn"
            aria-label="Open the intents menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
          >
            ☰
          </button>
          {bar}
        </header>
        {children}
      </div>
    </div>
  );
}
