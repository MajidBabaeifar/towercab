// Adding a repo from the page (UI-130, UI-131): owner/name in, the loop checks, clones and stores it.

import { useState } from "preact/hooks";
import type { ActionReply } from "../../src/ui/view.ts";
import { addRepo } from "./api.ts";
import { Alert, Check } from "./icons.tsx";

// Typed text and the last reply survive a refetch or a remount (UI-67).
const drafts = new Map<string, string>();
const replies = new Map<string, ActionReply>();

/** One field for `owner/name` and a button; with `name`, the repo is added under that short name. */
export function AddRepoForm({ name, initial = "" }: { name?: string; initial?: string }) {
  const key = name ?? "";
  const [text, setTextState] = useState(drafts.get(key) ?? initial);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<ActionReply | null>(replies.get(key) ?? null);
  const setText = (t: string) => {
    drafts.set(key, t);
    setTextState(t);
  };
  const id = `add-repo-${key || "new"}`;
  const submit = async () => {
    setBusy(true);
    const r = await addRepo(text.trim(), name);
    setBusy(false);
    replies.set(key, r);
    setReply(r);
    if (r.ok) setText("");
  };
  return (
    <form
      class="add-repo"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim() && !busy) void submit();
      }}
    >
      <label for={id}>{name ? `GitHub repo for “${name}”` : "GitHub repo"}</label>
      <div class="add-repo-row">
        <input
          id={id}
          name="github"
          type="text"
          autoComplete="off"
          spellcheck={false}
          placeholder="owner/name"
          value={text}
          onInput={(e) => setText((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn primary" disabled={!text.trim() || busy}>
          {busy ? "Adding…" : name ? "Add this repo" : "Add repo"}
        </button>
      </div>
      <p class="hint">
        Towercab checks that its GitHub App can reach the repo, takes its default branch and clones it.
      </p>
      {reply ? (
        <p class={`result ${reply.ok ? "ok" : "err"}`} role="status">
          {reply.ok ? <Check size={16} /> : <Alert size={16} />}
          <span>{reply.message}</span>
        </p>
      ) : null}
    </form>
  );
}
