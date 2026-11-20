// The page (UI-55, UI-57): top bar, routes, live data.

import { type JSX, render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
  BoardPage as BoardData,
  Overview,
  ReposPage as ReposData,
  TopBar as Top,
} from "../../src/ui/view.ts";
import { AccountMenu } from "./AccountMenu.tsx";
import { act, useLive } from "./api.ts";
import { ErrorNote, Freshness, Skeleton } from "./components.tsx";
import { Frame } from "./Frame.tsx";
import { Alert, Pause, Play, Spinner } from "./icons.tsx";
import { NewIntentHost } from "./NewIntent.tsx";
import { Palette } from "./Palette.tsx";
import { ActivityPage } from "./pages/Activity.tsx";
import { BoardPage } from "./pages/Board.tsx";
import { ChatView } from "./pages/Chat.tsx";
import { InboxPage } from "./pages/Inbox.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { ReposPage } from "./pages/Repos.tsx";
import { UsersPage } from "./pages/Users.tsx";
import { Link, usePath } from "./router.tsx";
import { Shortcuts } from "./Shortcuts.tsx";
import { SignIn } from "./SignIn.tsx";
import { canCreateAnywhere, useSession } from "./session.ts";

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

/** FRAME-5: the bar over the main pane: health, counts, spend, pause and the account (the tabs are gone). */
function TopBar({ top }: { top: Top | null }) {
  const { me } = useSession();
  return (
    <div class="topbar">
      <div class="topbar-inner">
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
        {top && (!me?.auth || me.role === "admin" || me.role === "maintainer") ? (
          <PauseButton top={top} />
        ) : null}
        {me?.auth && me.role === "admin" ? (
          <Link href="/users" class="btn ghost admin-link">
            People
          </Link>
        ) : null}
        {me?.auth ? <AccountMenu me={me} /> : null}
      </div>
    </div>
  );
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
  const session = useSession();
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (session.state === "out") setExpired(location.pathname !== "/signin");
  }, [session.state]);
  if (session.state === "loading") return <Skeleton />;
  if (session.state === "out" || location.pathname === "/signin") return <SignIn expired={expired} />;
  return <Pages />;
}

function Pages() {
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
      <ChatView
        key={intent}
        id={decodeURIComponent(intent)}
        readOnly={(top?.readOnly ?? true) || top?.role === "viewer"}
        onTitle={setIntentTitle}
      />
    );
  } else if (pathname === "/users") page = <UsersPage />;
  else if (pathname === "/board") page = <BoardRoute />;
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
  else
    page = state.data ? (
      <>
        <OverviewPage data={state.data} />
        <section class="page overview-more" aria-label="More">
          <p class="overview-links">
            <Link href="/activity">Activity</Link> · <Link href="/board">Board on its own page</Link>
          </p>
          <details class="overview-board">
            <summary>Board</summary>
            <BoardRoute />
          </details>
        </section>
      </>
    ) : (
      <Skeleton />
    );
  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <Frame top={top} path={pathname!} bar={<TopBar top={top} />}>
        {top?.banner ? (
          <div class="banner" role="status">
            <Alert size={16} />
            {top.banner}
          </div>
        ) : null}
        {state.error && state.data ? <div class="banner banner-err">{state.error}</div> : null}
        {page}
      </Frame>
      <Shortcuts />
      <Palette top={top} />
      <NewIntentHost top={top} />
    </>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
