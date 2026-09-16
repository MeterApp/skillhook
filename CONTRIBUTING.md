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

## Reporting security issues

Please email hello@meterapp.co instead of opening a public issue. See `SECURITY.md`.
