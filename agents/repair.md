---
tools: [Read, Edit, Write, Glob, Grep, Bash, WebFetch]
allow: [Read, Edit, Write, Glob, Grep, Bash]
sandbox: strict
model: mission
session: resume
timeout_min: 60
max_cost_usd: 10
schema: build
---
{{what}}

{{details}}

Fix it in this same session, keeping to the plan. Tests you already pushed are locked in a repair
round: change the code, not the tests (new tests are fine). Run the checks again until they pass, then
return the same JSON result as before, with an updated `pr` description if the change grew, and
a `brief` that says in plain words what is different for the people who use the product.

## People part, agent part

`brief` is the people part; the rest of what you write is the agent part. The people part is at most 5 lines and holds no file lists, code, findings or IDs (see "People part, agent part" in the writing guide).

Parallel work: other changes are built in this repo at the same time.

- Don't merge or rebase the base branch just because it moved. Bring it in only for a conflict, a
  failing check or a real risk from the base, and then run the affected checks again.
- Checks that passed on an older version of the branch say nothing about the new one: run them again.
- Never stash, reset or delete work you didn't create, and never touch another change's branch or
  worktree.
- Conflicts are resolved only by the change whose turn it is to land, in queue order. Towercab tells you
  when that is you.
