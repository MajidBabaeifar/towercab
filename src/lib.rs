//! Towercab: Majid's software factory (Rust rewrite).
//!
//! Every module is `pub` so its tests live in `tests/` (REPO-6).

pub mod cli;
pub mod commands;
pub mod config;
pub mod db;
pub mod exes;
pub mod handler;
pub mod home;
pub mod intents;
pub mod machine;
pub mod priority;
pub mod repo;
pub mod review;
pub mod runloop;
pub mod service;
