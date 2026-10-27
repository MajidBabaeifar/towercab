// The airspace strip (UI-78 to UI-82): every open intent as a tiny plane on one metro line, a small
// radar-style card per plane, and a toggle that hides it. Geometry lives in airspace-layout.ts.

import type { JSX } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { AirspaceView, Phase, Plane, StateKey } from "../../src/ui/view.ts";
import { type Item, layoutAirspace } from "./airspace-layout.ts";
import { Link, navigate } from "./router.tsx";

const PLANE =
  "M7 0L-4.5 -1.2L-4.5 1.2Z M1.5 0L-1.5 -6L-3 -6L-1 0L-3 6L-1.5 6Z M-3.5 0L-5.8 -3L-7 -3L-5.6 0L-7 3L-5.8 3Z";
const KEY = "towercab.airspace";
const CLOSE_MS = 250;
const CARD_W = 264;

function readHidden(): boolean {
  try {
    return localStorage.getItem(KEY) === "hidden";
  } catch {
    return false;
  }
}

function writeHidden(hidden: boolean): void {
  try {
    localStorage.setItem(KEY, hidden ? "hidden" : "shown");
  } catch {
    // Private mode: the choice lasts until reload.
  }
}

const tone = (k: StateKey) => ({ "--c": `var(--${k})` }) as JSX.CSSProperties;

const PHASE_MARK: Record<Phase["status"], string> = { done: "■", current: "◧", todo: "□", skipped: "–" };
const phaseText = (ps: Phase[]) =>
  ps.map((p) => `${p.label.toLowerCase()} ${PHASE_MARK[p.status]}`).join("  ");

/** One plane and its state's in-place motion (UI-79). */
function Glyph({ plane, heading, index }: { plane: Plane; heading: number; index: number }) {
  const k = plane.state.key;
  const body = <path d={PLANE} transform={heading ? `rotate(${heading})` : undefined} />;
  if (k === "ci")
    return (
      <>
        <circle class="air-ring" r="10" />
        <g class="air-orbit">
          <circle r="17" fill="none" />
          <path d={PLANE} transform="translate(10 0) rotate(90)" />
        </g>
      </>
    );
  return (
    <>
      {k === "working" ? <rect class="air-ping" x="-4" y="-4" width="8" height="8" /> : null}
      <g class={k === "working" ? "air-bob" : k === "stalled" ? "air-shake" : undefined}>{body}</g>
      {k === "needs" ? (
        <rect
          class="air-blink"
          x="-2"
          y="-14"
          width="4"
          height="4"
          style={{ animationDelay: `${(index % 3) * 0.4}s` }}
        />
      ) : null}
      {k === "stalled" ? (
        <text class="air-mark" x="10" y="-8">
          !
        </text>
      ) : null}
      {k === "cooling" ? (
        <text class="air-mark" x="9" y="-5">
          *
        </text>
      ) : null}
      {k === "upnext" ? (
        <text class="air-mark air-blink" y="-13" text-anchor="middle">
          next
        </text>
      ) : null}
      {k === "parked" && index % 2 === 0 ? (
        <text class="air-zz" x="2" y="-8" style={{ animationDelay: `${index * 0.7}s` }}>
          z
        </text>
      ) : null}
    </>
  );
}

const placeWords: Record<Plane["station"], string> = {
  parked: "parked",
  queue: "in the queue",
  gate: "at the gate",
  spec: "in spec",
  "spec-review": "at your spec review",
  plan: "in plan",
  "plan-review": "at your plan review",
  code: "in code",
  ci: "at CI",
  "code-review": "at your code review",
  landed: "landed",
};

interface Open {
  key: string;
  left: number;
  top: number;
  stem: number;
  /** The anchor's top, for opening upward. */
  above: number;
}

function Card({
  open,
  data,
  items,
  upTop,
  cardRef,
  keep,
  leave,
}: {
  open: Open;
  data: AirspaceView;
  items: Item[];
  upTop: number | null;
  cardRef: { current: HTMLDivElement | null };
  keep: () => void;
  leave: () => void;
}) {
  const item = items.find((i) => i.key === open.key);
  if (!item) return null;
  let k: StateKey = "done";
  let body: JSX.Element;
  if (item.kind === "plane") {
    const p = item.plane;
    k = p.state.key;
    body = (
      <>
        <div class="air-card-head">
          <span>
            {p.intent} · {p.repo}
          </span>
          <span>▲ {p.state.label.toLowerCase()}</span>
        </div>
        <div class="air-card-title">{p.title}</div>
        <div>▸ {p.lines[0]}</div>
        {p.lines[1] ? <div>▸ {p.lines[1]}</div> : null}
        <div>▸ {phaseText(p.phases)}</div>
        <Link class="air-go" href={`/i/${p.intent}`}>
          Open intent ›
        </Link>
      </>
    );
  } else if (item.kind === "more") {
    k = item.hidden[0]?.state.key ?? "queued";
    body = (
      <>
        <div class="air-card-head">
          <span>{placeWords[item.station]}</span>
          <span>+{item.hidden.length}</span>
        </div>
        <ul class="air-card-list">
          {item.hidden.map((p) => (
            <li key={p.intent} style={tone(p.state.key)}>
              <Link href={`/i/${p.intent}`}>
                <span class="air-dot">▲</span> {p.title}
              </Link>
            </li>
          ))}
        </ul>
      </>
    );
  } else {
    const l = data.landed;
    body = (
      <>
        <div class="air-card-head">
          <span>today</span>
          <span>▲ landed</span>
        </div>
        <div class="air-card-title">{l.count} landed today</div>
        <div>
          ▸ {l.cost} · {l.agentTime} agent time
        </div>
        {l.recent.map((r) => (
          <div key={r.intent}>
            ▸ {r.title} · {r.repo}
          </div>
        ))}
        <Link class="air-go" href="/activity?since=24h">
          Open activity ›
        </Link>
      </>
    );
  }
  return (
    <div
      ref={cardRef}
      class={`air-card${upTop !== null ? " up" : ""}`}
      role="dialog"
      aria-label="Intent brief"
      style={{ ...tone(k), left: `${open.left}px`, top: `${upTop ?? open.top}px`, "--sx": `${open.stem}px` }}
      onMouseEnter={keep}
      onMouseLeave={leave}
      onFocusIn={keep}
      onFocusOut={leave}
    >
      <i class="k k1" />
      <i class="k k2" />
      <i class="k k3" />
      <i class="k k4" />
      {body}
    </div>
  );
}

export function Airspace({ data }: { data: AirspaceView }) {
  const [hidden, setHidden] = useState(readHidden);
  const [width, setWidth] = useState(680);
  const [open, setOpen] = useState<Open | null>(null);
  const [upTop, setUpTop] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hidden]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, []);

  // Open upward only when the card would run off the bottom of the screen and fits above.
  useLayoutEffect(() => {
    const c = cardRef.current;
    const w = wrap.current;
    if (!open || !c || !w) return;
    const top = w.getBoundingClientRect().top;
    const h = c.offsetHeight;
    const room = top + open.top + h <= innerHeight || top + open.above - h - 10 < 0;
    setUpTop(room ? null : open.above - h - 10);
  }, [open]);

  const lay = layoutAirspace(data, width);
  const keep = () => clearTimeout(timer.current);
  const leave = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(null), CLOSE_MS);
  };
  const show = (key: string, el: Element) => {
    keep();
    const w = wrap.current;
    if (!w) return;
    const r = el.getBoundingClientRect();
    const b = w.getBoundingClientRect();
    const mid = r.left + r.width / 2 - b.left;
    const left = Math.max(6, Math.min(b.width - CARD_W - 6, mid - CARD_W / 2));
    setUpTop(null);
    setOpen({ key, left, top: r.bottom - b.top + 10, stem: mid - left, above: r.top - b.top });
  };
  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    setOpen(null);
    writeHidden(next);
  };
  const hrefOf = (it: Item) =>
    it.kind === "plane" ? `/i/${it.plane.intent}` : it.kind === "landed" ? "/activity?since=24h" : "#";
  const target = (it: Item, children: JSX.Element, label: string) => (
    <a
      href={hrefOf(it)}
      class="air-target"
      aria-label={label}
      onMouseEnter={(e) => show(it.key, e.currentTarget)}
      onMouseLeave={leave}
      onFocus={(e) => show(it.key, e.currentTarget)}
      onBlur={leave}
      onClick={(e) => {
        e.preventDefault();
        if (open?.key === it.key && it.kind !== "more") navigate(hrefOf(it));
        else show(it.key, e.currentTarget);
      }}
    >
      {children}
    </a>
  );

  const empty = data.planes.length === 0 && data.landed.count === 0;
  return (
    <section class="section air-section" aria-label="Airspace">
      <header class="section-head">
        <h2>Airspace</h2>
        <span class="section-aside">
          <button
            type="button"
            class="btn ghost small"
            aria-expanded={!hidden}
            aria-controls="airspace"
            onClick={toggle}
          >
            {hidden ? "Show airspace" : "Hide airspace"}
          </button>
        </span>
      </header>
      {hidden ? (
        <p class="air-collapsed">{data.countsText}</p>
      ) : (
        <div class="air" id="airspace" ref={wrap}>
          <p class="sr-only">{data.summary}</p>
          <svg
            class="air-svg"
            width={lay.width}
            height={lay.height}
            viewBox={`0 0 ${lay.width} ${lay.height}`}
            aria-label="Airspace map"
          >
            {lay.header.tag ? (
              <text class="air-tag" x="14" y="20">
                twr://airspace
              </text>
            ) : null}
            <text class="air-counts" x={lay.header.x} y={lay.header.y} text-anchor={lay.header.anchor}>
              <tspan style={tone("working")}>{data.counts.flying} in flight</tspan>
              {" · "}
              <tspan style={tone("needs")}>
                {data.counts.needs} need{data.counts.needs === 1 ? "s" : ""} you
              </tspan>
              {" · "}
              <tspan style={tone("done")}>{data.counts.landed} landed today</tspan>
            </text>
            <line class="air-rule" x1="14" x2={lay.width - 14} y1={lay.header.rule} y2={lay.header.rule} />
            <path class="air-siding" d={lay.siding} />
            <path class="air-track" d={lay.track} />
            <path class="air-flow" d={lay.flow} />
            {lay.stations.map((s) =>
              s.shape === "landed" ? (
                <rect
                  key={s.key}
                  class="air-st air-st-landed"
                  x={s.x - 6}
                  y={s.y - 6}
                  width="12"
                  height="12"
                />
              ) : (
                <rect
                  key={s.key}
                  class={`air-st${s.shape === "diamond" ? " air-st-review" : ""}`}
                  x={s.x - 4}
                  y={s.y - 4}
                  width="8"
                  height="8"
                  transform={s.shape === "diamond" ? `rotate(45 ${s.x} ${s.y})` : undefined}
                />
              ),
            )}
            {lay.labels.map((l) => (
              <text
                key={`${l.text}${l.x}${l.y}`}
                class={`air-label air-${l.tone}`}
                x={l.x}
                y={l.y}
                text-anchor={l.anchor}
              >
                {l.text}
              </text>
            ))}
            {empty ? (
              <text class="air-label" x={lay.width / 2} y={lay.vertical ? 46 : 70} text-anchor="middle">
                Nothing in the air: add an intent to the intents repo.
              </text>
            ) : null}
            {lay.items.map((it, n) => {
              if (it.kind === "plane") {
                const p = it.plane;
                return (
                  <g
                    key={it.key}
                    class="air-pos"
                    style={{ transform: `translate(${it.x}px, ${it.y}px)`, ...tone(p.state.key) }}
                  >
                    {target(
                      it,
                      <>
                        <Glyph plane={p} heading={it.heading} index={n} />
                        <rect class="air-hit" x="-12" y="-12" width="24" height="24" />
                      </>,
                      `${p.title}, ${p.state.label}, ${placeWords[p.station]}`,
                    )}
                  </g>
                );
              }
              if (it.kind === "more")
                return (
                  <g key={it.key} class="air-pos" style={{ transform: `translate(${it.x}px, ${it.y}px)` }}>
                    {target(
                      it,
                      <>
                        <rect class="air-more" x="-11" y="-8" width="22" height="16" />
                        <text class="air-label air-more-text" y="4" text-anchor="middle">
                          +{it.hidden.length}
                        </text>
                        <rect class="air-hit" x="-12" y="-12" width="24" height="24" />
                      </>,
                      `${it.hidden.length} more ${placeWords[it.station]}`,
                    )}
                  </g>
                );
              const xs = it.slots.map((s) => s.dx);
              const ys = it.slots.map((s) => s.dy);
              const x0 = Math.min(...xs) - 10;
              const y0 = Math.min(...ys) - 10;
              return (
                <g
                  key={it.key}
                  class="air-pos"
                  style={{ transform: `translate(${it.x}px, ${it.y}px)`, ...tone("done") }}
                >
                  {target(
                    it,
                    <>
                      {it.slots.map((s) => (
                        <path
                          key={s.key}
                          d={PLANE}
                          transform={`translate(${s.dx} ${s.dy})${lay.vertical ? " rotate(90)" : ""}`}
                        />
                      ))}
                      <rect
                        class="air-hit"
                        x={x0}
                        y={y0}
                        width={Math.max(...xs) + 10 - x0}
                        height={Math.max(...ys) + 10 - y0}
                      />
                    </>,
                    `${data.landed.count} landed today`,
                  )}
                </g>
              );
            })}
          </svg>
          {open ? (
            <Card
              open={open}
              data={data}
              items={lay.items}
              upTop={upTop}
              cardRef={cardRef}
              keep={keep}
              leave={leave}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
