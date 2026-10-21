//! Stage handlers (LOOP-3, loop.md **Handlers**).
//!
//! So far only the set the loop holds and whether it is complete: the `Handler` trait, `Pick`
//! and the stubs come with the state machine (loop-runner part 2).

/// The handlers the loop runs, one per stage.
#[derive(Debug)]
pub struct Handlers {
    built: bool,
}

impl Handlers {
    /// What `run` uses: no stage handler is built yet, so picks stay off.
    pub fn production() -> Handlers {
        Handlers { built: false }
    }

    /// Every stage has a handler: picks may run (LOOP-5).
    pub fn built(&self) -> bool {
        self.built
    }
}
