# Version-controlled hooks: `skillhook.yaml`

A repository can declare its own webhooks in a `skillhook.yaml` at its root. The file maps each webhook name to what runs (a shell command, a `SKILL.md` in the repository, or inline instructions for an agent) and lives in git next to the code it acts on. Anyone on the team can change which skill answers which webhook in a pull request, `git log` shows who changed it and when, and every machine that links the repository serves the same hooks. The question "which skill is running from which webhook" has one answer: the file in the repository.

Related: [skills.md](skills.md) (every field a hook accepts, filters, placeholders), [runners.md](runners.md) (the shell runner), [operations.md](operations.md) (the `projects` config key), [mcp.md](mcp.md) (`link_project`, `list_projects`).

## Quick start

In the repository:

```bash
skillhook projects init          # writes skillhook.yaml with a starter hook and links this directory
```

Edit the file, commit it. On each machine that should serve the hooks:

```bash
skillhook link ~/dev/your-repo   # registers the repository in ~/.skillhook/skillhook.json
```

```bash
skillhook secret set GITHUB_WEBHOOK_SECRET   # secrets stay on the machine, never in the repository
```

```bash
skillhook url pull-after-merge   # the URL to configure at the sender
```

The hooks are live on the running server as soon as the file is linked or edited; no restart. `skillhook projects` lists every linked repository with its hooks, `skillhook skills list` shows them next to the skills in `~/.skillhook/skills` with a `source` column.

## The file

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/MeterApp/skillhook/main/schema/skillhook.yaml.schema.json
hooks:
  # A shell command: no agent involved. Runs in the repository with the payload on stdin.
  pull-after-merge:
    description: Fast-forward this checkout when a pull request merges.
    run: git pull --ff-only
    auth: { type: github, secret_env: GITHUB_WEBHOOK_SECRET }
    when:
      - { header: x-github-event, equals: pull_request }
      - { path: action, equals: closed }
      - { path: pull_request.merged, equals: true }

  # An Agent Skill that lives in the repository. Its skillhook: block applies; keys set here win.
  release-notes:
    skill: .claude/skills/release-notes
    model: sonnet
    auth: { type: github, secret_env: GITHUB_WEBHOOK_SECRET }
    when:
      - { header: x-github-event, equals: release }
      - { path: action, equals: published }

  # Inline instructions for Claude Code or Codex, when a whole SKILL.md would be too much.
  summarize:
    prompt: Summarize the payload in three bullet points and write them to {{job_dir}}/summary.md.
    model: haiku
```

`hooks` is a map from webhook name to hook. The name follows the skill naming rule (1-64 lowercase letters, digits and single hyphens) and becomes the URL: `POST <public_url>/hooks/<name>`. `skillhook.yml` is accepted too. Unknown keys are rejected, so a typo cannot silently disable a filter.

## What a hook accepts

Exactly one of these says what runs:

| Key | Type | What runs |
|---|---|---|
| `run` | string or list of strings | A shell command through the [shell runner](runners.md#shell-runner): a string is executed with `/bin/sh -c`, a list directly (first element is the executable). Implies `runner: shell`. |
| `skill` | path | A directory containing a `SKILL.md` (or the path of the file), relative to the repository. The SKILL.md's frontmatter, body, `allowed-tools` and reference files are used exactly as for a skill in `~/.skillhook/skills`. |
| `prompt` | string | The body of an agent run, with the same `{{placeholders}}` as a SKILL.md body (`{{payload.x}}`, `{{job_dir}}`, …). |

Everything else is the [`skillhook:` block](skills.md#the-skillhook-block) of a SKILL.md, key for key: `description`, `runner`, `model`, `effort`, `cwd`, `timeout_seconds`, `auth`, `when`, `env`, `concurrency`, `dedupe`, `claude`, `codex`, `shell`, `enabled`. Two defaults differ from a skill directory:

- `cwd` defaults to the repository (the directory containing `skillhook.yaml`), not the skill directory. A relative `cwd` is resolved against the repository; `~` and absolute paths work as usual. `defaults.cwd` from `skillhook.json` does not apply to hooks.
- The default secret variable is derived from the **hook** name: `SKILLHOOK_SECRET_<HOOK>`.

`description` defaults to the SKILL.md's description for `skill` hooks and to a line about the command otherwise. Without `auth` a hook expects `Authorization: Bearer $SKILLHOOK_SECRET_<HOOK>`, like a skill.

### `run` hooks

The command runs in the repository (or the hook's `cwd`) with:

- the payload on stdin, pretty-printed JSON (or the raw text body);
- the [job environment](runners.md#environment): `SKILLHOOK_PAYLOAD_PATH`, `SKILLHOOK_EVENT_PATH`, `SKILLHOOK_JOB_DIR`, `SKILLHOOK_PROMPT_PATH`, `SKILLHOOK_SKILL` (the hook name), `SKILLHOOK_SKILL_DIR` (the repository), `SKILLHOOK_TRIGGER`, plus the names listed in `env:`;
- the merged `PATH` that also finds tools in `~/.local/bin`, `/opt/homebrew/bin` and friends when the server runs as a service.

Exit code 0 makes the job `succeeded` with stdout as the result; anything else `failed` with the last stderr lines as the error; `timeout_seconds` (default 900) still applies. Payload data never reaches the command line: read it from stdin or `$SKILLHOOK_PAYLOAD_PATH` (`jq -r .pull_request.number "$SKILLHOOK_PAYLOAD_PATH"`). `run` cannot be combined with `runner` (other than `shell`) or `shell.command`.

```yaml
hooks:
  deploy:
    run: ./scripts/deploy.sh            # a script in the repository
    auth: { type: bearer }              # skillhook generates SKILLHOOK_SECRET_DEPLOY on link
    when:
      - { path: environment, equals: production }
  notify:
    run: ["python3", "scripts/notify.py", "--channel", "ops"]
    env: [SLACK_BOT_TOKEN]
    timeout_seconds: 60
```

### `skill` hooks

The SKILL.md keeps its own name (which must match its directory, as always), while the webhook gets the hook's name. This is how one skill can answer several webhooks with different filters, and how a skill that also serves Claude Code interactively (`.claude/skills/<name>/SKILL.md`) becomes a webhook without duplicating it:

```yaml
hooks:
  issue-opened:
    skill: .claude/skills/issue-triage
    when: [{ header: x-github-event, equals: issues }, { path: action, equals: opened }]
    auth: { type: github, secret_env: GITHUB_WEBHOOK_SECRET }
  issue-labelled:
    skill: .claude/skills/issue-triage
    when: [{ header: x-github-event, equals: issues }, { path: action, equals: labeled }, { path: label.name, equals: agent }]
    auth: { type: github, secret_env: GITHUB_WEBHOOK_SECRET }
```

Keys set on the hook replace the same keys of the SKILL.md's `skillhook:` block (a whole `claude:` or `when:` block is replaced, not merged). The skill directory stays the one passed as `--add-dir` and `{{skill_dir}}`, so `references/*.md` next to the SKILL.md keep working; the agent's working directory is the repository unless `cwd` says otherwise.

### `prompt` hooks

`prompt` is the whole body: skillhook prepends `# Skill: <name>`, appends the event block when the prompt does not reference the payload, and adds the unattended-run guardrails, exactly as for a SKILL.md. Use it for one-paragraph jobs; move anything longer into a `SKILL.md` and point `skill:` at it.

## Linking

```bash
skillhook link [dir]            # default: the current directory; also accepts the path of the YAML file
```

`link` validates the file, appends the absolute path to `projects` in `~/.skillhook/skillhook.json`, generates the secrets it manages (bearer, basic, generic hmac; skip with `--no-secret`), names the provider secrets you still have to paste, and prints every hook with its URL. Linking the same repository again is a no-op that re-prints the hooks. `skillhook unlink <dir>` removes the entry; the hooks answer `404` at once and the repository is not touched. `skillhook projects` lists what is linked; `skillhook projects init [dir]` writes a starter file and links it. The MCP tools are `link_project` (with `init: true` to scaffold), `unlink_project` and `list_projects`.

Precedence and reloads:

- Routing order is `~/.skillhook/skills` first, then linked repositories in the order of `projects`. A name that is already taken is reported (`hook "deploy" in …/skillhook.yaml is shadowed by …`) by `skills list`, `skills validate`, `doctor` and the server log, and that later definition is not served. Rename one of them.
- The server re-reads `projects` when `skillhook.json` changes, and a repository's hooks when its `skillhook.yaml` or a referenced `SKILL.md` changes. `git pull` on the repository is enough to deploy a hook change.
- A repository that has moved or lost its file shows as an error in the same places; `unlink` it or restore the file.

Several machines can link the same repository; each has its own URL, secrets and job history, and all serve the same hooks. A hook that must run on only one machine can be disabled elsewhere with a machine-local skill of the same name in `~/.skillhook/skills` (`enabled: false`), which shadows it.

## Secrets

`skillhook.yaml` names secrets (`secret_env`) and never contains them. Values live in `~/.skillhook/.env` on each machine: `skillhook secret generate <hook>` for a bearer token, `skillhook secret set NAME` for a provider's signing secret or an API key listed in `env:`. `skillhook doctor` reports a hook whose secret is missing (its webhook answers `503 skill_not_configured` until it is set).

## Seeing what runs where

| Where | What it shows |
|---|---|
| `skillhook.yaml` in the repository, and its git history | The intended mapping, reviewable in pull requests. |
| `skillhook projects` | Each linked repository with its hooks: runner, kind (`run`, `skill`, `prompt`), auth, URL, and any error. |
| `skillhook skills list` | Every routable name with a `source` column (the skills directory or the repository). |
| `skillhook skills show <hook>` | The effective settings, the source file, and for `skill` hooks the SKILL.md path. |
| `GET /skills`, MCP `list_skills` / `list_projects` | The same as data: each skill carries `source: {type, dir, file, kind}`. |
| `skillhook jobs list` | Runs by hook name; `jobs show <id>` prints the working directory and the exact command. |

## Editor support

The first line of the starter file points editors at the JSON Schema: `# yaml-language-server: $schema=https://raw.githubusercontent.com/MeterApp/skillhook/main/schema/skillhook.yaml.schema.json` (VS Code with the YAML extension, JetBrains IDEs). The schema ships in the npm package as `schema/skillhook.yaml.schema.json`.

## Troubleshooting

### `No skillhook.yaml or skillhook.yml in …`

`link` needs the file to exist. Create it with `skillhook projects init <dir>` or write it by hand.

### `hook "x" in … is shadowed by …`

Two sources define the same name. Skills in `~/.skillhook/skills` win over repositories, earlier repositories over later ones. Rename the hook, or remove the other definition.

### `Hook "x": skill directory … does not exist`

`skill:` is resolved relative to the repository (the directory containing `skillhook.yaml`). Check the path and that the directory holds a `SKILL.md` whose `name` equals the directory name.

### The webhook answers `404` after `git pull`

The file was renamed or the hook removed, or the repository was unlinked on this machine. `skillhook projects` shows what is served; `skillhook skills validate` shows why something is not.

### A `run` hook fails with `command not found`

The service's `PATH` is fixed at install time plus the standard tool directories. Use an absolute path in `run`, or a script in the repository that sets up its own environment.
