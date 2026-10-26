//! What a wait asks of me, and the inputs to answer it (UI-20): every wait resolvable from
//! the UI, with what I decide on shown next to its buttons.

use std::fmt::Write as _;
use std::path::Path;

use super::{Ctx, buttons, esc, link, pages};
use crate::intents::Intent;
use crate::mission::Mission;

/// The paths the worker's guard refused in this mission's last run (`guard-blocks.jsonl`),
/// relative to its checkout, oldest first, once each.
pub fn blocked_paths(ctx: &Ctx, m: &Mission) -> Vec<String> {
    let file = ctx.home.runs(&m.label()).join("guard-blocks.jsonl");
    let Ok(text) = std::fs::read_to_string(file) else {
        return Vec::new();
    };
    let checkout = ctx.home.root.join(&m.checkout);
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let Some(path) = serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(str::to_string))
        else {
            continue;
        };
        let rel = Path::new(&path)
            .strip_prefix(&checkout)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or(path);
        if crate::commands::glob_ok(&rel) && !out.contains(&rel) {
            out.push(rel);
        }
    }
    out
}

/// What I decide on: the PR, the plan, the full reason, Towercab's notes, blocked paths.
pub fn context(ctx: &Ctx, m: Option<&Mission>, intent: Option<&Intent>) -> String {
    let waiting = m
        .and_then(|m| m.waiting.clone())
        .or_else(|| intent.and_then(|i| i.waiting().map(str::to_string)))
        .unwrap_or_default();
    let mut out = String::from("<div class=\"ctx\">");
    let pr = m.and_then(|m| m.pr_url.as_deref());
    if waiting.starts_with("approve spec") {
        match pr {
            Some(u) => {
                let _ = write!(out, "<p>Read the spec change: {}</p>", link(Some(u), "the spec PR"));
            }
            None => out.push_str(
                "<p>No spec change, so no PR: the spec already covers it. Towercab's notes are below.</p>",
            ),
        }
    } else if waiting.starts_with("approve plan") {
        let plan = intent.map(|i| ctx.config.intents.path.join(&i.dir).join("plan.md"));
        match plan.and_then(|p| std::fs::read_to_string(p).ok()) {
            Some(text) => {
                let _ = write!(
                    out,
                    "<details open><summary>plan.md</summary><div class=\"md\">{}</div></details>",
                    pages::md(&text)
                );
            }
            None => out
                .push_str("<p class=\"dim\">plan.md isn't in the local intents checkout yet.</p>"),
        }
    } else if let Some(u) = pr {
        let _ = write!(out, "<p>{}</p>", link(Some(u), "Open the PR"));
    }
    if let Some(why) = m.and_then(|m| m.why.as_deref()).filter(|w| !w.is_empty()) {
        let _ = write!(out, "<p class=\"why\">{}</p>", esc(why));
    }
    if let Some(m) = m {
        let blocked = blocked_paths(ctx, m);
        if !blocked.is_empty() {
            let _ = write!(
                out,
                "<p>The guard refused changes to: <code>{}</code>. Unlock them below to let the worker change them; the PR then waits for your merge.</p>",
                esc(&blocked.join(", "))
            );
        }
    }
    if let Some(note) = intent
        .and_then(|i| i.section("Towercab"))
        .filter(|n| !n.trim().is_empty())
    {
        let open = if waiting.starts_with("approve plan") {
            ""
        } else {
            " open"
        };
        let _ = write!(
            out,
            "<details{open}><summary>Towercab's notes</summary><div class=\"md\">{}</div></details>",
            pages::md(&note)
        );
    }
    out.push_str("</div>");
    out
}

/// The inputs for a wait on `id`: the stage's buttons, an answer box, an unlock field
/// (prefilled with the blocked paths), Drop.
pub fn controls(ctx: &Ctx, m: Option<&Mission>, id: &str) -> String {
    let key = esc(id);
    let mut out = String::from("<div class=\"btns\">");
    for b in buttons(m.map(|m| m.stage)) {
        let label = match b {
            "approve" => "Approve",
            "release" => "Release",
            _ => "Retry fresh",
        };
        let _ = write!(
            out,
            "<button data-cmd=\"{b}\" data-arg=\"{key}\">{label}</button>"
        );
    }
    let _ = write!(
        out,
        "<button data-cmd=\"drop\" data-arg=\"{key}\" class=\"danger\">Drop</button></div>\
         <div class=\"answer\"><textarea id=\"ans-{key}\" rows=\"2\" maxlength=\"2000\" placeholder=\"Answer or instruct the worker\"></textarea>\
         <button data-cmd=\"answer\" data-arg=\"{key}\" data-input=\"ans-{key}\">Answer and continue</button></div>"
    );
    let prefill = m
        .map(|m| blocked_paths(ctx, m).join(" "))
        .unwrap_or_default();
    let _ = write!(
        out,
        "<div class=\"unlock\"><input id=\"unl-{key}\" value=\"{}\" placeholder=\"paths or globs to unlock, e.g. .github/workflows/**\" size=\"40\">\
         <button data-cmd=\"unlock\" data-arg=\"{key}\" data-input=\"unl-{key}\">Unlock and continue</button></div>",
        esc(&prefill)
    );
    out
}
