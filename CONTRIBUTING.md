# Contributing

Thanks for contributing to Grepmind. This repository is a public npm workspace
and uses GitHub pull requests, Conventional Commits-style PR titles, and
Changesets for package releases.

## Pull Request Titles

Use this format:

```text
<type>(optional-scope): <description>
```

Examples:

```text
feat(agent): add branch sync status output
fix(mcp): handle missing agent socket
docs: update local setup instructions
chore: version packages
```

Allowed types:

- `feat`: user-facing feature
- `fix`: bug fix
- `docs`: documentation-only change
- `style`: formatting-only change
- `refactor`: code change without intended behavior change
- `perf`: performance improvement
- `test`: tests or test utilities
- `build`: packaging, dependencies, or build system
- `ci`: GitHub Actions and CI configuration
- `chore`: maintenance that does not fit another type
- `revert`: revert a previous change

Preferred scopes for package changes are `agent-rpc`, `agent`, `mcp`, and
`grepmind`. Repository-level scopes such as `ci`, `docs`, `release`,
`changeset`, `deps`, and `repo` are also fine when they make the title clearer.

Keep the description after the colon concise. The CI check allows up to 72
characters after `<type>(scope):`.

## Pull Request Descriptions

Use the repository pull request template and fill in at least:

- `Summary`: what changed and why reviewers should expect the change.
- `Behavior`: the user-visible behavior change, or `Internal only`.
- `Release impact`: whether the change is `patch`, `minor`, `major`, or
  `none`.
- `Compatibility`: any CLI, RPC, MCP, migration, or local runtime state impact.
- `Validation`: what was run, or why validation was not needed.

`Related issue` and `Changeset` should be filled when they apply.

For package source changes under `packages/**/src`, package scripts, package
migrations, or package manifests, include a `.changeset/*.md` file. The
`Changeset Required` workflow enforces this before release automation can run.

Draft pull requests may be incomplete. The metadata check is enforced when a PR
is ready for review.
