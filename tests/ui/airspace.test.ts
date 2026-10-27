// UI-82: the airspace layout caps crowded stations and turns vertical on a phone.

import { expect, test } from "vitest";
import type { AirspaceView, Plane, StationKey } from "../../src/ui/view.ts";
import { layoutAirspace, VERTICAL_BELOW } from "../../ui/src/airspace-layout.ts";

function plane(intent: string, station: StationKey): Plane {
  return {
    intent,
    title: intent,
    repo: "web",
    state: { key: "working", label: "Working", note: null },
    station,
    lines: ["Building · 1 min", "$0.10 · Opus"],
    phases: [],
    canStart: false,
  };
}

function view(planes: Plane[], landed = 0): AirspaceView {
  return {
    planes,
    landed: {
      count: landed,
      cost: "$0.00",
      agentTime: "0 min",
      recent: Array.from({ length: Math.min(landed, 3) }, (_, i) => ({
        intent: `l${i}`,
        title: "x",
        repo: "web",
      })),
    },
    counts: { parked: 0, queued: 0, flying: planes.length, needs: 0, landed },
    countsText: "",
    summary: "",
  };
}

const many = (n: number, station: StationKey) =>
  Array.from({ length: n }, (_, i) => plane(`${station}${i}`, station));

test("ui: airspace caps crowded stations", () => {
  const a = view([...many(7, "code"), ...many(3, "spec"), ...many(6, "queue"), ...many(4, "parked")], 9);
  const lay = layoutAirspace(a, 900);
  expect(lay.vertical).toBe(false);
  const at = (k: StationKey) => lay.items.filter((i) => i.kind === "plane" && i.plane.station === k);
  const more = (k: StationKey) => lay.items.find((i) => i.kind === "more" && i.station === k);
  // A step station shows 3, or 2 and a marker; the queue 4, the siding 3.
  expect(at("spec")).toHaveLength(3);
  expect(more("spec")).toBeUndefined();
  expect(at("code")).toHaveLength(2);
  expect(more("code")).toMatchObject({ hidden: many(7, "code").slice(2) });
  expect(at("queue")).toHaveLength(3);
  expect(more("queue")).toMatchObject({ hidden: many(6, "queue").slice(3) });
  expect(at("parked")).toHaveLength(2);
  // The landed block shows 6; the count says the rest.
  const landed = lay.items.find((i) => i.kind === "landed");
  expect(landed?.kind === "landed" && landed.slots.length).toBe(6);
  expect(lay.labels.map((l) => l.text)).toContain("today · 9");
  // Drawn at real pixels: the steps stretch with the width, the height doesn't.
  expect(lay.width).toBe(900);
  expect(lay.height).toBe(190);
  const xs = lay.stations.map((s) => s.x);
  expect(xs).toEqual([...xs].sort((p, q) => p - q));
  expect(xs.at(-1)).toBe(900 - 56);
});

test("ui: airspace runs top to bottom on a phone", () => {
  const lay = layoutAirspace(view(many(12, "code")), 360);
  expect(VERTICAL_BELOW).toBeGreaterThan(360);
  expect(lay.vertical).toBe(true);
  const planes = lay.items.filter((i) => i.kind === "plane");
  expect(planes.every((i) => i.kind === "plane" && i.heading === 90)).toBe(true);
  // Every plane fits inside the width; the rest go behind a marker.
  expect(planes.every((i) => i.x + 8 <= 360)).toBe(true);
  expect(lay.items.some((i) => i.kind === "more")).toBe(true);
  const ys = lay.stations.map((s) => s.y);
  expect(ys).toEqual([...ys].sort((p, q) => p - q));
});
