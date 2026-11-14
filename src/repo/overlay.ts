// The per-repo overlay (REPO-43 to REPO-49): settings and checks Towercab keeps in its own config
// directory, so a team's shared repo needs no Towercab file. The repo's own files win; the overlay can
// only be as strict as the repo (or, for a key the repo leaves out, Towercab's default) or stricter.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Tools } from "../tools.ts";
import {
  DEFAULT_TESTS,
  parseBase,
  parseTowercab,
  parseVerifying,
  RepoError,
  type RepoFiles,
  readBaseFiles,
  repoGit,
  type Source,
  type TowercabFile,
  towercabKeys,
  VERIFYING_SECTION,
  type Verifying,
} from "./files.ts";
import { type Kind, type Manifests, requiredSetup, suggestKind } from "./readiness.ts";
import { DEFAULTS } from "./settings.ts";

/** An overlay folder's two files, as text (null = absent). */
export interface Overlay {
  dir: string;
  towercab: string | null;
  verifying: string | null;
}

/** The overlay folder of repo `name`, or null for a name that could leave the config directory. */
export function overlayDir(configFile: string, name: string): string | null {
  if (!name || /[/\\]/.test(name) || name.includes("..") || name.startsWith(".") || name.includes("\0")) {
    return null;
  }
  return join(dirname(resolve(configFile)), "repos", name);
}

function readOverlayFile(dir: string, file: string): string | null {
  const path = join(dir, file);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" || (e as NodeJS.ErrnoException).code === "ENOTDIR") {
      return null;
    }
    throw RepoError.invalid(`overlay ${file}: ${(e as Error).message}`);
  }
  if (st.isSymbolicLink()) throw RepoError.invalid(`overlay ${file}: a symlink, not a file`);
  if (!st.isFile()) throw RepoError.invalid(`overlay ${file}: a directory, not a file`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    throw RepoError.invalid(`overlay ${file}: not UTF-8`);
  }
}

/** REPO-43: the overlay of repo `name`; null when it has none. Regular UTF-8 files only. */
export function loadOverlay(configFile: string, name: string): Overlay | null {
  const dir = overlayDir(configFile, name);
  if (dir === null) return null;
  const towercab = readOverlayFile(dir, "TOWERCAB.md");
  const verifying = readOverlayFile(dir, "verifying.md");
  if (towercab === null && verifying === null) return null;
  return { dir, towercab, verifying };
}

const NOTHING = /^(true|:|exit\s+0|echo\b.*|printf\b.*|sleep\b.*)$/;

/** REPO-35's rule for overlay checks: at least one command that does more than print or wait. */
function readsRepo(checks: string[]): boolean {
  return checks.some((l) => !NOTHING.test(l.trim()));
}

function overlayVerifying(text: string): Verifying {
  const heading = new RegExp(`^##\\s+${VERIFYING_SECTION}\\s*$`, "im");
  const body = heading.test(text) ? text : `## ${VERIFYING_SECTION}\n\n${text}`;
  try {
    return parseVerifying(body, "verifying.md");
  } catch (e) {
    if (e instanceof RepoError && e.kind === "noVerifying") {
      throw RepoError.invalid("overlay verifying.md: no checks block");
    }
    if (e instanceof RepoError) throw RepoError.invalid(`overlay ${e.message}`);
    throw e;
  }
}

function overlayTowercab(text: string): TowercabFile {
  try {
    return parseTowercab(text);
  } catch (e) {
    throw RepoError.invalid(`overlay TOWERCAB.md: ${(e as Error).message}`);
  }
}

const SETTINGS = [
  "max_autonomy",
  "protected",
  "tests",
  "live",
  "releases",
  "kind",
  "readiness",
  "waive",
  "go_live",
  "workers",
  "ahead",
] as const;
type Setting = (typeof SETTINGS)[number];

function settingOf(t: TowercabFile, k: Setting): unknown {
  switch (k) {
    case "max_autonomy":
      return t.maxAutonomy;
    case "protected":
      return t.protected;
    case "tests":
      return t.tests;
    case "live":
      return t.live;
    case "releases":
      return t.releases ?? "auto";
    case "kind":
      return t.kind ?? null;
    case "readiness":
      return t.readiness ?? "warn";
    case "waive":
      return t.waive ?? [];
    case "go_live":
      return t.goLive ?? null;
    case "workers":
      return t.workers ?? DEFAULTS.workers;
    case "ahead":
      return t.ahead ?? DEFAULTS.ahead;
  }
}

const DEFAULT_VALUE = (k: Setting): unknown =>
  settingOf({ maxAutonomy: 5, protected: [], tests: [...DEFAULT_TESTS], live: null }, k);

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A setting's value in words, for `doctor` and the repo page. */
export function showValue(v: unknown): string {
  if (Array.isArray(v))
    return v.length ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ") : "none";
  if (v === null || v === undefined) return "none";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * REPO-44, REPO-46: the repo's files (`raw`, from the base branch) with the overlay laid under them.
 * Pure. `inferred` is the kind Towercab would infer (REPO-21). A refused key is dropped alone.
 */
export function mergeOverlay(
  raw: (string | RepoError | null)[],
  overlay: Overlay,
  inferred: Kind | null,
  slug = "",
): RepoFiles {
  const refusals: string[] = [];
  const oT = overlay.towercab === null ? null : overlayTowercab(overlay.towercab);
  const oKeys = towercabKeys(overlay.towercab);
  let oV = overlay.verifying === null ? null : overlayVerifying(overlay.verifying);
  if (oV && !readsRepo(oV.checks)) {
    refusals.push("overlay checks refused: no command reads the repo's own files");
    oV = null;
  }
  const { files, from } = parseBase(raw, oV, slug);
  const tw = files.towercab;
  const repoKeys = towercabKeys(typeof raw[2] === "string" ? raw[2] : null);
  const sources: Record<string, Source> = {};
  for (const k of SETTINGS) sources[k] = repoKeys.has(k) ? "repo" : "default";
  sources.checks = from === "overlay" ? "overlay" : "repo";
  const out: RepoFiles = { ...files, towercab: tw, sources, refusals };

  if (oT) {
    for (const k of SETTINGS) {
      if (!oKeys.has(k)) continue;
      const ov = settingOf(oT, k);
      const repoSets = repoKeys.has(k);
      const refuse = () =>
        refusals.push(`overlay ${k} refused: looser than ${repoSets ? "the repo's value" : "the default"}`);
      if (k === "max_autonomy") {
        const o = ov as number;
        if (o < tw.maxAutonomy) {
          tw.maxAutonomy = o;
          sources[k] = "overlay";
        } else if (o > tw.maxAutonomy && repoSets) refuse();
      } else if (k === "protected") {
        const add = (ov as string[]).filter((g) => !tw.protected.includes(g));
        if (add.length) {
          tw.protected = [...tw.protected, ...add];
          sources[k] = "overlay";
        }
      } else if (k === "kind") {
        mergeKind(out, oT.kind ?? null, repoSets, inferred, refusals);
      } else if (repoSets || !same(ov, DEFAULT_VALUE(k))) {
        if (same(ov, settingOf(tw, k))) continue;
        if (repoSets) refuse();
        else if (k === "releases" && ov === "manual") {
          tw.releases = "manual";
          sources[k] = "overlay";
        } else if (k === "readiness") {
          tw.readiness = oT.readiness;
          sources[k] = "overlay";
        } else if ((k === "workers" || k === "ahead") && (ov as number) < (DEFAULT_VALUE(k) as number)) {
          tw[k] = ov as number;
          sources[k] = "overlay";
        } else refuse();
      }
    }
  }
  if (from !== "overlay" && oV) {
    out.replaced = {
      file: from,
      overlayFile: join(overlay.dir, "verifying.md"),
      hash: checksHash(files.verifying.checks, oV.checks),
    };
  }
  return out;
}

/** REPO-46: why an overlay kind is refused (it drops setup the inferred kind needs), or null when it stands. */
export function kindRefusal(kind: Kind, inferred: Kind | null): string | null {
  if (inferred === null || kind === inferred) return null;
  const has = requiredSetup(kind);
  const lost = requiredSetup(inferred).filter((i) => !has.includes(i));
  return lost.length ? `overlay kind refused: ${kind} drops ${lost.join(", ")} that ${inferred} needs` : null;
}

/** REPO-46: an overlay kind stands only when it keeps the setup the inferred kind needs. */
function mergeKind(
  out: RepoFiles,
  kind: Kind | null,
  repoSets: boolean,
  inferred: Kind | null,
  refusals: string[],
): void {
  if (kind === null) return;
  if (repoSets) {
    if (out.towercab.kind !== kind) refusals.push("overlay kind refused: looser than the repo's value");
    return;
  }
  const why = kindRefusal(kind, inferred);
  if (why) {
    refusals.push(why);
    return;
  }
  out.overlayKind = kind;
  out.sources!.kind = "overlay";
}

/** One setting in effect and where it came from (REPO-44, UI-276); `checks` is the last row. */
export interface SettingRow {
  key: string;
  value: string;
  source: Source;
}

export function settingRows(files: RepoFiles): SettingRow[] {
  const s = files.sources;
  if (!s) return [];
  const rows: SettingRow[] = SETTINGS.map((k) => ({
    key: k,
    value: showValue(
      k === "kind" ? (files.overlayKind ?? files.towercab.kind) : settingOf(files.towercab, k),
    ),
    source: s[k] ?? "default",
  }));
  rows.push({ key: "checks", value: files.verifying.checks.join("; "), source: s.checks ?? "repo" });
  return rows;
}

/** `<name>: <key> = <value> (repo|overlay|default)` lines for the settings in effect (REPO-47). */
export function settingLines(name: string, files: RepoFiles): string[] {
  return settingRows(files).map((r) => `${name}: ${r.key} = ${r.value} (${r.source})`);
}

/** REPO-49: a short fingerprint of the repo's checks and the overlay's, so a notice goes once per pair. */
export function checksHash(repo: string[], overlay: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([repo, overlay]))
    .digest("hex")
    .slice(0, 16);
}

/**
 * REPO-49: when the base branch has checks of its own and the overlay has checks too, the pair that
 * replaced the overlay's; null otherwise. `raw` is `readBaseFiles`.
 */
export function replacedChecks(
  raw: (string | RepoError | null)[],
  overlay: Overlay | null,
): { file: string; overlayFile: string; hash: string } | null {
  if (overlay?.verifying == null) return null;
  let own: ReturnType<typeof parseBase>;
  try {
    own = parseBase(raw, null);
  } catch {
    return null;
  }
  let theirs: Verifying;
  try {
    theirs = overlayVerifying(overlay.verifying);
  } catch {
    return null;
  }
  if (!readsRepo(theirs.checks)) return null;
  return {
    file: own.from,
    overlayFile: join(overlay.dir, "verifying.md"),
    hash: checksHash(own.files.verifying.checks, theirs.checks),
  };
}

/**
 * REPO-44, REPO-46 for the readiness read: whether the overlay supplies checks, and the kind it names that
 * stands (it stays unconfirmed). An unreadable or invalid overlay supplies nothing; `doctor` reports it.
 */
export function overlayReadiness(
  configFile: string,
  name: string,
  suggested: Kind | null,
): { verifying: boolean; kind: Kind | null } {
  try {
    const o = loadOverlay(configFile, name);
    if (o === null) return { verifying: false, kind: null };
    const v = o.verifying === null ? null : overlayVerifying(o.verifying);
    const t = o.towercab === null ? null : overlayTowercab(o.towercab);
    const kind = t?.kind && !kindRefusal(t.kind, suggested) ? t.kind : null;
    return { verifying: v !== null && readsRepo(v.checks), kind };
  } catch {
    return { verifying: false, kind: null };
  }
}

/**
 * REPO-46: the `workers` and `ahead` an overlay may set (below the default, never above); the repo's own
 * file wins, so the caller uses these only for a key the file leaves out. Invalid overlay → none.
 */
export function overlayLimits(configFile: string, name: string): { workers?: number; ahead?: number } {
  try {
    const t = loadOverlay(configFile, name)?.towercab;
    if (!t) return {};
    const parsed = overlayTowercab(t);
    const out: { workers?: number; ahead?: number } = {};
    for (const k of ["workers", "ahead"] as const) {
      const v = parsed[k];
      if (v !== undefined && v < DEFAULTS[k]) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function inferKind(tools: Tools, clone: string, base: string, ref: string): Promise<Kind | null> {
  const paths = (await repoGit(tools, clone, ["ls-tree", "-r", "--name-only", ref]))
    .split("\n")
    .filter(Boolean);
  const manifests: Manifests = {};
  const show = async (p: string) =>
    paths.includes(p) ? await repoGit(tools, clone, ["show", `${ref}:${p}`]) : null;
  const pkg = await show("package.json");
  if (pkg) {
    try {
      manifests.packageJson = JSON.parse(pkg) as Manifests["packageJson"];
    } catch {
      // A broken package.json gives no hint.
    }
  }
  const cargo = await show("Cargo.toml");
  if (cargo !== null) manifests.cargoToml = cargo;
  return suggestKind(paths, manifests);
}

/**
 * REPO-1 with the overlay (REPO-44): the base branch's files, with `overlay` laid under them. No
 * overlay → the files unchanged.
 */
export async function loadRepoFilesWith(
  tools: Tools,
  clone: string,
  base: string,
  slug: string,
  overlay: Overlay | null,
  ref = `refs/remotes/origin/${base}`,
): Promise<RepoFiles> {
  const raw = await readBaseFiles(tools, clone, base, ref);
  if (overlay === null) return parseBase(raw, null, slug).files;
  const needsKind =
    towercabKeys(overlay.towercab).has("kind") &&
    !towercabKeys(typeof raw[2] === "string" ? raw[2] : null).has("kind");
  const inferred = needsKind ? await inferKind(tools, clone, base, ref) : null;
  return mergeOverlay(raw, overlay, inferred, slug);
}

/**
 * REPO-47: `doctor`'s lines for one repo with an overlay: each setting's source, what was refused, and
 * the replaced-checks line; and whether the overlay is valid. A repo without an overlay has none.
 */
export async function overlayDoctor(
  tools: Tools,
  o: { configFile: string; name: string; clone: string; base: string; slug: string; cloned: boolean },
): Promise<{ lines: string[]; ok: boolean }> {
  let overlay: Overlay | null;
  try {
    overlay = loadOverlay(o.configFile, o.name);
  } catch (e) {
    return { lines: [`${o.name}: ${(e as Error).message}`], ok: false };
  }
  if (overlay === null) return { lines: [], ok: true };
  if (!o.cloned) {
    return {
      lines: [`${o.name}: overlay in ${overlay.dir}; clone the repo to see where each setting comes from`],
      ok: true,
    };
  }
  try {
    const files = await loadRepoFilesWith(tools, o.clone, o.base, o.slug, overlay);
    const lines = [...settingLines(o.name, files), ...(files.refusals ?? []).map((r) => `${o.name}: ${r}`)];
    if (files.replaced) {
      lines.push(
        `${o.name}: the repo's own checks (${files.replaced.file}) replace the overlay's in ${files.replaced.overlayFile}`,
      );
    }
    return { lines, ok: true };
  } catch (e) {
    const message = (e as Error).message;
    // An invalid overlay file fails the check; the repo's own files are reported elsewhere.
    return {
      lines: [`${o.name}: ${message}`],
      ok: !(e instanceof RepoError && message.startsWith("overlay ")),
    };
  }
}
