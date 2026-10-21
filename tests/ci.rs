//! Towercab's own CI (PIP-12).

mod common;

use common::read;
use yaml_rust2::{Yaml, YamlLoader};

#[test]
fn test_ci_workflow() {
    let docs = YamlLoader::load_from_str(&read(".github/workflows/ci.yml")).unwrap();
    let ci = &docs[0];
    assert!(!ci["on"]["pull_request"].is_badvalue(), "every PR");
    assert_eq!(
        ci["on"]["push"]["branches"],
        Yaml::Array(vec![Yaml::String("main".into())])
    );

    let steps = |job: &str| -> Vec<Yaml> {
        assert_eq!(
            ci["jobs"][job]["runs-on"].as_str(),
            Some("ubuntu-latest"),
            "{job}"
        );
        ci["jobs"][job]["steps"]
            .as_vec()
            .cloned()
            .unwrap_or_default()
    };
    let field = |steps: &[Yaml], key: &str| -> Vec<String> {
        steps
            .iter()
            .filter_map(|s| s[key].as_str().map(str::to_string))
            .collect()
    };

    let rust = steps("rust");
    let uses = field(&rust, "uses");
    assert!(uses.iter().any(|u| u.starts_with("actions/checkout@")));
    assert!(uses.contains(&"dtolnay/rust-toolchain@stable".to_string()));
    assert!(uses.contains(&"Swatinem/rust-cache@v2".to_string()));
    let toolchain = rust
        .iter()
        .find(|s| s["uses"].as_str() == Some("dtolnay/rust-toolchain@stable"))
        .unwrap();
    let components = toolchain["with"]["components"].as_str().unwrap_or_default();
    assert!(
        components.contains("rustfmt") && components.contains("clippy"),
        "{components}"
    );
    assert_eq!(
        field(&rust, "run"),
        [
            "cargo fmt --check",
            "cargo clippy --all-targets --locked -- -D warnings",
            "cargo test --locked",
        ]
    );

    let python = steps("python");
    let setup = python
        .iter()
        .find(|s| {
            s["uses"]
                .as_str()
                .is_some_and(|u| u.starts_with("actions/setup-python@"))
        })
        .expect("setup-python");
    assert_eq!(setup["with"]["python-version"].as_str(), Some("3.12"));
    assert_eq!(
        field(&python, "run"),
        ["python3 -m unittest discover -s tests"]
    );
    // No step may swallow a failure.
    for s in rust.iter().chain(&python) {
        assert!(s["continue-on-error"].is_badvalue(), "{s:?}");
    }
}
