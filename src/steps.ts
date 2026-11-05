// The owner's steps (SHIP-17..19, SHIP-22): the plan lists what only the owner can do, `plan.md` keeps
// the ticks, and `missions.data.steps` is a copy read from it. Pure text and data; the loop, the
// handlers and the commands do the reading and writing.

/** One of the owner's steps from the plan; `done_at` is an RFC 3339 time once ticked. */
export interface OwnerStep {
  n: number;
  when: "before" | "after";
  text: string;
  why: string;
  done_at: string | null;
}

/** A step as the plan agent returns it (SHIP-17). */
export interface PlanStep {
  when: "before" | "after";
  text: string;
  why: string;
}

/** What `machine.next` needs to know about a mission's data (LOOP-73). */
export interface ShipFacts {
  /** An `after` step is unticked and no fix round is running (SHIP-19). */
  steps: boolean;
  /** The plan says nothing about the change can be checked live (SHIP-21). */
  nothingLive: boolean;
  /** PIP-113: the plan says the owner does the work; there is no build and no code PR. */
  delivery?: boolean;
  /** The mission has steps to tick (PIP-113). */
  hasSteps?: boolean;
}

export const unticked = (steps: OwnerStep[] | undefined, when: "before" | "after"): OwnerStep[] =>
  (steps ?? []).filter((s) => s.when === when && !s.done_at);

/** The facts of a mission's data for the state machine. */
export function shipFacts(d: {
  steps?: OwnerStep[];
  liveNoneWhy?: string;
  ship?: { fixes?: number };
  delivery?: string;
}): ShipFacts {
  return {
    delivery: d.delivery === "steps",
    hasSteps: (d.steps ?? []).length > 0,
    steps: unticked(d.steps, "after").length > 0 && !(d.ship?.fixes ?? 0),
    nothingLive: !!d.liveNoneWhy?.trim(),
  };
}

const oneLine = (s: string) => s.split(/\s+/).filter(Boolean).join(" ");

/** The steps numbered by their order in the list. */
export function numbered(steps: PlanStep[]): OwnerStep[] {
  return steps.map((s, i) => ({
    n: i + 1,
    when: s.when === "before" ? "before" : "after",
    text: oneLine(s.text),
    why: oneLine(s.why),
    done_at: null,
  }));
}

/** `- [ ] before merge: <text> (<why>)`, ticked: `- [x] … · ticked <time>` (SHIP-17). */
export function stepLine(s: OwnerStep): string {
  // Parentheses in the why would end it early when the line is read back.
  const why = s.why.replace(/\(/g, "[").replace(/\)/g, "]");
  const tick = s.done_at ? ` · ticked ${s.done_at}` : "";
  return `- [${s.done_at ? "x" : " "}] ${s.when} merge: ${s.text}${why ? ` (${why})` : ""}${tick}`;
}

/** The `## Your steps` section; no steps → no section (SHIP-17). */
export function renderSteps(steps: OwnerStep[]): string {
  return steps.length ? `## Your steps\n\n${steps.map(stepLine).join("\n")}\n` : "";
}

/** `Nothing to check live: <why>` (SHIP-21); empty → no line. */
export function renderNoneLive(why: string): string {
  const w = oneLine(why);
  return w ? `Nothing to check live: ${w}\n` : "";
}

const LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(before|after) merge:\s+(.*?)\s*$/;

/** The steps in a `plan.md`'s `## Your steps` section, ticks included. */
export function parseSteps(planMd: string): OwnerStep[] {
  const out: OwnerStep[] = [];
  let inside = false;
  for (const raw of planMd.split("\n")) {
    if (/^#{1,2}\s/.test(raw)) inside = raw.trim().toLowerCase() === "## your steps";
    if (!inside) continue;
    const m = LINE.exec(raw);
    if (!m) continue;
    let rest = m[3]!;
    let done_at: string | null = null;
    const tick = /\s+·\s+ticked\s+(\S+)$/.exec(rest);
    if (tick) {
      done_at = tick[1]!;
      rest = rest.slice(0, tick.index);
    } else if (m[1] !== " ") {
      done_at = "";
    }
    let text = rest;
    let why = "";
    const at = rest.lastIndexOf(" (");
    if (at >= 0 && rest.endsWith(")")) {
      text = rest.slice(0, at);
      why = rest.slice(at + 2, -1);
    }
    out.push({
      n: out.length + 1,
      when: m[2] as "before" | "after",
      text,
      why,
      // Ticked by hand without a time: counts as done, the time unknown.
      done_at: done_at === "" ? "unknown" : done_at,
    });
  }
  return out;
}

/** The reason in a plan's `Nothing to check live: <why>` line, or "". */
export function parseNoneLive(planMd: string): string {
  const m = /^Nothing to check live:\s*(.+)$/m.exec(planMd);
  return m ? oneLine(m[1]!) : "";
}

/** The steps of `next` with the ticks of `old` steps whose text and time of need are unchanged (SHIP-17). */
export function keepTicks(next: OwnerStep[], old: OwnerStep[]): OwnerStep[] {
  return next.map((s) => {
    const was = old.find((o) => o.when === s.when && o.text === s.text && o.done_at);
    return was ? { ...s, done_at: was.done_at } : s;
  });
}

/**
 * The steps a mission works with (SHIP-22): the plan file is the record, so its steps and ticks win;
 * while a tick of the database's isn't written to the file yet (`dirty`), the database's ticks win for
 * every step whose text is unchanged. `dirty` stays true until the file has the same ticks.
 */
export function combine(
  file: OwnerStep[],
  db: OwnerStep[] | undefined,
  dirty: boolean,
): { steps: OwnerStep[]; dirty: boolean } {
  if (!dirty || !db?.length) return { steps: file, dirty: false };
  const steps = keepTicks(
    file.map((s) => ({ ...s, done_at: null })),
    db,
  );
  const same = steps.every((s, i) => s.done_at === file[i]?.done_at);
  return { steps, dirty: !same };
}

/** The checklist as the why of a wait (LOOP-74): the open steps, one line each. */
export function checklist(steps: OwnerStep[], when: "before" | "after"): string {
  return unticked(steps, when)
    .map((s) => `${s.n}. ${s.text}${s.why ? ` (${s.why})` : ""}`)
    .join("; ");
}

/** `2 of 3` for the open steps a wait asks for (`your steps first`: before the merge; else after it). */
export function leftOf(steps: OwnerStep[] | undefined, waiting: string | null): string | null {
  const when = waiting === "your steps first" ? "before" : waiting === "your steps" ? "after" : null;
  if (!when) return null;
  const all = (steps ?? []).filter((s) => s.when === when);
  return all.length ? `${all.filter((s) => !s.done_at).length} of ${all.length}` : null;
}

/** The plan's `Delivery: code|steps` line (PIP-112); null when the plan has none. */
export function parseDelivery(planMd: string): "code" | "steps" | null {
  const m = /^Delivery:\s*(code|steps)\b/m.exec(planMd);
  return m ? (m[1] as "code" | "steps") : null;
}

/** The plan file with its `Delivery:` line set to `delivery` (added under the IDs line when missing). */
export function withDelivery(planMd: string, delivery: "code" | "steps"): string {
  if (/^Delivery:.*$/m.test(planMd)) return planMd.replace(/^Delivery:.*$/m, `Delivery: ${delivery}`);
  return planMd.replace(/^(Intent .*)$/m, `$1\nDelivery: ${delivery}`);
}

/** The plan file with its steps and claim replaced by `steps` and `noneLive` (SHIP-22's write). */
export function withSteps(planMd: string, steps: OwnerStep[], noneLive: string): string {
  const lines = planMd.split("\n");
  const keep: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (/^#{1,2}\s/.test(l)) skipping = l.trim().toLowerCase() === "## your steps";
    if (skipping) continue;
    if (/^Nothing to check live:/.test(l)) continue;
    keep.push(l);
  }
  const body = keep.join("\n").trimEnd();
  const tail = [renderSteps(steps).trimEnd(), renderNoneLive(noneLive).trimEnd()].filter(Boolean);
  return `${[body, ...tail].join("\n\n")}\n`;
}
