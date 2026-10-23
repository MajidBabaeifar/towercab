//! The pipeline's switch-over (LOOP-1, pipeline.md **Switch-over**): `run` drives the
//! pipeline (picks on), and the Python package has left `main`.

mod common;

use common::world::{World, intent_file};
use towercab::handler::Handlers;

#[test]
fn test_production_handlers_built() {
    let h = Handlers::production();
    assert!(h.built(), "{h:?}");
    assert!(h.unbuilt().is_empty());
    // Picks on: a queued intent is picked and its mission starts.
    let mut w = World::new(&[intent_file("261001-0900-x", "web", "", "X")], &["web"]);
    let mut lp = w.open(Handlers::production());
    assert!(lp.pick_state(w.clock).unwrap().built);
    let r = w.pass(&mut lp);
    assert_eq!(r.picked.as_deref(), Some("261001-0900"));
    assert_eq!(w.missions("261001-0900").len(), 1);
    lp.shutdown().unwrap();
}

#[test]
fn test_python_package_gone() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    for gone in [
        "towercab",
        "bin/towercab",
        "examples",
        "tests/fake_telegram.py",
    ] {
        assert!(!root.join(gone).exists(), "{gone} left main");
    }
    // Only the ops/ scripts' tests stay (until the metrics intent ports them), with their scripts.
    let py: Vec<String> = std::fs::read_dir(root.join("tests"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".py"))
        .collect();
    assert_eq!(py, ["test_ops.py"]);
    for kept in ["ops/telemetry", "ops/grafana/build_dashboard.py"] {
        assert!(root.join(kept).is_file(), "{kept} stays");
    }
    // install.sh links only the /intent skill; the binary comes from cargo install.
    let install = std::fs::read_to_string(root.join("install.sh")).unwrap();
    assert!(install.contains("skills/intent"), "{install}");
    assert!(!install.contains("bin/towercab"), "{install}");
    let readme = std::fs::read_to_string(root.join("README.md")).unwrap();
    assert!(readme.contains("cargo install --path . --locked"));
    assert!(!readme.contains("python3 -m towercab"));
}
