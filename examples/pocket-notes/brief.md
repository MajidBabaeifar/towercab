# Pocket Notes — first product mission

Build a useful, local-only command-line notebook using Python 3.11+ standard
library only. No package installation, accounts, servers, or network requests.
The deliverable is a complete working application, not a plan or scaffold.

## User experience

I want to capture a thought quickly, attach tags, find it later, archive old
notes, and export my notes to readable Markdown. Default output should be easy
for a person to read. A --json option must provide the exact machine interface
below so the factory can test real behavior.

## Invocation and storage

- Entrypoint: `python3 notes.py` from the project root.
- Global options, before the subcommand: `--db PATH` and `--json`.
- Default database: `~/.local/share/pocket-notes/notes.sqlite3`. Create missing
  parent directories. Use SQLite with parameterized queries and transactions.
- Help (`--help`) must not create a database.
- Persist notes across separate process invocations. Use integer positive IDs
  stable across edits, plus UTC ISO-8601 created_at/updated_at strings.
- No ANSI codes in JSON output. Successful JSON commands emit one JSON value on
  stdout. Errors exit nonzero, explain the problem on stderr, and leave stdout
  empty in JSON mode. Do not silently replace or destroy an existing database.

## Commands and exact JSON contract

A note object has keys: `id` (integer), `title` (string), `body` (string), `tags`
(list of strings), `archived` (boolean), `created_at` and `updated_at` (strings).
Extra fields are allowed. Lists are arrays of note objects, ordered by id ASC.

1. `add TITLE --body TEXT [--tag TAG ...]`: return the created note. Title must
   contain non-whitespace text. Empty body is allowed; --body defaults to "".
   Tags are stripped, lowercased, deduplicated, and sorted; reject empty tags.
2. `list [--tag TAG] [--include-archived]`: return active notes by default. Tag
   matching is exact and case-insensitive; include-archived includes both states.
3. `show ID`: return a note, including archived notes. Missing ID is an error.
4. `search QUERY [--include-archived]`: case-insensitive literal substring search
   across title and body. SQL wildcard characters `%` and `_` are literal text,
   not special operators. Return matching notes once each, ordered by id ASC.
5. `edit ID [--title TITLE] [--body TEXT]`: return the updated note. Preserve tags,
   id, archived, and created_at. Reject whitespace-only titles and nonexistent
   IDs. Reject an edit with no supplied fields. Body may be set to empty.
6. `archive ID`: set archived=true, return the note. Repeating it is harmless.
7. `restore ID`: set archived=false, return the note. Repeating it is harmless.
8. `export --output PATH [--include-archived]`: export active notes (or all notes)
   as UTF-8 Markdown. Include titles, bodies, tags and note IDs, in id order.
   Create parent directories. Reject an output path that resolves to the database
   path before writing. JSON response: {"path": "...", "count": N}.

## Engineering requirements

- Include README.md with setup, examples for all commands, where data lives,
  backup instructions (when app is stopped), and instructions to run tests.
- Add meaningful unittest tests under tests/; no external dependencies. Cover
  storage, argument validation, literal search, archive/restore and export.
- Include .gitignore for Python caches and generated SQLite files.
- Structure code clearly; helper modules are welcome. Avoid unnecessary layers.
- Do not implement web UI, sync, encryption, AI features or permanent deletion.

## Definition of done

Run your unit tests and the factory's supplied external verification command.
The external verifier exercises the CLI in fresh temporary directories. Do not
modify it or weaken this interface. Report the actual checks run and limitations.
The reviewer should inspect usability and code quality as well as test results.
