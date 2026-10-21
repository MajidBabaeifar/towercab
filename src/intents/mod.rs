//! The intent home (`intents` repo): folders, `intent.md`, generated views, git sync ([INT](../../specs/intents.md)).

pub mod git;
pub mod id;
pub mod intent;
pub mod migrate;
pub mod store;
pub mod views;

pub use intent::{Intent, Stage, Value};
pub use store::{Listing, NewIntent, Store, StoreError, Unreadable};
