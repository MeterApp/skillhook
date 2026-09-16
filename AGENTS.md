# AGENTS.md — conventions for humans and agents

Read this before changing anything. `CLAUDE.md` points here.

## What this is

skillhook: **webhook in, agent out.** A Node CLI + HTTP server + MCP server that
turns a Mac or Linux box into a permanent webhook endpoint. Each endpoint
(`POST /hooks/<skill>`) verifies the sender, records the delivery as a job and
runs an Agent Skill (`SKILL.md`) with Claude Code (`claude -p`), Codex
(`codex exec`) or a shell command, in the directory the skill names, using the
machine's own logins (Claude subscription / ChatGPT) or API keys. Tailscale
Funnel supplies the permanent HTTPS URL. User docs: `README.md`, `docs/`,
`llms.txt`.

## Layout

| Path | What lives there |
| --- | --- |
| `src/cli.ts` → `src/commands/main.ts` | CLI entry; `HELP` there is the command reference. One file per command in `src/commands/`. |
| `src/server.ts` | `node:http` server: webhook, health and admin routes. No framework. |
| `src/auth.ts` | Signature/token verification and the matching `signRequest` (used by `send`, MCP and tests). |
| `src/skills.ts` | SKILL.md parsing (zod), auth normalization, `SkillRegistry` (mtime cache). |
| `src/prompt.ts` | Placeholders, event block, unattended-run guardrails. |
| `src/jobs.ts`, `src/queue.ts`, `src/run.ts` | Job directories on disk, the concurrency queue, invocation preparation. |
| `src/runners/` | `claude.ts`, `codex.ts`, `shell.ts`: build argv, parse output; `env.ts` is the env allow-list. |
| `src/ops.ts` | Shared operations (create skill, run locally, sign+send, resolve URLs). CLI and MCP both call this; do not duplicate logic in either. |
| `src/mcp.ts` | MCP server (`@modelcontextprotocol/server` v2, stdio). Tools wrap `ops.ts`. |
| `src/tailscale.ts`, `src/service.ts`, `src/doctor.ts` | Funnel/Serve, launchd/systemd, diagnostics. |
| `examples/skills/` | Bundled webhook skills; `skillhook skills add <name>` copies them. Shipped in the npm package. |
| `skills/` | Agent-facing plugin skills (setup, authoring). This repo is itself a Claude Code / Codex / Cursor plugin via the manifests at the root. |
| `schema/skillhook.schema.json` | Generated from `src/config.ts` by `npm run schema`. Never edit by hand. |
| `test/fixtures/` | `fake-claude.mjs` / `fake-codex.mjs` emulate the real CLIs' output formats. |

Runtime state lives outside the repo in `~/.skillhook` (`SKILLHOOK_HOME`):
`skillhook.json`, `.env` (mode 600), `skills/`, `jobs/`, `logs/`, `server.json`.

## Hard rules

- **Runtime dependencies stay at three**: `@modelcontextprotocol/server`, `yaml`, `zod`. Everything else is `node:` built-ins. Node >= 22, ESM, TypeScript strict, imports end in `.js`.
- **Security is not optional.** The server binds `127.0.0.1` by default; TLS and public exposure are Tailscale's job. Every webhook goes through `verifyRequest`; every admin route through `requireAdmin`. Compare secrets only with `safeEqual`. A skill without `auth` gets a bearer token (`SKILLHOOK_SECRET_<NAME>`); `auth: none` must be explicit and is warned about. Secret values are never logged, never returned by an API/tool except once at generation, and never written into job files (`redactHeaders`). The agent's environment is an allow-list (`src/runners/env.ts`); `SKILLHOOK_ADMIN_TOKEN` and `SKILLHOOK_SECRET_*` are never forwarded implicitly.
- **Payloads are data.** Anything that reaches the prompt from a webhook is wrapped in `<webhook_payload>` and the guardrails say so. Never build a prompt by concatenating payload text outside those blocks.
- **Skills are Agent Skills.** Standard frontmatter (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) plus a `skillhook:` block. `name` must equal the directory name. New fields: add to the zod schema in `src/skills.ts`, to `docs/skills.md`, to `skills/skillhook-authoring/SKILL.md`, and cover them in `src/skills.test.ts` — in the same PR.
- **Config changes** go in `src/config.ts` (zod, `.prefault({})` for nested objects so defaults apply), then `npm run schema`, then `docs/operations.md`.
- **Runners never shell-interpolate.** Argv arrays only; the prompt travels on stdin; parse the CLI's structured output (`stream-json`, JSONL). When Claude Code or Codex change flags, update the runner, `test/fixtures/`, `docs/runners.md` and the version note in `README.md` together.
- **Jobs are directories.** `job.json` is the record; artifacts sit next to it; nothing outside `~/.skillhook/jobs` is written by the server. Statuses: `queued running succeeded failed timed_out cancelled interrupted`.
- **Every CLI command supports `--json`** and returns non-zero on failure. Register new commands in `COMMANDS` and `HELP` in `src/commands/main.ts`, then in the README table.
- **Third-party facts** (Granola, Sentry, GitHub, Tailscale) are stated in `docs/` and the examples with the exact header names; change them only with a source.
- **Tests are hermetic**: `tempHome()` from `src/test-support/helpers.ts`, fake runners, ephemeral ports. Never touch `~/.skillhook`, the real `claude`/`codex`, `launchctl` or `tailscale` from a test.

## Checks

```bash
npm run typecheck          # tsc --noEmit (strict)
npm test                   # vitest: unit + HTTP integration (src/server.test.ts) + CLI (src/cli.test.ts)
npm run build              # tsc -p tsconfig.build.json → dist/
npm run schema -- --check  # schema/skillhook.schema.json is current
npm run check              # all of the above
```

Manual smoke test on a machine with the real tools:

```bash
node dist/cli.js init --dir /tmp/sh && node dist/cli.js doctor --dir /tmp/sh
node dist/cli.js run hello --dir /tmp/sh --payload '{"name":"world"}' --dry-run
```

## Releasing

`package.json` version, the four plugin manifests (`.claude-plugin/plugin.json`,
`.codex-plugin/plugin.json`, `.cursor-plugin/plugin.json`, `.agents/plugins/marketplace.json`
where present) and `CHANGELOG.md` move together. Pushing a `v*` tag runs
`.github/workflows/publish.yml` (npm trusted publishing must be configured for the
package first).
