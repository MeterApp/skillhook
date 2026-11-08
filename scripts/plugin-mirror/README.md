# skillhook plugin

Webhook in, agent out. [skillhook](https://skillhook.dev/?ref=plugin) by Meter turns a Mac or Linux
machine into a permanent, secure webhook endpoint that runs Agent Skills with Claude Code or Codex.
This plugin, for Claude Code, Codex and Cursor, gives your agent:

- `skillhook-setup`: install skillhook, expose it with Tailscale Funnel and verify a webhook end to end.
- `skillhook-authoring`: write, test and debug the SKILL.md (or `skillhook.yaml` hook) a webhook runs.
- `skillhook-cloud`: see and operate every machine of your Skillhook Cloud organisation.
- One hosted MCP server, `skillhook-cloud` (`https://skillhook.dev/api/mcp`): the organisation, as the
  Skillhook Cloud dashboard shows and runs it.

## Install

Claude Code:

```text
/plugin marketplace add MeterApp/skillhook-plugins
/plugin install skillhook@meterapp-skillhook
```

Codex: `codex plugin marketplace add MeterApp/skillhook-plugins`, then install `skillhook` from it.

## What it runs

Nothing on your machine. The plugin is skills and the address of one hosted server; it ships no code
and starts no process. The skills tell your agent how to install and use the `skillhook` command line,
which is a separate install.

To manage this machine through MCP as well, add skillhook's local server once the command line is
installed: `skillhook mcp --print-config` prints the command for Claude Code, Codex and mcp.json hosts.
The [source repository](https://github.com/MeterApp/skillhook)'s own marketplace installs the same
skills with that server already registered.

## How sign-in works

The plugin takes no option and carries no key. The host signs you in with your browser the first time
the server is used, and acts with the rights you approved on skillhook.dev.

## Also sent

Tool calls go to `https://skillhook.dev` and nowhere else. No telemetry or analytics. Skillhook Cloud's
[privacy policy](https://skillhook.dev/privacy?ref=plugin) and [terms](https://skillhook.dev/terms?ref=plugin)
cover what reaches it.

[Documentation](https://skillhook.dev/docs?ref=plugin) ·
[Source and issues](https://github.com/MeterApp/skillhook) · MIT licence
