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
