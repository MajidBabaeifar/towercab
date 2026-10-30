# Contributing to Towercab

Thanks for looking. Towercab is built for one owner and used daily, so small, well-explained changes
are the easiest to take in. By taking part you agree to the [code of conduct](CODE_OF_CONDUCT.md).

## Specs first

The files in `specs/` say what Towercab does, and the code follows them. A change in behaviour starts
with a requirement row: add or change it in the right file, with the test titles that will verify it.
[specs/README.md](specs/README.md) explains the format. A change that alters no behaviour (a refactor,
docs, CI) needs no row.

## Set up and check

```bash
npm ci
npm run check
```

`npm run check` runs the linter (Biome), the type check and every test. `npm run format` fixes style.
Towercab runs TypeScript straight from the checkout, so there is no build step.

## Tests

Tests are hermetic: temporary directories, local bare git repos and fakes for `gh`, `claude` and
`bwrap`. A test never uses the network, GitHub or your real `~/.local/share/towercab`, and never
sleeps for real: inject a test clock. A test's title is the name the spec row lists under
`Verified by`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(ui): …`, `fix(loop): …`,
  `docs(specs): …`.
- Keep pull requests small, one idea each, and commit in small steps.
- Say in the description what changes, why, and what a reviewer should look at.

## Security

Do not report a vulnerability in an issue or a pull request. Follow [SECURITY.md](SECURITY.md) and
report it privately through GitHub.
