# Contributing

Thank you for helping improve the CollieAi node for n8n. Bug reports,
questions and pull requests are welcome.

## How changes land

This repository is published from CollieAi's internal source, where every
change also runs against the CollieAi server's own test suites and a real
n8n. We review pull requests here; an accepted change is then applied in the
internal source and comes back to this repository with the next export. Your
pull request is closed with a link to that commit, and you are credited as a
co-author (`Co-authored-by:`).

Direct pushes to `main` are not possible for anyone: every change arrives
through a reviewed pull request with green CI.

## Before you start

- For a bug, open an issue with the package version, the n8n version, the
  node's settings and what you expected.
- For a larger change, open an issue first so we can agree on the approach.
- Security issues go to security@collieai.io, not to issues
  (see [SECURITY.md](SECURITY.md)).

## Setting up and running the tests

The commands below are the ones CI runs ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
No CollieAi account or network access to the service is needed: the tests use
a fake n8n context and fake HTTP. Node.js 22 or newer.

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

`npm run lint` is n8n's strict lint for verified community nodes; a change
that needs it relaxed is not accepted. CI also runs n8n's community package
scan on the source and on the packed package (`.github/scripts/scan.mjs`):
its rules are the ones n8n vets verified nodes with, and they ignore
`eslint-disable` comments. `npm run mutation` runs the mutation
tests (Stryker); it is slow and not part of CI.

`nodes/CollieAi/pacing.ts` and `test/verdict_cases.json` are byte copies of
files of the [CollieAi SDK](https://github.com/CollieAi/collieai-sdk) and
change only there.

## Behavior changes

The node never lets text through unless CollieAi said so: a check that cannot
be made, or an answer it cannot read, never comes out as allowed, whatever
the node's On Error setting. It never repeats a check, and it sends the API
key only to the credential's Base URL. A change in behavior is accepted only
with tests, and must keep these promises.

## Commit messages

One logical change per commit, summary in the imperative, with the area in
front:

```
fix(check): end the poll at its deadline after a dropped connection
docs: clarify the Timeout option
```

## Code of conduct

Participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE) of this repository.
