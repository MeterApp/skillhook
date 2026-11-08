# skillhook plugin

Webhook in, agent out. [skillhook](https://skillhook.dev/?ref=plugin) by Meter turns a Mac or Linux
machine into a permanent, secure webhook endpoint that runs Agent Skills with Claude Code or Codex.
This plugin, for Claude Code, Codex and Cursor, gives your agent:

- `skillhook-setup`: install skillhook, expose it with Tailscale Funnel and verify a webhook end to end.
- `skillhook-authoring`: write, test and debug the SKILL.md (or `skillhook.yaml` hook) a webhook runs.
- `skillhook-cloud`: see and operate every machine of your Skillhook Cloud organisation.
- Two MCP servers: `skillhook` (this machine: status, skills, secrets, jobs, exposure, signed test
  webhooks) and `skillhook-cloud` (the organisation, as the Skillhook Cloud dashboard shows and runs it).

## Install

Claude Code:

```text
/plugin marketplace add MeterApp/skillhook
/plugin install skillhook@meterapp-skillhook
```

Codex: `codex plugin marketplace add MeterApp/skillhook`, then install `skillhook` from it. Node.js 22
or newer is required.

## What it runs

Both servers are local (stdio) and run exactly this plugin's release of the
[`@meterapp/skillhook`](https://www.npmjs.com/package/@meterapp/skillhook) npm package, published with
provenance from [MeterApp/skillhook](https://github.com/MeterApp/skillhook): the host starts
`npx -y @meterapp/skillhook@<version> mcp` and `npx -y @meterapp/skillhook@<version> mcp --cloud`, and
the first start downloads exactly that version. The copy in the plugin directory and
[MeterApp/skillhook-plugins](https://github.com/MeterApp/skillhook-plugins) has no local servers: it
carries the skills and the hosted Skillhook Cloud server.

- **`skillhook`** reads and writes skillhook's own configuration under `~/.skillhook` on this machine
  (settings, skills, the secrets you saved with `skillhook secret set`, jobs) and talks to the local
  skillhook server on `127.0.0.1`. When your agent calls the matching tools it runs skills with
  `claude`, `codex` or a shell command, sends signed test webhooks to your own server, installs the
  background service, and turns on Tailscale Funnel (`expose`), which makes this machine's webhook
  endpoint reachable from the internet; nothing is exposed until then, and `skillhook expose off`
  removes it.
- **`skillhook-cloud`** talks over HTTPS to [Skillhook Cloud](https://skillhook.dev/?ref=plugin) only.
  Before you sign in it offers just the public pricing and checkout-link routes.

## How sign-in works

The plugin takes no option and carries no key. Its server entries are a command and arguments,
nothing else.

- The local server reads only skillhook's own configuration under `~/.skillhook` on this machine.
- The cloud server signs in with your browser: its `skillhook_cloud_setup` tool, or `skillhook cloud
  login` in a terminal, opens a page on skillhook.dev where you approve a code. The organisation key
  that this sign-in saves under `~/.skillhook` is sent to `https://skillhook.dev` and nowhere else,
  with each tool call, and acts with the rights of the person who approved it. `skillhook cloud
  logout` removes it.
- The plugin itself reads nothing from your shell and asks you for nothing at install.

Pairing this machine with the cloud (uploading its jobs and deliveries) is separate and only starts
when a person runs `skillhook cloud connect` in a terminal. What that link sends:
[docs/cloud.md](https://github.com/MeterApp/skillhook/blob/main/docs/cloud.md).

## Also sent

- **Update check.** At most once an hour the CLI asks the npm registry for the latest version of
  `@meterapp/skillhook`. The plugin's copy never installs anything itself; it moves to a new version
  when the plugin updates.
- **Nothing else.** No telemetry or analytics. Skillhook Cloud's
  [privacy policy](https://skillhook.dev/privacy?ref=plugin) and [terms](https://skillhook.dev/terms?ref=plugin)
  cover what reaches it.

[Documentation](https://skillhook.dev/docs?ref=plugin) ·
[Source and issues](https://github.com/MeterApp/skillhook) · [Changelog](CHANGELOG.md) · MIT licence
