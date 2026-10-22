//! Pipeline fixtures (pipeline.md **Tests**): a fake `claude`, a scripted `gh`, a fake `bwrap`,
//! and [`Pipe`]: a [`World`] whose loop runs the pipeline's handlers on them, stepping one
//! intent at a time (`Loop::step_intent`).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};
use towercab::db::Db;
use towercab::exes::Exes;
use towercab::github::Identity;
use towercab::handler::{ChildEnd, ChildSpec, Ctx, Handlers, Probe, Stub};
use towercab::intents::Store;
use towercab::mission::Mission;
use towercab::pipeline::{self, Mode};
use towercab::runloop::{Loop, LoopOpts, Tick};

use super::world::World;
use super::{exe, git, github_git, write};

/// A `claude` whose n-th call writes its argv (`claude-<n>.argv`, one per line), stdin
/// (`claude-<n>.stdin`) and cwd (`claude-<n>.cwd`), runs `claude-<n>.sh` in its cwd if present
/// (the worker's edits), prints `claude-<n>.json`, `claude-<n>.err` to stderr and exits
/// `claude-<n>.exit` (default 0). `--version` answers.
pub struct FakeClaude {
    pub dir: PathBuf,
    pub bin: PathBuf,
}

impl FakeClaude {
    pub fn new(dir: &Path) -> FakeClaude {
        fs::create_dir_all(dir).unwrap();
        let bin = dir.join("claude");
        exe(
            &bin,
            &format!(
                r#"d='{d}'
[ "$1" = --version ] && echo '2.1.0 (Claude Code)' && exit 0
n=$(($(cat "$d/count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$d/count"
: > "$d/claude-$n.argv"
for a in "$@"; do printf '%s\n' "$a" >> "$d/claude-$n.argv"; done
cat > "$d/claude-$n.stdin"
pwd > "$d/claude-$n.cwd"
[ -f "$d/claude-$n.sh" ] && sh "$d/claude-$n.sh"
[ -f "$d/claude-$n.json" ] && cat "$d/claude-$n.json"
[ -f "$d/claude-$n.err" ] && cat "$d/claude-$n.err" >&2
exit "$(cat "$d/claude-$n.exit" 2>/dev/null || echo 0)"
"#,
                d = dir.display()
            ),
        );
        FakeClaude {
            dir: dir.to_path_buf(),
            bin,
        }
    }

    /// A `type: result` line with `structured` as `structured_output`.
    pub fn result(structured: Value) -> String {
        json!({
            "type": "result", "subtype": "success", "is_error": false, "result": "done",
            "session_id": "s", "total_cost_usd": 0.25, "duration_ms": 1000,
            "structured_output": structured,
        })
        .to_string()
            + "\n"
    }

    /// Call `n` prints `json`.
    pub fn answer(&self, n: usize, json: &str) -> &FakeClaude {
        fs::write(self.dir.join(format!("claude-{n}.json")), json).unwrap();
        self
    }

    /// Call `n` runs `sh` in its cwd first.
    pub fn script(&self, n: usize, sh: &str) -> &FakeClaude {
        fs::write(self.dir.join(format!("claude-{n}.sh")), sh).unwrap();
        self
    }

    pub fn stderr(&self, n: usize, text: &str) -> &FakeClaude {
        fs::write(self.dir.join(format!("claude-{n}.err")), text).unwrap();
        self
    }

    pub fn exit(&self, n: usize, code: i32) -> &FakeClaude {
        fs::write(self.dir.join(format!("claude-{n}.exit")), code.to_string()).unwrap();
        self
    }

    /// Calls so far.
    pub fn calls(&self) -> usize {
        fs::read_to_string(self.dir.join("count"))
            .map(|s| s.trim().parse().unwrap())
            .unwrap_or(0)
    }

    pub fn argv(&self, n: usize) -> Vec<String> {
        fs::read_to_string(self.dir.join(format!("claude-{n}.argv")))
            .unwrap_or_else(|e| panic!("claude call {n}: {e}"))
            .lines()
            .map(str::to_string)
            .collect()
    }

    pub fn stdin(&self, n: usize) -> String {
        fs::read_to_string(self.dir.join(format!("claude-{n}.stdin"))).unwrap()
    }

    pub fn cwd(&self, n: usize) -> String {
        fs::read_to_string(self.dir.join(format!("claude-{n}.cwd")))
            .unwrap()
            .trim()
            .to_string()
    }

    /// The value after `flag` in call `n`'s argv.
    pub fn flag(&self, n: usize, flag: &str) -> Option<String> {
        let a = self.argv(n);
        a.iter()
            .position(|x| x == flag)
            .and_then(|i| a.get(i + 1).cloned())
    }
}

/// A `gh` that matches `"$*"` against ordered shell `case` patterns ([`GhScript::on`]), each
/// with a queue of answers (the last one repeats); every call logged (`calls.log`, argv per
/// call, newlines as spaces in `calls.log`); a `--body-file <f>` or `-F body=@<f>` copied to
/// `body-<n>`. No rule → exit 98.
pub struct GhScript {
    pub dir: PathBuf,
    pub bin: PathBuf,
}

impl GhScript {
    pub fn new(dir: &Path) -> GhScript {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("rules"), "").unwrap();
        let bin = dir.join("gh");
        exe(
            &bin,
            &format!(
                r#"d='{d}'
n=$(($(cat "$d/count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$d/count"
printf '%s' "$*" | tr '\n' ' ' >> "$d/calls.log"
echo >> "$d/calls.log"
: > "$d/argv-$n"
prev=
for a in "$@"; do
  printf '%s\n' "$a" >> "$d/argv-$n"
  [ "$prev" = --body-file ] && cp "$a" "$d/body-$n"
  case "$a" in body=@*) cp "${{a#body=@}}" "$d/body-$n" ;; esac
  prev="$a"
done
i=0
while IFS= read -r pat; do
  i=$((i + 1))
  case "$*" in
    $pat)
      k=$(($(cat "$d/r$i.used" 2>/dev/null || echo 0) + 1))
      if [ -f "$d/r$i-$k.code" ]; then echo "$k" > "$d/r$i.used"; else k=$((k - 1)); fi
      [ -f "$d/r$i-$k.sh" ] && exec sh "$d/r$i-$k.sh" "$@"
      cat "$d/r$i-$k.out"
      cat "$d/r$i-$k.err" >&2
      exit "$(cat "$d/r$i-$k.code")"
      ;;
  esac
done < "$d/rules"
echo "gh script: no rule for: $*" >&2
exit 98
"#,
                d = dir.display()
            ),
        );
        GhScript {
            dir: dir.to_path_buf(),
            bin,
        }
    }

    /// A rule: calls whose `"$*"` matches `pattern` get `answers` in turn (stdout, stderr, exit
    /// code), the last one repeating.
    pub fn on(&self, pattern: &str, answers: &[(&str, &str, i32)]) -> &GhScript {
        let rules = self.dir.join("rules");
        let mut text = fs::read_to_string(&rules).unwrap();
        let i = text.lines().count() + 1;
        text.push_str(pattern);
        text.push('\n');
        for (k, (out, err, code)) in answers.iter().enumerate() {
            let k = k + 1;
            fs::write(self.dir.join(format!("r{i}-{k}.out")), out).unwrap();
            fs::write(self.dir.join(format!("r{i}-{k}.err")), err).unwrap();
            fs::write(self.dir.join(format!("r{i}-{k}.code")), code.to_string()).unwrap();
        }
        fs::write(rules, text).unwrap();
        self
    }

    /// A rule whose answers are shell scripts (run with the call's arguments; their output and
    /// exit code are the answer), the last one repeating.
    pub fn on_sh(&self, pattern: &str, scripts: &[&str]) -> &GhScript {
        let rules = self.dir.join("rules");
        let mut text = fs::read_to_string(&rules).unwrap();
        let i = text.lines().count() + 1;
        text.push_str(pattern);
        text.push('\n');
        for (k, sh) in scripts.iter().enumerate() {
            let k = k + 1;
            fs::write(self.dir.join(format!("r{i}-{k}.sh")), sh).unwrap();
            fs::write(self.dir.join(format!("r{i}-{k}.code")), "0").unwrap();
        }
        fs::write(rules, text).unwrap();
        self
    }

    /// Replaces the answers of the rule with exactly `pattern` (its queue starts again).
    pub fn replace(&self, pattern: &str, answers: &[(&str, &str, i32)]) -> &GhScript {
        let i = self.clear(pattern);
        for (k, (out, err, code)) in answers.iter().enumerate() {
            let k = k + 1;
            fs::write(self.dir.join(format!("r{i}-{k}.out")), out).unwrap();
            fs::write(self.dir.join(format!("r{i}-{k}.err")), err).unwrap();
            fs::write(self.dir.join(format!("r{i}-{k}.code")), code.to_string()).unwrap();
        }
        self
    }

    /// [`GhScript::replace`] with script answers ([`GhScript::on_sh`]).
    pub fn replace_sh(&self, pattern: &str, scripts: &[&str]) -> &GhScript {
        let i = self.clear(pattern);
        for (k, sh) in scripts.iter().enumerate() {
            let k = k + 1;
            fs::write(self.dir.join(format!("r{i}-{k}.sh")), sh).unwrap();
            fs::write(self.dir.join(format!("r{i}-{k}.code")), "0").unwrap();
        }
        self
    }

    /// The rule `pattern`'s number, its answers removed.
    fn clear(&self, pattern: &str) -> usize {
        let text = fs::read_to_string(self.dir.join("rules")).unwrap();
        let i = text
            .lines()
            .position(|l| l == pattern)
            .unwrap_or_else(|| panic!("no gh rule {pattern}"))
            + 1;
        for e in fs::read_dir(&self.dir).unwrap() {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            if name.starts_with(&format!("r{i}-")) || name == format!("r{i}.used") {
                fs::remove_file(self.dir.join(name)).unwrap();
            }
        }
        i
    }

    /// Every call's `"$*"`, in order.
    pub fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.dir.join("calls.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The numbers (1-based) of the calls whose `"$*"` starts with `prefix`.
    pub fn find(&self, prefix: &str) -> Vec<usize> {
        self.calls()
            .iter()
            .enumerate()
            .filter(|(_, c)| c.starts_with(prefix))
            .map(|(i, _)| i + 1)
            .collect()
    }

    pub fn argv(&self, n: usize) -> Vec<String> {
        fs::read_to_string(self.dir.join(format!("argv-{n}")))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The body file call `n` passed.
    pub fn body(&self, n: usize) -> Option<String> {
        fs::read_to_string(self.dir.join(format!("body-{n}"))).ok()
    }
}

/// A `bwrap` that logs each call's argv (`bwrap-<n>.argv` next to it, one per line), drops its
/// options (`--chdir <dir>` honoured) and runs what follows `--`.
pub fn fake_bwrap(dir: &Path) -> PathBuf {
    let bin = dir.join("bwrap");
    exe(
        &bin,
        &r#"[ "$1" = --version ] && echo 'bubblewrap 0.11.0' && exit 0
d='{dir}'
n=$(($(cat "$d/bwrap.count" 2>/dev/null || echo 0) + 1))
echo "$n" > "$d/bwrap.count"
: > "$d/bwrap-$n.argv"
for a in "$@"; do printf '%s\n' "$a" >> "$d/bwrap-$n.argv"; done
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  if [ "$1" = --chdir ]; then cd "$2" || exit 1; shift; fi
  shift
done
shift
exec "$@"
"#
        .replace("{dir}", &dir.display().to_string()),
    );
    bin
}

/// The argv of the fake `bwrap`'s calls in `dir`, in order.
pub fn bwrap_calls(dir: &Path) -> Vec<Vec<String>> {
    let n: usize = fs::read_to_string(dir.join("bwrap.count"))
        .map(|s| s.trim().parse().unwrap())
        .unwrap_or(0);
    (1..=n)
        .map(|k| {
            fs::read_to_string(dir.join(format!("bwrap-{k}.argv")))
                .unwrap()
                .lines()
                .map(str::to_string)
                .collect()
        })
        .collect()
}

/// A plan result listing `files`.
pub fn plan_result(files: &[&str]) -> Value {
    json!({"files": files, "order": ["tests first", "then the code"], "risks": ["none known"],
        "proof": ["run the checks"]})
}

/// A worker result: `done` with `notes`.
pub fn done(notes: &str) -> Value {
    json!({"status": "done", "question": null, "notes": notes, "plan": null, "plan_why": null,
        "lower_a": null, "lower_why": null})
}

/// A worker result: `blocked` on `question`.
pub fn blocked(question: &str) -> Value {
    json!({"status": "blocked", "question": question, "notes": "", "plan": null,
        "plan_why": null, "lower_a": null, "lower_why": null})
}

/// A design result: `type` feat, scope `auth`, the spec IDs and concerns given.
pub fn design(spec_ids: &[&str], concerns: &[(&str, &str)]) -> Value {
    json!({
        "type": "feat", "scope": "auth", "breaking": false,
        "spec_ids": spec_ids,
        "concerns": concerns.iter().map(|(w, y)| json!({"what": w, "why": y, "policy": null})).collect::<Vec<_>>(),
        "open_questions": [],
        "summary": "Adds login.",
    })
}

/// A shell line writing `text` to `rel` in the cwd (the worker's edit).
pub fn writes(rel: &str, text: &str) -> String {
    let dir = Path::new(rel)
        .parent()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    let mk = if dir.is_empty() {
        String::new()
    } else {
        format!("mkdir -p '{dir}' && ")
    };
    format!(
        "{mk}printf '%s' '{}' > '{rel}'\n",
        text.replace('\'', r"'\''")
    )
}

/// A [`World`] whose loop runs the pipeline on [`FakeClaude`], [`GhScript`], [`fake_bwrap`]
/// and a `git` that maps `https://github.com/<o>/<n>` to `<root>/github/<o>/<n>.git`.
pub struct Pipe {
    pub w: World,
    pub claude: FakeClaude,
    pub gh: GhScript,
    pub exes: Exes,
    pub lp: Option<Loop>,
}

impl Pipe {
    /// The world (intents `files`, `repos`); the loop is opened by the first [`Pipe::step`].
    pub fn new(files: &[(String, String)], repos: &[&str]) -> Pipe {
        let w = World::new(files, repos);
        let claude = FakeClaude::new(&w.root.join("claude"));
        let gh = GhScript::new(&w.root.join("ghs"));
        let bin = w.root.join("pipebin");
        fs::create_dir_all(&bin).unwrap();
        let exes = Exes {
            claude: claude.bin.clone().into(),
            gh: gh.bin.clone().into(),
            bwrap: fake_bwrap(&bin).into(),
            git: github_git(&bin, &w.root.join("github")).into(),
            towercab: env!("CARGO_BIN_EXE_towercab").into(),
            ..w.exes()
        };
        Pipe {
            w,
            claude,
            gh,
            exes,
            lp: None,
        }
    }

    /// The pipeline's handlers (`Mode::Live`) with [`Stub`] for each stage not built yet.
    pub fn handlers() -> Handlers {
        let mut h = pipeline::handlers(Mode::Live);
        for s in h.unbuilt() {
            h.set(s, Box::new(Stub));
        }
        h
    }

    /// Opens the loop with `h` (replacing one already open).
    pub fn open_with(&mut self, h: Handlers) -> &mut Loop {
        self.lp = None;
        let lp = self.w.open_with(h, self.exes.clone(), LoopOpts::default());
        self.lp = Some(lp);
        self.lp.as_mut().unwrap()
    }

    pub fn lp(&mut self) -> &mut Loop {
        if self.lp.is_none() {
            self.open_with(Pipe::handlers());
        }
        self.lp.as_mut().unwrap()
    }

    /// `towercab step <id>`: one step of the intent's mission → `<id>: <from> → <to>[ · …]`.
    pub fn step(&mut self, id: &str) -> String {
        self.lp()
            .step_intent(id)
            .unwrap_or_else(|e| panic!("step {id}: {e}"))
    }

    /// Steps until the intent's mission is at `stage` (at most `max` steps).
    pub fn step_to(&mut self, id: &str, stage: towercab::machine::Stage, max: usize) {
        for _ in 0..max {
            if self.w.stage(id) == Some(stage) {
                return;
            }
            let line = self.step(id);
            eprintln!("{line}");
        }
        assert_eq!(self.w.stage(id), Some(stage), "not reached in {max} steps");
    }

    /// Passes (61 s of the world's clock apart: every poll due; 30 ms of real time) until
    /// `done` holds, at most `secs` seconds of real time.
    pub fn until(&mut self, secs: u64, done: impl Fn(&World) -> bool) {
        let end = std::time::Instant::now() + Duration::from_secs(secs);
        let lp = self.lp.as_mut().expect("the loop is open");
        while !done(&self.w) {
            assert!(std::time::Instant::now() < end, "not reached in {secs} s");
            std::thread::sleep(Duration::from_millis(30));
            self.w.pass(lp);
        }
    }

    pub fn mission(&self, id: &str) -> Mission {
        self.w.mission(id)
    }

    /// `data` of the intent's latest mission.
    pub fn data(&self, id: &str) -> Value {
        serde_json::from_str(&self.mission(id).data).unwrap()
    }

    /// Towercab's runs directory of the intent.
    pub fn runs(&self, id: &str) -> PathBuf {
        self.w.home.runs(id)
    }

    /// Files on `main` of the repo's origin (pushed from my clone) and in Towercab's clone.
    pub fn base(&self, repo: &str, files: &[(&str, &str)], msg: &str) {
        let mine = self.w.mine(repo);
        for (rel, text) in files {
            write(&mine, rel, text);
        }
        git(&mine, &["add", "-A"]);
        git(&mine, &["commit", "--quiet", "-m", msg]);
        git(&mine, &["push", "--quiet", "origin", "HEAD:main"]);
        git(&self.w.clone_path(repo), &["fetch", "--quiet", "origin"]);
    }

    /// The fake `bwrap`'s calls so far.
    pub fn bwraps(&self) -> Vec<Vec<String>> {
        bwrap_calls(&self.w.root.join("pipebin"))
    }

    /// A file of the intent home's `main` (Towercab's pushes).
    pub fn intents_file(&self, rel: &str) -> Option<String> {
        let out = std::process::Command::new("git")
            .args(["show", &format!("main:{rel}")])
            .current_dir(&self.w.intents.remote)
            .output()
            .unwrap();
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
    }

    /// The subjects of the intent home's `main`, newest first.
    pub fn intents_log(&self) -> Vec<String> {
        git(&self.w.intents.remote, &["log", "--format=%s", "main"])
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// A branch's commits on the repo's origin, newest first: (subject, author name).
    pub fn origin_log(&self, repo: &str, branch: &str) -> Vec<(String, String)> {
        let origin = self.w.root.join("repos").join(format!("{repo}.git"));
        git(&origin, &["log", "--format=%s%x09%an", branch])
            .lines()
            .map(|l| {
                let (s, a) = l.split_once('\t').unwrap();
                (s.to_string(), a.to_string())
            })
            .collect()
    }

    /// A file on a branch of the repo's origin.
    pub fn origin_file(&self, repo: &str, branch: &str, rel: &str) -> String {
        let origin = self.w.root.join("repos").join(format!("{repo}.git"));
        git(&origin, &["show", &format!("{branch}:{rel}")])
    }

    /// I push `files` onto `branch` of the repo's origin (from my clone).
    pub fn push_mine(&self, repo: &str, branch: &str, files: &[(&str, &str)], msg: &str) {
        let mine = self.w.mine(repo);
        git(&mine, &["fetch", "--quiet", "origin"]);
        git(
            &mine,
            &[
                "checkout",
                "--quiet",
                "-B",
                branch,
                &format!("origin/{branch}"),
            ],
        );
        for (rel, text) in files {
            write(&mine, rel, text);
        }
        git(&mine, &["add", "-A"]);
        git(&mine, &["commit", "--quiet", "-m", msg]);
        git(
            &mine,
            &["push", "--quiet", "origin", &format!("HEAD:{branch}")],
        );
        git(&mine, &["checkout", "--quiet", "main"]);
    }

    /// `f` with a `Ctx` on this world (its own store, db and identity).
    pub fn cx<T>(&self, f: impl FnOnce(&mut Ctx<'_>) -> T) -> T {
        let store = Store::open(&self.w.config).expect("store opens");
        let db = Db::open(&self.w.home.db()).unwrap();
        let mut identity = Identity::from_config(&self.w.config, &self.exes);
        let probe = Probe::default();
        let mut cx = Ctx {
            config: &self.w.config,
            home: &self.w.home,
            db: &db,
            store: &store,
            exes: &self.exes,
            identity: &mut identity,
            tick: Tick::now(),
            timeouts: true,
            probe: &probe,
        };
        f(&mut cx)
    }
}

/// Runs a child to its end (foreground) → how it ended.
pub fn run_child(spec: &ChildSpec) -> ChildEnd {
    let start = std::time::Instant::now();
    let mono = |s: std::time::Instant| Duration::from_secs(1000) + s.elapsed();
    let mut c = towercab::child::spawn(spec, mono(start)).expect("child starts");
    c.budget = spec.timeout;
    loop {
        if let Some(end) = c.poll(mono(start)) {
            return end;
        }
        c.enforce(mono(start), Duration::from_millis(200));
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// `gh pr view` of the CI handler.
pub const CI_VIEW: &str = "pr view * --json headRefOid,mergeable,statusCheckRollup";
/// `gh pr view` of a PR read (`events::GhPrs`).
pub const PR_READ: &str =
    "pr view * --json state,mergedAt,mergeCommit,headRefOid,mergeable,comments,reviews";
/// The review comments of a PR read.
pub const PR_COMMENTS: &str = "api --paginate --slurp *";
/// `gh pr view` of the merge handler.
pub const MERGE_VIEW: &str = "pr view * --json headRefOid,mergeStateStatus,mergedAt,mergeCommit";

/// A `statusCheckRollup` check run of Actions run `run` (started long after any push).
pub fn check(name: &str, status: &str, conclusion: &str, run: u64) -> String {
    json!({
        "__typename": "CheckRun", "name": name, "status": status, "conclusion": conclusion,
        "startedAt": "2099-01-01T00:00:00Z",
        "detailsUrl": format!("https://github.com/me/web/actions/runs/{run}/job/{}", run * 10),
    })
    .to_string()
}

/// A review result: approved, the login bullet met, nothing weakened, the plan followed,
/// `findings` (JSON list), `door` (JSON) and no red line.
pub fn review(approved: bool, findings: Value, door: Value) -> Value {
    json!({
        "approved": approved,
        "outcomes": [{"bullet": "I can log in", "met": true, "why": "login works"}],
        "tests_weakened": {"weakened": false, "where": ""},
        "plan_followed": {"followed": true, "where": ""},
        "findings": findings,
        "door": door,
        "red_lines": [],
        "why": "Looks right.",
    })
}

/// A finding.
pub fn finding(important: bool, file: &str, line: Option<u64>, what: &str) -> Value {
    json!({"pass": "correctness", "severity": if important { "important" } else { "nit" },
           "file": file, "line": line, "what": what, "rule": null, "policy": null})
}

/// The login intent of the build tests.
pub const LOGIN_ID: &str = "261001-0900";
pub const LOGIN_DIR: &str = "261001-0900-login";
pub const LOGIN_BRANCH: &str = "towercab/261001-0900-login";

/// The base's checks: every `tests/*.sh` passes (none: green).
pub const CHECK_SH: &str =
    "for t in tests/*.sh; do [ -f \"$t\" ] || continue; sh \"$t\" || exit 1; done\n";

/// The worker's test: `src/login.rs` has `fn login`.
pub const LOGIN_TEST: &str = "grep -q 'fn login' src/login.rs\n";

/// The base's `CLAUDE.md`: setup `setup` (one line), checks `sh check.sh`.
pub fn claude_md(setup: &str) -> String {
    format!(
        "# Web\n\n## Verifying your work\n\n```setup\n{setup}\n```\n\n```checks\nsh check.sh\n```\n"
    )
}

impl Pipe {
    /// The login intent (`extra` front matter) on repo `web`, whose base has setup (each run
    /// appends its cwd to `<root>/setup.log`) and checks `sh check.sh`; design run 1 changes
    /// `WEB-1`; gh opens PR 7 and takes every write.
    pub fn login(extra: &str) -> Pipe {
        let p = Pipe::new(
            &[(
                format!("intents/{LOGIN_DIR}/intent.md"),
                super::intent_md(
                    "web",
                    extra,
                    "Add login\n\nspec IDs: WEB-1..3\n\n## Proposed outcome\n\n- I can log in\n",
                ),
            )],
            &["web"],
        );
        let setup = format!(
            "echo \"$PWD\" >> '{}'",
            p.w.root.join("setup.log").display()
        );
        p.base(
            "web",
            &[("CLAUDE.md", &claude_md(&setup)), ("check.sh", CHECK_SH)],
            "verifying",
        );
        p.claude
            .script(
                1,
                &writes("specs/web.md", "| WEB-1 | log in | test_login |\n"),
            )
            .answer(1, &FakeClaude::result(design(&["WEB-1"], &[])));
        p.gh.on("pr list *", &[("[]", "", 0)])
            .on(
                "pr create *",
                &[("https://github.com/me/web/pull/7\n", "", 0)],
            )
            .on("pr ready *", &[("", "", 0)])
            .on("api -X POST repos/me/web/check-runs *", &[("{}", "", 0)])
            .on("api -X PATCH *", &[("{}", "", 0)])
            .on("pr comment *", &[("", "", 0)])
            .on(
                PR_READ,
                &[(r#"{"state":"OPEN","comments":[],"reviews":[]}"#, "", 0)],
            )
            .on(PR_COMMENTS, &[("[[]]", "", 0)]);
        p
    }

    /// CI answers `checks` (the `statusCheckRollup` JSON) on the branch's head on origin, with
    /// `mergeable` (each read: the head as origin has it now).
    pub fn ci_answers(&self, mergeable: &str, checks: &str) -> &Pipe {
        let sh = self.rollup_sh(mergeable, checks);
        let rules = fs::read_to_string(self.gh.dir.join("rules")).unwrap();
        if rules.lines().any(|l| l == CI_VIEW) {
            self.gh.replace_sh(CI_VIEW, &[&sh]);
        } else {
            self.gh.on_sh(CI_VIEW, &[&sh]);
        }
        self
    }

    /// The script printing a rollup on the branch's origin head.
    pub fn rollup_sh(&self, mergeable: &str, checks: &str) -> String {
        let origin = self.w.root.join("repos/web.git");
        let n = fs::read_dir(&self.gh.dir).unwrap().count();
        let tpl = self.gh.dir.join(format!("rollup-{n}.json"));
        fs::write(
            &tpl,
            format!(
                r#"{{"headRefOid":"@HEAD@","mergeable":"{mergeable}","statusCheckRollup":{checks}}}"#
            ),
        )
        .unwrap();
        format!(
            "h=$(git --git-dir='{}' rev-parse 'refs/heads/{LOGIN_BRANCH}')\nsed \"s/@HEAD@/$h/\" '{}'\n",
            origin.display(),
            tpl.display()
        )
    }

    /// CI green: one completed, successful Actions check started after any push.
    pub fn ci_green(&self) -> &Pipe {
        self.ci_answers(
            "MERGEABLE",
            &format!("[{}]", check("test", "COMPLETED", "SUCCESS", 11)),
        )
    }

    /// Call `n` plans (`src/login.rs`).
    pub fn plans(&self, n: usize) -> &Pipe {
        self.claude
            .answer(n, &FakeClaude::result(plan_result(&["src/login.rs"])));
        self
    }

    /// Call `n` builds: `src/login.rs` and its test, `done`.
    pub fn builds(&self, n: usize) -> &Pipe {
        self.claude
            .script(
                n,
                &(writes("src/login.rs", "pub fn login() {}\n")
                    + &writes("tests/login_test.sh", LOGIN_TEST)),
            )
            .answer(n, &FakeClaude::result(done("Adds login.")));
        self
    }

    /// Call `n` builds with a Rust test for `WEB-1` (`fn test_login(` in the diff).
    pub fn builds_tested(&self, n: usize) -> &Pipe {
        self.claude
            .script(
                n,
                &(writes("src/login.rs", "pub fn login() {}\n")
                    + &writes("tests/login_test.sh", LOGIN_TEST)
                    + &writes("tests/login.rs", "#[test]\nfn test_login() {}\n")),
            )
            .answer(n, &FakeClaude::result(done("Adds login.")));
        self
    }

    /// `setup.log`'s lines: where setup ran, in order.
    pub fn setups(&self) -> Vec<String> {
        fs::read_to_string(self.w.root.join("setup.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// The intent's checkout (absolute).
    pub fn checkout(&self, id: &str) -> PathBuf {
        self.w.home.root.join(self.mission(id).checkout)
    }
}

/// A real `bwrap` that can sandbox on this machine (user namespaces allowed), if any: tests
/// run the sandbox for real there, and only check its argv elsewhere.
pub fn real_bwrap() -> Option<PathBuf> {
    let bwrap = towercab::exes::which(std::ffi::OsStr::new("bwrap"))?;
    std::process::Command::new(&bwrap)
        .args([
            "--unshare-net",
            "--die-with-parent",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--",
            "true",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| bwrap)
}
