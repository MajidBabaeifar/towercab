// The page (UI-55, UI-57): top bar, routes, live data.

import { type JSX, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
  BoardPage as BoardData,
  IntentPage as IntentData,
  Overview,
  ReposPage as ReposData,
  TopBar as Top,
} from "../../src/ui/view.ts";
import { act, useLive } from "./api.ts";
import { ErrorNote, Freshness, Skeleton } from "./components.tsx";
import { Alert, Logo, Pause, Play } from "./icons.tsx";
import { ActivityPage } from "./pages/Activity.tsx";
import { BoardPage } from "./pages/Board.tsx";
import { FocusPage } from "./pages/Focus.tsx";
import { IntentPage } from "./pages/Intent.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { ReposPage } from "./pages/Repos.tsx";
import { Link, usePath } from "./router.tsx";

const TABS = [
  ["/", "Overview"],
  ["/board", "Board"],
  ["/focus", "Focus"],
  ["/repos", "Repos"],
  ["/activity", "Activity"],
] as const;

function HealthPill({ top }: { top: Top }) {
  const cls = { Running: "ok", Paused: "paused", Problem: "bad", "Not running": "off" }[top.health];
  return (
    <span class={`health health-${cls}`} title={top.healthNote}>
      <span class="health-dot" aria-hidden="true" />
      {top.health}
    </span>
  );
}

function PauseButton({ top }: { top: Top }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  if (top.readOnly) return null;
  const click = async () => {
    setBusy(true);
    const r = await act(top.paused ? "resume" : "pause");
    setBusy(false);
    setNote(r.ok ? null : r.message);
  };
  return (
    <button
      type="button"
      class="btn ghost pause-btn"
      disabled={busy}
      onClick={() => void click()}
      title={
        note ?? (top.paused ? "Let Towercab start new work again" : "Stop Towercab from starting new work")
      }
    >
      {top.paused ? <Play size={14} /> : <Pause size={14} />}
      <span>{top.paused ? "Resume" : "Pause"}</span>
    </button>
  );
}

function TopBar({ top, path }: { top: Top | null; path: string }) {
  // `/queue` is the Repos tab's old name (UI-140): old links land there.
  const at = path === "/queue" || path.startsWith("/queue/") ? "/repos" : path;
  const section =
    ["/board", "/focus", "/repos", "/activity"].find((p) => at === p || at.startsWith(`${p}/`)) ?? "/";
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <Link href="/" class="brand" aria-label="Towercab overview">
          <Logo size={28} />
          <span>Towercab</span>
        </Link>
        {top ? <HealthPill top={top} /> : null}
        {top ? (
          <p class="counts">
            <Link href="/" class={top.needs ? "count-needs" : undefined}>
              {top.needs} need{top.needs === 1 ? "s" : ""} you
            </Link>
            <span class="dot-sep" aria-hidden="true">
              ·
            </span>
            <span>{top.working} working</span>
            <span class="dot-sep" aria-hidden="true">
              ·
            </span>
            <span>{top.queued} queued</span>
          </p>
        ) : null}
        <span class="grow" />
        {top ? (
          <p class={`top-spend${top.overBudget ? " over" : ""}`} title="Spent today">
            <span class="num">{top.spendToday}</span>
            <span class="meta"> today{top.budget ? ` ${top.budget}` : ""}</span>
          </p>
        ) : null}
        {top ? <PauseButton top={top} /> : null}
      </div>
      <nav class="tabs" aria-label="Pages">
        <div class="tabs-inner">
          {TABS.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              class={section === href ? "tab on" : "tab"}
              aria-current={section === href ? "page" : undefined}
            >
              {label}
              {href === "/" && top?.needs ? <span class="tab-badge">{top.needs}</span> : null}
            </Link>
          ))}
          <span class="grow" />
          <Freshness />
        </div>
      </nav>
    </header>
  );
}

function IntentRoute({ id, readOnly, onTitle }: { id: string; readOnly: boolean; onTitle(t: string): void }) {
  const live = useLive<IntentData>(`/api/intents/${encodeURIComponent(id)}`);
  const title = live.data?.title;
  useEffect(() => {
    if (title) onTitle(title);
  }, [title, onTitle]);
  if (live.error && !live.data) {
    return (
      <main class="page" id="main">
        <ErrorNote text={live.error} />
        <p>
          <Link href="/">Back to the overview</Link>
        </p>
      </main>
    );
  }
  if (!live.data) return <Skeleton />;
  return <IntentPage data={live.data} readOnly={readOnly} />;
}

function ReposRoute({ search, readOnly }: { search: string; readOnly: boolean }) {
  const repo = new URLSearchParams(search).get("repo");
  const live = useLive<ReposData>(`/api/repos${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`);
  if (live.error && !live.data) return <ErrorNote text={live.error} />;
  return live.data ? <ReposPage data={live.data} readOnly={readOnly} /> : <Skeleton />;
}

function BoardRoute() {
  const live = useLive<BoardData>("/api/board");
  if (live.error && !live.data) return <ErrorNote text={live.error} />;
  return live.data ? <BoardPage data={live.data} /> : <Skeleton />;
}

function App() {
  const path = usePath();
  const [pathname, search = ""] = path.split("?");
  const state = useLive<Overview>("/api/state");
  const top = state.data?.top ?? null;
  const n = top?.needs ?? 0;
  // UI-112: a ground stop (the owner's pause or a service pause) marks the tab.
  const stopped = Boolean(state.data?.airspace.stop);
  const [intentTitle, setIntentTitle] = useState<string | null>(null);
  const intent = /^\/i\/([^/]+)\/?$/.exec(pathname!)?.[1];
  useEffect(() => {
    const page = intent
      ? intentTitle
      : pathname!.startsWith("/board")
        ? "Board"
        : pathname!.startsWith("/focus")
          ? "Focus"
          : pathname!.startsWith("/repos") || pathname!.startsWith("/queue")
            ? "Repos"
            : pathname!.startsWith("/activity")
              ? "Activity"
              : null;
    document.title = `${stopped ? "⏸ " : ""}${n ? `(${n}) ` : ""}Towercab${page ? ` · ${page}` : ""}`;
  }, [n, stopped, pathname, intent, intentTitle]);
  let page: JSX.Element;
  if (intent) {
    page = (
      <IntentRoute
        key={intent}
        id={decodeURIComponent(intent)}
        readOnly={top?.readOnly ?? true}
        onTitle={setIntentTitle}
      />
    );
  } else if (pathname === "/board") page = <BoardRoute />;
  else if (pathname === "/focus") page = <FocusPage readOnly={top?.readOnly ?? true} />;
  else if (pathname === "/repos" || pathname === "/queue")
    page = <ReposRoute search={search} readOnly={top?.readOnly ?? true} />;
  else if (pathname === "/activity") page = <ActivityPage search={search} />;
  else if (state.error && !state.data) page = <ErrorNote text={state.error} />;
  else page = state.data ? <OverviewPage data={state.data} /> : <Skeleton />;
  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <TopBar top={top} path={pathname!} />
      {top?.banner ? (
        <div class="banner" role="status">
          <Alert size={16} />
          {top.banner}
        </div>
      ) : null}
      {state.error && state.data ? <div class="banner banner-err">{state.error}</div> : null}
      {page}
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
