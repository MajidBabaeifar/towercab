// What happened, newest first (UI-64), filterable by intent, repo, kind and time; the filters live in
// the URL.

import { useEffect, useState } from "preact/hooks";
import type { ActivityItem, ActivityPage as Data } from "../../../src/ui/view.ts";
import { getJson, useLive } from "../api.ts";
import { Empty, ErrorNote, Skeleton } from "../components.tsx";
import { Alert, Bell, Dot, Log } from "../icons.tsx";
import { Link, navigate } from "../router.tsx";

const KINDS = [
  ["", "All"],
  ["moves", "Moves"],
  ["waits", "Waits"],
  ["errors", "Errors"],
] as const;

const SINCE = [
  ["", "Any time"],
  ["1h", "Last hour"],
  ["24h", "Last 24 hours"],
  ["7d", "Last 7 days"],
  ["30d", "Last 30 days"],
] as const;

function KindIcon({ kind }: { kind: ActivityItem["kind"] }) {
  if (kind === "wait") return <Bell size={14} />;
  if (kind === "error") return <Alert size={14} />;
  if (kind === "log") return <Log size={14} />;
  return <Dot size={14} />;
}

export function ActivityPage({ search }: { search: string }) {
  const params = new URLSearchParams(search);
  const filters = {
    intent: params.get("intent") ?? "",
    repo: params.get("repo") ?? "",
    kind: params.get("kind") ?? "",
    since: params.get("since") ?? "",
  };
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const live = useLive<Data>(`/api/activity${qs ? `?${qs}` : ""}`);
  const [extra, setExtra] = useState<ActivityItem[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => {
    setExtra([]);
    setMore(null);
  }, [qs]);

  const set = (k: keyof typeof filters, v: string) => {
    const next = new URLSearchParams(Object.entries({ ...filters, [k]: v }).filter(([, x]) => x)).toString();
    navigate(`/activity${next ? `?${next}` : ""}`, { replace: true, keepScroll: true });
  };
  const data = live.data;
  const items = data ? [...data.items, ...extra] : [];
  const hasMore = more ?? data?.more ?? false;
  const showMore = async () => {
    setLoadingMore(true);
    try {
      const page = await getJson<Data>(`/api/activity?${qs}${qs ? "&" : ""}offset=${items.length}`);
      setExtra((x) => [...x, ...page.items]);
      setMore(page.more);
    } finally {
      setLoadingMore(false);
    }
  };
  const days: [string, ActivityItem[]][] = [];
  for (const it of items) {
    const last = days[days.length - 1];
    if (last && last[0] === it.day) last[1].push(it);
    else days.push([it.day, [it]]);
  }
  const filtered = Object.values(filters).some(Boolean);
  return (
    <main class="page activity" id="main">
      <section class="hero hero-small">
        <h1>Activity</h1>
        <p class="hero-sub">Every move Towercab made, and what the loop logged, newest first.</p>
      </section>
      <form class="filters card" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
        <fieldset class="seg">
          <legend class="sr-only">Kind</legend>
          {KINDS.map(([v, label]) => (
            <button
              key={v}
              type="button"
              aria-pressed={filters.kind === v}
              class={filters.kind === v ? "on" : undefined}
              onClick={() => set("kind", v)}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <label class="field">
          <span>Intent</span>
          <select
            value={filters.intent}
            onChange={(e) => set("intent", (e.target as HTMLSelectElement).value)}
          >
            <option value="">All intents</option>
            {(data?.intents ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.title}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>Repo</span>
          <select value={filters.repo} onChange={(e) => set("repo", (e.target as HTMLSelectElement).value)}>
            <option value="">All repos</option>
            {(data?.repos ?? []).map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <label class="field">
          <span>When</span>
          <select value={filters.since} onChange={(e) => set("since", (e.target as HTMLSelectElement).value)}>
            {SINCE.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {filtered ? (
          <button
            type="button"
            class="link-btn clear"
            onClick={() => navigate("/activity", { replace: true, keepScroll: true })}
          >
            Clear filters
          </button>
        ) : null}
      </form>
      {live.error && !data ? <ErrorNote text={live.error} /> : null}
      {!data ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <Empty text={filtered ? "Nothing matches these filters." : "Nothing has happened yet."} />
      ) : (
        <div class="days">
          {days.map(([day, list]) => (
            <section key={day} class="day" aria-label={day}>
              <h2 class="day-head">{day}</h2>
              <ol class="feed card">
                {list.map((it) => (
                  <li key={it.key} class={`feed-item k-${it.kind}`}>
                    <time
                      class="feed-time"
                      dateTime={new Date(it.at.at * 1000).toISOString()}
                      title={it.at.exact}
                    >
                      {it.time}
                    </time>
                    <span class="feed-icon">
                      <KindIcon kind={it.kind} />
                    </span>
                    <div class="feed-body">
                      <p class="feed-text">
                        {it.title && it.intent ? (
                          <>
                            <Link href={`/i/${it.intent}`} class="feed-title">
                              {it.title}
                            </Link>
                            <span class="feed-sep"> · </span>
                          </>
                        ) : null}
                        {it.text}
                      </p>
                      {it.detail ? <p class="feed-detail">{it.detail}</p> : null}
                    </div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
          {hasMore ? (
            <button
              type="button"
              class="btn ghost more"
              disabled={loadingMore}
              onClick={() => void showMore()}
            >
              {loadingMore ? "Loading…" : "Show more"}
            </button>
          ) : null}
        </div>
      )}
    </main>
  );
}
