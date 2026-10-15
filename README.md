# baton

Personal software factory. One central task list (Gradient); agents pick tasks by
priority, validate, push, and report how they did.

**Status:** design. Nothing runs yet. Decisions live in [specs/](specs/README.md).

## Target workflow

- Tasks live in the Gradient list, each scored urgency, importance, autonomy (1–5).
- baton picks the top runnable task, claims it, runs an agent in its own worktree.
- Validation always runs in full; autonomy decides where the task waits for me.
- `baton inbox` · `baton watch <id>` · `baton review` · `baton report`
