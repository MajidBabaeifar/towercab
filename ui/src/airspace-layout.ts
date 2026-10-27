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
}

export interface Label {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  tone: "plain" | "review" | "landed";
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
  "landed",
];

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
  landed: "landed",
};

const REVIEWS = new Set<StationKey>(["spec-review", "plan-review", "code-review"]);
const STEPS = ORDER.slice(2, 10);

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
  const step = (landedX - gateX) / 8;
  const xOf = (k: StationKey) => (k === "landed" ? landedX : gateX + STEPS.indexOf(k) * step);
  const items: Item[] = [];
  const stations: StationMark[] = [];
  const labels: Label[] = [];

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
  for (const k of STEPS) {
    const x = xOf(k);
    place(k, (n) => [x, 90 - 22 * n]);
    stations.push({ key: k, x, y: lineY, shape: REVIEWS.has(k) ? "diamond" : "square" });
    labels.push({ text: NAMES[k], x, y: 134, anchor: "middle", tone: REVIEWS.has(k) ? "review" : "plain" });
  }
  stations.push({ key: "landed", x: landedX, y: lineY, shape: "landed" });
  labels.push({ text: "landed", x: landedX, y: 134, anchor: "middle", tone: "landed" });
  labels.push({ text: `today · ${count("landed")}`, x: landedX, y: 150, anchor: "middle", tone: "plain" });
  labels.push({ text: `queue · ${count("queue")}`, x: gateX - 80, y: 98, anchor: "middle", tone: "plain" });
  labels.push({ text: `parked · ${count("parked")}`, x: 56, y: 160, anchor: "middle", tone: "plain" });
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
  const yOf = (k: StationKey) => y0 + ORDER.indexOf(k) * gap;
  const first = lineX + 26;
  const rowCap = Math.max(2, Math.floor((w - 24 - first) / 22) + 1);
  const items: Item[] = [];
  const stations: StationMark[] = [];
  const labels: Label[] = [];
  for (const k of ORDER) {
    const y = yOf(k);
    const name = k === "parked" || k === "queue" || k === "landed" ? `${NAMES[k]} · ${count(k)}` : NAMES[k];
    const tone = REVIEWS.has(k) ? "review" : k === "landed" ? "landed" : "plain";
    labels.push({ text: name, x: lineX - 16, y: y + 4, anchor: "end", tone });
    if (k !== "parked" && k !== "queue")
      stations.push({
        key: k,
        x: lineX,
        y,
        shape: k === "landed" ? "landed" : REVIEWS.has(k) ? "diamond" : "square",
      });
    if (k === "landed") continue;
    const { shown, hidden } = capped(at.get(k)!, rowCap);
    shown.forEach((plane, n) => {
      items.push({ kind: "plane", key: plane.intent, plane, x: first + 22 * n, y, heading: 90 });
    });
    if (hidden.length)
      items.push({ kind: "more", key: `more:${k}`, station: k, hidden, x: first + 22 * shown.length, y });
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
    header: { x: 16, y: 22, anchor: "start", rule: 32, tag: false },
  };
}
