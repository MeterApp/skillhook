# Getting a permanent URL

skillhook listens on `127.0.0.1:8787` and never terminates TLS itself. A tunnel on the same machine gives it a stable HTTPS URL that webhook senders can reach. The default is Tailscale Funnel: free, no domain to buy, and the configuration survives reboots. Tailscale Serve (tailnet only), Cloudflare Tunnel and ngrok also work.

Related: [security.md](security.md) (why the server stays on loopback), [operations.md](operations.md) (running the server as a service).

## Tailscale Funnel (default)

Prerequisites: Tailscale installed and signed in on the machine (`tailscale status` reports `Running`); HTTPS certificates enabled for the tailnet; the `funnel` node attribute granted in the tailnet policy. The last two are a one-time approval in the admin console, and the CLI prints the link.

```bash
skillhook expose tailscale
```

What it does:

1. Finds the `tailscale` binary (on `PATH`, then `/usr/local/bin/tailscale`, `/opt/homebrew/bin/tailscale`, `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `/usr/bin/tailscale`) and checks that `tailscale status --json` reports `BackendState: Running`.
2. Runs `tailscale funnel --bg --yes <port>`, where `<port>` is `port` from `skillhook.json` (`--port N` overrides it). `--bg` stores the mapping inside tailscaled, so it persists across reboots and does not depend on skillhook running.
3. Reads `tailscale serve status --json` back, derives the URL (`https://<machine>.<tailnet>.ts.net`) and writes it to `public_url` in `skillhook.json`.
4. If a local server is running, polls `<url>/health` for up to 60 seconds and reports `verified`, or a hint to check again (a node's first TLS certificate can take a while).
5. Prints the webhook URL of every skill.

```text
✓ Tailscale Funnel (public internet) → http://127.0.0.1:8787
  https://jonathans-mbp.tail1234.ts.net
  Persistent: survives reboots (stored by tailscaled). Turn off with: skillhook expose off
  ✓ verified: https://jonathans-mbp.tail1234.ts.net/health answered after 4s

Webhook URLs:
  hello                    https://jonathans-mbp.tail1234.ts.net/hooks/hello

The server stays bound to 127.0.0.1; only Tailscale's TLS proxy reaches it.
```

The hostname is your Tailscale node name; it changes only if you rename the machine or move tailnets. Funnel accepts connections on ports 443, 8443 and 10000; skillhook uses 443, so URLs have no port suffix.

First-time approval: when Funnel is not yet allowed for the node, the command exits 1 and prints

```text
Funnel needs a one-time approval in the Tailscale admin console: https://login.tailscale.com/f/funnel?node=…
Approve it, then run this command again.
```

Open the link, approve, and re-run `skillhook expose tailscale` (`--json` output carries the link as `approval_url`).

Status and teardown:

```bash
skillhook expose status
```

shows the Tailscale state, every serve/funnel mapping on the node (marking the one that targets skillhook's port) and the configured `public_url`.

```bash
skillhook expose off
```

runs `tailscale funnel --https=443 off` and clears `public_url`.

## Tailscale Serve (tailnet only)

Same mechanics, but the URL answers only for devices on your tailnet: right for skills triggered by your own scripts, iOS Shortcuts or internal services, and for reaching the admin API from another machine.

```bash
skillhook expose tailscale --serve
```

```bash
skillhook expose off
```

Pair it with an IP allow-list so that even a leaked bearer token is useless from outside the tailnet (Tailscale forwards the client's tailnet address in `X-Forwarded-For`):

```yaml
skillhook:
  auth:
    type: bearer
    allow_ips: ["100.64.0.0/10"]
```

## Cloudflare Tunnel

Free; needs a domain on Cloudflare. `skillhook expose cloudflare` prints the recipe:

```bash
brew install cloudflared
```

```bash
cloudflared tunnel login
```

```bash
cloudflared tunnel create skillhook
```

```bash
cloudflared tunnel route dns skillhook hooks.example.com
```

```bash
cloudflared tunnel run --url http://127.0.0.1:8787 skillhook      # or: cloudflared service install
```

```bash
skillhook config set public_url https://hooks.example.com
```

## ngrok

The free tier includes one static domain. `skillhook expose ngrok` prints the recipe:

```bash
brew install ngrok && ngrok config add-authtoken <token>
```

```bash
# claim a static domain at https://dashboard.ngrok.com/domains
ngrok http --url=<your-name>.ngrok-free.app 8787
```

```bash
skillhook config set public_url https://<your-name>.ngrok-free.app
```

## `public_url`

`public_url` in `skillhook.json` is informational: `skillhook url`, `skills list`, `send --public`, `doctor` and the MCP tools use it to print and test webhook URLs, and `serve` logs it at start. `expose tailscale` sets it and `expose off` clears it; for other tunnels set it yourself with `skillhook config set public_url https://…` (and `skillhook config unset public_url` to remove it).

URL resolution order used by `url`, `skills list` and the MCP tools: `public_url`; an active Tailscale mapping that targets the configured port; the running server's local address; the configured `host:port`. `send` defaults to the local server; `--public` forces the first two.

## Client IPs behind a proxy

With `trust_proxy: true` (default), when the TCP peer is loopback and the request carries `X-Forwarded-For` (or `X-Real-IP` / `CF-Connecting-IP`), the first address becomes the client IP used for rate limits, `allow_ips`, `{{source_ip}}` and job records. Tailscale, cloudflared and ngrok all set one of these. A request carrying any proxy header is treated as "via proxy" and cannot use the token-less local admin access ([security.md](security.md#admin-api)). Set `trust_proxy: false` only if something other than a local proxy connects to the port directly.

## Verifying

```bash
skillhook url
```

```bash
curl -i https://<node>.ts.net/hooks/hello        # GET → 200 "skillhook: POST your webhook to this URL."
```

```bash
skillhook send hello --public --wait 60
```

```bash
skillhook doctor                                  # includes a "public url" check that fetches <public_url>/health
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `tailscale CLI not found` | Install Tailscale (https://tailscale.com/download) and sign in. skillhook also looks inside `/Applications/Tailscale.app`. |
| `Tailscale is NeedsLogin` / `Stopped` / `not running` | Open the Tailscale app and sign in; `tailscale status` must say `Running`. |
| `Funnel needs a one-time approval in the Tailscale admin console` | Open the printed link, enable Funnel for the node (this also enables HTTPS certificates when needed), re-run the command. |
| Command succeeded, but the URL times out or fails TLS | The first certificate for a node can take up to a minute. `skillhook expose status`, then retry; `send` prints the same hint. |
| `doctor` says `port 8787 not exposed` after you changed `port` | The mapping targets a fixed local port. Re-run `skillhook expose tailscale`. |
| Works from the tailnet, not from the internet | Serve is enabled instead of Funnel: `skillhook expose off`, then `skillhook expose tailscale` (without `--serve`). |
| Admin routes answer `401` through the tunnel | Expected. Send `Authorization: Bearer $SKILLHOOK_ADMIN_TOKEN`. |
| `expose off` says it could not disable | Pass `--serve` if you exposed with `--serve`; check `tailscale serve status`. |
