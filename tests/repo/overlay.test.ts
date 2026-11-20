// The per-repo overlay (REPO-43 to REPO-46): read from the config directory, merged under the repo's files.

import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type RawFiles, RepoError } from "../../src/repo/files.ts";
import {
  loadOverlay,
  loadRepoFilesWith,
  mergeOverlay,
  type Overlay,
  overlayDir,
} from "../../src/repo/overlay.ts";
import { FakeTools } from "../helpers/tools.ts";
import { bareRepo, git, tempDir } from "../helpers/world.ts";

const CLAUDE = "# Repo\n\n## Verifying your work\n\n```checks\nmake test\n```\n";
const OVERLAY_CHECKS = "```checks\nnpm test\n```\n";

const raw = (
  o: { claude?: string | null; towercab?: string | null; agents?: string | null } = {},
): RawFiles => [o.claude === undefined ? CLAUDE : o.claude, null, o.towercab ?? null, o.agents ?? null];
const overlay = (o: { towercab?: string; verifying?: string }): Overlay => ({
  dir: "/cfg/repos/web",
  towercab: o.towercab ?? null,
  verifying: o.verifying ?? null,
});
const fm = (body: string) => `---\n${body}\n---\n`;

test("repo: overlay files are read from the config directory", () => {
  const cfg = tempDir("tc-cfg-");
  const file = join(cfg, "config.toml");
  expect(loadOverlay(file, "web")).toBeNull();
  const dir = join(cfg, "repos", "web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TOWERCAB.md"), fm("max_autonomy: 2"));
  writeFileSync(join(dir, "verifying.md"), OVERLAY_CHECKS);
  expect(overlayDir(file, "web")).toBe(dir);
  expect(loadOverlay(file, "web")).toEqual({
    dir,
    towercab: fm("max_autonomy: 2"),
    verifying: OVERLAY_CHECKS,
  });
});

test("repo: an invalid overlay file is reported", () => {
  const cfg = tempDir("tc-cfg-");
  const file = join(cfg, "config.toml");
  const dir = join(cfg, "repos", "web");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "other"), "x");
  symlinkSync(join(dir, "other"), join(dir, "TOWERCAB.md"));
  expect(() => loadOverlay(file, "web")).toThrow(/^overlay TOWERCAB.md: a symlink, not a file$/);
  writeFileSync(join(dir, "verifying.md"), Buffer.from([0xff, 0xfe]));
  mkdirSync(join(cfg, "repos", "api"));
  writeFileSync(join(cfg, "repos", "api", "verifying.md"), Buffer.from([0xff, 0xfe]));
  expect(() => loadOverlay(file, "api")).toThrow(/^overlay verifying.md: not UTF-8$/);
  // A bad front matter or a verifying file without checks is invalid and says whose it is.
  const bad = (o: Overlay) => {
    try {
      mergeOverlay(raw(), o, null);
    } catch (e) {
      expect(e).toBeInstanceOf(RepoError);
      return (e as RepoError).message;
    }
    return "no error";
  };
  expect(bad(overlay({ towercab: fm("max_autonomy: 9") }))).toBe(
    "overlay TOWERCAB.md: front matter: max_autonomy must be an integer 1-5",
  );
  expect(bad(overlay({ verifying: "just prose\n" }))).toBe("overlay verifying.md: no checks block");
});

test("repo: an overlay path escape is refused", () => {
  const cfg = tempDir("tc-cfg-");
  const file = join(cfg, "config.toml");
  for (const name of ["../x", "a/b", "..", ".hidden", "", "a\\b"])
    expect(overlayDir(file, name), name).toBeNull();
  expect(loadOverlay(file, "../x")).toBeNull();
});

test("repo: a repo key wins over the overlay", () => {
  const f = mergeOverlay(
    raw({ towercab: fm("tests: [t/**]\nreleases: manual") }),
    overlay({ towercab: fm("tests: [x/**]\nreleases: auto") }),
    null,
  );
  expect(f.towercab.tests).toEqual(["t/**"]);
  expect(f.towercab.releases).toBe("manual");
  expect(f.sources).toMatchObject({ tests: "repo", releases: "repo" });
  expect(f.refusals).toEqual([
    "overlay tests refused: looser than the repo's value",
    "overlay releases refused: looser than the repo's value",
  ]);
});

test("repo: an absent key takes the overlay", () => {
  const f = mergeOverlay(
    raw(),
    overlay({
      towercab: fm("max_autonomy: 3\nprotected: [infra/**]\nreleases: manual\nworkers: 1\nreadiness: block"),
    }),
    null,
  );
  expect(f.towercab.maxAutonomy).toBe(3);
  expect(f.towercab.protected).toEqual(["infra/**"]);
  expect(f.towercab.releases).toBe("manual");
  expect(f.towercab.readiness).toBe("block");
  expect(f.sources).toMatchObject({
    max_autonomy: "overlay",
    protected: "overlay",
    releases: "overlay",
    readiness: "overlay",
    tests: "default",
    checks: "repo",
  });
  expect(f.refusals).toEqual([]);
});

test("repo: the overlay's checks apply only without repo checks", async () => {
  const o = overlay({ verifying: OVERLAY_CHECKS });
  const without = mergeOverlay(raw({ claude: "# no section\n" }), o, null);
  expect(without.verifying.checks).toEqual(["npm test"]);
  expect(without.sources?.checks).toBe("overlay");
  expect(without.replaced).toBeUndefined();
  const withRepo = mergeOverlay(raw(), o, null);
  expect(withRepo.verifying.checks).toEqual(["make test"]);
  expect(withRepo.sources?.checks).toBe("repo");
  // The heading is optional in the overlay file and allowed.
  const headed = mergeOverlay(raw({ claude: null }), overlay({ verifying: CLAUDE }), null);
  expect(headed.verifying.checks).toEqual(["make test"]);
});

test("repo: an overlay with checks skips the setup PR", async () => {
  // The pick sets checks up only on `noVerifying`: a repo with no CLAUDE.md at all loads with overlay checks.
  const bare = bareRepo({ "README.md": "hi\n" });
  const clone = join(tempDir("tc-clone-"), "clone");
  git(join(clone, ".."), "clone", "-q", bare, clone);
  const tools = new FakeTools();
  await expect(loadRepoFilesWith(tools, clone, "main", "", null)).rejects.toMatchObject({
    kind: "noVerifying",
  });
  const files = await loadRepoFilesWith(tools, clone, "main", "", overlay({ verifying: OVERLAY_CHECKS }));
  expect(files.verifying.checks).toEqual(["npm test"]);
});

test("repo: the overlay lowers max_autonomy", () => {
  const f = mergeOverlay(
    raw({ towercab: fm("max_autonomy: 4") }),
    overlay({ towercab: fm("max_autonomy: 2") }),
    null,
  );
  expect(f.towercab.maxAutonomy).toBe(2);
  expect(f.sources?.max_autonomy).toBe("overlay");
  expect(f.refusals).toEqual([]);
});

test("repo: the overlay cannot raise max_autonomy", () => {
  const f = mergeOverlay(
    raw({ towercab: fm("max_autonomy: 2") }),
    overlay({ towercab: fm("max_autonomy: 4") }),
    null,
  );
  expect(f.towercab.maxAutonomy).toBe(2);
  expect(f.sources?.max_autonomy).toBe("repo");
  expect(f.refusals).toEqual(["overlay max_autonomy refused: looser than the repo's value"]);
});

test("repo: overlay protected paths add to the repo's", () => {
  const f = mergeOverlay(
    raw({ towercab: fm("protected: [a/**, b/**]") }),
    overlay({ towercab: fm("protected: [b/**, c/**]") }),
    null,
  );
  expect(f.towercab.protected).toEqual(["a/**", "b/**", "c/**"]);
});

test("repo: a loosening overlay key is refused with one line", () => {
  const f = mergeOverlay(
    raw({ towercab: fm("workers: 2\nkind: service") }),
    overlay({ towercab: fm("workers: 4\nkind: site\nwaive:\n  - ci: not here") }),
    "service",
  );
  expect(f.towercab.workers).toBe(2);
  expect(f.towercab.kind).toBe("service");
  expect(f.towercab.waive).toBeUndefined();
  expect(f.refusals).toEqual([
    "overlay kind refused: looser than the repo's value",
    "overlay waive refused: looser than the default",
    "overlay workers refused: looser than the repo's value",
  ]);
});

test("repo: an omitted key is held to the default", () => {
  const f = mergeOverlay(raw(), overlay({ towercab: fm("workers: 1\nahead: 2\ntests: [src/**]") }), null);
  expect(f.towercab.ahead).toBe(2);
  expect(f.towercab.workers).toBeUndefined();
  expect(f.towercab.tests).not.toEqual(["src/**"]);
  expect(f.sources).toMatchObject({ ahead: "overlay", workers: "default", tests: "default" });
  expect(f.refusals).toEqual(["overlay tests refused: looser than the default"]);
});

test("repo: an overlay that loosens the default is refused", () => {
  const f = mergeOverlay(
    raw(),
    overlay({
      towercab: fm(
        "workers: 5\nahead: 9\nlive:\n  url: https://x.example\n  suites:\n    - {name: api, command: hurl api.hurl, tests: [api.hurl]}\ngo_live: we just push",
      ),
    }),
    null,
  );
  expect(f.towercab.workers).toBeUndefined();
  expect(f.towercab.ahead).toBeUndefined();
  expect(f.towercab.live).toBeNull();
  expect(f.towercab.goLive).toBeUndefined();
  expect(f.refusals).toEqual([
    "overlay live refused: looser than the default",
    "overlay go_live refused: looser than the default",
    "overlay workers refused: looser than the default",
    "overlay ahead refused: looser than the default",
  ]);
});

test("repo: overlay checks that check nothing are refused", () => {
  const o = overlay({ verifying: "```checks\ntrue\necho ok\n```\n" });
  const f = mergeOverlay(raw(), o, null);
  expect(f.refusals).toEqual(["overlay checks refused: no command reads the repo's own files"]);
  expect(f.sources?.checks).toBe("repo");
  expect(() => mergeOverlay(raw({ claude: null }), o, null)).toThrow(RepoError);
});

test("repo: an overlay kind matching the inferred one is accepted", () => {
  const f = mergeOverlay(raw(), overlay({ towercab: fm("kind: cli") }), "cli");
  expect(f.overlayKind).toBe("cli");
  expect(f.refusals).toEqual([]);
  // With nothing inferred, any valid kind stands: each only adds setup.
  expect(mergeOverlay(raw(), overlay({ towercab: fm("kind: site") }), null).overlayKind).toBe("site");
});

test("repo: an overlay kind that keeps the inferred setup is accepted", () => {
  const f = mergeOverlay(raw(), overlay({ towercab: fm("kind: service") }), "site");
  expect(f.overlayKind).toBe("service");
  expect(f.sources?.kind).toBe("overlay");
});

test("repo: an overlay kind that drops inferred setup is refused", () => {
  const f = mergeOverlay(raw(), overlay({ towercab: fm("kind: spec-only") }), "service");
  expect(f.overlayKind).toBeUndefined();
  expect(f.refusals).toEqual([
    "overlay kind refused: spec-only drops image, apps, deploy, live that service needs",
  ]);
});

test("repo: an overlay kind stays unconfirmed", () => {
  const f = mergeOverlay(raw(), overlay({ towercab: fm("kind: service") }), "site");
  expect(f.towercab.kind).toBeUndefined();
  expect(f.overlayKind).toBe("service");
});

test("repo: the overlay cannot unprotect the repo's own files", () => {
  const f = mergeOverlay(
    raw({ towercab: fm("protected: [src/machine.ts]") }),
    overlay({ towercab: fm("protected: []") }),
    null,
  );
  expect(f.towercab.protected).toEqual(["src/machine.ts"]);
});

test("repo: an overlay without any file changes nothing", async () => {
  const bare = bareRepo({ "CLAUDE.md": CLAUDE });
  const clone = join(tempDir("tc-clone-"), "clone");
  git(join(clone, ".."), "clone", "-q", bare, clone);
  const files = await loadRepoFilesWith(new FakeTools(), clone, "main", "", null);
  expect(files.sources).toBeUndefined();
  expect(files.refusals).toBeUndefined();
});
