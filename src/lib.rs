//! Towercab: Majid's software factory (Rust rewrite).
//!
//! Every module is `pub` so its tests live in `tests/` (REPO-6).

pub mod checkout;
pub mod child;
pub mod claude;
pub mod cli;
pub mod commands;
pub mod config;
pub mod db;
pub mod env;
pub mod events;
pub mod exes;
pub mod github;
pub mod handler;
pub mod home;
pub mod intents;
pub mod limits;
pub mod machine;
pub mod mission;
pub mod outbox;
pub mod pick;
pub mod priority;
pub mod repo;
pub mod review;
pub mod runloop;
pub mod service;
