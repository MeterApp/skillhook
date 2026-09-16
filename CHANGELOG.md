# Changelog

All notable changes to skillhook, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org). Describe changes under **Unreleased** as they land; `npm run release -- <patch|minor|major>` moves them under a new version, and the Release and Publish workflows tag it, publish it to npm and turn the section into the GitHub release notes.

## Unreleased

## 0.1.0 (2026-09-16)

Initial release.

- Webhook server (`/hooks/<skill>`) with per-skill auth: bearer, basic, HMAC, GitHub,
  Sentry, Linear, Standard Webhooks (Granola, Svix), Stripe, Slack; filters, de-duplication,
  rate limits, synchronous `?wait=` responses and an admin API.
- In-flight de-duplication: a delivery whose payload and query string match a job of the same
  skill that is still queued or running is answered with that job (`duplicate: true, in_flight: true`)
  instead of starting a second run. On by default (`jobs.dedupe_in_flight`); a skill opts out with
  `dedupe.in_flight: false`.
- Runners: Claude Code (`claude -p`, stream-json), Codex (`codex exec --json`), shell.
  Per-skill runner, model, effort, cwd, timeout and env allow-list.
- Agent Skills format (`SKILL.md` + `skillhook:` block) with a live-reloading registry.
- Jobs on disk with prompt, logs, result and a resume command for the agent session.
- CLI: init, doctor, serve, service (launchd/systemd), expose (Tailscale Funnel/Serve),
  skills, secret, run, send, jobs, config, url, mcp, update.
- Update notifications: `skillhook update [--install]`, a daily background check (cached in
  `update-check.json`) that mentions a newer version after commands, in `doctor` and in the
  server log. Opt out with `SKILLHOOK_NO_UPDATE_CHECK=1`, `CI`, or `"update_check": false`.
- MCP server exposing the whole workflow to Claude Code, Codex, Cursor and others.
- Bundled examples: hello, granola-meeting-actions, sentry-triage, github-issue-triage,
  remote-prompt.
- Release tooling: `npm run release`, a CI job that installs the packed tarball, and
  workflows that tag merged version bumps, publish to npm with provenance and verify the
  published package.
