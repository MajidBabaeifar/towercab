// The queue (UI-63): per repo, what runs, what waits behind it, what is parked, what was done.

import type { QueuePage as Data, QueueItem } from "../../../src/ui/view.ts";
import { StateChip, Time, WorkRow } from "../components.tsx";
import { Link } from "../router.tsx";

function Item({ item }: { item: QueueItem }) {
  return (
    <li class="q-item">
      {item.position !== null ? <span class="pos">{item.position}</span> : null}
      <div class="q-body">
        <Link class="q-title" href={`/i/${item.intent}`}>
          {item.title}
        </Link>
        {item.reason ? <span class="up-reason">{item.reason}</span> : null}
        {item.when || item.cost ? (
          <span class="meta">
            {item.when ? <Time when={item.when} /> : null}
            {item.when && item.cost ? " · " : ""}
            {item.cost ? <span class="num">{item.cost}</span> : null}
          </span>
        ) : null}
      </div>
      <StateChip state={item.state} small />
    </li>
  );
}

export function QueuePage({ data }: { data: Data }) {
  return (
    <main class="page queue" id="main">
      <section class="hero hero-small">
        <h1>Queue</h1>
        <p class="hero-sub">Per repo: what runs now, what waits behind it, and what was done lately.</p>
      </section>
      {data.lanes.length === 0 ? (
        <p class="empty-line">No repos in the config yet.</p>
      ) : (
        <div class="lanes">
          {data.lanes.map((l) => (
            <section key={l.repo} class="card lane" aria-label={`Repo ${l.repo}`}>
              <header class="lane-head">
                <h2>{l.repo}</h2>
                {l.github ? <span class="meta mono">{l.github}</span> : null}
                <span class="meta">{l.ahead}</span>
              </header>
              <div class="lane-group">
                <h3>In progress</h3>
                {l.running.length ? (
                  <div class="rows compact">
                    {l.running.map((r) => (
                      <WorkRow key={r.intent} row={r} />
                    ))}
                  </div>
                ) : (
                  <p class="empty-line">Nothing is running.</p>
                )}
              </div>
              {l.waiting.length ? (
                <div class="lane-group">
                  <h3>Waiting</h3>
                  <ol class="q-list">
                    {l.waiting.map((i) => (
                      <Item key={i.intent} item={i} />
                    ))}
                  </ol>
                </div>
              ) : null}
              {l.parked.length ? (
                <div class="lane-group">
                  <h3>Parked</h3>
                  <ul class="q-list">
                    {l.parked.map((i) => (
                      <Item key={i.intent} item={i} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {l.done.length ? (
                <div class="lane-group">
                  <h3>Recently done</h3>
                  <ul class="q-list done-list">
                    {l.done.map((i) => (
                      <Item key={i.intent} item={i} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
