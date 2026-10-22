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

/// A `bwrap` that drops its options (`--chdir <dir>` honoured) and runs what follows `--`.
pub fn fake_bwrap(dir: &Path) -> PathBuf {
    let bin = dir.join("bwrap");
    exe(
        &bin,
        r#"[ "$1" = --version ] && echo 'bubblewrap 0.11.0' && exit 0
while [ $# -gt 0 ] && [ "$1" != -- ]; do
  if [ "$1" = --chdir ]; then cd "$2" || exit 1; shift; fi
  shift
done
shift
exec "$@"
"#,
    );
    bin
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
