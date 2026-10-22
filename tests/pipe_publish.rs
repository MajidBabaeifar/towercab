//! Publish (PIP-2): Towercab commits, pushes from its clone, opens the PR once, marks it
//! ready once, never force-pushes over my commits.

mod common;

use std::cell::Cell;
use std::fs;
use std::rc::Rc;

use common::git;
use common::pipe::{FakeClaude, Pipe, design, writes};
use common::world::intent_file;
use serde_json::json;
use towercab::handler::{ChildEnd, Ctx, Handler, Handlers, Outcome, Progress, StepError, Stub};
use towercab::machine::Stage;
use towercab::mission::Mission;
use towercab::pipeline::data::Data;
use towercab::pipeline::design::{pr_title, spec_commit};
use towercab::pipeline::schemas::DesignResult;
use towercab::pipeline::{conventional, git as pgit};

const ID: &str = "261001-0900";
const BRANCH: &str = "towercab/261001-0900-login";

/// A build: writes `src/login.rs` (build <k>) and commits it as Towercab.
#[derive(Clone, Default)]
struct Builds(Rc<Cell<u32>>);

impl Handler for Builds {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let k = self.0.get() + 1;
        self.0.set(k);
        let dir = cx.checkout(m);
        fs::write(dir.join("src/login.rs"), format!("// build {k}\n")).unwrap();
        pgit::commit(cx, m, &dir, "feat(auth): Add login", false)?;
        Ok(Progress::Done(Outcome::ok()))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        unreachable!()
    }
}

/// A green verify: `data.verify` and its log, as part 2's verify keeps them.
struct Green;

impl Handler for Green {
    fn step(&mut self, cx: &mut Ctx<'_>, m: &Mission) -> Result<Progress, StepError> {
        let mut data = Data::of(m);
        let n = data.next_n("verify");
        let head = pgit::rev(cx, &cx.checkout(m), "HEAD")?;
        data.set(
            "verify",
            json!({"head": head, "line": "green (1 command)", "n": n}),
        );
        data.set(
            "proof",
            json!({"line": "skipped: no behaviour change", "n": 0}),
        );
        fs::write(
            cx.runs(m).join(format!("verify-{n}.log")),
            "$ make test\nok\n",
        )
        .unwrap();
        Ok(Progress::Done(Outcome::ok().with("data", data.text())))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        unreachable!()
    }
}

/// CI: red the first `reds` times, then green.
struct Ci(Rc<Cell<u32>>);

impl Handler for Ci {
    fn step(&mut self, _: &mut Ctx<'_>, _: &Mission) -> Result<Progress, StepError> {
        if self.0.get() > 0 {
            self.0.set(self.0.get() - 1);
            return Ok(Progress::Done(Outcome::red("CI red")));
        }
        Ok(Progress::Done(Outcome::ok()))
    }
    fn finish(&mut self, _: &mut Ctx<'_>, _: &Mission, _: ChildEnd) -> Result<Progress, StepError> {
        unreachable!()
    }
}

fn handlers(builds: &Builds, reds: u32) -> Handlers {
    let mut h = Pipe::handlers();
    h.set(Stage::Plan, Box::new(Stub));
    h.set(Stage::Build, Box::new(builds.clone()));
    h.set(Stage::Verify, Box::new(Green));
    h.set(Stage::Proof, Box::new(Stub));
    h.set(Stage::Ci, Box::new(Ci(Rc::new(Cell::new(reds)))));
    h
}

/// Designed (a4, PR 7 as a draft), at `plan`.
fn designed(reds: u32) -> (Pipe, Builds) {
    let mut p = Pipe::new(
        &[intent_file(
            "261001-0900-login",
            "web",
            "a: 4\n",
            "Add login",
        )],
        &["web"],
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
        .on("api -X PATCH *", &[("{}", "", 0)]);
    let builds = Builds::default();
    p.open_with(handlers(&builds, reds));
    p.step_to(ID, Stage::Plan, 3);
    (p, builds)
}

#[test]
fn test_publish_after_verify() {
    let (mut p, _) = designed(0);
    let designed = p.mission(ID).head.unwrap();
    p.step_to(ID, Stage::Publish, 6);
    // Built and verified, nothing pushed yet.
    assert_eq!(p.origin_log("web", BRANCH)[0].0, "docs(specs): Add login");
    assert_eq!(p.step(ID), "261001-0900: publish → ci");
    let m = p.mission(ID);
    let log = p.origin_log("web", BRANCH);
    assert_eq!(log[0], ("feat(auth): Add login".into(), "Towercab".into()));
    assert_eq!(p.origin_file("web", BRANCH, "src/login.rs"), "// build 1\n");
    let origin = p.w.root.join("repos/web.git");
    let head = git(&origin, &["rev-parse", BRANCH]).trim().to_string();
    assert_eq!(m.head.as_deref(), Some(head.as_str()));
    assert_ne!(head, designed);
    // The PR from design stays: no second one; marked ready; the verify check run on the head.
    assert_eq!(p.gh.find("pr create").len(), 1);
    assert_eq!(m.pr, Some(7));
    assert_eq!(p.gh.find("pr ready 7 -R me/web").len(), 1);
    let runs = p.gh.find("api -X POST repos/me/web/check-runs");
    assert_eq!(runs.len(), 1, "proof skipped: no check run");
    let argv = p.gh.argv(runs[0]);
    for f in [
        "name=towercab/verify".to_string(),
        format!("head_sha={head}"),
        "status=completed".into(),
        "conclusion=success".into(),
        "output[title]=green (1 command)".into(),
        "output[summary]=$ make test\nok\n".into(),
    ] {
        let f = f.lines().next().unwrap().to_string();
        assert!(argv.iter().any(|a| a.starts_with(&f)), "{f}: {argv:?}");
    }
    assert_eq!(p.data(ID)["ready"], true);
}

#[test]
fn test_commit_messages_conventional() {
    assert_eq!(
        conventional("feat", "auth", false, "Add login"),
        "feat(auth): Add login"
    );
    assert_eq!(conventional("fix", "", false, "Crash"), "fix: Crash");
    assert_eq!(
        conventional("feat", "api", true, "New v2"),
        "feat(api)!: New v2"
    );
    assert_eq!(
        conventional("refactor", " ", true, "a\nb"),
        "refactor!: a b"
    );
    assert_eq!(spec_commit("Add login", false), "docs(specs): Add login");
    assert_eq!(
        spec_commit("Add login", true),
        "docs(specs): revise Add login"
    );
    let mut d = design(&["WEB-1"], &[]);
    d["breaking"] = json!(true);
    let d = DesignResult::from_json(&d).unwrap();
    assert_eq!(pr_title(&d, "Add login"), "feat(auth)!: Add login");
    // A type outside Conventional Commits, or a scope that would break the subject: refused.
    for (k, v) in [
        ("type", json!("feature")),
        ("scope", json!("a(b)")),
        ("scope", json!("x: y")),
    ] {
        let mut bad = design(&["WEB-1"], &[]);
        bad[k] = v;
        assert!(DesignResult::from_json(&bad).is_err(), "{k}");
    }
    // In a flow: the spec commit and the build's, both Conventional, both Towercab's.
    let (mut p, _) = designed(0);
    p.step_to(ID, Stage::Ci, 8);
    let log = p.origin_log("web", BRANCH);
    let subjects: Vec<&str> = log.iter().take(2).map(|(s, _)| s.as_str()).collect();
    assert_eq!(
        subjects,
        ["feat(auth): Add login", "docs(specs): Add login"]
    );
    let title = p.gh.argv(p.gh.find("pr create")[0]);
    assert!(title.contains(&"feat(auth): Add login".to_string()));
}

#[test]
fn test_ready_marked_once() {
    // CI red once: a second build and publish.
    let (mut p, builds) = designed(1);
    p.step_to(ID, Stage::Ci, 8);
    p.step(ID);
    assert_eq!(p.w.stage(ID), Some(Stage::Build));
    p.step_to(ID, Stage::Ci, 8);
    assert_eq!(builds.0.get(), 2);
    assert_eq!(p.origin_file("web", BRANCH, "src/login.rs"), "// build 2\n");
    assert_eq!(p.gh.find("pr ready").len(), 1, "{:?}", p.gh.calls());
    assert_eq!(p.gh.find("api -X POST repos/me/web/check-runs").len(), 2);
}

#[test]
fn test_push_rejected_keeps_my_commits() {
    let (mut p, _) = designed(1);
    p.step_to(ID, Stage::Ci, 8);
    // I push onto the PR while CI runs; CI goes red, the worker builds again.
    p.push_mine("web", BRANCH, &[("README.md", "# mine\n")], "docs: my note");
    let mine = p.origin_log("web", BRANCH)[0].clone();
    assert_eq!(mine.0, "docs: my note");
    assert_eq!(p.step(ID), "261001-0900: ci → build");
    p.step_to(ID, Stage::Ci, 8);
    // Merged in, never forced over.
    let log = p.origin_log("web", BRANCH);
    let subjects: Vec<&str> = log.iter().map(|(s, _)| s.as_str()).collect();
    assert!(subjects.contains(&"docs: my note"), "{subjects:?}");
    assert!(subjects[0].starts_with("Merge "), "{subjects:?}");
    assert_eq!(p.origin_file("web", BRANCH, "README.md"), "# mine\n");
    assert_eq!(p.origin_file("web", BRANCH, "src/login.rs"), "// build 2\n");
    // A conflict there asks me; nothing pushed.
    let (mut p, _) = designed(1);
    p.step_to(ID, Stage::Ci, 8);
    p.push_mine("web", BRANCH, &[("src/login.rs", "// mine\n")], "fix: mine");
    let origin = p.w.root.join("repos/web.git");
    let before = git(&origin, &["rev-parse", BRANCH]);
    p.step(ID);
    p.step_to(ID, Stage::Blocked, 8);
    let m = p.mission(ID);
    assert_eq!(m.waiting.as_deref(), Some("answer the question"));
    assert!(m.why.unwrap().starts_with("publish failed: "));
    assert_eq!(git(&origin, &["rev-parse", BRANCH]), before);
    let dir = p.w.home.root.join(&m.checkout);
    assert!(
        git(&dir, &["status", "--porcelain"]).trim().is_empty(),
        "merge aborted"
    );
    let md = p.w.intent_md("261001-0900-login");
    assert!(md.contains("## Towercab\n\npublish failed: "), "{md}");
    // ⛔ Not ready in the PR text (PIP-14).
    let patch = *p
        .gh
        .find("api -X PATCH repos/me/web/pulls/7")
        .last()
        .unwrap_or_else(|| panic!("{:?}", p.gh.calls()));
    let body =
        p.gh.body(patch)
            .unwrap_or_else(|| panic!("{:?}", p.gh.argv(patch)));
    assert!(
        body.starts_with("⛔ Not ready: answer the question: publish failed"),
        "{body}"
    );
}
