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
