// A mission in memory for the tests of LOOP-76 and LOOP-77: moves go through `machine.apply`.

import { type ApplyCtx, apply, type Outcome } from "../../src/machine.ts";
import { getMission, insertMission, type Mission } from "../../src/mission.ts";
import { testDb } from "./world.ts";

export function exitsWorld() {
  const db = testDb();
  const cx: ApplyCtx = {
    db,
    now: 100,
    subject: () => ({ title: "Ship it", repo: "web", link: "https://github.com/me/web/pull/7" }),
  };
  let mission: Mission = insertMission(
    db,
    { intent: "261001-0900", slug: "x", repo: "web", model: "opus", a: 3 },
    0,
  );
  const set = (cols: Record<string, string | number | null>) => {
    const keys = Object.keys(cols);
    db.run(
      `UPDATE missions SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
      ...keys.map((k) => cols[k]!),
      mission.id,
    );
    mission = getMission(db, mission.id)!;
  };
  return {
    db,
    cx,
    set,
    move: (o: Outcome) => {
      mission = apply(cx, mission, o);
      return mission;
    },
    get m() {
      return mission;
    },
  };
}
