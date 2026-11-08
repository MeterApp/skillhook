# Contributing

Thanks for helping make skillhook better. Start with `AGENTS.md`: it lists the layout,
the hard rules (security, dependencies, skill format) and the checks.

## Setup

```bash
git clone https://github.com/MeterApp/skillhook.git
cd skillhook
pnpm install --frozen-lockfile --prefer-offline
pnpm run check
```

Run the CLI from source with `pnpm exec tsx src/cli.ts <command> --dir /tmp/skillhook-dev`
so you never touch your real `~/.skillhook`.

## Pull requests

- Keep runtime dependencies at three (`@modelcontextprotocol/server`, `yaml`, `zod`).
- Add or update tests next to the code (`src/**/*.test.ts`); the HTTP and CLI suites
  use the fake runners in `test/fixtures/`.
- Update the docs that describe what you changed (`README.md`, `docs/`, the plugin
  skills under `plugins/skillhook/skills/`) in the same PR, and run `pnpm run schema` after touching
  `src/config.ts`.
- The plugin is the folder `plugins/skillhook/` (manifests, icon, `.mcp.json`, skills, its own
  `README.md`); the repository root is only its marketplace (`.claude-plugin/marketplace.json`,
  `.agents/plugins/marketplace.json`). Anthropic's plugin directory reads every file in the plugin
  folder and holds the plugin for review (`MCP_FORWARDS_CREDENTIAL_ENV`) when one looks like it reads
  a credential, examples and denials included. So nothing in `plugins/skillhook/` may show a shell
  variable holding a key, a `process.env` read, an `export` of one, a path to the secrets file or
  wording about environment variables: describe secrets as "saved with `skillhook secret set`" and
  link to `docs/` on GitHub for the rest. `pnpm run release --check` runs that audit
  (`scripts/plugin-audit.ts`, the fleet's patterns) along with the manifest rules (no `userConfig`,
  no `env` block, no headers, the `npx` launchers pinned at the version in `package.json`). Keep
  every file there under 256 KiB, text and images only, and no symlinks.
  `claude plugin validate plugins/skillhook --strict --profile directory` checks the rest.
- Describe the security impact of the change in the PR description when it touches
  `src/auth.ts`, `src/server.ts`, `src/runners/env.ts` or `src/prompt.ts`.

## Branch rules

`main` is protected by a repository ruleset: no direct pushes, no force pushes, linear history,
pull requests only (squash or rebase merges), every review thread resolved, and the CI checks
`Node.js 22`, `Node.js 24` and `Package` green on a branch that is up to date with `main`; CodeQL
must not report high-severity alerts. Release tags (`v*`) cannot be moved or deleted. The ruleset
does not require approving reviews today because the team is small; switch that on under
Settings → Rules → main when it should.

## Releasing

Versions are cut from `main` by pull request:

1. Describe changes under `## Unreleased` in `CHANGELOG.md` as they land.
2. Run `pnpm run release minor` (or `patch`, `major`, `1.2.3`). It bumps `package.json`,
   the plugin manifests, the pinned `npx -y @meterapp/skillhook@X.Y.Z` launchers in `plugins/skillhook/.mcp.json`
   and moves the Unreleased entries under
   `## 1.2.0 (date)`. Nothing is committed; `pnpm run release --check` verifies the result.
3. Commit on a branch, open a pull request, let CI pass, merge.
4. The **Release** workflow sees the new version on `main`, tags `v1.2.0` and dispatches the
   **Publish** workflow.
5. **Publish** checks the tag against `package.json`, runs `npm publish --provenance` (versions
   already on npm are skipped, so re-runs are safe), creates the GitHub release with the changelog
   section as its notes, then installs `@meterapp/skillhook@1.2.0` from the registry on a clean
   runner and runs it.

Publishing by hand also works: `git tag v1.2.0 && git push origin v1.2.0`, or **Releases → Draft a
new release** in the GitHub UI; both trigger Publish. If something fails after the tag exists, re-run
Publish from the Actions tab (**Run workflow** with the tag).

### First publish and npm trusted publishing

The package is `@meterapp/skillhook` in the `meterapp` npm organization (0.1.0 went out as the
unscoped `skillhook`). The workflows read the name from `package.json`. npm's trusted publishing
(short-lived OIDC credentials, no long-lived token) can only be configured for a package that already
exists on npm, so the first version under a new name is published from a laptop by an organization
member:

```bash
npm login
git fetch --tags && git checkout v0.1.1 && npm ci
npm publish --access public          # prepublishOnly runs the full check first
```

Then trust the Publish workflow, with npm 11.10 or newer:

```bash
npm trust github @meterapp/skillhook --repo MeterApp/skillhook --file publish.yml --env npm --allow-publish
```

or on npmjs.com → @meterapp/skillhook → Settings → Trusted publisher → GitHub Actions: organization
`MeterApp`, repository `skillhook`, workflow filename `publish.yml`, environment `npm`. From then on
the workflow publishes without any secret. Re-run Publish for that first tag afterwards so it creates
the GitHub release and verifies the package. Alternative: store an npm granular access token with
publish rights as the `NPM_TOKEN` repository secret; Publish uses it when present.

## Reporting security issues

Please email jonathan@skillhook.dev instead of opening a public issue. See `SECURITY.md`.

### Shared dependency cache

Use pnpm 12.14.0 (the `packageManager` pin), then run `pnpm deps:install`. It installs the committed lockfile and prefers cached packages while fetching anything missing. Dependency updates remain explicit.

The pnpm global virtual store is enabled here after tests and builds passed. Equivalent dependency graphs share installed packages across projects and worktrees. It is experimental; to opt out set `virtualStoreType: project` in `pnpm-workspace.yaml` and reinstall.

Keep the shared download store warm; prune only occasionally, and retire completed worktrees through their owning tool after preserving changes.

## Publishing the plugin directory mirror

[MeterApp/skillhook-plugins](https://github.com/MeterApp/skillhook-plugins) is a
plugin-only mirror: the contents of `plugins/skillhook/` at its root, with marketplaces
that point at `./`. `plugins/skillhook/` remains the source of truth here, and
`MeterApp/skillhook` itself installs the same plugin through its root marketplace.

The mirror is what the plugin directory installs. The directory refuses local MCP servers, scripts
and package manager files from organizations that are not Verified, so the mirror carries the skills
and the hosted Skillhook Cloud server only, with its own README (`scripts/plugin-mirror/README.md`) and
description. The script fails if anything it stages would be refused. This repository's marketplace
keeps both local servers. When MeterApp is Verified, the mirror can carry them again.

After merging a plugin change, run from a clean `main` checkout:

```bash
node scripts/publish-plugins.mjs --dry-run
node scripts/publish-plugins.mjs
```

Both commands stage the plugin folder and run
`claude plugin validate <snapshot> --strict --profile directory` before publishing.
`--output=<empty-directory>` preserves the validated snapshot for inspection.
Set `CLAUDE_BIN` if the Claude CLI is not on PATH. Never edit the generated public
mirror directly, and do not enable operational Skillhook hooks for either public
repository.
