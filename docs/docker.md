# Docker

skillhook as one container: the server, Claude Code, Codex, `git` and `gh`, running as an unprivileged user, with
everything that must survive a restart on one volume. Use it on a server, a NAS or a VM where nobody installs Node
and logs in by hand.

```bash
docker run -d --name skillhook --restart unless-stopped \
  -p 127.0.0.1:8787:8787 -v skillhook-data:/data \
  -e CLAUDE_CODE_OAUTH_TOKEN=… \
  ghcr.io/meterapp/skillhook:latest
```

Or with Compose: copy [`docker/compose.yaml`](../docker/compose.yaml), put the variables you use in a `.env` next to
it, and run `docker compose up -d`. Then:

```bash
docker compose exec skillhook skillhook doctor
```

Every `skillhook` command works the same way (`docker compose exec skillhook skillhook <command>`); the examples below
leave the prefix out.

## What the first start does

1. `skillhook init` when `/data/skillhook/skillhook.json` does not exist yet: the config, the admin token and the
   `hello` skill.
2. Keeps `CLAUDE_CODE_OAUTH_TOKEN`, when set, in `/data/skillhook/.env` (mode 600). Runs get only the credentials in
   that file, never a `CLAUDE_CODE_*` variable of the process that started the server.
3. Pairs with Skillhook Cloud when `SKILLHOOK_CLOUD_CODE` is set and the machine is not paired yet. A failed pairing
   (a used or expired code) is logged and the server starts unpaired.
4. `skillhook serve --host 0.0.0.0`. Inside a container the loopback address is the container's own, so the server
   listens on every interface and the port mapping decides who reaches it. Requests from outside the container never
   arrive from loopback: every admin route needs the admin token (`skillhook secret list` shows where it is kept).

Later starts skip what is already done. Any other command runs instead of the server:
`docker run --rm -v skillhook-data:/data ghcr.io/meterapp/skillhook doctor`.

## Variables

| Variable | What |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code with your subscription: the token `claude setup-token` prints (run it on a computer with a browser). About a year. |
| `ANTHROPIC_API_KEY` | Claude Code paid per use. With both set, `runners.claude.auth` decides ([runners.md](runners.md)). |
| `OPENAI_API_KEY` | Codex paid per use. |
| `SKILLHOOK_CLOUD_CODE` | A pairing code from the Skillhook Cloud dashboard; used once, on the first start that has it. `SKILLHOOK_CLOUD_MODE=control` pairs in control mode instead of observe ([cloud.md](cloud.md)). |
| `SKILLHOOK_PORT` | The port inside the container (default 8787). |
| `SKILLHOOK_RUNNER` | The default runner `init` writes: `claude` (default), `codex` or `shell`. |
| `TZ` | The time zone for schedules that name none. |

The image sets `SKILLHOOK_HOME=/data/skillhook`, `HOME=/data/home`, `SKILLHOOK_NO_UPDATE_CHECK=1` and
`SKILLHOOK_CONTAINER=1` (`doctor` then skips the service and Tailscale checks). It never updates itself: pull a newer
image and recreate the container.

## Logging in

Use your own subscription or key. One of:

- **A subscription token** (`CLAUDE_CODE_OAUTH_TOKEN`, above): no browser needed in the container.
- **An API key** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`).
- **A login inside the container**: `docker compose exec -it skillhook claude` and `/login`, or
  `docker compose exec -it skillhook codex login --device-auth`. The login is kept in `/data/home`.
- **Several accounts** with failover on usage limits: `skillhook accounts add work --runner claude --token`
  ([accounts.md](accounts.md)).

`skillhook doctor` says which one the runner found.

## The volume

| Path | What |
| --- | --- |
| `/data/skillhook` | The skillhook home: `skillhook.json`, `.env`, `skills/`, `jobs/`, `logs/` ([operations.md](operations.md#home-directory)) |
| `/data/home` | The user's home: Claude Code's and Codex's configuration and logins, their MCP servers, `gh` and `git` configuration, SSH keys |
| `/data/workspace` | The working directory; check repositories out here |

The container runs as uid 1000. A named volume gets that owner by itself; a bind-mounted directory keeps its own, so
`chown -R 1000:1000` it first. Back up the volume: it holds the secrets and every job's record.

## Giving the agents a repository

skillhook serves the hooks a checked-out repository declares ([projects.md](projects.md)); check it out on the volume
and link it:

```bash
docker compose exec -it skillhook gh auth login          # once; then: gh auth setup-git
docker compose exec skillhook git clone https://github.com/you/repo.git /data/workspace/repo
docker compose exec skillhook skillhook link /data/workspace/repo
```

`project_refresh` then fast-forwards the checkout before each job. Agents that open pull requests need a git identity:
`git config --global user.name …` and `user.email …` inside the container (kept in `/data/home`).

MCP servers the agents should have are Claude Code's and Codex's own configuration: add them inside the container
(`claude mcp add …`) or commit a `.mcp.json` to the repository.

## Receiving webhooks

- **Skillhook Cloud's hosted URLs**: pair the container and it needs no published port at all, since it only ever
  connects outwards. Remove the `ports:` mapping.
- **Your own reverse proxy or tunnel** in front of the published port (Caddy, nginx, Cloudflare Tunnel), with
  `skillhook config set public_url https://hooks.example.com` so the URLs skillhook prints are the public ones
  ([exposure.md](exposure.md)). The Compose file publishes the port on the host's loopback only; a proxy in another
  container reaches it over the Compose network as `skillhook:8787`.

## What the container is and is not

The agents run with the rights of the container's user: they can read and change everything on the volume, including
the secrets, and reach the network ([security.md](security.md)). The container keeps that away from the host; it does
not separate one skill from another. Run one container per owner, and give it only the credentials its skills need.

## Building it yourself

```bash
docker build -t skillhook .
docker build -t skillhook --build-arg CLAUDE_CODE_VERSION=2.1.326 --build-arg CODEX_VERSION=0.169.0 .
```

The image installs the newest Claude Code and Codex when it is built; the build arguments pin them. To add tools your
skills need, build on top of it:

```dockerfile
FROM ghcr.io/meterapp/skillhook:latest
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
USER node
```
