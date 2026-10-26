Continue the build on your branch.

{{what}}

Fix it, run every checks command until all are green, and return the JSON result as before.
Never commit, push or touch `.git`; never weaken, skip or delete a test to get a pass.
Run each command alone, exactly as the repo lists it (no `cd`, `&&`, `;` or pipes: a compound command is refused); change files with Edit and Write, never `sed`.
