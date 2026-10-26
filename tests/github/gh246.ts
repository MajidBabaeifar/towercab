// gh 2.46.0 (Ubuntu's, the minimum Towercab supports: LOOP-20): its `api`, `pr`, `run`, `issue` and
// `auth` subcommands and their flags, from `gh <cmd> --help`. ` --x=` takes a value, ` --x` doesn't.
// `refuse` answers anything else as gh 2.46 does, so a newer gh's flag fails a test.

import type { RunResult } from "../../src/tools.ts";

const R = " --help --repo= -R= ";
export const COMMANDS: Record<string, string> = {
  api: " --cache= --field= -F= --header= -H= --hostname= --include -i --input= --jq= -q= --method= -X= --paginate --preview= -p= --raw-field= -f= --silent --template= -t= --verbose --help ",
  "auth status": " --hostname= -h= --show-token -t --help ",
  "pr checks": ` --fail-fast --interval= -i= --required --watch --web -w${R}`,
  "pr close": ` --comment= -c= --delete-branch -d${R}`,
  "pr comment": ` --body= -b= --body-file= -F= --edit-last --editor -e --web -w${R}`,
  "pr create": ` --assignee= -a= --base= -B= --body= -b= --body-file= -F= --draft -d --dry-run --fill -f --fill-first --fill-verbose --head= -H= --label= -l= --milestone= -m= --no-maintainer-edit --project= -p= --recover= --reviewer= -r= --template= -T= --title= -t= --web -w${R}`,
  "pr diff": ` --color= --name-only --patch --web -w${R}`,
  "pr edit": ` --add-assignee= --add-label= --add-project= --add-reviewer= --base= -B= --body= -b= --body-file= -F= --milestone= -m= --remove-assignee= --remove-label= --remove-project= --remove-reviewer= --title= -t=${R}`,
  "pr list": ` --app= --assignee= -a= --author= -A= --base= -B= --draft -d --head= -H= --jq= -q= --json= --label= -l= --limit= -L= --search= -S= --state= -s= --template= -t= --web -w${R}`,
  "pr merge": ` --admin --author-email= -A= --auto --body= -b= --body-file= -F= --delete-branch -d --disable-auto --match-head-commit= --merge -m --rebase -r --squash -s --subject= -t=${R}`,
  "pr ready": ` --undo${R}`,
  "pr reopen": ` --comment= -c=${R}`,
  "pr review": ` --approve -a --body= -b= --body-file= -F= --comment -c --request-changes -r${R}`,
  "pr view": ` --comments -c --jq= -q= --json= --template= -t= --web -w${R}`,
  "run list": ` --branch= -b= --commit= -c= --created= --event= -e= --jq= -q= --json= --limit= -L= --status= -s= --template= -t= --user= -u= --workflow= -w=${R}`,
  "run rerun": ` --debug -d --failed --job= -j=${R}`,
  "run view": ` --attempt= -a= --exit-status --job= -j= --jq= -q= --json= --log --log-failed --template= -t= --verbose -v --web -w${R}`,
  "issue comment": ` --body= -b= --body-file= -F= --edit-last --editor -e --web -w${R}`,
  "issue view": ` --comments -c --jq= -q= --json= --template= -t= --web -w${R}`,
};

/** `pr view --json` fields gh 2.46 knows. */
export const PR_JSON = new Set(
  "additions assignees author autoMergeRequest baseRefName body changedFiles closed closedAt comments commits createdAt deletions files headRefName headRefOid headRepository headRepositoryOwner id isCrossRepository isDraft labels latestReviews maintainerCanModify mergeCommit mergeStateStatus mergeable mergedAt mergedBy milestone number potentialMergeCommit projectCards projectItems reactionGroups reviewDecision reviewRequests reviews state statusCheckRollup title updatedAt url".split(
    " ",
  ),
);

/** `run view --json` fields gh 2.46 knows (no `attempt`). */
export const RUN_JSON = new Set(
  "conclusion createdAt databaseId displayTitle event headBranch headSha jobs name number startedAt status updatedAt url workflowDatabaseId workflowName".split(
    " ",
  ),
);

const fail = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr, timedOut: false });

/** gh 2.46's error for a call it doesn't have, or null when it would run. */
export function refuse(args: string[]): RunResult | null {
  const top = args[0] ?? "";
  if (!["api", "pr", "run", "issue", "auth"].includes(top)) return null;
  const skip = top === "api" ? 1 : 2;
  const cmd = top === "api" ? "api" : `${top} ${args[1] ?? ""}`;
  const flags = COMMANDS[cmd];
  if (flags === undefined) {
    return fail(`unknown command "${args[1]}" for "gh ${top}"\n\nUsage:  gh ${top} <command> [flags]\n`);
  }
  for (let i = skip; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break;
    if (!/^-./.test(a)) continue;
    const name = a.split("=")[0]!;
    if (flags.includes(` ${name}= `)) {
      const value = a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[++i];
      const known = cmd === "pr view" ? PR_JSON : cmd === "run view" ? RUN_JSON : null;
      if (name === "--json" && known) {
        const bad = (value ?? "").split(",").find((f) => !known.has(f));
        if (bad) return fail(`Unknown JSON field: "${bad}"\nAvailable fields:\n  ...\n`);
      }
    } else if (!flags.includes(` ${name} `)) {
      return fail(`unknown flag: ${name}\n\nUsage:  gh ${cmd} [flags]\n\nFlags:\n  ...\n`);
    }
  }
  return null;
}
