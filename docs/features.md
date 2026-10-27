# How Towercab works

Towercab turns short written requests into reviewed, tested pull requests. It runs on your own Linux
machine, uses Claude Code to do the writing and coding, and uses plain code to check the work and
decide what happens next. You stay in charge through ordinary GitHub actions: merging a pull request
approves it, closing it drops it, and a comment sends it back with your notes.

Towercab follows the structure of Anthropic's AI-Native SDLC Playbook: every change starts from a
stated intent, the requirements are written down as specs before any code, a plan is agreed before
the build, the code is written test-first, and an independent review and hard checks stand between
the change and the main branch. Towercab is not affiliated with or endorsed by Anthropic.

This page describes the whole workflow and the features around it. The [specs](../specs/README.md)
hold the exact rules; each section below links to the one it summarises.

## The idea in one minute

You write an *intent*: a small Markdown file that says what the problem is, what outcome you want,
how urgent it is and how important it is. Towercab keeps a queue of intents and always works on the
most important one it can run. For each intent it opens three pull requests, one after the other:

1. **Spec PR** in the target repo: the requirements the change adds or alters, in plain sentences.
2. **Plan PR** in your intents repo: the approach, the steps, the risks, and a checklist of the
   access the work will need.
3. **Code PR** in the target repo: tests first, then the code, checked in a sandbox, proven, run
   through CI and reviewed by a separate Claude session.

How many of these you merge yourself depends on the autonomy level you give the intent. The checks
are the same at every level.

## The workflow, step by step

### 1. You write an intent

An intent is a folder in a private `intents` repo on GitHub, holding one `intent.md` file. Because it
is just a file in a repo, you can write it from a laptop, a phone, or a Claude conversation. The file
has a short header with the target repo, an urgency `u` and importance `i` from 1 to 5, and an
optional autonomy `a`. The body has a title and a few sections: Problem, Proposed outcome, Affected
users and systems, Constraints and Open questions. Only the repo and the title are required.
([intents.md](../specs/intents.md))

There are three ways to add one:

- **By hand**, by committing the file to `main` of the intents repo.
- **From the command line**: `towercab add "web: Log in with a magic link" u3 i4` writes a minimal
  intent.
- **With the `/intent` skill in Claude Code**: Claude asks what an analyst would (scope, users,
  constraints, what success looks like), writes the file, proposes the scores and commits it.

GitHub issues can also become intents. Every 5 minutes Towercab looks at the open issues in your
repos. An issue you wrote, or one anyone wrote that you labelled `towercab`, is read by a short
Claude run with no tools, which proposes the title, the problem, the outcomes and the two scores with
a sentence of reasoning each. Towercab adds the intent, comments on the issue with its place in the
queue, and the code PR later closes the issue with `Fixes #<n>`. Issues from other people without
that label are never read at all, so a stranger's text never reaches a Claude run. Closing the issue
before work starts drops the intent.

### 2. Towercab picks the most important intent

The order is computed by code, never by a model: priority is twice the importance plus the urgency
(3 to 15), and between equal priorities the older intent goes first. Intents below a cutoff (7 by
default) are *parked*: they stay visible but don't start until you raise a score or start them by
name. An intent can list other intents it must wait `after`. ([priority.md](../specs/priority.md))

By default Towercab runs one unmerged intent per repo, so changes to the same code don't collide,
while other repos keep moving. A pull request waiting on you never blocks work elsewhere.
([loop.md](../specs/loop.md), LOOP-4 and LOOP-5)

### 3. The spec PR: what should change

Claude reads the intent and the target repo's `specs/` folder and edits only the spec files: it adds
or changes the requirements the intent touches, each as one plain sentence plus the technical
detail and the tests that will verify it. It also lists any concerns and open questions. Towercab
opens this as the spec PR. If the intent changes no behaviour, there is no spec PR and the work moves
straight on to the plan.

Comment on the spec PR and Claude revises it in the same PR. At low autonomy, or whenever Claude
raised a concern, you merge it yourself; otherwise Towercab merges it once its checks pass.
([pipeline.md](../specs/pipeline.md), PIP-25 and PIP-50)

### 4. The plan PR: how it will be done

Claude then reads the code, without changing anything, and writes `plan.md`: the approach and why,
the steps in order (failing tests first), the risks, and how to check the result. Below that,
Towercab adds an **Access** checklist: each network domain and protected file the work expects to
need, with the reason. Every box is ticked by default. Untick what you refuse, then merge. What is
ticked in the merged plan is exactly what the build gets. (PIP-28, PIP-46, PIP-47)

The plan lives in your intents repo next to the intent, so the reasoning behind every change stays in
one place.

### 5. The build: tests first, then code

The same Claude session that wrote the spec and the plan now builds it, so it keeps all of its
context. It writes a failing test for every requirement and every proposed outcome, then the code,
then the docs, and runs the repo's checks itself until they pass. Towercab commits the result under
its own bot identity. (PIP-1, PIP-13)

If the build needs something only you can decide, Claude stops and asks **one question**: what it was
doing, the question, the options with what each one means, and its recommendation. You can answer
in one reply. If it needs access the plan didn't grant, it says what and why; Towercab grants it,
keeps going, and lists it in the code PR under "Access beyond the plan". If Claude decides the
change is riskier than the intent says, it can lower the intent's autonomy level, but never raise
it. (PIP-41, AUT-7, AUT-15)

### 6. Checks in a sandbox

After every build or repair, code (not Claude) runs the repo's own setup and check commands inside a
sandbox with no network. The commands come from the target repo's `CLAUDE.md`. When the repo has CI,
Towercab runs a faster subset locally (for example only the changed test files) and leaves the full
suite to CI. A red check goes back to Claude with the log tail for a repair, at most twice, before
Towercab asks you. (PIP-23, REPO-2, REPO-9)

### 7. The red→green proof

Passing tests are not enough. Towercab takes the base branch *without* the change, lays the new tests
on top and runs them. They must fail there. If they pass without the change, they prove nothing, and
Claude is asked for a test that does. A change whose tests still don't prove it is never merged
automatically; it goes to you with that reason. (PIP-30)

During repair rounds Claude also can't edit the tests it already pushed, so it can't turn a red check
green by weakening the test. (PIP-31)

### 8. The code PR and CI

Towercab pushes the branch and opens the code PR. The description opens with what the change does,
why, and what to check before merging, in plain words; then the technical changes; then a Checks
section (local checks, proof, CI, review), links to the spec and plan PRs, and a footer with the cost
and agent time. (PIP-2, PIP-48)

It then watches CI on the exact commit it pushed. A first red or cancelled GitHub Actions run is
rerun once, since that often is a flake. A real failure goes back to Claude with the failing jobs'
logs, at most twice. Towercab never force-pushes: if you push commits to the PR yourself, they are
merged in and kept. (PIP-3, PIP-18)

### 9. An independent review

A separate, read-only Claude session reviews every code PR, by default on a model one step above
the one that wrote it (the strongest model reviews its own tier). It sees the intent, the requirements, the plan, the diff, the CI result
and the target repo's `REVIEW.md`. For repos with a UI, it also sees fresh screenshots of the pages.
(PIP-4, PIP-49)

The review returns a structured verdict: whether each proposed outcome is met, whether any test was
weakened, whether the plan was followed, its findings marked important or nit, whether the change is
easy or hard to undo, and whether it touches one of the repo's red lines. Code turns that into
approved or not; a single important finding, a weakened test or an unmet outcome means not approved.
The summary is posted on the PR. (PIP-5)

### 10. The gate and the merge

Code, not a model, decides whether Towercab may merge. It merges only when CI is green, the review
approved, the proof holds, nobody else pushed to the PR, the build stayed within the plan, and the
autonomy level allows it. Anything else sends the PR to you with the reason. When it does merge, it
squash-merges the exact commit that passed the gate; if the branch moved in the meantime, it goes
back to CI. (PIP-7, PIP-22)

### 11. Done

When the code PR merges, the intent's folder moves to `done/`, and its file records the total cost,
agent time and number of attempts. `DONE.md` in the intents repo lists every finished intent with
those numbers. (INT-5, MET-10)

## Steering from GitHub

You never need a separate app to direct the work. What you do on any of the intent's pull requests
moves it: (PIP-43, PIP-44)

| You do this on GitHub | Towercab does this |
|---|---|
| Merge the spec, plan or code PR | Takes it as your approval and moves on |
| Approve a PR that waits on you | Merges it for you |
| Comment, or request changes | Sends your notes back to Claude, which revises the same PR |
| Reply to a question | Continues with your answer |
| Close a PR | Stops and drops the intent (it moves to `done/`, never deleted) |
| Comment `/retry` | Starts a fresh attempt and closes the old attempt's open PRs |

Only your own comments and reviews count. Comments from anyone else, and from Towercab's own bot, are
ignored. Each comment Towercab posts says which step wrote it (for example **Review** · round 2) and
is edited in place instead of piling up.

## Autonomy levels

Each intent gets an autonomy level from 1 to 5. It decides who merges and how much access the work
gets without asking; it never removes a check. ([autonomy.md](../specs/autonomy.md))

| Level | Spec PR | Plan PR | Code PR | Access during the build |
|---|---|---|---|---|
| a1–a2 | You merge | You merge | You merge | Default domains plus the plan's; anything more is granted and listed in the PR |
| a3 | Towercab merges* | You merge | You merge | Same as a1–a2 |
| a4 | Towercab merges* | You merge | Towercab merges when every check passes | Only what the plan grants; anything more sends the code PR to you |
| a5 | Towercab merges* | Towercab merges | Towercab merges when every check passes | Open network |

\* Unless the spec raised a concern, in which case you merge it.

A few rules keep this safe:

- **The checks never shrink.** Every intent goes through the local checks, the proof, CI, the review
  and the gate at every level.
- **Repos can cap it.** A repo's `TOWERCAB.md` can set `max_autonomy`, and the lowest level wins.
- **a5 is only for intents you wrote.** An intent from an issue counts as a4 at most, so a planted
  instruction in someone's issue can't open the network, change CI and merge itself.
- **No level set** means Towercab merges only when the repo allows a4 and the review judges the change
  low-risk.
- **Access beyond the plan at a4** sends the code PR to you instead of merging.

## Safety

Towercab assumes the model can make mistakes and builds its fences in code. (PIP-24, PIP-29, REPO-8)

- **Sandbox for everything.** Every Claude run and every check runs in a `bwrap` sandbox. Claude Code
  runs headless with its own sandbox switched on and unsandboxed commands refused.
- **No secrets in reach.** SSH keys, cloud credentials, the GitHub CLI login, password stores,
  Towercab's own config and the other missions' folders are hidden from every run. Claude never gets
  a GitHub token, and `git push`, `gh`, `ssh` and `sudo` are refused outright.
- **Network by allowlist.** The build reaches only the domains it was granted: a default list of
  package registries and docs, plus what you ticked in the plan.
- **Protected files.** CI workflows, `CLAUDE.md`, `REVIEW.md`, `TOWERCAB.md`, `.claude/` and any
  paths the repo lists decide how a change is judged. At a4 a hook stops Claude from writing them
  unless the plan granted them; at a1–a3, where you read every diff, it may, and the PR lists them.
  The hook fails closed: any error blocks the write. Publishing refuses an ungranted change too.
- **Rules from the base branch.** The checks, review rules and settings are read from the base branch,
  so a pull request can't loosen the rules it is judged by.
- **One file per agent, with a ceiling.** Each kind of Claude run is described by one file in
  `agents/`: its tools, permissions, time and cost limits. A test fails if any agent gets more than it
  had before, and the files can't switch off the sandbox or the guard.
- **A separate identity.** Towercab acts on GitHub as its own GitHub App, so its commits and comments
  are clearly the bot's. Actions you take from Towercab's web page run under your own GitHub login.

## Setting up a target repo

Towercab reads three optional files from each repo it works in. ([repo.md](../specs/repo.md))

- **`CLAUDE.md`**, section "Verifying your work": the `setup` commands (such as `npm ci`), the full
  `checks`, an optional `fast` subset with `{tests}` for the changed test files, and an optional
  `screenshots` command for the review. A repo without a checks block waits for you to add one.
- **`REVIEW.md`**: what the reviewer should look for, what counts as important here, how many nits
  to report, what not to report, and the red lines whose change makes a PR high-risk.
- **`TOWERCAB.md`**: the repo's autonomy cap, extra protected paths, and where its tests live.

## Running unattended

Towercab is one long-running service (a systemd user service, started with `towercab up`). It is
built to keep working through the night without losing anything. ([loop.md](../specs/loop.md))

- **Usage limits.** When Claude hits a usage limit, Towercab reads the reset time from the message,
  waits, and continues the same step where it stopped. A limit is never counted as a failure.
- **Crashes and restarts.** Every step is recorded in a local SQLite database before it acts, so after
  a crash or reboot each intent continues from its last step, and a cut-off Claude run resumes its own
  session. Nothing is pushed, opened or merged twice.
- **Network and login failures.** These are retried with backoff. If GitHub or Claude stay
  unreachable for 15 minutes, Towercab pauses new work and sends one message naming the problem.
- **Stays awake.** The machine is kept from sleeping while work is running, and polls catch up after
  a resume.
- **Budgets.** Each Claude run has a cost limit ($10 by default), and an optional daily budget pauses
  new work until midnight once it is spent.
- **Shared build cache.** Each repo has one build cache that every attempt reuses, so a new attempt
  doesn't compile from scratch.
- **Self-update.** When Towercab's own `main` branch moves, the running service pulls it, checks the
  new code, and restarts within a minute once nothing is running. If the check fails, it rolls back and tells you.

## Knowing what's happening

**A local web page** (`towercab ui`) answers four questions, in this order: what needs me, what is
stuck, what is moving, and what it costs. Each thing waiting on you is one card with the ask, a short
brief and only the buttons that answer it (merge, reply, start over, drop). Moving intents show their
progress through spec, plan and code, the current step in plain words, and the time and cost so far.
Problems appear only when there are some. Each intent has its own page with its three PRs, a timeline,
the cost per attempt and links to every log and prompt. There are also a queue page per repo and a
filterable activity page. The page is served only to your own browser on localhost.
([ui.md](../specs/ui.md))

**Telegram messages** arrive only when you have to do something, each saying what, on which intent,
with a link. Merges, finished intents and limit waits don't send messages.

**The command line** has `towercab status` (what is running, waiting and queued) and `towercab next`
(what will start next, and why each other intent is waiting), plus `answer`, `approve`, `retry`,
`drop`, `pause`, `resume`, `doctor` and `update`.

**The intents repo itself** stays readable: each intent's file shows its stage, what it is waiting
for and its PR links, and the generated `TODO.md` gives a one-page view of what waits on you, what is
in flight, what is next and what is parked.

## Cost and time

Every Claude run adds its cost and duration to its intent. The web page shows spend today and over the
last 7 days, the cost so far of each running intent, and the time each step took, with time spent
waiting on you shown apart from Towercab's own time. Finished intents record their total cost, agent
time and attempts in the intent file and `DONE.md`. An intent that costs more than three times the median
of the last 20 is flagged as a problem. ([metrics.md](../specs/metrics.md))

## The agents

Towercab starts six kinds of Claude run, each configured by one file in [`agents/`](../agents):

| Agent | What it does | What it may touch |
|---|---|---|
| design | Writes the spec changes and the spec PR's text | Reads the repo; edits only `specs/` |
| plan | Writes the plan | Reads only |
| worker | Writes the tests, the code and the code PR's text | Edits the checkout in the sandbox, granted domains only |
| repair | Fixes red checks, conflicts, review findings or follows your answer | The worker's permissions, no more |
| review | Reviews the code PR in a fresh session | Reads only |
| score | Turns a GitHub issue into a scored intent | Nothing: no tools |

Every run also gets the same [writing guide](../prompts/writing.md), so pull requests, questions and
review summaries read like a colleague wrote them: the outcome first, plain sentences, no internal
jargon.

## Built with itself

Towercab is developed with Towercab. Its own repo has a `TOWERCAB.md`, its state machine is a
protected file, and several of its recent features were specified, planned, built, reviewed and merged
by `towercab[bot]` through the same three pull requests described here, such as turning GitHub issues
into intents and moving each agent's settings into its own file. After each merge, the running
service updates itself.

## Limits today

Towercab is early and built for one person: it runs on one Linux machine with systemd, for one
owner, and needs `bwrap`, `gh`, the Claude Code CLI and a GitHub App of your own. See the
[README](../README.md) for requirements and the quickstart.
