//! Edits to intents from outside the loop (UI-14): one interface, so the git store behind it
//! can become a database later (intent 261025-1900) without touching its callers.

use std::sync::Arc;

use chrono::{DateTime, FixedOffset};

use crate::config::Config;
use crate::intents::git::AuthFn;
use crate::intents::store::{NewIntent, Store};
use crate::intents::{Intent, Value};

/// The models an intent may name.
pub const MODELS: [&str; 3] = ["opus", "sonnet", "haiku"];

/// One change to one intent.
#[derive(Debug, Clone, PartialEq)]
pub enum Edit {
    /// `u`, `i` (1–5) and `a` (1–5, `None` = no `a`).
    Scores { u: u8, i: u8, a: Option<u8> },
    /// `None` = the default model.
    Model(Option<String>),
    /// `stage: dropped` (moved to `done/`).
    Drop,
}

impl Edit {
    /// The commit's verb: `towercab: <what> <id>`.
    pub fn what(&self) -> &'static str {
        match self {
            Edit::Scores { .. } => "rescore",
            Edit::Model(_) => "model",
            Edit::Drop => "drop",
        }
    }
}

/// Applies `edit` to `intent` line by line (`Intent::set`/`remove`: every other line kept).
pub fn apply(intent: &mut Intent, edit: &Edit) -> Result<(), String> {
    let score = |name: &str, v: u8| {
        if (1..=5).contains(&v) {
            Ok(())
        } else {
            Err(format!("{name} must be 1-5"))
        }
    };
    match edit {
        Edit::Scores { u, i, a } => {
            score("u", *u)?;
            score("i", *i)?;
            intent.set("u", Value::Int((*u).into()))?;
            intent.set("i", Value::Int((*i).into()))?;
            match a {
                Some(a) => {
                    score("a", *a)?;
                    intent.set("a", Value::Int((*a).into()))?;
                }
                None => intent.remove("a")?,
            }
        }
        Edit::Model(None) => intent.remove("model")?,
        Edit::Model(Some(m)) if MODELS.contains(&m.as_str()) => {
            intent.set("model", Value::Str(m.clone()))?
        }
        Edit::Model(Some(m)) => return Err(format!("unknown model {m}")),
        Edit::Drop => intent.set("stage", Value::Str("dropped".into()))?,
    }
    Ok(())
}

/// Where edits go. Today the `intents` git repo; a database later.
pub trait IntentWriter: Send + Sync {
    /// Applies `edit` to the open intent `id`; the reply line.
    fn edit(&self, id: &str, edit: &Edit) -> Result<String, String>;
    /// A thin new intent (as `towercab add`); its ID.
    fn add(&self, new: NewIntent) -> Result<String, String>;
}

/// The git store (INT-1): pull, write, commit, push, as `auth` (the GitHub App, LOOP-19).
pub struct GitWriter {
    pub config: Config,
    /// A fresh auth per store open (tokens expire).
    pub auth: Option<Arc<dyn Fn() -> Option<AuthFn> + Send + Sync>>,
}

impl GitWriter {
    fn store(&self) -> Result<Store, String> {
        let auth = self.auth.as_ref().and_then(|f| f());
        Store::open_as(&self.config, auth).map_err(|e| e.to_string())
    }
}

impl IntentWriter for GitWriter {
    fn edit(&self, id: &str, edit: &Edit) -> Result<String, String> {
        let store = self.store()?;
        let done = store
            .update(id, edit.what(), |i| apply(i, edit))
            .map_err(|e| e.to_string())?;
        Ok(format!("{} {}", edit.what(), done.id))
    }

    fn add(&self, new: NewIntent) -> Result<String, String> {
        let store = self.store()?;
        let i = store.add(new).map_err(|e| e.to_string())?;
        Ok(i.id)
    }
}

/// A new intent from the UI: `source: me`, now.
pub fn new_intent(
    repo: &str,
    title: &str,
    u: Option<u8>,
    i: Option<u8>,
    a: Option<u8>,
    now: DateTime<FixedOffset>,
) -> NewIntent {
    NewIntent {
        repo: repo.into(),
        title: title.trim().into(),
        u,
        i,
        a,
        source: "me".into(),
        created: now,
    }
}
