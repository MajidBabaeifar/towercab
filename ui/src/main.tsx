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
import { Alert, Logo, Pause, Play, Spinner } from "./icons.tsx";
import { Palette } from "./Palette.tsx";
import { ActivityPage } from "./pages/Activity.tsx";
import { BoardPage } from "./pages/Board.tsx";
import { InboxPage } from "./pages/Inbox.tsx";
import { IntentPage } from "./pages/Intent.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { ReposPage } from "./pages/Repos.tsx";
import { Link, usePath } from "./router.tsx";
import { Shortcuts } from "./Shortcuts.tsx";

const TABS = [
  ["/", "Inbox"],
  ["/overview", "Overview"],
  ["/board", "Board"],
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
  // UI-282: after a click the loop applies the command on its next pass, so the button shows it is
  // working until the page reports the new state, and cannot be pressed again meanwhile.
  const [want, setWant] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (want !== null && top.paused === want) setWant(null);
  }, [top.paused, want]);
  useEffect(() => {
    if (want === null) return;
    const t = setTimeout(() => {
      setWant(null);
      setNote("Towercab has not applied it yet: check that the service is running");
    }, 60_000);
    return () => clearTimeout(t);
  }, [want]);
  if (top.readOnly) return null;
  const click = async () => {
    const target = !top.paused;
    setWant(target);
    setNote(null);
    const r = await act(target ? "pause" : "resume");
    if (!r.ok) {
      setWant(null);
      setNote(r.message);
    }
  };
  const pending = want !== null;
  const label = pending ? (want ? "Pausing…" : "Resuming…") : top.paused ? "Resume" : "Pause";
  return (
    <button
      type="button"
      class="btn ghost pause-btn"
      disabled={pending}
      aria-busy={pending}
      onClick={() => void click()}
      title={
        note ??
        (pending
          ? "Towercab applies this on its next pass, within a few seconds"
          : top.paused
            ? "Let Towercab start new work again"
            : "Stop Towercab from starting new work")
      }
    >
      {pending ? <Spinner size={14} class="spin" /> : top.paused ? <Play size={14} /> : <Pause size={14} />}
      <span>{label}</span>
    </button>
  );
}

function TopBar({ top, path }: { top: Top | null; path: string }) {
  // `/queue` is the Repos tab's old name (UI-140): old links land there.
  const at = path === "/queue" || path.startsWith("/queue/") ? "/repos" : path;
  const section =
    ["/overview", "/board", "/repos", "/activity"].find((p) => at === p || at.startsWith(`${p}/`)) ?? "/";
  return (
    <header class="topbar">
      <div class="topbar-inner">
        <Link href="/" class="brand" aria-label="Towercab inbox">
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
            {top.slotsText ? (
              <span class="slots-note" title={top.slotsText}>
                <span class="dot-sep" aria-hidden="true">
                  ·
                </span>{" "}
                {top.slotsText.split(" · ")[0]}
              </span>
            ) : null}
            <Freshness />
          </p>
        ) : null}
        <span class="grow" />
        {top ? (
          <p
            class={`top-spend${top.overBudget ? " over" : ""}${top.budgetChip && top.budgetChip.level !== "ok" ? ` ${top.budgetChip.level}` : ""}`}
            title="Spent against the budget"
          >
            {top.budgetChip ? (
              <>
                <span class="num">{top.budgetChip.text}</span>
                {top.budgetChip.note ? <span class="meta"> · {top.budgetChip.note}</span> : null}
              </>
            ) : (
              <>
                <span class="num">{top.spendToday}</span>
                <span class="meta"> today{top.budget ? ` ${top.budget}` : ""}</span>
              </>
            )}
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
          <Link href="/overview">Back to the overview</Link>
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
        : pathname!.startsWith("/overview")
          ? "Overview"
          : pathname!.startsWith("/repos") || pathname!.startsWith("/queue")
            ? "Repos"
            : pathname!.startsWith("/activity")
              ? "Activity"
              : null;
    document.title = `${stopped ? "⏸ " : ""}${n ? `(${n}) ` : ""}Towercab${page ? ` · ${page}` : ""}`;
  }, [n, stopped, pathname, intent, intentTitle]);
  // UI-266: the Inbox is the home page; the Overview has its own address.
  const inboxId =
    pathname === "/" || pathname === "/inbox" || pathname === "/inbox/"
      ? ""
      : /^\/inbox\/([^/]+)\/?$/.exec(pathname!)?.[1];
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
  else if (pathname === "/repos" || pathname === "/queue")
    page = <ReposRoute search={search} readOnly={top?.readOnly ?? true} />;
  else if (pathname === "/activity") page = <ActivityPage search={search} />;
  else if (inboxId !== undefined)
    page = (
      <InboxPage
        readOnly={top?.readOnly ?? true}
        selected={inboxId ? decodeURIComponent(inboxId) : null}
        search={search}
      />
    );
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
      <Shortcuts />
      <Palette top={top} />
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
