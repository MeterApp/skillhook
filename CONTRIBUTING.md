# Contributing

Thanks for helping make skillhook better. Start with `AGENTS.md`: it lists the layout,
the hard rules (security, dependencies, skill format) and the checks.

## Setup

```bash
git clone https://github.com/MeterApp/skillhook.git
cd skillhook
npm install
npm run check
```

Run the CLI from source with `npx tsx src/cli.ts <command> --dir /tmp/skillhook-dev`
so you never touch your real `~/.skillhook`.

## Pull requests

- Keep runtime dependencies at three (`@modelcontextprotocol/server`, `yaml`, `zod`).
- Add or update tests next to the code (`src/**/*.test.ts`); the HTTP and CLI suites
  use the fake runners in `test/fixtures/`.
- Update the docs that describe what you changed (`README.md`, `docs/`, the plugin
  skills under `skills/`) in the same PR, and run `npm run schema` after touching
  `src/config.ts`.
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
2. Run `npm run release -- minor` (or `patch`, `major`, `1.2.3`). It bumps `package.json`,
   `package-lock.json` and the plugin manifests and moves the Unreleased entries under
   `## 1.2.0 (date)`. Nothing is committed; `npm run release -- --check` verifies the result.
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

Please email hello@meterapp.co instead of opening a public issue. See `SECURITY.md`.
