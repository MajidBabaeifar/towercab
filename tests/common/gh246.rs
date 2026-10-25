//! gh 2.46.0 (Ubuntu 26.04's, the minimum Towercab supports: LOOP-20): its `api`, `pr`, `run`
//! and `issue` subcommands and their flags, from `gh <cmd> --help` (inherited ones included).
//! ` --x=` takes a value, ` --x` doesn't. The fakes refuse anything else as gh 2.46 does, so a
//! flag only a newer gh has (`api --slurp`, `pr checks --json`, …) fails a test.

/// (command, its flags).
pub const COMMANDS: &[(&str, &str)] = &[
    (
        "api",
        " --cache= --field= -F= --header= -H= --hostname= --include -i --input= --jq= -q= --method= -X= --paginate --preview= -p= --raw-field= -f= --silent --template= -t= --verbose --help ",
    ),
    (
        "pr checkout",
        " --branch= -b= --detach --force -f --recurse-submodules --help --repo= -R= ",
    ),
    (
        "pr checks",
        " --fail-fast --interval= -i= --required --watch --web -w --help --repo= -R= ",
    ),
    (
        "pr close",
        " --comment= -c= --delete-branch -d --help --repo= -R= ",
    ),
    (
        "pr comment",
        " --body= -b= --body-file= -F= --edit-last --editor -e --web -w --help --repo= -R= ",
    ),
    (
        "pr create",
        " --assignee= -a= --base= -B= --body= -b= --body-file= -F= --draft -d --dry-run --fill -f --fill-first --fill-verbose --head= -H= --label= -l= --milestone= -m= --no-maintainer-edit --project= -p= --recover= --reviewer= -r= --template= -T= --title= -t= --web -w --help --repo= -R= ",
    ),
    (
        "pr diff",
        " --color= --name-only --patch --web -w --help --repo= -R= ",
    ),
    (
        "pr edit",
        " --add-assignee= --add-label= --add-project= --add-reviewer= --base= -B= --body= -b= --body-file= -F= --milestone= -m= --remove-assignee= --remove-label= --remove-project= --remove-reviewer= --title= -t= --help --repo= -R= ",
    ),
    (
        "pr list",
        " --app= --assignee= -a= --author= -A= --base= -B= --draft -d --head= -H= --jq= -q= --json= --label= -l= --limit= -L= --search= -S= --state= -s= --template= -t= --web -w --help --repo= -R= ",
    ),
    ("pr lock", " --reason= -r= --help --repo= -R= "),
    (
        "pr merge",
        " --admin --author-email= -A= --auto --body= -b= --body-file= -F= --delete-branch -d --disable-auto --match-head-commit= --merge -m --rebase -r --squash -s --subject= -t= --help --repo= -R= ",
    ),
    ("pr ready", " --undo --help --repo= -R= "),
    ("pr reopen", " --comment= -c= --help --repo= -R= "),
    (
        "pr review",
        " --approve -a --body= -b= --body-file= -F= --comment -c --request-changes -r --help --repo= -R= ",
    ),
    (
        "pr status",
        " --conflict-status -c --jq= -q= --json= --template= -t= --help --repo= -R= ",
    ),
    ("pr unlock", " --help --repo= -R= "),
    (
        "pr view",
        " --comments -c --jq= -q= --json= --template= -t= --web -w --help --repo= -R= ",
    ),
    ("run cancel", " --help --repo= -R= "),
    ("run delete", " --help --repo= -R= "),
    (
        "run download",
        " --dir= -D= --name= -n= --pattern= -p= --help --repo= -R= ",
    ),
    (
        "run list",
        " --branch= -b= --commit= -c= --created= --event= -e= --jq= -q= --json= --limit= -L= --status= -s= --template= -t= --user= -u= --workflow= -w= --help --repo= -R= ",
    ),
    (
        "run rerun",
        " --debug -d --failed --job= -j= --help --repo= -R= ",
    ),
    (
        "run view",
        " --attempt= -a= --exit-status --job= -j= --jq= -q= --json= --log --log-failed --template= -t= --verbose -v --web -w --help --repo= -R= ",
    ),
    (
        "run watch",
        " --exit-status --interval= -i= --help --repo= -R= ",
    ),
    (
        "issue close",
        " --comment= -c= --reason= -r= --help --repo= -R= ",
    ),
    (
        "issue comment",
        " --body= -b= --body-file= -F= --edit-last --editor -e --web -w --help --repo= -R= ",
    ),
    (
        "issue create",
        " --assignee= -a= --body= -b= --body-file= -F= --label= -l= --milestone= -m= --project= -p= --recover= --template= -T= --title= -t= --web -w --help --repo= -R= ",
    ),
    ("issue delete", " --yes --help --repo= -R= "),
    (
        "issue develop",
        " --base= -b= --branch-repo= --checkout -c --list -l --name= -n= --help --repo= -R= ",
    ),
    (
        "issue edit",
        " --add-assignee= --add-label= --add-project= --body= -b= --body-file= -F= --milestone= -m= --remove-assignee= --remove-label= --remove-project= --title= -t= --help --repo= -R= ",
    ),
    (
        "issue list",
        " --app= --assignee= -a= --author= -A= --jq= -q= --json= --label= -l= --limit= -L= --mention= --milestone= -m= --search= -S= --state= -s= --template= -t= --web -w --help --repo= -R= ",
    ),
    ("issue lock", " --reason= -r= --help --repo= -R= "),
    ("issue pin", " --help --repo= -R= "),
    ("issue reopen", " --comment= -c= --help --repo= -R= "),
    (
        "issue status",
        " --jq= -q= --json= --template= -t= --help --repo= -R= ",
    ),
    ("issue transfer", " --help --repo= -R= "),
    ("issue unlock", " --help --repo= -R= "),
    ("issue unpin", " --help --repo= -R= "),
    (
        "issue view",
        " --comments -c --jq= -q= --json= --template= -t= --web -w --help --repo= -R= ",
    ),
];

/// `sh` lines for a fake `gh`, after its own logging: a gh 2.46 `api`/`pr`/`run`/`issue` call
/// with an unknown subcommand or flag → gh's error on stderr, exit 1 (anything else: on).
pub fn guard() -> String {
    let mut cases = String::new();
    for (c, flags) in COMMANDS {
        cases.push_str(&format!("    \"{c}\") gok='{flags}' ;;\n"));
    }
    format!(
        r#"case "$1" in
  api) gc=api; go=1 ;;
  pr|run|issue) gc="$1 $2"; go=2 ;;
  *) gc=; go=0 ;;
esac
if [ -n "$gc" ]; then
  case "$gc" in
{cases}    *) printf 'unknown command "%s" for "gh %s"\n\nUsage:  gh %s <command> [flags]\n' "${{gc#* }}" "${{gc%% *}}" "${{gc%% *}}" >&2; exit 1 ;;
  esac
  gi=0; gskip=
  for ga in "$@"; do
    gi=$((gi + 1)); [ "$gi" -le "$go" ] && continue
    if [ -n "$gskip" ]; then gskip=; continue; fi
    case "$ga" in
      --) break ;;
      -?*)
        gf="${{ga%%=*}}"
        case "$gok" in
          *" $gf= "*) [ "$gf" = "$ga" ] && gskip=1 ;;
          *" $gf "*) ;;
          *) printf 'unknown flag: %s\n\nUsage:  gh %s [flags]\n\nFlags:\n  ...\n' "$gf" "$gc" >&2; exit 1 ;;
        esac ;;
    esac
  done
fi
"#
    )
}
