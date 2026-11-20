// Where everything sits on the airspace line (UI-78, UI-82): pure geometry, drawn at real pixels
// (1 SVG unit = 1 px) so labels stay 11 px at any width. Below VERTICAL_BELOW the line runs top to bottom.

import type { AirspaceView, Plane, StationKey } from "../../src/ui/view.ts";

export const VERTICAL_BELOW = 560;
const HEIGHT = 190;

export interface StationMark {
  key: StationKey;
  x: number;
  y: number;
  shape: "square" | "diamond" | "landed";
  /** UI-110: a station that feeds new work, dimmed during a ground stop. */
  dim?: boolean;
}

export interface Label {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  tone: "plain" | "review" | "landed";
  dim?: boolean;
}

/** UI-110: the small `held` mark under a station that feeds new work. */
export interface HeldMark {
  key: StationKey;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
}

export type Item =
  | { kind: "plane"; key: string; plane: Plane; x: number; y: number; heading: number }
  | { kind: "more"; key: string; station: StationKey; hidden: Plane[]; x: number; y: number }
  | { kind: "landed"; key: "landed"; x: number; y: number; slots: { key: string; dx: number; dy: number }[] };

export interface Layout {
  vertical: boolean;
  width: number;
  height: number;
  /** The solid line, the parked siding (dashed) and the flowing packets, as SVG paths. */
  track: string;
  siding: string;
  flow: string;
  stations: StationMark[];
  labels: Label[];
  items: Item[];
  /** UI-109, UI-110: the amber band behind the track and the held marks; empty without a ground stop. */
  band: { x: number; y: number; width: number; height: number } | null;
  held: HeldMark[];
  /** The stations whose planes are dimmed (UI-110). */
  dimmed: StationKey[];
  /** Where the counts line sits; the header rule's y. */
  header: { x: number; y: number; anchor: "start" | "end"; rule: number; tag: boolean };
}

const ORDER: StationKey[] = [
  "parked",
  "queue",
  "gate",
  "spec",
  "spec-review",
  "plan",
  "plan-review",
  "code",
  "ci",
  "code-review",
  "deploy",
  "e2e",
  "landed",
];

/** UI-120: the ship stations, drawn only while a plane sits at one. */
const SHIP = new Set<StationKey>(["deploy", "e2e"]);
const orderOf = (a: AirspaceView): StationKey[] => (a.ship ? ORDER : ORDER.filter((k) => !SHIP.has(k)));

const NAMES: Record<StationKey, string> = {
  parked: "parked",
  queue: "queue",
  gate: "00 gate",
  spec: "01 spec",
  "spec-review": "you",
  plan: "02 plan",
  "plan-review": "you",
  code: "03 code",
  ci: "ci",
  "code-review": "you",
  deploy: "04 deploy",
  e2e: "05 e2e",
  landed: "landed",
};

/** UI-110: the stations that feed new work; a plane past the gate keeps moving. */
export const FEEDERS: StationKey[] = ["parked", "queue", "gate"];

const REVIEWS = new Set<StationKey>(["spec-review", "plan-review", "code-review"]);

/** How many planes a station shows before the rest go behind a `+n` marker. */
export function capOf(station: StationKey, vertical: boolean, rowCap: number): number {
  if (station === "landed") return vertical ? rowCap : 6;
  if (vertical) return rowCap;
  if (station === "queue") return 4;
  return 3;
}

/** Up to `cap` planes, or `cap - 1` and a marker for the rest. */
function capped(planes: Plane[], cap: number): { shown: Plane[]; hidden: Plane[] } {
  if (planes.length <= cap) return { shown: planes, hidden: [] };
  return { shown: planes.slice(0, cap - 1), hidden: planes.slice(cap - 1) };
}

const LANDED_SLOTS = [
  [-11, 18],
  [11, 18],
  [-11, 0],
  [11, 0],
  [-11, -18],
  [11, -18],
] as const;

export function layoutAirspace(a: AirspaceView, width: number): Layout {
  const w = Math.max(320, Math.round(width));
  const vertical = w < VERTICAL_BELOW;
  const at = new Map<StationKey, Plane[]>(ORDER.map((k) => [k, []]));
  for (const p of a.planes) at.get(p.station)?.push(p);
  const count = (k: StationKey) => (k === "landed" ? a.landed.count : at.get(k)!.length);
  return vertical ? vertical_(a, w, at, count) : horizontal(a, w, at, count);
}

function horizontal(
  a: AirspaceView,
  w: number,
  at: Map<StationKey, Plane[]>,
  count: (k: StationKey) => number,
): Layout {
  const lineY = 112;
  const gateX = 150;
  const landedX = w - 56;
  const steps = orderOf(a).slice(2, -1);
  const step = (landedX - gateX) / steps.length;
  const xOf = (k: StationKey) => (k === "landed" ? landedX : gateX + steps.indexOf(k) * step);
  const items: Item[] = [];
  const stations: StationMark[] = [];
  const labels: Label[] = [];
  const stopped = a.stop !== null;

  const place = (k: StationKey, slot: (n: number) => [number, number]) => {
    const { shown, hidden } = capped(at.get(k)!, capOf(k, false, 0));
    shown.forEach((plane, n) => {
      const [x, y] = slot(n);
      items.push({ kind: "plane", key: plane.intent, plane, x, y, heading: 0 });
    });
    if (hidden.length) {
      const [x, y] = slot(shown.length);
      items.push({ kind: "more", key: `more:${k}`, station: k, hidden, x, y });
    }
  };

  place("parked", (n) => [30 + 22 * n, 136]);
  place("queue", (n) => [gateX - 54 - 22 * n, lineY]);
  for (const k of steps) {
    const x = xOf(k);
    place(k, (n) => [x, 90 - 22 * n]);
    stations.push({
      key: k,
      x,
      y: lineY,
      shape: REVIEWS.has(k) ? "diamond" : "square",
      dim: stopped && k === "gate",
    });
    labels.push({
      text: NAMES[k],
      x,
      y: 134,
      anchor: "middle",
      tone: REVIEWS.has(k) ? "review" : "plain",
      dim: stopped && k === "gate",
    });
  }
  stations.push({ key: "landed", x: landedX, y: lineY, shape: "landed" });
  labels.push({ text: "landed", x: landedX, y: 134, anchor: "middle", tone: "landed" });
  labels.push({ text: `today · ${count("landed")}`, x: landedX, y: 150, anchor: "middle", tone: "plain" });
  labels.push({
    text: `queue · ${count("queue")}`,
    x: gateX - 80,
    y: 98,
    anchor: "middle",
    tone: "plain",
    dim: stopped,
  });
  labels.push({
    text: `parked · ${count("parked")}`,
    x: 56,
    y: 160,
    anchor: "middle",
    tone: "plain",
    dim: stopped,
  });
  if (a.landed.count) {
    const n = Math.min(a.landed.count, capOf("landed", false, 0));
    const slots = LANDED_SLOTS.slice(0, n).map(([dx, dy], i) => ({
      key: a.landed.recent[i]?.intent ?? `landed-${i}`,
      dx,
      dy,
    }));
    items.push({ kind: "landed", key: "landed", x: landedX, y: 72, slots });
  }
  return {
    vertical: false,
    width: w,
    height: HEIGHT,
    track: `M34 ${lineY} H${landedX}`,
    siding: `M${gateX - 20} ${lineY} L${gateX - 44} ${lineY + 24} H18`,
    flow: `M${gateX} ${lineY} H${landedX}`,
    stations,
    labels,
    items,
    band: stopped ? { x: 14, y: lineY - 9, width: w - 28, height: 18 } : null,
    held: stopped
      ? [
          { key: "parked", x: 56, y: 174, anchor: "middle" },
          { key: "queue", x: gateX - 80, y: 84, anchor: "middle" },
          { key: "gate", x: gateX, y: 150, anchor: "middle" },
        ]
      : [],
    dimmed: stopped ? FEEDERS : [],
    header: { x: w - 14, y: 20, anchor: "end", rule: 30, tag: true },
  };
}

function vertical_(
  a: AirspaceView,
  w: number,
  at: Map<StationKey, Plane[]>,
  count: (k: StationKey) => number,
): Layout {
  const lineX = 112;
  const y0 = 56;
  const gap = 34;
  const order = orderOf(a);
  const yOf = (k: StationKey) => y0 + order.indexOf(k) * gap;
  const first = lineX + 26;
  // UI-275: room for the `+n` marker's whole box (22 px wide) beside the last plane, inside the edge.
  const rowCap = Math.max(2, Math.floor((w - 24 - first - 12) / 22) + 1);
  const items: Item[] = [];
  const stations: StationMark[] = [];
  const labels: Label[] = [];
  const stopped = a.stop !== null;
  const held: HeldMark[] = [];
  for (const k of order) {
    const y = yOf(k);
    const name = k === "parked" || k === "queue" || k === "landed" ? `${NAMES[k]} · ${count(k)}` : NAMES[k];
    const tone = REVIEWS.has(k) ? "review" : k === "landed" ? "landed" : "plain";
    const dim = stopped && FEEDERS.includes(k);
    labels.push({ text: name, x: lineX - 16, y: y + 4, anchor: "end", tone, dim });
    if (dim) held.push({ key: k, x: lineX - 16, y: y + 16, anchor: "end" });
    if (k !== "parked" && k !== "queue")
      stations.push({
        key: k,
        x: lineX,
        y,
        shape: k === "landed" ? "landed" : REVIEWS.has(k) ? "diamond" : "square",
        dim,
      });
    if (k === "landed") continue;
    const { shown, hidden } = capped(at.get(k)!, rowCap);
    shown.forEach((plane, n) => {
      items.push({ kind: "plane", key: plane.intent, plane, x: first + 22 * n, y, heading: 90 });
    });
    if (hidden.length)
      items.push({
        kind: "more",
        key: `more:${k}`,
        station: k,
        hidden,
        x: first + 22 * shown.length + 4,
        y,
      });
  }
  if (a.landed.count) {
    const n = Math.min(a.landed.count, rowCap);
    const slots = Array.from({ length: n }, (_, i) => ({
      key: a.landed.recent[i]?.intent ?? `landed-${i}`,
      dx: 26 + 22 * i,
      dy: 0,
    }));
    items.push({ kind: "landed", key: "landed", x: lineX, y: yOf("landed"), slots });
  }
  return {
    vertical: true,
    width: w,
    height: yOf("landed") + 30,
    track: `M${lineX} ${yOf("queue")} V${yOf("landed")}`,
    siding: `M${lineX} ${yOf("parked")} V${yOf("queue")}`,
    flow: `M${lineX} ${yOf("gate")} V${yOf("landed")}`,
    stations,
    labels,
    items,
    band: stopped ? { x: lineX - 9, y: yOf("queue"), width: 18, height: yOf("landed") - yOf("queue") } : null,
    held,
    dimmed: stopped ? FEEDERS : [],
    header: { x: 16, y: 22, anchor: "start", rule: 32, tag: false },
  };
}
