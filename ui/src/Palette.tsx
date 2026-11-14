// UI-265: Cmd-K (Ctrl-K elsewhere) finds intents, repos and pull requests and runs commands. It searches
// data the page already reads and makes no request per keystroke; a command is an action the page already
// has, or a navigation.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { InboxPage, Overview, ReposPage, TopBar } from "../../src/ui/view.ts";
import { act, useLive } from "./api.ts";
import { openNewIntent, PALETTE_EVENT } from "./keys.ts";
import { Modal } from "./Modal.tsx";
import { navigate } from "./router.tsx";

interface Entry {
  key: string;
  group: "Intents" | "Repos" | "PRs" | "Commands";
  label: string;
  hint?: string;
  /** A command that changes something asks again in the box before it runs. */
  confirm?: string;
  run(): Promise<string | null> | null;
}

const PAGES: [string, string][] = [
  ["inbox", "/"],
  ["overview", "/overview"],
  ["board", "/board"],
  ["repos", "/repos"],
  ["activity", "/activity"],
];

function PaletteBox({ top, close }: { top: TopBar | null; close(): void }) {
  const inbox = useLive<InboxPage>("/api/inbox").data;
  const state = useLive<Overview>("/api/state").data;
  const repos = useLive<ReposPage>("/api/repos").data;
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const [asking, setAsking] = useState<Entry | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  const all = useMemo(() => {
    const out: Entry[] = [];
    const go = (href: string) => () => {
      navigate(href);
      return null;
    };
    const seen = new Set<string>();
    const intent = (id: string, title: string, repo: string) => {
      if (seen.has(id) || id.startsWith("proposed-") || id.startsWith("cap-")) return;
      seen.add(id);
      out.push({
        key: `i:${id}`,
        group: "Intents",
        label: title,
        hint: `${repo} · ${id}`,
        run: go(`/i/${id}`),
      });
    };
    for (const i of inbox?.items ?? []) {
      intent(i.key, i.title, i.repo);
      if (i.pr !== null)
        out.push({
          key: `p:${i.key}`,
          group: "PRs",
          label: `#${i.pr} ${i.title}`,
          hint: i.repo,
          run: go(i.kind === "card" ? `/i/${i.key}` : `/inbox/${i.key}`),
        });
    }
    for (const r of [...(state?.working ?? []), ...(state?.queued ?? [])]) intent(r.intent, r.title, r.repo);
    for (const u of state?.upNext ?? []) intent(u.intent, u.title, u.repo);
    const names = (repos?.chips ?? []).map((c) => c.repo).filter(Boolean);
    for (const n of names) {
      out.push({ key: `r:${n}`, group: "Repos", label: n, run: go(`/repos?repo=${encodeURIComponent(n)}`) });
      out.push({
        key: `c:repo:${n}`,
        group: "Commands",
        label: `go to repo ${n}`,
        run: go(`/repos?repo=${encodeURIComponent(n)}`),
      });
    }
    for (const [name, href] of PAGES)
      out.push({ key: `c:${name}`, group: "Commands", label: `go to ${name}`, run: go(href) });
    out.push({ key: "c:settings", group: "Commands", label: "open settings", run: go("/repos") });
    if (top && !top.readOnly && top.role !== "viewer") {
      out.push({
        key: "c:new-intent",
        group: "Commands",
        label: "new intent",
        run: () => {
          openNewIntent();
          return null;
        },
      });
    }
    if (top && !top.readOnly) {
      const paused = top.paused;
      out.push({
        key: paused ? "c:resume" : "c:pause",
        group: "Commands",
        label: paused ? "resume" : "pause",
        confirm: paused ? "Let Towercab start new work again?" : "Stop Towercab from starting new work?",
        run: async () => {
          const r = await act(paused ? "resume" : "pause");
          return r.ok ? null : r.message;
        },
      });
    }
    return out;
  }, [inbox, state, repos, top]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase().replace(/^#/, "");
    if (!t) return all.filter((e) => e.group === "Commands" && !e.key.startsWith("c:repo:")).slice(0, 8);
    const words = t.split(/\s+/);
    return all
      .filter((e) => {
        const hay = `${e.label} ${e.hint ?? ""}`.toLowerCase();
        if (e.group === "PRs") return /^\d+$/.test(t) && e.label.slice(1).split(" ")[0]!.startsWith(t);
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 30);
  }, [all, q]);

  useEffect(() => setAt(0), [q]);
  useEffect(() => {
    list.current?.querySelector("[aria-selected=true]")?.scrollIntoView?.({ block: "nearest" });
  }, [at]);

  const run = async (e: Entry) => {
    setAsking(null);
    const out = await e.run();
    if (out) setMsg(out);
    else close();
  };
  const pick = (e: Entry | undefined) => {
    if (!e) return;
    if (e.confirm) setAsking(e);
    else void run(e);
  };

  if (asking) {
    return (
      <Modal label="Confirm" onClose={() => setAsking(null)} focus=".confirm-no">
        <h2 class="modal-title">{asking.label[0]!.toUpperCase() + asking.label.slice(1)}?</h2>
        <p>{asking.confirm}</p>
        {msg ? <p class="result err">{msg}</p> : null}
        <div class="modal-actions">
          <button type="button" class="btn confirm-no" onClick={() => setAsking(null)}>
            Cancel
          </button>
          <button type="button" class="btn primary" onClick={() => void run(asking)}>
            {asking.label[0]!.toUpperCase() + asking.label.slice(1)}
          </button>
        </div>
      </Modal>
    );
  }
  const groups = ["Intents", "Repos", "PRs", "Commands"] as const;
  return (
    <Modal label="Search and commands" onClose={close} focus="input" class="palette">
      <label class="sr-only" for="palette-q">
        Search intents, repos and pull requests, or type a command
      </label>
      <input
        id="palette-q"
        class="palette-input"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={shown[at] ? `palette-${shown[at]!.key}` : undefined}
        autocomplete="off"
        placeholder="Search, or type a command: pause, go to repo …"
        value={q}
        onInput={(e) => {
          setQ((e.currentTarget as HTMLInputElement).value);
          setMsg(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setAt(Math.min(shown.length - 1, at + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAt(Math.max(0, at - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            pick(shown[at]);
          }
        }}
      />
      <p class="sr-only" role="status" aria-live="polite">
        {shown.length ? `${shown.length} result${shown.length === 1 ? "" : "s"}` : "No results"}
      </p>
      {msg ? <p class="result err">{msg}</p> : null}
      <div class="palette-list" id="palette-list" role="listbox" ref={list}>
        {groups.map((g) => {
          const rows = shown.filter((e) => e.group === g);
          return rows.length ? (
            <div key={g}>
              <p class="palette-group">{g}</p>
              <div>
                {rows.map((e) => (
                  // biome-ignore lint/a11y/useKeyWithClickEvents: the input's keys drive the list
                  <div
                    key={e.key}
                    id={`palette-${e.key}`}
                    tabIndex={-1}
                    role="option"
                    aria-selected={shown[at] === e}
                    class="palette-row"
                    onMouseEnter={() => setAt(shown.indexOf(e))}
                    onClick={() => pick(e)}
                  >
                    <span>{e.label}</span>
                    {e.hint ? <span class="meta">{e.hint}</span> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null;
        })}
      </div>
      {!shown.length ? <p class="meta palette-none">Nothing matches.</p> : null}
    </Modal>
  );
}

export function Palette({ top }: { top: TopBar | null }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    addEventListener(PALETTE_EVENT, show);
    addEventListener("keydown", key);
    return () => {
      removeEventListener(PALETTE_EVENT, show);
      removeEventListener("keydown", key);
    };
  }, []);
  return open ? <PaletteBox top={top} close={() => setOpen(false)} /> : null;
}
