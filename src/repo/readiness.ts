// Repo readiness (REPO-20..27): the kind of a repo, the setup that kind needs, how each item is read
// from files, and the plain words for what is missing. Pure: the loop gathers the data (src/readiness.ts).

import type { ProposedPr } from "../github/proposed.ts";
import type { Live } from "../ship/live.ts";

export const KINDS = ["service", "site", "cli", "library", "spec-only", "infra"] as const;
export type Kind = (typeof KINDS)[number];

export const isKind = (v: unknown): v is Kind =>
  typeof v === "string" && (KINDS as readonly string[]).includes(v);

/** REPO-22's items; `kind` is the extra one for a repo whose kind nobody confirmed. */
export const ITEMS = [
  "kind",
  "ci",
  "settings",
  "release",
  "verifying",
  "image",
  "apps",
  "deploy",
  "live",
  "publish",
  "go_live",
] as const;
export type Item = (typeof ITEMS)[number];

export const isItem = (v: string): v is Item => (ITEMS as readonly string[]).includes(v);

export type ItemState = "present" | "missing" | "unknown" | "waived";

export interface ItemResult {
  item: Item;
  state: ItemState;
  /** The fix in plain words; for a waived item the owner's reason. */
  words: string;
}

export interface Waiver {
  item: Item;
  reason: string;
}

export type Mode = "warn" | "block";

export interface Readiness {
  /** The confirmed kind, else the suggested one, else null. */
  kind: Kind | null;
  confirmed: boolean;
  /** The suggestion, while the kind is unconfirmed. */
  suggested: Kind | null;
  /** No item is `missing`. */
  ready: boolean;
  /** Not ready, kind confirmed and `readiness: block`: new intents wait (LOOP-70). */
  blocks: boolean;
  items: ItemResult[];
}

/** One item's raw check: `words` is the fix for `missing` and the reason for `unknown`. */
export interface Check {
  state: "present" | "missing" | "unknown";
  words?: string;
}

/** REPO-22: the items a kind needs, in order. */
export function requiredSetup(kind: Kind | null): Item[] {
  const out: Item[] = ["ci", "settings", "release", "verifying"];
  if (kind === "service") out.push("image", "apps", "deploy", "live");
  else if (kind === "site") out.push("live");
  else if (kind === "cli" || kind === "library") out.push("publish");
  else if (kind === "infra") out.push("go_live");
  return out;
}

const WORDS: Record<Item, string> = {
  kind: "Say what kind of repo this is: add kind to TOWERCAB.md",
  ci: "No CI with required checks: add a workflow and require its checks on the base branch",
  settings: "The standard GitHub settings differ: run bin/apply-settings",
  release: "Release-please is not set up: add its config, manifest and workflow",
  verifying: "No verifying section: add a checks block under ## Verifying your work in CLAUDE.md",
  image: "No signed image: add a workflow that builds and signs one",
  apps: "No entry in the infra repo's apps list: add this repo there",
  deploy: "No deploy jobs: add a workflow job named deploy",
  live: "No live block with a smoke suite: add live to TOWERCAB.md with a suite that has smoke: true",
  publish: "Release publishing is not set up: add a publish job",
  go_live: "No stated way its changes go live: add a go_live line to TOWERCAB.md",
};

export const wordsFor = (item: Item): string => WORDS[item];

/**
 * REPO-24. `kind` is the effective kind (confirmed, else suggested); `checks` has an entry per required
 * item (none → unknown, "Not checked yet"). A waived item counts as present.
 */
export function repoReadiness(
  kind: Kind | null,
  confirmed: boolean,
  checks: Map<Item, Check>,
  waive: Waiver[],
  mode: Mode = "warn",
): Readiness {
  const waived = new Map(waive.map((w) => [w.item, w.reason]));
  const items: ItemResult[] = [];
  if (!confirmed) {
    items.push({
      item: "kind",
      state: "missing",
      words: kind ? `${WORDS.kind} (suggested: kind: ${kind})` : WORDS.kind,
    });
  }
  for (const item of requiredSetup(kind)) {
    const reason = waived.get(item);
    if (reason !== undefined) {
      items.push({ item, state: "waived", words: reason });
      continue;
    }
    const c = checks.get(item);
    if (!c) items.push({ item, state: "unknown", words: "Not checked yet" });
    else if (c.state === "present") items.push({ item, state: "present", words: "" });
    else items.push({ item, state: c.state, words: c.words || WORDS[item] });
  }
  const ready = !items.some((i) => i.state === "missing");
  return {
    kind,
    confirmed,
    suggested: confirmed ? null : kind,
    ready,
    blocks: !ready && confirmed && mode === "block",
    items,
  };
}

export const missing = (r: Readiness): ItemResult[] => r.items.filter((i) => i.state === "missing");

/** `2 missing (ci, release)` for the pick's wait and `repo list`. */
export function missingText(r: Readiness): string {
  const m = missing(r);
  return `${m.length} missing (${m.map((i) => i.item).join(", ")})`;
}

export interface Manifests {
  packageJson?: { bin?: unknown; main?: unknown; exports?: unknown } | null;
  cargoToml?: string | null;
}

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** REPO-21: the first rule that matches wins; null → no suggestion. */
export function suggestKind(paths: string[], manifests: Manifests = {}): Kind | null {
  const pkg = manifests.packageJson ?? null;
  const cargo = manifests.cargoToml ?? "";
  if (paths.some((p) => /\.tf$/.test(p) || p.startsWith("ansible/") || /(^|\/)apps\.ya?ml$/.test(p)))
    return "infra";
  if (
    paths.some(
      (p) =>
        base(p) === "Dockerfile" ||
        /^(docker-)?compose\.ya?ml$/.test(base(p)) ||
        base(p) === "docker-compose.yml" ||
        base(p) === "docker-compose.yaml",
    )
  ) {
    return "service";
  }
  const generator = paths.some(
    (p) => /^(astro\.config\.|hugo\.)/.test(p) || p === "_config.yml" || p === "mkdocs.yml",
  );
  const serverCode = !!pkg?.bin || !!pkg?.main || /\[\[bin\]\]/.test(cargo) || paths.includes("src/main.rs");
  if (generator || (paths.includes("index.html") && !serverCode)) return "site";
  if (pkg?.bin || /\[\[bin\]\]/.test(cargo) || paths.includes("src/main.rs")) return "cli";
  if (pkg?.main || pkg?.exports || paths.includes("src/lib.rs")) return "library";
  if (paths.length > 0 && paths.every((p) => p.toLowerCase().endsWith(".md") || p.startsWith("specs/"))) {
    return "spec-only";
  }
  return null;
}

/** What the checks of REPO-23 read; the loop fills it. `null` = could not be read. */
export interface Evidence {
  /** The base branch's file paths. */
  paths: string[];
  /** The contents of `.github/workflows/*`, joined. */
  workflows: string;
  /** The base branch requires at least one status check. */
  requiredChecks: boolean | null;
  /** REPO-25's answer. */
  settings: Check;
  /** The infra repo's apps list has an entry for this repo. */
  appsEntry: boolean | null;
  verifying: boolean;
  live: Live | null;
  goLive: string | null;
}

const yes = (ok: boolean, words?: string): Check =>
  ok ? { state: "present" } : { state: "missing", ...(words ? { words } : {}) };

/** REPO-23: each required item of `kind`, read from the evidence. */
export function checkItems(kind: Kind | null, e: Evidence): Map<Item, Check> {
  const out = new Map<Item, Check>();
  const hasWorkflow = e.paths.some((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
  for (const item of requiredSetup(kind)) {
    let c: Check;
    switch (item) {
      case "ci":
        if (!hasWorkflow) c = { state: "missing", words: "No CI: add a workflow in .github/workflows" };
        else if (e.requiredChecks === null)
          c = { state: "unknown", words: "The required checks could not be read" };
        else c = yes(e.requiredChecks);
        break;
      case "settings":
        c = e.settings;
        break;
      case "release":
        c = yes(
          e.paths.includes("release-please-config.json") &&
            e.paths.includes(".release-please-manifest.json") &&
            /release-please/.test(e.workflows),
        );
        break;
      case "verifying":
        c = yes(e.verifying);
        break;
      case "image": {
        const shared = /uses:\s*[\w.-]+\/ci\/\.github\/workflows\/[\w.-]*image[\w.-]*\.ya?ml/.test(
          e.workflows,
        );
        const own =
          /cosign\s+sign/.test(e.workflows) && /docker\s+build|build-push-action|buildx/.test(e.workflows);
        c = yes(shared || own);
        break;
      }
      case "apps":
        c =
          e.appsEntry === null
            ? { state: "unknown", words: "The infra repo's apps list could not be read" }
            : yes(e.appsEntry);
        break;
      case "deploy":
        c = yes(/^ {2}deploy[\w-]*:/m.test(e.workflows));
        break;
      case "live":
        c = yes(!!e.live && e.live.suites.some((s) => s.smoke));
        break;
      case "publish":
        c = yes(
          /^ {2}publish[\w-]*:/m.test(e.workflows) ||
            /npm publish|cargo publish|pypa\/gh-action-pypi-publish/.test(e.workflows),
        );
        break;
      case "go_live":
        c = yes(!!e.goLive?.trim() || !!e.live);
        break;
      default:
        continue;
    }
    out.set(item, c);
  }
  return out;
}

const SHIP = ["deploy", "e2e", "rollback", "revert"];

/** REPO-26: null when the stage applies, else why it is skipped. */
export function stageSkip(
  kind: Kind | null,
  hasLive: boolean,
  goLive: string | null,
  stage: string,
): string | null {
  if (!SHIP.includes(stage) || hasLive || kind === "service" || kind === "site") return null;
  switch (kind) {
    case "library":
      return "a library has nothing to deploy";
    case "cli":
      return "a CLI has nothing to deploy";
    case "spec-only":
      return "a spec-only repo has nothing to deploy";
    case "infra":
      return `this repo's changes go live outside Towercab: ${goLive?.trim() || "see TOWERCAB.md"}`;
    default:
      return "kind not set";
  }
}

/** What the loop keeps in `meta` `readiness:<repo>`. */
export interface Stored {
  base: string;
  at: number;
  readiness: Readiness;
  /** The `go_live` line and whether a live block exists, for the stage map. */
  goLive: string | null;
  hasLive: boolean;
}

export function parseStored(raw: string | null): Stored | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Stored;
    return v && Array.isArray(v.readiness?.items) ? v : null;
  } catch {
    return null;
  }
}

/** The open proposed PR that adds a setup intent for `repo` (LOOP-71, LOOP-92), whoever opened it. */
export function openSetupPr(proposed: ProposedPr[], repo: string): ProposedPr | null {
  return proposed.find((p) => p.intent?.repo === repo && p.intent.setup === true) ?? null;
}
