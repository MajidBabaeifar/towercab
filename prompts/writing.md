# Writing for people

Some of what you produce is read by a person: a spec change, a plan, a pull request description, a
question, a review summary. This guide is how to write those. It does not apply to code, commit
subjects, or the JSON fields that only code reads.

## Who reads it

The reader is the owner of the repo, or a reviewer they trust. They know the project well, but they
were not here: they did not see the files you read, the commands you ran, or the dead ends you hit.
They read on GitHub or a phone, often between other things, and they decide from what you write
whether to merge, answer, or stop the work. Write so that someone with two minutes can make that
decision, and someone with ten can check it.

## Lead with the outcome

Put the answer first: what changes for the user of the software, what you need from the reader, or
what you found. Reasons, details and history come after. If the reader stops after the first two
sentences, they should still know what this is and whether it needs them.
- Good: "Login now survives a server restart: sessions are stored in the database instead of memory."
- Bad: "This PR refactors the session module and introduces a new storage layer."

## Plain sentences

- Write full sentences, in the active voice, in the present tense. "The loop retries the push" beats
  "push retry logic has been added".
- Use plain words before identifiers. Say what a thing does, then name it in code font if the reader
  needs the name: "the setting that limits parallel work (`[agent].parallel`)".
- One idea per paragraph, and keep paragraphs short: two to four sentences.
- Be specific. Numbers, file names, commands and limits beat adjectives. "Fails after 3 retries over
  7 minutes" beats "fails after several retries".
- Say what you did not do, or did not check, when the reader might assume you did.
- Cut filler: no "this PR aims to", "it is worth noting", "in order to", "basically", no apologies,
  no praise of your own work.

## Headings and lists

Use a heading only when the text has parts a reader will look for on their own, such as the fixed
sections of a pull request. Use a list for items that are truly parallel: steps in order, files,
options. Do not turn an explanation into bullets; reasons connect, and sentences show how. Never nest
lists more than one level.

## No internal jargon

Text for a person never contains Towercab's own vocabulary: step or stage names (design, verify,
proof, gate), schema keys and field names (`lower_a`, `plan_changed`, `spec_ids`), status values, or
the names of these instructions. Describe what happened in the reader's terms: "the checks failed
twice", not "verify went red at repairs = 2". Identifiers from the repo itself (functions, files,
spec IDs such as `PIP-4`) are fine when they help the reader find something.

## Asking a question

Ask only what you cannot decide yourself from the repo, the intent and its specs. Ask one question,
and make it answerable in one reply:
1. Context: what you were doing, and what made you stop, in two or three sentences.
2. The question, in one sentence, ending with a question mark.
3. The options, each with what follows from it: the work it means, the risk, what it rules out.
4. Your recommendation and why, in one or two sentences.

The reader should be able to answer "go with your recommendation" without opening a single file.

## A pull request description

Use these sections, in this order:
- `## What this does`: the change in behaviour, for someone who will not read the diff. Two to five
  sentences.
- `## Why`: the problem it solves or the intent it serves; link the intent or issue.
- `## What to check before merging`: the few things a reviewer should actually look at or try, such
  as a risky migration, a changed default, or a screen to click through. If nothing needs a human
  eye, say so in one line.
- `## Changes`: the technical detail, grouped by area, a short list. Name the files or modules that
  matter, not every file touched.

Do not repeat test output or check results; Towercab adds those itself. Do not paste the diff.

A spec pull request follows the same idea: what changes in behaviour, why, and which requirements
are new, changed or removed, for a reader who was not in the discussion.

## A spec requirement

Follow the repo's `specs/README.md`. Each requirement is a `### <ID> · <name>` heading, then one
plain sentence that a person who never saw the code can follow, then the technical detail as short
bullets, then how it is verified:

```markdown
### PRI-3 · Priority score

An intent's priority is twice its importance plus its urgency.
- `priority(u, i) = 2 * i + u`, 3–15; missing scores count as 3.
- Verified by: `priority: score is 2i + u`
```

The sentence says what the system does, not how it is built. The detail is precise: name
interfaces, fields, commands, limits and error texts. `Verified by` names the exact test titles that
check it. Never reuse an ID; a dropped requirement keeps its heading and says `Removed: <why>`.

## Before you hand it over

Read it once as the owner would, on a phone, with no context. Cut every sentence that does not help
them decide or check. If something is uncertain, say so plainly instead of hedging every line.
